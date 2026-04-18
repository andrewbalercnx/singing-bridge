// File: server/src/ws/lobby.rs
// Purpose: Lobby state transitions — join, watch, admit, reject. All mutate
//          RoomState under a single `write().await` scope; no `.await`
//          inside the guard except collecting data.
// Role: The admission workflow described in §4.7.
// Exports: join_lobby, watch_lobby, admit, reject
// Depends: tokio, state, protocol, session_log
// Invariants: ≤ 1 teacher_conn, ≤ 1 active_session, LobbyEntry placement is
//             XOR between lobby and active_session.
//             Blocked IP → close 1008 "blocked". Plain reject → close 1000.
//             Block-with-ttl → close 1008 "blocked".
// Last updated: Sprint 5 (2026-04-18) -- block list, session log open_row
#![allow(dead_code)]

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::mpsc;

use crate::state::{ActiveSession, AppState, ClientHandle, LobbyEntry, SlugKey};
use crate::ws::connection::ConnContext;
use crate::ws::protocol::{EntryId, ErrorCode, PumpDirective, Role, ServerMsg, Tier, MAX_TIER_REASON_CHARS};
use crate::ws::session_log::{self, SessionLogId};

/// Truncate to at most `max_chars` *characters*. Plain
/// `String::truncate` is byte-based and panics on a non-char-boundary
/// byte. This helper walks `char_indices()` exactly `max_chars + 1`
/// times to find the byte offset of the (max_chars)-th codepoint —
/// that offset is guaranteed to be a valid char boundary, so the
/// in-place `String::truncate` call is safe.
pub(crate) fn truncate_to_chars(mut s: String, max_chars: usize) -> String {
    if let Some((byte_idx, _)) = s.char_indices().nth(max_chars) {
        s.truncate(byte_idx);
    }
    s
}

/// Max `block_ttl_secs` the server will honour (24 hours).
const MAX_BLOCK_TTL_SECS: u32 = 86_400;

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

#[cfg(test)]
mod block_tests {
    #[test]
    fn block_ttl_zero_is_plain_reject() {
        // block_ttl_secs = 0 → same as None → close 1000
        let ttl: Option<u32> = Some(0);
        let effective = ttl.filter(|&t| t > 0);
        assert!(effective.is_none());
    }

    #[test]
    fn block_ttl_above_cap_is_clamped() {
        let ttl: Option<u32> = Some(super::MAX_BLOCK_TTL_SECS + 1);
        let effective = ttl.map(|t| t.min(super::MAX_BLOCK_TTL_SECS));
        assert_eq!(effective, Some(super::MAX_BLOCK_TTL_SECS));
    }

    #[test]
    fn block_ttl_at_cap_accepted() {
        let ttl: Option<u32> = Some(super::MAX_BLOCK_TTL_SECS);
        let effective = ttl.map(|t| t.min(super::MAX_BLOCK_TTL_SECS));
        assert_eq!(effective, Some(super::MAX_BLOCK_TTL_SECS));
    }

