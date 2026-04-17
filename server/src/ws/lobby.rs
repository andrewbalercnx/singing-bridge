// File: server/src/ws/lobby.rs
// Purpose: Lobby state transitions — join, watch, admit, reject. All mutate
//          RoomState under a single `write().await` scope; no `.await`
//          inside the guard except collecting data.
// Role: The admission workflow described in §4.7.
// Exports: join_lobby, watch_lobby, admit, reject
// Depends: tokio, state, protocol
// Invariants: ≤ 1 teacher_conn, ≤ 1 active_session, LobbyEntry placement is
//             XOR between lobby and active_session.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::sync::Arc;
use std::time::Instant;

use tokio::sync::mpsc;

use crate::state::{ActiveSession, AppState, ClientHandle, LobbyEntry, SlugKey};
use crate::ws::connection::ConnContext;
use crate::ws::protocol::{EntryId, ErrorCode, PumpDirective, Role, ServerMsg};

async fn send(tx: &mpsc::Sender<PumpDirective>, msg: ServerMsg) {
    let _ = tx.send(PumpDirective::Send(msg)).await;
}

async fn send_error(
    tx: &mpsc::Sender<PumpDirective>,
    code: ErrorCode,
    message: impl Into<String>,
) {
    send(
        tx,
        ServerMsg::Error {
            code,
            message: message.into(),
        },
    )
    .await;
}

pub async fn join_lobby(
    state: &Arc<AppState>,
    ctx: &ConnContext,
    slug: &SlugKey,
    email: String,
    browser: String,
    device_class: String,
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

pub async fn admit(state: &Arc<AppState>, ctx: &ConnContext, entry_id: EntryId) {
    let Some(slug) = ctx.slug.as_ref() else {
        return;
    };
    let Some(room) = state.room(slug) else {
        return;
    };

    let outcome = {
        let mut rs = room.write().await;
        if rs.active_session.is_some() {
            None::<(mpsc::Sender<PumpDirective>, ServerMsg, Vec<LobbyEntryViewOut>)>
        } else if let Some(pos) = rs.lobby.iter().position(|e| e.id == entry_id) {
            let entry = rs.lobby.swap_remove(pos);
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
            let updated_lobby = rs
                .lobby_view()
                .into_iter()
                .map(|v| LobbyEntryViewOut(v))
                .collect();
            Some((
                student_tx,
                ServerMsg::Admitted { entry_id },
                updated_lobby,
            ))
        } else {
            send_error_sync(&ctx.tx, ErrorCode::EntryNotFound, "entry not found");
            None
        }
    };

    match outcome {
        None if ctx.role == Some(Role::Teacher) => {
            // Either session-in-progress or entry-not-found. Entry-not-found
            // already buffered via send_error_sync; detect session-in-progress
            // by re-checking.
            let rs = room.read().await;
            if rs.active_session.is_some() {
                drop(rs);
                send_error(&ctx.tx, ErrorCode::SessionInProgress, "session in progress").await;
            }
        }
        Some((student_tx, admitted_msg, updated_lobby)) => {
            send(&student_tx, admitted_msg).await;
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
            send(
                &ctx.tx,
                ServerMsg::LobbyState {
                    entries: updated_lobby.into_iter().map(|v| v.0).collect(),
                },
            )
            .await;
        }
        None => {}
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
            let entry = rs.lobby.swap_remove(pos);
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

// Non-async helper that queues an error via try_send; used inside a lock
// region only when we want to avoid an await. Falls back silently if the
// channel is full, which here means the caller's own channel is saturated
// and they will be torn down anyway.
fn send_error_sync(tx: &mpsc::Sender<PumpDirective>, code: ErrorCode, message: &str) {
    let _ = tx.try_send(PumpDirective::Send(ServerMsg::Error {
        code,
        message: message.into(),
    }));
}

// Wrapper to keep the `outcome` tuple typed consistently across the `if let`
// arms without naming a long LobbyEntryView path in the match scrutinee.
struct LobbyEntryViewOut(crate::ws::protocol::LobbyEntryView);
