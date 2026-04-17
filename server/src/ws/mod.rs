// File: server/src/ws/mod.rs
// Purpose: WebSocket upgrade handler + per-connection driver. Strict Origin
//          check; slug-aware role resolution on first lobby message; clean
//          async teardown. Ban panic edges in the hot path.
// Role: The live end of signalling. Owns the pump-driven connection loop.
// Exports: ws_upgrade
// Depends: axum, tokio, state, protocol
// Invariants: no unwrap/expect in this module. Origin must match base_url.
//             Role is decided on the first LobbyJoin/LobbyWatch and immutable
//             thereafter.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

#![deny(clippy::unwrap_used, clippy::expect_used)]

pub mod connection;
pub mod lobby;
pub mod protocol;
pub mod session;

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::stream::StreamExt;
use futures_util::sink::SinkExt;
use std::net::SocketAddr;
use tokio::sync::mpsc;

use crate::auth::{magic_link::TeacherId, resolve_teacher_from_cookie};
use crate::state::{AppState, ConnectionId, RemovalKind, SlugKey};
use crate::ws::connection::ConnContext;
use crate::ws::protocol::{
    ClientMsg, ErrorCode, PumpDirective, Role, ServerMsg, MAX_BROWSER_LEN, MAX_DEVICE_CLASS_LEN,
    MAX_EMAIL_LEN, MAX_SIGNAL_PAYLOAD_BYTES,
};

pub async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    ConnectInfo(_addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response {
    // Origin must match base_url.origin() (R1 finding #3).
    let expected_origin = state.config.base_url.origin().ascii_serialization();
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|o| o == expected_origin)
        .unwrap_or(false);
    if !origin_ok {
        return (StatusCode::FORBIDDEN, "bad origin").into_response();
    }

    let candidate_teacher = resolve_teacher_from_cookie(&state.db, &headers).await;
    let state_for_conn = Arc::clone(&state);

    ws.on_upgrade(move |sock| async move {
        run(sock, state_for_conn, candidate_teacher).await;
    })
}

async fn run(
    sock: WebSocket,
    state: Arc<AppState>,
    candidate_teacher: Option<TeacherId>,
) {
    let (mut ws_tx, mut ws_rx) = sock.split();
    let (tx, mut rx) = mpsc::channel::<PumpDirective>(64);

    // Pump — the sole writer of the WebSocket.
    let pump = tokio::spawn(async move {
        while let Some(directive) = rx.recv().await {
            match directive {
                PumpDirective::Send(msg) => match serde_json::to_string(&msg) {
                    Ok(s) => {
                        if ws_tx.send(Message::Text(s)).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                PumpDirective::Close { code, reason } => {
                    let _ = ws_tx
                        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            }
        }
    });

    let conn_id = ConnectionId::new();
    let mut ctx = ConnContext {
        id: conn_id,
        candidate_teacher_id: candidate_teacher,
        slug: None,
        role: None,
        tx,
        pump,
    };

    // Inbound loop, select'd against shutdown.
    let result = inbound_loop(&mut ws_rx, &mut ctx, &state).await;

    cleanup(&state, ctx, result).await;
}

pub(crate) enum LoopExit {
    Normal,
    ShuttingDown,
}

async fn inbound_loop(
    ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
    ctx: &mut ConnContext,
    state: &Arc<AppState>,
) -> LoopExit {
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => {
                // Shutdown path: server_shutdown message then close.
                let _ = ctx.tx.send(PumpDirective::Send(ServerMsg::ServerShutdown)).await;
                let _ = ctx.tx.send(PumpDirective::Close {
                    code: 1012,
                    reason: "server_restart".into(),
                }).await;
                return LoopExit::ShuttingDown;
            }
            frame = ws_rx.next() => {
                match frame {
                    None => return LoopExit::Normal,
                    Some(Err(_)) => return LoopExit::Normal,
                    Some(Ok(Message::Close(_))) => return LoopExit::Normal,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(Message::Binary(_))) => {
                        close_malformed(ctx, "binary_not_supported").await;
                        return LoopExit::Normal;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > crate::ws::protocol::MAX_FRAME_BYTES {
                            let _ = ctx.tx.send(PumpDirective::Close { code: 1009, reason: "frame_too_large".into() }).await;
                            return LoopExit::Normal;
                        }
                        let msg: Result<ClientMsg, _> = serde_json::from_str(&text);
                        let Ok(msg) = msg else {
                            close_malformed(ctx, "malformed_message").await;
                            return LoopExit::Normal;
                        };
                        if !handle_client_msg(ctx, state, msg).await {
                            return LoopExit::Normal;
                        }
                    }
                }
            }
        }
    }
}

