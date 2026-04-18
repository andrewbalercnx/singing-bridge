// File: server/src/ws/mod.rs
// Purpose: WebSocket upgrade handler + per-connection driver. Strict Origin
//          check; slug-aware role resolution on first lobby message; clean
//          async teardown. Ban panic edges in the hot path.
// Role: The live end of signalling. Owns the pump-driven connection loop.
// Exports: ws_upgrade, resolve_peer_ip
// Depends: axum, tokio, state, protocol
// Invariants: no unwrap/expect in this module. Origin must match base_url.
//             Role is decided on the first LobbyJoin/LobbyWatch and immutable
//             thereafter. SessionMetrics rate-limited to 1 frame per 5 s.
//             loss_bp clamped to [0, 10000] before persist (100% = 10000 bp).
// Last updated: Sprint 7 (2026-04-18) -- Chat + LobbyMessage handlers

#![deny(clippy::unwrap_used, clippy::expect_used)]

pub mod connection;
pub mod lobby;
pub mod protocol;
pub mod rate_limit;
pub mod session;
pub mod session_log;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::Ordering;

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
use tokio::sync::mpsc;

use crate::auth::{magic_link::TeacherId, resolve_teacher_from_cookie};
use crate::config::Config;
use crate::state::{AppState, ConnectionId, RemovalKind, SlugKey};
use crate::ws::connection::ConnContext;
use crate::ws::protocol::{
    ClientMsg, EntryId, ErrorCode, PumpDirective, Role, ServerMsg, MAX_BROWSER_LEN,
    MAX_CHAT_BYTES, MAX_CHAT_CHARS, MAX_DEVICE_CLASS_LEN, MAX_EMAIL_LEN, MAX_SIGNAL_PAYLOAD_BYTES,
    MAX_TIER_REASON_BYTES,
};
use crate::ws::rate_limit::check_and_inc;
use crate::ws::session_log::{close_row, EndedReason};

/// Resolve the peer IP from request headers + socket address.
///
/// In prod (trust_forwarded_for=true): prefer `CF-Connecting-IP` (set by
/// Cloudflare), then fall back to the first token of `X-Forwarded-For`.
/// An unparse-able / missing header falls through to the socket addr.
///
/// In dev (trust_forwarded_for=false): always use the socket addr directly.
pub fn resolve_peer_ip(config: &Config, headers: &HeaderMap, addr: SocketAddr) -> IpAddr {
    if !config.trust_forwarded_for {
        return addr.ip();
    }
    // Prefer CF-Connecting-IP (Cloudflare rewrites this).
    if let Some(cf_ip) = headers
        .get("CF-Connecting-IP")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
    {
        return cf_ip;
    }
    // Fall through to X-Forwarded-For first token.
    if let Some(xff_ip) = headers
        .get("X-Forwarded-For")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
    {
        return xff_ip;
    }
    addr.ip()
}

pub async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
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

    let peer_ip = resolve_peer_ip(&state.config, &headers, addr);
    let candidate_teacher = resolve_teacher_from_cookie(&state.db, &headers).await;
    let state_for_conn = Arc::clone(&state);

    ws.on_upgrade(move |sock| async move {
        run(sock, state_for_conn, candidate_teacher, peer_ip).await;
    })
}

async fn run(
    sock: WebSocket,
    state: Arc<AppState>,
    candidate_teacher: Option<TeacherId>,
    peer_ip: IpAddr,
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
        peer_ip,
        last_metrics_at: None,
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
            tier,
            tier_reason,
        } => handle_lobby_join(ctx, state, slug, email, browser, device_class, tier, tier_reason).await,
        ClientMsg::LobbyWatch { slug } => handle_lobby_watch(ctx, state, slug).await,
        ClientMsg::LobbyAdmit { slug, entry_id } => {
            handle_lobby_admit(ctx, state, &slug, entry_id).await
        }
        ClientMsg::LobbyReject { slug, entry_id, block_ttl_secs } => {
            handle_lobby_reject(ctx, state, &slug, entry_id, block_ttl_secs).await
        }
        ClientMsg::SessionMetrics { loss_bp, rtt_ms } => {
            handle_session_metrics(ctx, state, loss_bp, rtt_ms).await
        }
        ClientMsg::Signal { to, payload } => handle_signal(ctx, state, to, payload).await,
        ClientMsg::RecordStart { slug } => handle_record_start(ctx, state, &slug).await,
        ClientMsg::RecordConsent { slug, granted } => {
            handle_record_consent(ctx, state, &slug, granted).await
        }
        ClientMsg::RecordStop { slug } => handle_record_stop(ctx, state, &slug).await,
        ClientMsg::Chat { text } => handle_chat(ctx, state, text).await,
        ClientMsg::LobbyMessage { entry_id, text } => {
            handle_lobby_message(ctx, state, entry_id, text).await
        }
    }
}

