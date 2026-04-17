// File: server/src/ws/lobby.rs
// Purpose: Lobby state transitions — join, watch, admit, reject. All mutate
//          RoomState under a single `write().await` scope; no `.await`
//          inside the guard except collecting data.
// Role: The admission workflow described in §4.7.
// Exports: join_lobby, watch_lobby, admit, reject
// Depends: tokio, state, protocol
// Invariants: ≤ 1 teacher_conn, ≤ 1 active_session, LobbyEntry placement is
//             XOR between lobby and active_session.
// Last updated: Sprint 3 (2026-04-17) -- persist tier + char-safe tier_reason

use std::sync::Arc;
use std::time::Instant;

use tokio::sync::mpsc;

use crate::state::{ActiveSession, AppState, ClientHandle, LobbyEntry, SlugKey};
use crate::ws::connection::ConnContext;
use crate::ws::protocol::{EntryId, ErrorCode, PumpDirective, Role, ServerMsg, Tier, MAX_TIER_REASON_LEN};

/// Truncate to at most `max_chars` *characters*. `String::truncate`
/// is byte-based and panics on a non-char-boundary byte — this helper
/// counts characters with `.chars().count()` for the guard and
/// rebuilds the String with `.chars().take(max_chars).collect()` so
/// every codepoint boundary is respected. Regression fixture in
/// `server/tests/ws_lobby_tier.rs` uses a 3-byte codepoint placed so
/// that byte-based truncation would split inside the codepoint.
pub(crate) fn truncate_to_chars(s: String, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s;
    }
    s.chars().take(max_chars).collect()
}

async fn send(tx: &mpsc::Sender<PumpDirective>, msg: ServerMsg) {
    let _ = tx.send(PumpDirective::Send(msg)).await;
}

async fn send_error(
    tx: &mpsc::Sender<PumpDirective>,
    code: ErrorCode,
    message: impl Into<String>,
) {
    super::pump_send_error(tx, code, message).await;
}

pub async fn join_lobby(
    state: &Arc<AppState>,
    ctx: &ConnContext,
    slug: &SlugKey,
    email: String,
    browser: String,
    device_class: String,
    tier: Tier,
    tier_reason: Option<String>,
) -> bool {
    let room = match state.room_or_insert(slug.clone()) {
        Ok(r) => r,
        Err(_) => {
            send_error(&ctx.tx, ErrorCode::Internal, "server overloaded").await;
            return true;
        }
    };

    let entry_id = EntryId::new();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp();
    let client_handle = ClientHandle {
        id: ctx.id,
        tx: ctx.tx.clone(),
    };

    let (teacher_tx, update) = {
        let mut rs = room.write().await;
        if rs.lobby.len() >= state.config.lobby_cap_per_room {
            drop(rs);
            send_error(&ctx.tx, ErrorCode::LobbyFull, "lobby full").await;
            return true;
        }
        rs.lobby.push(LobbyEntry {
            id: entry_id,
            email,
            browser,
            device_class,
            tier,
            tier_reason: tier_reason.map(|r| truncate_to_chars(r, MAX_TIER_REASON_LEN)),
            joined_at: Instant::now(),
            joined_at_unix: now_unix,
            conn: client_handle,
        });
        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let update = ServerMsg::LobbyState {
            entries: rs.lobby_view(),
        };
        (teacher_tx, update)
    };

    if let Some(tx) = teacher_tx {
        send(&tx, update).await;
    }
    true
}

pub async fn watch_lobby(state: &Arc<AppState>, ctx: &ConnContext, slug: &SlugKey) -> bool {
    let room = match state.room_or_insert(slug.clone()) {
        Ok(r) => r,
        Err(_) => {
            send_error(&ctx.tx, ErrorCode::Internal, "server overloaded").await;
            return true;
        }
    };

    let client_handle = ClientHandle {
        id: ctx.id,
        tx: ctx.tx.clone(),
    };

    let snapshot = {
        let mut rs = room.write().await;
        rs.teacher_conn = Some(client_handle);
        ServerMsg::LobbyState {
            entries: rs.lobby_view(),
        }
    };
    send(&ctx.tx, snapshot).await;
    true
}

enum AdmitOutcome {
    Ok {
        student_tx: mpsc::Sender<PumpDirective>,
        lobby_update: ServerMsg,
    },
    SessionInProgress,
    EntryNotFound,
    NoRoom,
}

pub async fn admit(state: &Arc<AppState>, ctx: &ConnContext, entry_id: EntryId) {
    let outcome = {
        let Some(slug) = ctx.slug.as_ref() else {
            return;
        };
        let Some(room) = state.room(slug) else {
            return;
        };
        let mut rs = room.write().await;
        if rs.active_session.is_some() {
            AdmitOutcome::SessionInProgress
        } else if let Some(pos) = rs.lobby.iter().position(|e| e.id == entry_id) {
            let entry = rs.lobby.remove(pos);
            let student_tx = entry.conn.tx.clone();
            rs.active_session = Some(ActiveSession {
                student: entry,
                started_at: std::time::Instant::now(),
            });
            debug_assert!(!rs.lobby.iter().any(|e| e.id == entry_id));
            debug_assert!(rs
                .active_session
                .as_ref()
                .map(|s| s.student.id == entry_id)
                .unwrap_or(false));
            let lobby_update = ServerMsg::LobbyState {
                entries: rs.lobby_view(),
            };
            AdmitOutcome::Ok {
                student_tx,
                lobby_update,
            }
        } else {
            AdmitOutcome::EntryNotFound
        }
    };

    match outcome {
        AdmitOutcome::Ok {
            student_tx,
            lobby_update,
        } => {
            send(&student_tx, ServerMsg::Admitted { entry_id }).await;
            send(
                &student_tx,
                ServerMsg::PeerConnected {
                    role: Role::Teacher,
                },
            )
            .await;
            send(
                &ctx.tx,
                ServerMsg::PeerConnected {
                    role: Role::Student,
                },
            )
            .await;
            send(&ctx.tx, lobby_update).await;
        }
        AdmitOutcome::SessionInProgress => {
            send_error(&ctx.tx, ErrorCode::SessionInProgress, "session in progress").await;
        }
        AdmitOutcome::EntryNotFound => {
            send_error(&ctx.tx, ErrorCode::EntryNotFound, "entry not found").await;
        }
        AdmitOutcome::NoRoom => {}
    }
}

pub async fn reject(state: &Arc<AppState>, ctx: &ConnContext, entry_id: EntryId) {
    let Some(slug) = ctx.slug.as_ref() else {
        return;
    };
    let Some(room) = state.room(slug) else {
        return;
    };

    let outcome = {
        let mut rs = room.write().await;
        if let Some(pos) = rs.lobby.iter().position(|e| e.id == entry_id) {
            let entry = rs.lobby.remove(pos);
            let student_tx = entry.conn.tx.clone();
            let updated = ServerMsg::LobbyState {
                entries: rs.lobby_view(),
            };
            Some((student_tx, updated))
        } else {
            None
        }
    };

    if let Some((student_tx, lobby_update)) = outcome {
        send(
            &student_tx,
            ServerMsg::Rejected {
                reason: "teacher_rejected".into(),
            },
        )
        .await;
        let _ = student_tx
            .send(PumpDirective::Close {
                code: 1000,
                reason: "teacher_rejected".into(),
            })
            .await;
        send(&ctx.tx, lobby_update).await;
    } else {
        send_error(&ctx.tx, ErrorCode::EntryNotFound, "entry not found").await;
    }
}

