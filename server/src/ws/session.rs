// File: server/src/ws/session.rs
// Purpose: Signal relay inside an active session.
// Role: One short file; all authorisation is server-resolved role checks.
// Exports: relay
// Depends: state, protocol
// Invariants: sender must be part of active_session; `to != sender_role`;
//             payload has already been size-capped by the caller.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::state::AppState;
use crate::ws::connection::ConnContext;
use crate::ws::protocol::{ErrorCode, PumpDirective, Role, ServerMsg};

pub async fn relay(
    state: &Arc<AppState>,
    ctx: &ConnContext,
    to: Role,
    payload: serde_json::Value,
) {
    let Some(slug) = ctx.slug.as_ref() else {
        return;
    };
    let Some(sender_role) = ctx.role else {
        return;
    };
    if to == sender_role {
        send_error(&ctx.tx, ErrorCode::InvalidRoute, "self-addressed").await;
        return;
    }
    let Some(room) = state.room(slug) else {
        return;
    };

    let (peer_tx, from) = {
        let rs = room.read().await;
        let active = match &rs.active_session {
            Some(a) => a,
            None => {
                drop(rs);
                send_error(&ctx.tx, ErrorCode::NotInSession, "no active session").await;
                return;
            }
        };
        let (peer_tx, from) = match sender_role {
            Role::Teacher => {
                if rs.teacher_conn.as_ref().map(|c| c.id) != Some(ctx.id) {
                    drop(rs);
                    send_error(&ctx.tx, ErrorCode::NotInSession, "not in session").await;
                    return;
                }
                (active.student.conn.tx.clone(), Role::Teacher)
            }
            Role::Student => {
                if active.student.conn.id != ctx.id {
                    drop(rs);
                    send_error(&ctx.tx, ErrorCode::NotInSession, "not in session").await;
                    return;
                }
                let Some(teacher) = rs.teacher_conn.as_ref() else {
                    drop(rs);
                    send_error(&ctx.tx, ErrorCode::NotInSession, "no teacher").await;
                    return;
                };
                (teacher.tx.clone(), Role::Student)
            }
        };
        (peer_tx, from)
    };

    let _ = peer_tx
        .send(PumpDirective::Send(ServerMsg::Signal { from, payload }))
        .await;
}

async fn send_error(
    tx: &mpsc::Sender<PumpDirective>,
    code: ErrorCode,
    message: impl Into<String>,
) {
    super::pump_send_error(tx, code, message).await;
}