async fn handle_lobby_join(
    ctx: &mut ConnContext,
    state: &Arc<AppState>,
    slug: String,
    email: String,
    browser: String,
    device_class: String,
    tier: crate::ws::protocol::Tier,
    tier_reason: Option<String>,
) -> bool {
    if ctx.slug.is_some() {
        send_error(ctx, ErrorCode::AlreadyJoined, "already joined").await;
        return true;
    }
    if email.len() > MAX_EMAIL_LEN
        || browser.len() > MAX_BROWSER_LEN
        || device_class.len() > MAX_DEVICE_CLASS_LEN
        || tier_reason.as_deref().map_or(0, str::len) > MAX_TIER_REASON_BYTES
    {
        send_error(ctx, ErrorCode::FieldTooLong, "field too long").await;
        return true;
    }

    // Per-IP WS join rate limit — checked before slug DB lookup.
    {
        let now_unix = time::OffsetDateTime::now_utc().unix_timestamp();
        let over = check_and_inc(
            &*state.ws_join_rate_limits,
            ctx.peer_ip,
            state.config.ws_join_rate_limit_per_ip,
            state.config.ws_join_rate_limit_window_secs,
            now_unix,
        );
        if over {
            send_error(ctx, ErrorCode::RateLimited, "rate limited").await;
            let _ = ctx.tx.send(PumpDirective::Close { code: 1008, reason: "rate_limited".into() }).await;
            return false;
        }
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
    lobby::join_lobby(state, ctx, &key, ctx.peer_ip, email, browser, device_class, tier, tier_reason).await
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
    block_ttl_secs: Option<u32>,
) -> bool {
    if !require_joined(ctx, msg_slug).await {
        return true;
    }
    if ctx.role != Some(Role::Teacher) {
        send_error(ctx, ErrorCode::NotOwner, "teacher only").await;
        return true;
    }
    lobby::reject(state, ctx, entry_id, ctx.peer_ip, block_ttl_secs).await;
    true
}

async fn handle_session_metrics(
    ctx: &mut ConnContext,
    state: &Arc<AppState>,
    loss_bp: u16,
    rtt_ms: u16,
) -> bool {
    // Clamp to valid domain before persisting (malformed client input guard).
    let loss_bp = loss_bp.min(10_000); // 100% = 10_000 basis points

    // Rate-limit: 1 frame per 5 s per connection.
    let now = std::time::Instant::now();
    if let Some(last) = ctx.last_metrics_at {
        if now.duration_since(last).as_secs() < 5 {
            // Silently drop; don't close the connection.
            return true;
        }
    }
    ctx.last_metrics_at = Some(now);

    let Some(slug) = ctx.slug.as_ref() else {
        return true;
    };
    let Some(room) = state.room(slug) else {
        return true;
    };

    let (log_id, needs_persist) = {
        let rs = room.read().await;
        let Some(session) = rs.active_session.as_ref() else {
            return true;
        };
        // Accept metrics from either role (teacher metrics silently accepted).
        let is_student = session.student.conn.id == ctx.id;
        let is_teacher = rs.teacher_conn.as_ref().map(|c| c.id) == Some(ctx.id);
        if !is_student && !is_teacher {
            return true;
        }
        // Update atomic peaks (fetch_max = compare-and-swap loop).
        let _ = session.peak_loss_bp.fetch_max(loss_bp, Ordering::Relaxed);
        let _ = session.peak_rtt_ms.fetch_max(rtt_ms, Ordering::Relaxed);
        (session.log_id.clone(), true)
    };

    if needs_persist {
        if let Some(id) = log_id {
            if let Err(e) = crate::ws::session_log::record_peak(&state.db, &id, loss_bp, rtt_ms).await {
                tracing::warn!(error = %e, "session_log record_peak failed");
            }
        }
    }
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

async fn handle_record_start(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    msg_slug: &str,
) -> bool {
    if !require_joined(ctx, msg_slug).await {
        return true;
    }
    if ctx.role != Some(Role::Teacher) {
        send_error(ctx, ErrorCode::NotOwner, "teacher only").await;
        return true;
    }
    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let student_tx = {
        let mut rs = room.write().await;
        if rs.active_session.is_none() {
            drop(rs);
            send_error(ctx, ErrorCode::NotInSession, "no active session").await;
            return true;
        }
        if rs.recording_active || rs.consent_pending {
            drop(rs);
            send_error(ctx, ErrorCode::RecordAlreadyActive, "recording already active").await;
            return true;
        }
        rs.consent_pending = true;
        rs.active_session.as_ref().unwrap().student.conn.tx.clone()
    };

    let _ = student_tx
        .send(PumpDirective::Send(ServerMsg::RecordConsentRequest))
        .await;
    true
}

async fn handle_record_consent(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    msg_slug: &str,
    granted: bool,
) -> bool {
    if !require_joined(ctx, msg_slug).await {
        return true;
    }
    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let (teacher_tx_opt, student_tx_opt) = {
        let mut rs = room.write().await;
        let has_session = rs.active_session.is_some();
        if !has_session {
            drop(rs);
            send_error(ctx, ErrorCode::NotInSession, "no active session").await;
            return true;
        }
        let student_id = rs.active_session.as_ref().unwrap().student.conn.id;
        if student_id != ctx.id {
            drop(rs);
            send_error(ctx, ErrorCode::NotInSession, "not the session student").await;
            return true;
        }
        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let student_tx = rs.active_session.as_ref().map(|s| s.student.conn.tx.clone());
        rs.consent_pending = false;
        if granted {
            rs.recording_active = true;
        }
        (teacher_tx, student_tx)
    };

    if let Some(ttx) = teacher_tx_opt {
        let _ = ttx
            .send(PumpDirective::Send(ServerMsg::RecordConsentResult { granted }))
            .await;
        if granted {
            let _ = ttx.send(PumpDirective::Send(ServerMsg::RecordingActive)).await;
        }
    }
    if granted {
        if let Some(stx) = student_tx_opt {
            let _ = stx.send(PumpDirective::Send(ServerMsg::RecordingActive)).await;
        }
    }
    true
}

async fn handle_record_stop(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    msg_slug: &str,
) -> bool {
    if !require_joined(ctx, msg_slug).await {
        return true;
    }
    if ctx.role != Some(Role::Teacher) {
        send_error(ctx, ErrorCode::NotOwner, "teacher only").await;
        return true;
    }
    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let (teacher_tx, student_tx) = {
        let mut rs = room.write().await;
        // No-op if neither recording nor consent is active.
        if !rs.recording_active && !rs.consent_pending {
            return true;
        }
        rs.recording_active = false;
        rs.consent_pending = false;
        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let student_tx = rs.active_session.as_ref().map(|s| s.student.conn.tx.clone());
        (teacher_tx, student_tx)
    };

    if let Some(ttx) = teacher_tx {
        let _ = ttx.send(PumpDirective::Send(ServerMsg::RecordingStopped)).await;
    }
    if let Some(stx) = student_tx {
        let _ = stx.send(PumpDirective::Send(ServerMsg::RecordingStopped)).await;
    }
    true
}

async fn validate_chat_text(ctx: &ConnContext, text: &str) -> bool {
    if text.is_empty() {
        send_error(ctx, ErrorCode::PayloadTooLarge, "chat text must not be empty").await;
        return false;
    }
    if text.len() > MAX_CHAT_BYTES {
        send_error(ctx, ErrorCode::PayloadTooLarge, "chat text too long").await;
        return false;
    }
    if text.chars().count() > MAX_CHAT_CHARS {
        send_error(ctx, ErrorCode::PayloadTooLarge, "chat text too long").await;
        return false;
    }
    true
}

async fn handle_chat(ctx: &ConnContext, state: &Arc<AppState>, text: String) -> bool {
    if !validate_chat_text(ctx, &text).await {
        return true;
    }
    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let (sender_role, teacher_tx, student_tx) = {
        let rs = room.read().await;
        let Some(session) = rs.active_session.as_ref() else {
            drop(rs);
            send_error(ctx, ErrorCode::NotInSession, "no active session").await;
            return true;
        };
        let is_teacher = rs.teacher_conn.as_ref().map(|c| c.id) == Some(ctx.id);
        let is_student = session.student.conn.id == ctx.id;
        if !is_teacher && !is_student {
            drop(rs);
            send_error(ctx, ErrorCode::NotInSession, "not a session participant").await;
            return true;
        }
        let role = if is_teacher { Role::Teacher } else { Role::Student };
        let ttx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let stx = session.student.conn.tx.clone();
        (role, ttx, stx)
    };

    let msg = ServerMsg::Chat { from: sender_role, text };
    if let Some(ttx) = teacher_tx {
        let _ = ttx.send(PumpDirective::Send(msg.clone())).await;
    }
    let _ = student_tx.send(PumpDirective::Send(msg)).await;
    true
}

async fn handle_lobby_message(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    entry_id: EntryId,
    text: String,
) -> bool {
    if !validate_chat_text(ctx, &text).await {
        return true;
    }
    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let target_tx = {
        let rs = room.read().await;
        let is_teacher = rs.teacher_conn.as_ref().map(|c| c.id) == Some(ctx.id);
        if !is_teacher {
            drop(rs);
            send_error(ctx, ErrorCode::NotOwner, "teacher only").await;
            return true;
        }
        match rs.lobby.iter().find(|e| e.id == entry_id) {
            Some(entry) => entry.conn.tx.clone(),
            None => {
                drop(rs);
                send_error(ctx, ErrorCode::EntryNotFound, "entry not found").await;
                return true;
            }
        }
    };

    let _ = target_tx
        .send(PumpDirective::Send(ServerMsg::LobbyMessage { text }))
        .await;
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
    let (exit_kind, ended_reason) = match result {
        LoopExit::Normal => ("normal", EndedReason::Disconnect),
        LoopExit::ShuttingDown => ("shutdown", EndedReason::ServerShutdown),
    };
    tracing::debug!(exit = %exit_kind, conn = ctx.id.0, "ws exit");

    // Close session log row if this connection held an active session.
    if let Some(slug) = ctx.slug.clone() {
        if let Some(room) = state.room(&slug) {
            let log_id = {
                let rs = room.read().await;
                rs.active_session.as_ref().and_then(|s| {
                    let is_student = s.student.conn.id == ctx.id;
                    let is_teacher = rs.teacher_conn.as_ref().map(|c| c.id) == Some(ctx.id);
                    if is_student || is_teacher {
                        s.log_id.clone()
                    } else {
                        None
                    }
                })
            };
            if let Some(id) = log_id {
                let ended_at = time::OffsetDateTime::now_utc().unix_timestamp();
                if let Err(e) = close_row(&state.db, &id, ended_at, ended_reason).await {
                    tracing::warn!(error = %e, "session_log close_row failed");
                }
            }

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
                        // Teacher disconnect: reset recording state, notify student.
                        rs.consent_pending = false;
                        if rs.recording_active {
                            rs.recording_active = false;
                            if let Some(student_tx) =
                                rs.active_session.as_ref().map(|s| s.student.conn.tx.clone())
                            {
                                outbound.push((student_tx, ServerMsg::RecordingStopped));
                            }
                        }
                    } else {
                        match rs.remove_by_connection(ctx.id) {
                            Some(RemovalKind::FromActiveSession) => {
                                // Student disconnect: reset recording state, notify teacher.
                                rs.consent_pending = false;
                                if rs.recording_active {
                                    rs.recording_active = false;
                                    if let Some(teacher_tx) =
                                        rs.teacher_conn.as_ref().map(|c| c.tx.clone())
                                    {
                                        outbound.push((teacher_tx.clone(), ServerMsg::RecordingStopped));
                                        outbound.push((teacher_tx, ServerMsg::PeerDisconnected));
                                    }
                                } else if let Some(teacher_tx) =
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    fn make_config(trust: bool) -> Config {
        let mut c = Config::dev_default();
        c.trust_forwarded_for = trust;
        c
    }

    fn addr(ip: &str) -> SocketAddr {
        format!("{ip}:12345").parse().unwrap()
    }

    fn headers_with(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn dev_mode_uses_socket_addr() {
        let c = make_config(false);
        let h = headers_with(&[("CF-Connecting-IP", "1.2.3.4")]);
        let ip = resolve_peer_ip(&c, &h, addr("10.0.0.1"));
        assert_eq!(ip.to_string(), "10.0.0.1");
    }

    #[test]
    fn prod_prefers_cf_connecting_ip() {
        let c = make_config(true);
        let h = headers_with(&[
            ("CF-Connecting-IP", "1.2.3.4"),
            ("X-Forwarded-For", "5.6.7.8"),
        ]);
        let ip = resolve_peer_ip(&c, &h, addr("10.0.0.1"));
        assert_eq!(ip.to_string(), "1.2.3.4");
    }

    #[test]
    fn prod_falls_back_to_xff() {
        let c = make_config(true);
        let h = headers_with(&[("X-Forwarded-For", "5.6.7.8, 9.10.11.12")]);
        let ip = resolve_peer_ip(&c, &h, addr("10.0.0.1"));
        assert_eq!(ip.to_string(), "5.6.7.8");
    }

    #[test]
    fn malformed_cf_header_falls_back_to_xff() {
        let c = make_config(true);
        let h = headers_with(&[
            ("CF-Connecting-IP", "not-an-ip"),
            ("X-Forwarded-For", "5.6.7.8"),
        ]);
        let ip = resolve_peer_ip(&c, &h, addr("10.0.0.1"));
        assert_eq!(ip.to_string(), "5.6.7.8");
    }

    #[test]
    fn malformed_cf_and_xff_falls_back_to_socket() {
        let c = make_config(true);
        let h = headers_with(&[
            ("CF-Connecting-IP", "bad"),
            ("X-Forwarded-For", "also-bad"),
        ]);
        let ip = resolve_peer_ip(&c, &h, addr("10.0.0.1"));
        assert_eq!(ip.to_string(), "10.0.0.1");
    }
}
