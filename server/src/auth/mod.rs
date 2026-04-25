// File: server/src/auth/mod.rs
// Purpose: Session cookie extractor + helper for turning a valid cookie into
//          a `TeacherId`, plus re-exports of the auth submodules.
// Role: One module gate for auth-adjacent helpers.
// Exports: SessionCookie, resolve_teacher_from_cookie, issue_session_cookie,
//          SESSION_COOKIE_NAME, magic_link, slug, mailer, rate_limit, secret, password
// Depends: sqlx, axum, cookie, sha2
// Invariants: raw cookie never stored; sessions.expires_at > now is always
//             checked before trusting the cookie.
// Last updated: Sprint 10 (2026-04-21) -- password module

pub mod magic_link;
pub mod mailer;
pub mod password;
pub mod rate_limit;
pub mod secret;
pub mod slug;

use axum::http::HeaderMap;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::error::Result;

pub const SESSION_COOKIE_NAME: &str = "sb_session";

pub fn cookie_hash(raw: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    h.finalize().to_vec()
}

fn random_cookie_hex() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Insert a new row in `sessions` and return the raw cookie value the
/// browser should carry.
pub async fn issue_session_cookie(
    pool: &PgPool,
    teacher_id: magic_link::TeacherId,
    ttl_secs: i64,
) -> Result<String> {
    let raw = random_cookie_hex();
    let hash = cookie_hash(&raw);
    let issued = time::OffsetDateTime::now_utc().unix_timestamp();
    let expires = issued + ttl_secs;
    sqlx::query(
        "INSERT INTO sessions (cookie_hash, teacher_id, issued_at, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(&hash)
    .bind(teacher_id)
    .bind(issued)
    .bind(expires)
    .execute(pool)
    .await?;
    Ok(raw)
}

/// Parse cookies from a header map, look up the session, and return the
/// owning teacher_id only if the cookie is known and not expired. Any
/// missing / invalid / expired cookie returns None (never an error), so
/// callers never branch on cookie-validity disclosure.
pub async fn resolve_teacher_from_cookie(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Option<magic_link::TeacherId> {
    let raw = extract_cookie_value(headers, SESSION_COOKIE_NAME)?;
    let hash = cookie_hash(&raw);
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    match sqlx::query_as::<_, (magic_link::TeacherId,)>(
        "SELECT teacher_id FROM sessions WHERE cookie_hash = $1 AND expires_at > $2",
    )
    .bind(&hash)
    .bind(now)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.map(|(tid,)| tid),
        Err(e) => {
            // Log the failure — an unauth'd response is the safe fallback,
            // but silent DB errors would hide outages.
            tracing::error!(error = %e, "sessions lookup failed");
            None
        }
    }
}

pub fn extract_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    for h in headers.get_all(axum::http::header::COOKIE) {
        let Ok(s) = h.to_str() else { continue };
        for part in s.split(';') {
            let part = part.trim();
            let Ok(c) = cookie::Cookie::parse(part) else {
                continue;
            };
            if c.name() == name {
                return Some(c.value().to_string());
            }
        }
    }
    None
}
