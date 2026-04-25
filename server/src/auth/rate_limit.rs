// File: server/src/auth/rate_limit.rs
// Purpose: Per-email and per-IP signup rate limiting via signup_attempts table.
// Role: Guards POST /signup against easy abuse.
// Exports: check_and_record
// Depends: sqlx
// Invariants: INSERT runs before SELECT COUNT so each transaction observes its
//             own attempt in the count, tightening the concurrent-request race
//             window (R1 finding #35). All attempts are recorded regardless of
//             outcome so a client cannot reset its counter by hammering the endpoint.
// Last updated: Sprint 19 (2026-04-25) -- INSERT-before-COUNT tightens TOCTOU window

use sqlx::PgPool;

use crate::error::{AppError, Result};

pub struct Limits {
    pub per_email: usize,
    pub per_ip: usize,
    pub window_secs: i64,
}

/// Record the attempt first, then count — every transaction observes its own
/// INSERT in the subsequent COUNT, so the race window is reduced to the case
/// where two concurrent transactions both INSERT before either commits. Under
/// the default READ COMMITTED isolation this window remains narrow; a hard
/// uniqueness constraint on teacher email (enforced by PostgreSQL) prevents
/// duplicate accounts even if concurrent signups slip through.
pub async fn check_and_record(
    pool: &PgPool,
    email: &str,
    peer_ip: &str,
    limits: &Limits,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let since = now - limits.window_secs;

    let mut tx = pool.begin().await?;

    // INSERT first so the following COUNT includes this attempt.
    sqlx::query("INSERT INTO signup_attempts (email, peer_ip, attempted_at) VALUES ($1, $2, $3)")
        .bind(email)
        .bind(peer_ip)
        .bind(now)
        .execute(&mut *tx)
        .await?;

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

    tx.commit().await?;

    // Count includes the just-inserted row, so threshold is per_* + 1.
    if email_count.0 as usize > limits.per_email || ip_count.0 as usize > limits.per_ip {
        return Err(AppError::TooManyRequests);
    }
    Ok(())
}
