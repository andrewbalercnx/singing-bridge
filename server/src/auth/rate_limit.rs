// File: server/src/auth/rate_limit.rs
// Purpose: Per-email and per-IP signup rate limiting via signup_attempts table.
// Role: Guards POST /signup against easy abuse.
// Exports: check_and_record
// Depends: sqlx
// Invariants: records ALL attempts (successful + rate-limited), so concurrent
//             races cannot exceed the cap by more than N+1.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use sqlx::{Executor, SqlitePool};

use crate::error::{AppError, Result};

pub struct Limits {
    pub per_email: usize,
    pub per_ip: usize,
    pub window_secs: i64,
}

/// Atomic count-and-insert: the whole operation runs inside a
/// `BEGIN IMMEDIATE` transaction so concurrent signups cannot
/// observe each other's counts before they hit the DB (R1 code-
/// review finding #49 — resolves the TOCTOU in the previous
/// non-transactional check-then-insert).
pub async fn check_and_record(
    pool: &SqlitePool,
    email: &str,
    peer_ip: &str,
    limits: &Limits,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let since = now - limits.window_secs;

    let mut conn = pool.acquire().await?;
    conn.execute("BEGIN IMMEDIATE").await?;

    let email_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signup_attempts WHERE email = ? AND attempted_at > ?",
    )
    .bind(email)
    .bind(since)
    .fetch_one(&mut *conn)
    .await?;
    let ip_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signup_attempts WHERE peer_ip = ? AND attempted_at > ?",
    )
    .bind(peer_ip)
    .bind(since)
    .fetch_one(&mut *conn)
    .await?;

    let over_email = email_count.0 as usize >= limits.per_email;
    let over_ip = ip_count.0 as usize >= limits.per_ip;

    // Always insert a record — rate-limited attempts count toward the same
    // window so a client hammering us cannot reset their own counter by
    // succeeding once.
    sqlx::query("INSERT INTO signup_attempts (email, peer_ip, attempted_at) VALUES (?, ?, ?)")
        .bind(email)
        .bind(peer_ip)
        .bind(now)
        .execute(&mut *conn)
        .await?;

    // If any of the queries above returned an error, the `?` unwound
    // before this COMMIT ran and the connection drops with the
    // transaction still open — sqlx then issues an implicit ROLLBACK
    // when the connection is returned to the pool. That's the safety
    // net for the error path; the happy path commits explicitly here.
    conn.execute("COMMIT").await?;

    if over_email || over_ip {
        return Err(AppError::TooManyRequests);
    }
    Ok(())
}
