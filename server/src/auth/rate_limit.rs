// File: server/src/auth/rate_limit.rs
// Purpose: Per-email and per-IP signup rate limiting via signup_attempts table.
// Role: Guards POST /signup against easy abuse.
// Exports: check_and_record
// Depends: sqlx
// Invariants: records ALL attempts (successful + rate-limited), so concurrent
//             races cannot exceed the cap by more than N+1.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use sqlx::SqlitePool;

use crate::error::{AppError, Result};

pub struct Limits {
    pub per_email: usize,
    pub per_ip: usize,
    pub window_secs: i64,
}

pub async fn check_and_record(
    pool: &SqlitePool,
    email: &str,
    peer_ip: &str,
    limits: &Limits,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let since = now - limits.window_secs;

    let (email_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signup_attempts WHERE email = ? AND attempted_at > ?",
    )
    .bind(email)
    .bind(since)
    .fetch_one(pool)
    .await?;

    let (ip_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signup_attempts WHERE peer_ip = ? AND attempted_at > ?",
    )
    .bind(peer_ip)
    .bind(since)
    .fetch_one(pool)
    .await?;

    sqlx::query("INSERT INTO signup_attempts (email, peer_ip, attempted_at) VALUES (?, ?, ?)")
        .bind(email)
        .bind(peer_ip)
        .bind(now)
        .execute(pool)
        .await?;

    if email_count as usize >= limits.per_email || ip_count as usize >= limits.per_ip {
        return Err(AppError::TooManyRequests);
    }
    Ok(())
}
