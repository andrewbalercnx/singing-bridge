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
use crate::ws::protocol::{EntryId, ErrorCode, PumpDirective, Role, ServerMsg, Tier, MAX_TIER_REASON_CHARS};

/// Truncate to at most `max_chars` *characters*. Plain
/// `String::truncate` is byte-based and panics on a non-char-boundary
/// byte. This helper walks `char_indices()` exactly `max_chars + 1`
/// times to find the byte offset of the (max_chars)-th codepoint —
/// that offset is guaranteed to be a valid char boundary, so the
/// in-place `String::truncate` call is safe. One pass, no new
/// allocation unless the caller passes ownership of an already-short
/// string. Regression fixture in `server/tests/ws_lobby_tier.rs` uses
/// a 3-byte codepoint placed so that a naive byte truncation would
/// split inside the codepoint.
pub(crate) fn truncate_to_chars(mut s: String, max_chars: usize) -> String {
    if let Some((byte_idx, _)) = s.char_indices().nth(max_chars) {
        s.truncate(byte_idx);
    }
    s
}

#[cfg(test)]
mod truncate_tests {
    use super::truncate_to_chars;

    #[test]
    fn ascii_shorter_than_cap_passes_through() {
        let s = "hello".to_string();
        assert_eq!(truncate_to_chars(s, 200), "hello");
    }

    #[test]
    fn ascii_at_exact_cap_passes_through() {
        let s = "x".repeat(200);
        let out = truncate_to_chars(s.clone(), 200);
        assert_eq!(out, s);
        assert_eq!(out.chars().count(), 200);
    }

    #[test]
    fn ascii_over_cap_is_cut_at_cap() {
        let s = "y".repeat(201);
        let out = truncate_to_chars(s, 200);
        assert_eq!(out.chars().count(), 200);
    }

    #[test]
    fn multibyte_at_boundary_is_preserved() {
        // 199 ASCII + 1 three-byte codepoint = 200 chars, 202 bytes.
        // Adding one more char makes 201 chars / 203 bytes. The cap
        // must land right after the 3-byte codepoint, not inside it.
        let mut s = "a".repeat(199);
        s.push('中');
        s.push('b');
        assert_eq!(s.chars().count(), 201);
        let out = truncate_to_chars(s, 200);
        assert_eq!(out.chars().count(), 200);
        assert!(out.ends_with('中'), "multibyte codepoint should be intact at cut");
    }

    #[test]
    fn zero_cap_returns_empty() {
        assert_eq!(truncate_to_chars("abc".to_string(), 0), "");
    }

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(truncate_to_chars(String::new(), 200), "");
    }
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
            tier_reason: tier_reason.map(|r| truncate_to_chars(r, MAX_TIER_REASON_CHARS)),
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

