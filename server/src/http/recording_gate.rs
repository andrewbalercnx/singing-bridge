// File: server/src/http/recording_gate.rs
// Purpose: Student recording access gate — email verification, token lockout.
// Role: No-account low-friction recording access: student enters their email
//       to unlock a time-limited recording link.
// Exports: get_recording_page, post_verify
// Depends: axum, sqlx, sha2, subtle, time
// Invariants: Token must be exactly 64 lowercase hex characters; other formats → 404.
//             Two-control rate limiting: per-IP (recording_gate_attempts) checked first,
//             per-token lockout (failed_attempts >= 3) checked second.
//             Email comparison uses constant-time comparison (subtle::ConstantTimeEq).
//             accessed_at is set on first successful verify and is immutable thereafter.
//             Per-IP limit: gate_rate_limit_per_ip attempts per gate_rate_limit_window_secs.
// Last updated: Sprint 6 (2026-04-18) -- initial implementation

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{header, HeaderMap, HeaderValue},
    response::{Html, IntoResponse, Json, Response},
    Json as JsonBody,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::{AppError, Result};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /recording/:token — serve the gate page
// ---------------------------------------------------------------------------

pub async fn get_recording_page(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Response> {
    // Validate token format: must be exactly 64 lowercase hex chars.
    if !is_valid_token(&token) {
        return Err(AppError::NotFound);
    }

    let html_path = state.config.static_dir.join("recording.html");
    let html = tokio::fs::read_to_string(&html_path).await?;
    let mut resp = Html(html).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(resp)
}

// ---------------------------------------------------------------------------
// POST /recording/:token/verify — check email, return blob URL
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct VerifyBody {
    pub email: String,
}

#[derive(Serialize)]
pub struct VerifyResponse {
    pub url: String,
}

pub async fn post_verify(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(token): Path<String>,
    JsonBody(body): JsonBody<VerifyBody>,
) -> Result<Response> {
    if !is_valid_token(&token) {
        return Err(AppError::NotFound);
    }

    let peer_ip = crate::ws::resolve_peer_ip(&state.config, &headers, addr);
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Decode token and compute hash before acquiring the transaction.
    let token_bytes = match hex::decode(&token) {
        Ok(b) => b,
        Err(_) => return Err(AppError::NotFound),
    };
    let token_hash: Vec<u8> = {
        let mut h = Sha256::new();
        h.update(&token_bytes);
        h.finalize().to_vec()
    };
    let provided_hash: Vec<u8> = {
        let mut h = Sha256::new();
        h.update(body.email.trim().to_lowercase().as_bytes());
        h.finalize().to_vec()
    };

    // Begin exclusive transaction to make rate-limit check + attempt log + verify atomic.
    let mut tx = state.db.begin().await?;

    // Per-IP rate limit: check recent attempts in the window.
    let window_start = now - state.config.gate_rate_limit_window_secs;
    let (ip_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM recording_gate_attempts WHERE peer_ip = ? AND attempted_at > ?",
    )
    .bind(peer_ip.to_string())
    .bind(window_start)
    .fetch_one(&mut *tx)
    .await?;

    if ip_count >= state.config.gate_rate_limit_per_ip as i64 {
        return Err(AppError::TooManyRequests);
    }

    // Record this attempt (before checking token, to prevent enumeration timing).
    sqlx::query(
        "INSERT INTO recording_gate_attempts (peer_ip, attempted_at) VALUES (?, ?)",
    )
    .bind(peer_ip.to_string())
    .bind(now)
    .execute(&mut *tx)
    .await?;

    // Look up recording by token hash (not deleted).
    let row: Option<(i64, Vec<u8>, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, student_email_hash, blob_key, failed_attempts
         FROM recordings
         WHERE token_hash = ? AND deleted_at IS NULL",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?;

    let (id, stored_email_hash, blob_key, failed_attempts) =
        match row {
            Some(r) => r,
            None => return Err(AppError::NotFound),
        };

    // Per-token lockout: reject if already at 3 failures.
    if failed_attempts >= 3 {
        return Err(AppError::Forbidden);
    }

    // Constant-time email comparison.
    let email_match = stored_email_hash.as_slice().ct_eq(provided_hash.as_slice()).unwrap_u8() == 1;

    if !email_match {
        let new_attempts = failed_attempts + 1;
        sqlx::query("UPDATE recordings SET failed_attempts = ? WHERE id = ?")
            .bind(new_attempts)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        if new_attempts >= 3 {
            notify_teacher_token_disabled(&state, id).await;
            return Err(AppError::Forbidden);
        }
        return Err(AppError::Unauthorized);
    }

    // Email matches. Set accessed_at on first successful verify.
    sqlx::query(
        "UPDATE recordings SET accessed_at = CASE WHEN accessed_at IS NULL THEN ? ELSE accessed_at END WHERE id = ?",
    )
    .bind(now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Return blob URL.
    let blob_key = blob_key.ok_or(AppError::NotFound)?;
    let url = state
        .blob
        .get_url(&blob_key, &state.config.base_url)
        .await
        .map_err(|_| AppError::NotFound)?;

    Ok(Json(VerifyResponse { url: url.to_string() }).into_response())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

async fn notify_teacher_token_disabled(state: &AppState, recording_id: i64) {
    // Best-effort: look up teacher email + slug and send notification.
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT t.email, t.slug FROM recordings r
         JOIN teachers t ON t.id = r.teacher_id
         WHERE r.id = ?",
    )
    .bind(recording_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    if let Some((teacher_email, slug)) = row {
        let notify_url = state
            .config
            .base_url
            .join(&format!("teach/{slug}/recordings"))
            .unwrap_or_else(|_| state.config.base_url.clone());
        if let Err(e) = state
            .mailer
            .send_recording_link(&teacher_email, &notify_url)
            .await
        {
            tracing::warn!(error = %e, recording_id, "failed to notify teacher of disabled token");
        }
    }
}