async fn close_malformed(ctx: &ConnContext, reason: &'static str) {
    let _ = ctx
        .tx
        .send(PumpDirective::Close {
            code: 1008,
            reason: reason.into(),
        })
        .await;
}

async fn send_error(ctx: &ConnContext, code: ErrorCode, message: impl Into<String>) {
    pump_send_error(&ctx.tx, code, message).await;
}

/// Shared helper used by lobby, session, and the dispatcher so the error
/// shape is built in one place.
pub(crate) async fn pump_send_error(
    tx: &mpsc::Sender<PumpDirective>,
    code: ErrorCode,
    message: impl Into<String>,
) {
    let _ = tx
        .send(PumpDirective::Send(ServerMsg::Error {
            code,
            message: message.into(),
        }))
        .await;
}

/// Returns false to terminate the loop.
async fn handle_client_msg(
    ctx: &mut ConnContext,
    state: &Arc<AppState>,
    msg: ClientMsg,
) -> bool {
    match msg {
        ClientMsg::LobbyJoin {
            slug,
            email,
            browser,
            device_class,
        } => handle_lobby_join(ctx, state, slug, email, browser, device_class).await,
        ClientMsg::LobbyWatch { slug } => handle_lobby_watch(ctx, state, slug).await,
        ClientMsg::LobbyAdmit { slug, entry_id } => {
            handle_lobby_admit(ctx, state, &slug, entry_id).await
        }
        ClientMsg::LobbyReject { slug, entry_id } => {
            handle_lobby_reject(ctx, state, &slug, entry_id).await
        }
        ClientMsg::Signal { to, payload } => handle_signal(ctx, state, to, payload).await,
    }
}

async fn handle_lobby_join(
    ctx: &mut ConnContext,
    state: &Arc<AppState>,
    slug: String,
    email: String,
    browser: String,
    device_class: String,
) -> bool {
    if ctx.slug.is_some() {
        send_error(ctx, ErrorCode::AlreadyJoined, "already joined").await;
        return true;
    }
    if email.len() > MAX_EMAIL_LEN
        || browser.len() > MAX_BROWSER_LEN
        || device_class.len() > MAX_DEVICE_CLASS_LEN
    {
        send_error(ctx, ErrorCode::FieldTooLong, "field too long").await;
        return true;
    }
    let Some(key) = parse_slug_or_err(ctx, &slug).await else {
        return true;
    };
    if !slug_exists(state, &key).await {
        send_error(ctx, ErrorCode::NotOwner, "no such room").await;
        return true;
    }
    ctx.slug = Some(key.clone());
    ctx.role = Some(Role::Student);
    lobby::join_lobby(state, ctx, &key, email, browser, device_class).await
}

async fn handle_lobby_watch(ctx: &mut ConnContext, state: &Arc<AppState>, slug: String) -> bool {
    if ctx.slug.is_some() {
        send_error(ctx, ErrorCode::AlreadyJoined, "already joined").await;
        return true;
    }
    let Some(key) = parse_slug_or_err(ctx, &slug).await else {
        return true;
    };
    if !owns_slug(state, ctx.candidate_teacher_id, &key).await {
        send_error(ctx, ErrorCode::NotOwner, "not slug owner").await;
        let _ = ctx
            .tx
            .send(PumpDirective::Close {
                code: 1008,
                reason: "not_slug_owner".into(),
            })
            .await;
        return false;
    }
    ctx.slug = Some(key.clone());
    ctx.role = Some(Role::Teacher);
    lobby::watch_lobby(state, ctx, &key).await
}

async fn handle_lobby_admit(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    msg_slug: &str,
    entry_id: crate::ws::protocol::EntryId,
) -> bool {
    if !require_joined(ctx, msg_slug).await {
        return true;
    }
    if ctx.role != Some(Role::Teacher) {
        send_error(ctx, ErrorCode::NotOwner, "teacher only").await;
        return true;
    }
    lobby::admit(state, ctx, entry_id).await;
    true
}

async fn handle_lobby_reject(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    msg_slug: &str,
    entry_id: crate::ws::protocol::EntryId,
) -> bool {
    if !require_joined(ctx, msg_slug).await {
        return true;
    }
    if ctx.role != Some(Role::Teacher) {
        send_error(ctx, ErrorCode::NotOwner, "teacher only").await;
        return true;
    }
    lobby::reject(state, ctx, entry_id).await;
    true
}

