// File: server/src/auth/magic_link.rs
// Purpose: Issue + consume magic-link tokens. Single-use enforcement is a
//          single atomic UPDATE so concurrent consume races resolve with
//          exactly one winner.
// Role: Back-end of the /signup → /auth/consume flow.
// Exports: issue, consume, invalidate_pending, hash_token, TeacherId
// Depends: sqlx, sha2, rand, hex
// Invariants: raw tokens never persisted; storage holds sha256(raw). Consume
//             atomically checks consumed_at IS NULL AND expires_at > now.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::error::{AppError, Result};

pub type TeacherId = i64;

pub struct IssuedLink {
    pub raw_token: String,
    pub expires_at: i64,
}

pub fn hash_token(raw: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    h.finalize().to_vec()
}

fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn random_token_hex() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub async fn issue(pool: &PgPool, teacher_id: TeacherId, ttl_secs: i64) -> Result<IssuedLink> {
    let raw = random_token_hex();
    let hash = hash_token(&raw);
    let issued = now_unix();
    let expires = issued + ttl_secs;

    sqlx::query(
        "INSERT INTO magic_links (token_hash, teacher_id, issued_at, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(&hash)
    .bind(teacher_id)
    .bind(issued)
    .bind(expires)
    .execute(pool)
    .await?;

    Ok(IssuedLink {
        raw_token: raw,
        expires_at: expires,
    })
}

/// Invalidate all unconsumed magic links for a teacher. Used on re-signup.
pub async fn invalidate_pending(pool: &PgPool, teacher_id: TeacherId) -> Result<()> {
    let now = now_unix();
    sqlx::query(
        "UPDATE magic_links SET consumed_at = $1 WHERE teacher_id = $2 AND consumed_at IS NULL",
    )
    .bind(now)
    .bind(teacher_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomically mark a token consumed. Returns the teacher_id of the owner,
/// or `Err(BadRequest)` if the token is unknown, expired, or already consumed.
pub async fn consume(pool: &PgPool, raw: &str) -> Result<TeacherId> {
    let hash = hash_token(raw);
    let now = now_unix();

    let row: Option<(TeacherId,)> = sqlx::query_as(
        "UPDATE magic_links
         SET consumed_at = $1
         WHERE token_hash = $2 AND consumed_at IS NULL AND expires_at > $3
         RETURNING teacher_id",
    )
    .bind(now)
    .bind(&hash)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    match row {
        Some((teacher_id,)) => Ok(teacher_id),
        None => Err(AppError::BadRequest("invalid or expired token".into())),
    }
}
