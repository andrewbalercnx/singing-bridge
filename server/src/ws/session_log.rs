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
// Last updated: Sprint 5 (2026-04-18) -- initial implementation, R1 fixes

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::auth::magic_link::TeacherId;
use crate::error::Result;
use crate::ws::protocol::Tier;

/// Compile-time fallback pepper used in dev/test so callers don't need
/// to provision a secret. Never used when `SB_SESSION_LOG_PEPPER` is set.
pub const DEV_PEPPER: &[u8] = b"dev-session-log-pepper-INSECURE-CONSTANT";

/// Opaque session log row identifier. Inner UUID is private to prevent
/// callers from constructing arbitrary IDs.
#[derive(Clone, Debug)]
pub struct SessionLogId(Uuid);

impl SessionLogId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    fn as_bytes(&self) -> Vec<u8> {
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
    fn as_str(self) -> &'static str {
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
    pool: &SqlitePool,
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
         VALUES (?, ?, ?, ?, ?, ?, ?)",
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
    pool: &SqlitePool,
    id: &SessionLogId,
    loss_bp: u16,
    rtt_ms: u16,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_log \
         SET peak_loss_bp = MAX(peak_loss_bp, ?), peak_rtt_ms = MAX(peak_rtt_ms, ?) \
         WHERE id = ? AND ended_at IS NULL",
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
/// duration_secs = MAX(0, ended_at - started_at) prevents negative values
/// from clock skew.
pub async fn close_row(
    pool: &SqlitePool,
    id: &SessionLogId,
    ended_at: i64,
    reason: EndedReason,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_log \
         SET ended_at = ?, \
             duration_secs = MAX(0, ? - started_at), \
             ended_reason = ? \
         WHERE id = ? AND ended_at IS NULL",
    )
    .bind(ended_at)
    .bind(ended_at)
    .bind(reason.as_str())
    .bind(id.as_bytes())
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn make_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        // Insert a teacher so foreign key constraints are satisfied.
        sqlx::query("INSERT INTO teachers (id, email, slug, created_at) VALUES (1, 'teacher@test.com', 'testslug', 0)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn sample_hash() -> [u8; 32] {
        hash_email("student@example.com", DEV_PEPPER)
    }

    #[tokio::test]
    async fn open_row_creates_row_with_null_ended_at() {
        let pool = make_pool().await;
        let id = SessionLogId::new();
        open_row(&pool, &id, 1, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000).await.unwrap();
        let row: (Option<i64>,) = sqlx::query_as("SELECT ended_at FROM session_log WHERE id = ?")
            .bind(id.as_bytes())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(row.0.is_none());
    }

    #[tokio::test]
    async fn close_row_sets_ended_at_and_duration() {
        let pool = make_pool().await;
        let id = SessionLogId::new();
        open_row(&pool, &id, 1, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000).await.unwrap();
        close_row(&pool, &id, 1060, EndedReason::Hangup).await.unwrap();
        let row: (Option<i64>, Option<i64>, Option<String>) =
            sqlx::query_as("SELECT ended_at, duration_secs, ended_reason FROM session_log WHERE id = ?")
                .bind(id.as_bytes())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, Some(1060));
        assert_eq!(row.1, Some(60)); // MAX(0, 1060 - 1000)
        assert_eq!(row.2.as_deref(), Some("hangup"));
    }

    #[tokio::test]
    async fn duration_secs_never_negative() {
        let pool = make_pool().await;
        let id = SessionLogId::new();
        // ended_at < started_at (clock skew) → duration = 0
        open_row(&pool, &id, 1, &sample_hash(), "Chrome/99", "mobile", Tier::Degraded, 1000).await.unwrap();
        close_row(&pool, &id, 999, EndedReason::Disconnect).await.unwrap();
        let row: (Option<i64>,) =
            sqlx::query_as("SELECT duration_secs FROM session_log WHERE id = ?")
                .bind(id.as_bytes())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, Some(0));
    }

    #[tokio::test]
    async fn close_row_is_idempotent() {
        let pool = make_pool().await;
        let id = SessionLogId::new();
        open_row(&pool, &id, 1, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000).await.unwrap();
        close_row(&pool, &id, 1060, EndedReason::Hangup).await.unwrap();
        // Second call should not change ended_at (first-writer-wins).
        close_row(&pool, &id, 9999, EndedReason::Disconnect).await.unwrap();
        let row: (Option<i64>,) = sqlx::query_as("SELECT ended_at FROM session_log WHERE id = ?")
            .bind(id.as_bytes())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, Some(1060)); // first close wins
    }

    #[tokio::test]
    async fn record_peak_updates_high_watermark() {
        let pool = make_pool().await;
        let id = SessionLogId::new();
        open_row(&pool, &id, 1, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000).await.unwrap();
        record_peak(&pool, &id, 200, 50).await.unwrap();
        record_peak(&pool, &id, 100, 80).await.unwrap(); // lower loss, higher rtt
        let row: (i32, i32) =
            sqlx::query_as("SELECT peak_loss_bp, peak_rtt_ms FROM session_log WHERE id = ?")
                .bind(id.as_bytes())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, 200);
        assert_eq!(row.1, 80);
    }

    #[tokio::test]
    async fn record_peak_noop_on_missing_row() {
        let pool = make_pool().await;
        let id = SessionLogId::new(); // no open_row
        // Should not error
        record_peak(&pool, &id, 500, 100).await.unwrap();
    }

    #[tokio::test]
    async fn hash_email_no_plaintext() {
        let hash = hash_email("student@example.com", DEV_PEPPER);
        let hex_hash = hex::encode(hash);
        assert!(!hex_hash.contains("student"));
        assert!(!hex_hash.contains("example"));
    }

    #[tokio::test]
    async fn session_log_no_plaintext_email_or_ip() {
        let pool = make_pool().await;
        let id = SessionLogId::new();
        let email = "noshow@secret.com";
        let hash = hash_email(email, DEV_PEPPER);
        open_row(&pool, &id, 1, &hash, "Firefox/99", "desktop", Tier::Supported, 1000).await.unwrap();
        record_peak(&pool, &id, 100, 50).await.unwrap();
        close_row(&pool, &id, 1060, EndedReason::Hangup).await.unwrap();

        // Scan all text columns for raw email or an IP pattern.
        let rows: Vec<(Option<String>, String, String, String, Option<String>)> =
            sqlx::query_as(
                "SELECT ended_reason, browser, device_class, tier, ended_reason FROM session_log",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
        for (a, b, c, d, e) in &rows {
            for col in [a.as_deref().unwrap_or(""), b.as_str(), c.as_str(), d.as_str(), e.as_deref().unwrap_or("")] {
                assert!(!col.contains("noshow"), "found email in column: {col}");
                assert!(!col.contains("secret.com"), "found email in column: {col}");
            }
        }
    }
}