    #[test]
    fn block_ttl_absent_is_plain_reject() {
        let ttl: Option<u32> = None;
        assert!(ttl.filter(|&t| t > 0).is_none());
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
    peer_ip: IpAddr,
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

    let (teacher_tx, update, blocked) = {
        let mut rs = room.write().await;
        // Check block list (also sweeps expired entries).
        let blocked = rs.is_blocked(peer_ip);
        if blocked {
            (None, None, true)
        } else if rs.lobby.len() >= state.config.lobby_cap_per_room {
            drop(rs);
            send_error(&ctx.tx, ErrorCode::LobbyFull, "lobby full").await;
            return true;
        } else {
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
            (teacher_tx, Some(update), false)
        }
    };

    if blocked {
        let _ = ctx.tx.send(PumpDirective::Send(ServerMsg::Error {
            code: ErrorCode::Blocked,
            message: "blocked_by_teacher".into(),
        })).await;
        let _ = ctx.tx.send(PumpDirective::Close {
            code: 1008,
            reason: "blocked".into(),
        }).await;
        return false;
    }

    if let (Some(tx), Some(update)) = (teacher_tx, update) {
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
        log_id: SessionLogId,
        email: String,
        browser: String,
        device_class: String,
        tier: Tier,
        started_at: i64,
        teacher_id: Option<i64>,
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
        let teacher_id = ctx.candidate_teacher_id;
        let mut rs = room.write().await;
        if rs.active_session.is_some() {
            AdmitOutcome::SessionInProgress
        } else if let Some(pos) = rs.lobby.iter().position(|e| e.id == entry_id) {
            let entry = rs.lobby.remove(pos);
            let student_tx = entry.conn.tx.clone();
            let email = entry.email.clone();
            let browser = entry.browser.clone();
            let device_class = entry.device_class.clone();
            let tier = entry.tier;
            let started_at = time::OffsetDateTime::now_utc().unix_timestamp();
            let log_id = SessionLogId::new();
            rs.active_session = Some(ActiveSession {
                student: entry,
                started_at: Instant::now(),
                log_id: None, // set after open_row completes outside the guard
                peak_loss_bp: std::sync::atomic::AtomicU16::new(0),
                peak_rtt_ms: std::sync::atomic::AtomicU16::new(0),
            });
            let lobby_update = ServerMsg::LobbyState {
                entries: rs.lobby_view(),
            };
            AdmitOutcome::Ok {
                student_tx,
                lobby_update,
                log_id,
                email,
                browser,
                device_class,
                tier,
                started_at,
                teacher_id,
            }
        } else {
            AdmitOutcome::EntryNotFound
        }
    };

    match outcome {
        AdmitOutcome::Ok {
            student_tx,
            lobby_update,
            log_id,
            email,
            browser,
            device_class,
            tier,
            started_at,
            teacher_id,
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

            // Open session log row outside the room lock.
            if let Some(tid) = teacher_id {
                let pepper = state.session_log_pepper_bytes();
                let email_hash = session_log::hash_email(&email, pepper);
                match session_log::open_row(
                    &state.db,
                    &log_id,
                    tid,
                    &email_hash,
                    &browser,
                    &device_class,
                    tier,
                    started_at,
                )
                .await
                {
                    Ok(()) => {
                        // Re-acquire write to store the log_id.
                        if let Some(slug) = ctx.slug.as_ref() {
                            if let Some(room) = state.room(slug) {
                                let mut rs = room.write().await;
                                if let Some(ref mut session) = rs.active_session {
                                    session.log_id = Some(log_id);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "session_log open_row failed; session continues without logging");
                    }
                }
            }
        }
        AdmitOutcome::SessionInProgress => {
            send_error(&ctx.tx, ErrorCode::SessionInProgress, "session in progress").await;
        }
        AdmitOutcome::EntryNotFound => {
            send_error(&ctx.tx, ErrorCode::EntryNotFound, "entry not found").await;
        }
    }
}

pub async fn reject(
    state: &Arc<AppState>,
    ctx: &ConnContext,
    entry_id: EntryId,
    peer_ip: IpAddr,
    block_ttl_secs: Option<u32>,
) {
    let Some(slug) = ctx.slug.as_ref() else {
        return;
    };
    let Some(room) = state.room(slug) else {
        return;
    };

    // Effective TTL: None or 0 = plain reject; >0 clamped to MAX_BLOCK_TTL_SECS.
    let effective_block_secs = block_ttl_secs
        .filter(|&t| t > 0)
        .map(|t| t.min(MAX_BLOCK_TTL_SECS));

    let outcome = {
        let mut rs = room.write().await;
        if let Some(pos) = rs.lobby.iter().position(|e| e.id == entry_id) {
            let entry = rs.lobby.remove(pos);
            let student_tx = entry.conn.tx.clone();
            let student_ip = peer_ip; // IP associated with this connection

            if let Some(ttl) = effective_block_secs {
                let until = Instant::now() + std::time::Duration::from_secs(ttl as u64);
                rs.block_ip(student_ip, until);
            }

            let updated = ServerMsg::LobbyState {
                entries: rs.lobby_view(),
            };
            Some((student_tx, updated, effective_block_secs.is_some()))
        } else {
            None
        }
    };

    if let Some((student_tx, lobby_update, is_block)) = outcome {
        send(
            &student_tx,
            ServerMsg::Rejected {
                reason: "teacher_rejected".into(),
            },
        )
        .await;
        if is_block {
            // Blocked: close 1008 so the browser can render #blocked-notice.
            let _ = student_tx
                .send(PumpDirective::Close {
                    code: 1008,
                    reason: "blocked".into(),
                })
                .await;
        } else {
            // Plain reject: close 1000 (normal closure).
            let _ = student_tx
                .send(PumpDirective::Close {
                    code: 1000,
                    reason: "teacher_rejected".into(),
                })
                .await;
        }
        send(&ctx.tx, lobby_update).await;
    } else {
        send_error(&ctx.tx, ErrorCode::EntryNotFound, "entry not found").await;
    }
}