async fn handle_signal(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    to: Role,
    payload: serde_json::Value,
) -> bool {
    let payload_len = serde_json::to_vec(&payload)
        .map(|v| v.len())
        .unwrap_or(usize::MAX);
    if payload_len > MAX_SIGNAL_PAYLOAD_BYTES {
        send_error(ctx, ErrorCode::PayloadTooLarge, "payload > 16 KiB").await;
        return true;
    }
    session::relay(state, ctx, to, payload).await;
    true
}

async fn parse_slug_or_err(ctx: &ConnContext, raw: &str) -> Option<SlugKey> {
    match SlugKey::new(raw) {
        Ok(k) => Some(k),
        Err(_) => {
            send_error(ctx, ErrorCode::SlugInvalid, "slug invalid").await;
            None
        }
    }
}

async fn require_joined(ctx: &ConnContext, msg_slug: &str) -> bool {
    let Some(current) = &ctx.slug else {
        let _ = ctx
            .tx
            .send(PumpDirective::Close {
                code: 1008,
                reason: "first_message_must_join_or_watch".into(),
            })
            .await;
        return false;
    };
    // Slug field on subsequent messages must match the connection-bound slug.
    let Ok(parsed) = SlugKey::new(msg_slug) else {
        send_error(ctx, ErrorCode::InvalidRoute, "slug mismatch").await;
        return false;
    };
    if parsed != *current {
        send_error(ctx, ErrorCode::InvalidRoute, "slug mismatch").await;
        return false;
    }
    true
}

async fn slug_exists(state: &AppState, slug: &SlugKey) -> bool {
    let count: (i64,) = match sqlx::query_as("SELECT COUNT(*) FROM teachers WHERE slug = ?")
        .bind(slug.as_str())
        .fetch_one(&state.db)
        .await
    {
        Ok(v) => v,
        Err(_) => return false,
    };
    count.0 > 0
}

async fn owns_slug(state: &AppState, teacher_id: Option<i64>, slug: &SlugKey) -> bool {
    let Some(tid) = teacher_id else { return false };
    let row: Result<(i64,), sqlx::Error> =
        sqlx::query_as("SELECT COUNT(*) FROM teachers WHERE id = ? AND slug = ?")
            .bind(tid)
            .bind(slug.as_str())
            .fetch_one(&state.db)
            .await;
    matches!(row, Ok((n,)) if n > 0)
}

async fn cleanup(state: &AppState, mut ctx: ConnContext, result: LoopExit) {
    // Shutdown path already enqueued ServerShutdown + Close into the pump;
    // normal exit is a peer-initiated disconnect. Room-state cleanup runs
    // the same way in both cases.
    let exit_kind = match result {
        LoopExit::Normal => "normal",
        LoopExit::ShuttingDown => "shutdown",
    };
    tracing::debug!(exit = %exit_kind, conn = ctx.id.0, "ws exit");
    if let Some(slug) = ctx.slug.clone() {
        if let Some(room) = state.room(&slug) {
            // Collect up to two messages to send to the teacher after the
            // lock is released.
            let mut outbound: Vec<(mpsc::Sender<PumpDirective>, ServerMsg)> = Vec::new();

            {
                let mut rs = room.write().await;
                if let Some(role) = ctx.role {
                    if role == Role::Teacher
                        && rs.teacher_conn.as_ref().map(|c| c.id) == Some(ctx.id)
                    {
                        rs.teacher_conn = None;
                    } else {
                        match rs.remove_by_connection(ctx.id) {
                            Some(RemovalKind::FromActiveSession) => {
                                if let Some(teacher_tx) =
                                    rs.teacher_conn.as_ref().map(|c| c.tx.clone())
                                {
                                    outbound.push((teacher_tx, ServerMsg::PeerDisconnected));
                                }
                            }
                            Some(RemovalKind::FromLobby) => {
                                if let Some(teacher_tx) =
                                    rs.teacher_conn.as_ref().map(|c| c.tx.clone())
                                {
                                    outbound.push((
                                        teacher_tx,
                                        ServerMsg::LobbyState {
                                            entries: rs.lobby_view(),
                                        },
                                    ));
                                }
                            }
                            None => {}
                        }
                    }
                }
            }

            for (tx, msg) in outbound {
                let _ = tx.send(PumpDirective::Send(msg)).await;
            }
        }
    }

    drop(ctx.tx);

    match tokio::time::timeout(std::time::Duration::from_secs(2), &mut ctx.pump).await {
        Ok(_) => {}
        Err(_) => {
            ctx.pump.abort();
            let _ = (&mut ctx.pump).await;
        }
    }
}
