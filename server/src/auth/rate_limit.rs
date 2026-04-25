// File: server/src/auth/rate_limit.rs
// Purpose: Per-email and per-IP signup rate limiting via signup_attempts table.
// Role: Guards POST /signup against easy abuse.
// Exports: check_and_record
// Depends: sqlx
// Invariants: records ALL attempts (successful + rate-limited), so concurrent
//             races cannot exceed the cap by more than N+1.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; pool.begin() replaces BEGIN IMMEDIATE

use sqlx::PgPool;

use crate::error::{AppError, Result};

pub struct Limits {
    pub per_email: usize,
    pub per_ip: usize,
    pub window_secs: i64,
}

/// Atomic count-and-insert: the whole operation runs inside a transaction
/// so concurrent signups cannot observe each other's counts before they hit
/// the DB (R1 code-review finding #49 — resolves the TOCTOU in the previous
/// non-transactional check-then-insert).
pub async fn check_and_record(
    pool: &PgPool,
    email: &str,
    peer_ip: &str,
    limits: &Limits,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let since = now - limits.window_secs;

    let mut tx = pool.begin().await?;

    let email_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signup_attempts WHERE email = $1 AND attempted_at > $2",
    )
    .bind(email)
    .bind(since)
    .fetch_one(&mut *tx)
    .await?;
    let ip_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signup_attempts WHERE peer_ip = $1 AND attempted_at > $2",
    )
    .bind(peer_ip)
    .bind(since)
    .fetch_one(&mut *tx)
    .await?;

    let over_email = email_count.0 as usize >= limits.per_email;
    let over_ip = ip_count.0 as usize >= limits.per_ip;

    // Always insert a record — rate-limited attempts count toward the same
    // window so a client hammering us cannot reset their own counter by
    // succeeding once.
    sqlx::query("INSERT INTO signup_attempts (email, peer_ip, attempted_at) VALUES ($1, $2, $3)")
        .bind(email)
        .bind(peer_ip)
        .bind(now)
        .execute(&mut *tx)
        .await?;

    // If any of the queries above returned an error, the `?` unwound
    // before this commit ran and sqlx issues an implicit ROLLBACK when
    // the transaction is dropped. The happy path commits explicitly here.
    tx.commit().await?;

    if over_email || over_ip {
        return Err(AppError::TooManyRequests);
    }
    Ok(())
}
