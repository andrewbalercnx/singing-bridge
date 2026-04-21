// File: server/src/auth/password.rs
// Purpose: Argon2id password hashing, verification, DUMMY_PHC for constant-time
//          login, and login-attempt recording + rate-limit enforcement.
// Role: All credential-validation logic for the password-auth flow.
// Exports: hash_password_with_params, hash_password, verify_password, DUMMY_PHC,
//          record_and_check_limits, LimitConfig, LimitResult
// Depends: argon2, once_cell, sqlx, tokio
// Invariants: DUMMY_PHC is runtime-derived (never a compile-time literal) so its
//             Argon2 params always match production. verify_password returns bool
//             (never Err) — all failures are false. record_and_check_limits
//             always INSERTs before checking limits so DB cost is symmetric across
//             known and unknown email paths.
// Last updated: Sprint 10 (2026-04-21) -- initial implementation

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use once_cell::sync::Lazy;
use sqlx::SqlitePool;

use crate::auth::magic_link::TeacherId;
use crate::error::Result;

/// Runtime-derived dummy PHC. Initialized on first use with production Argon2
/// params. Used when no teacher row exists (or has a NULL hash) so the caller
/// always performs a full Argon2 verify regardless of whether the account exists.
pub(crate) static DUMMY_PHC: Lazy<String> = Lazy::new(|| {
    hash_password_with_params(
        "",
        Params::new(19456, 2, 1, None).expect("valid production params"),
    )
    .expect("DUMMY_PHC derivation must not fail")
});

/// Synchronous hash helper parameterized by caller-supplied Params.
/// Production code calls `hash_password()` instead (async, spawn_blocking).
/// This is `pub` so test fixtures in `server/tests/` can call it with cheap
/// params without any runtime config flag.
pub fn hash_password_with_params(raw: &str, params: Params) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let hash = argon2
        .hash_password(raw.as_bytes(), &salt)
        .map_err(|e| crate::error::AppError::Internal(format!("argon2 hash: {e}").into()))?
        .to_string();
    Ok(hash)
}

/// Async public API. Runs Argon2 in a blocking thread pool.
/// Callers must not call hash_password_with_params directly in async context.
pub async fn hash_password(raw: &str) -> Result<String> {
    let raw = raw.to_owned();
    tokio::task::spawn_blocking(move || {
        hash_password_with_params(
            &raw,
            Params::new(19456, 2, 1, None).expect("valid production params"),
        )
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(format!("spawn_blocking: {e}").into()))?
}

/// Constant-time verify. Returns false on any failure — never an error.
pub fn verify_password(raw: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(raw.as_bytes(), &parsed)
        .is_ok()
}

pub struct LimitConfig {
    pub account_window_secs: i64,
    pub account_max_failures: u32,
    pub ip_window_secs: i64,
    pub ip_max_attempts: u32,
}

pub enum LimitResult {
    Allow,
    IpThrottled,
    AccountLocked,
}

/// Record the attempt then evaluate IP + account limits in a single transaction.
/// Always inserts (teacher_id may be None for unknown-email) before checking.
/// Uses BEGIN IMMEDIATE because the single-connection SQLite pool serialises
/// writers anyway, but the explicit transaction ensures INSERT + COUNT are atomic.
pub async fn record_and_check_limits(
    pool: &SqlitePool,
    teacher_id: Option<TeacherId>,
    peer_ip: &str,
    cfg: &LimitConfig,
) -> Result<LimitResult> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO login_attempts (teacher_id, peer_ip, attempted_at, succeeded) VALUES (?, ?, ?, 0)",
    )
    .bind(teacher_id)
    .bind(peer_ip)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let ip_cutoff = now - cfg.ip_window_secs;
    let (ip_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM login_attempts WHERE peer_ip = ? AND attempted_at > ?")
            .bind(peer_ip)
            .bind(ip_cutoff)
            .fetch_one(&mut *tx)
            .await?;

    if ip_count >= cfg.ip_max_attempts as i64 {
        tx.commit().await?;
        return Ok(LimitResult::IpThrottled);
    }

    if let Some(tid) = teacher_id {
        let account_cutoff = now - cfg.account_window_secs;
        let last_success: Option<(i64,)> = sqlx::query_as(
            "SELECT MAX(attempted_at) FROM login_attempts WHERE teacher_id = ? AND succeeded = 1",
        )
        .bind(tid)
        .fetch_optional(&mut *tx)
        .await?;
        let last_success_ts = last_success.and_then(|(t,)| Some(t)).unwrap_or(0);
        let failure_since = last_success_ts.max(account_cutoff);

        let (failure_count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM login_attempts WHERE teacher_id = ? AND succeeded = 0 AND attempted_at > ?",
        )
        .bind(tid)
        .bind(failure_since)
        .fetch_one(&mut *tx)
        .await?;

        if failure_count >= cfg.account_max_failures as i64 {
            tx.commit().await?;
            return Ok(LimitResult::AccountLocked);
        }
    }

    tx.commit().await?;
    Ok(LimitResult::Allow)
}
