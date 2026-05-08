// File: server/src/ws/session_log.rs
// Purpose: Session-log persistence — open, record_peak, close per admitted session.
// Role: All session-log DB writes flow through this module; no raw PII stored.
// Exports: SessionLogId, EndedReason, open_row, record_peak, close_row,
//          hash_email, DEV_PEPPER
// Depends: sqlx, sha2, hex, uuid
// Invariants: student_email_hash is sha256(lower(email) || pepper); 32 bytes; no
//             raw email or IP is persisted. close_row is first-writer-wins
//             (WHERE ended_at IS NULL), so concurrent calls are safe.
//             record_peak is a no-op if the row is missing or already closed.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; $N placeholders

use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::magic_link::TeacherId;
use crate::error::Result;
use crate::ws::protocol::Tier;

/// Compile-time fallback pepper used in dev/test so callers don't need
/// to provision a secret. Never used when `SB_SESSION_LOG_PEPPER` is set.
pub const DEV_PEPPER: &[u8] = b"dev-session-log-pepper-INSECURE-CONSTANT";

/// Opaque session log row identifier. Inner UUID is private to prevent
/// callers from constructing arbitrary IDs.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionLogId(Uuid);

impl SessionLogId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_bytes(&self) -> Vec<u8> {
        self.0.as_bytes().to_vec()
    }
}

impl Default for SessionLogId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug)]
pub enum EndedReason {
    Hangup,
    FloorViolation,
    Disconnect,
    Blocked,
    ServerShutdown,
}

impl EndedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndedReason::Hangup => "hangup",
            EndedReason::FloorViolation => "floor_violation",
            EndedReason::Disconnect => "disconnect",
            EndedReason::Blocked => "blocked",
            EndedReason::ServerShutdown => "server_shutdown",
        }
    }
}

/// Hash an email address with the given pepper.
/// Returns sha256(lower(email) || pepper).
pub fn hash_email(email: &str, pepper: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(email.to_ascii_lowercase().as_bytes());
    h.update(pepper);
    h.finalize().into()
}

pub async fn open_row(
    pool: &PgPool,
    id: &SessionLogId,
    teacher_id: TeacherId,
    email_hash: &[u8; 32],
    browser: &str,
    device_class: &str,
    tier: Tier,
    started_at: i64,
) -> Result<()> {
    let tier_str = match tier {
        Tier::Supported => "supported",
        Tier::Degraded => "degraded",
        Tier::Unworkable => "unworkable",
    };
    sqlx::query(
        "INSERT INTO session_log \
         (id, teacher_id, student_email_hash, browser, device_class, tier, started_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id.as_bytes())
    .bind(teacher_id)
    .bind(email_hash.as_slice())
    .bind(browser)
    .bind(device_class)
    .bind(tier_str)
    .bind(started_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Update the peak metrics for a session row. No-op if the row is missing or
/// already closed — the WHERE clause naturally matches nothing.
pub async fn record_peak(
    pool: &PgPool,
    id: &SessionLogId,
    loss_bp: u16,
    rtt_ms: u16,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_log \
         SET peak_loss_bp = GREATEST(peak_loss_bp, $1), peak_rtt_ms = GREATEST(peak_rtt_ms, $2) \
         WHERE id = $3 AND ended_at IS NULL",
    )
    .bind(loss_bp as i32)
    .bind(rtt_ms as i32)
    .bind(id.as_bytes())
    .execute(pool)
    .await?;
    Ok(())
}

/// Close a session row. First-writer-wins: if ended_at is already set
/// (concurrent close), the update matches zero rows and returns Ok.
/// duration_secs = GREATEST(0, ended_at - started_at) prevents negative values
/// from clock skew.
pub async fn close_row(
    pool: &PgPool,
    id: &SessionLogId,
    ended_at: i64,
    reason: EndedReason,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_log \
         SET ended_at = $1, \
             duration_secs = GREATEST(0, $2 - started_at), \
             ended_reason = $3 \
         WHERE id = $4 AND ended_at IS NULL",
    )
    .bind(ended_at)
    .bind(ended_at)
    .bind(reason.as_str())
    .bind(id.as_bytes())
    .execute(pool)
    .await?;
    Ok(())
}

