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
    http::{header, HeaderMap, HeaderValue, StatusCode},
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

pub(crate) async fn get_recording_page(
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
pub(crate) struct VerifyBody {
    email: String,
}

#[derive(Serialize)]
pub(crate) struct VerifyResponse {
    url: String,
}

pub(crate) async fn post_verify(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(token): Path<String>,
    JsonBody(body): JsonBody<VerifyBody>,
) -> Result<Response> {
    if !is_valid_token(&token) {
        return Err(AppError::NotFound);
    }

    // In production (trust_forwarded_for=true), CF-Connecting-IP is mandatory; no XFF fallback.
    let peer_ip = if state.config.trust_forwarded_for {
        headers
            .get("CF-Connecting-IP")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
            .ok_or_else(|| AppError::BadRequest("missing CF-Connecting-IP header".into()))?
    } else {
        addr.ip()
    };
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

    // Per-IP rate limit: check recent attempts in the window (read-only, no transaction needed).
    let window_start = now - state.config.gate_rate_limit_window_secs;
    let (ip_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM recording_gate_attempts WHERE peer_ip = $1 AND attempted_at > $2",
    )
    .bind(peer_ip.to_string())
    .bind(window_start)
    .fetch_one(&state.db)
    .await?;

    if ip_count >= state.config.gate_rate_limit_per_ip as i64 {
        return Err(AppError::TooManyRequests);
    }

    // Record this attempt outside any transaction so it persists even when token is
    // not found or already locked — prevents enumeration via attempt-log rollback.
    sqlx::query(
        "INSERT INTO recording_gate_attempts (peer_ip, attempted_at) VALUES ($1, $2)",
    )
    .bind(peer_ip.to_string())
    .bind(now)
    .execute(&state.db)
    .await?;

    // Begin transaction for the atomic failed_attempts read-modify-write only.
    let mut tx = state.db.begin().await?;

    // Look up recording by token hash (not deleted).
    let row: Option<(i64, Vec<u8>, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, student_email_hash, blob_key, failed_attempts
         FROM recordings
         WHERE token_hash = $1 AND deleted_at IS NULL",
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
        return Ok(gate_error(StatusCode::FORBIDDEN, "disabled"));
    }

    // Constant-time email comparison.
    let email_match = stored_email_hash.as_slice().ct_eq(provided_hash.as_slice()).unwrap_u8() == 1;

    if !email_match {
        let new_attempts = failed_attempts + 1;
        sqlx::query("UPDATE recordings SET failed_attempts = $1 WHERE id = $2")
            .bind(new_attempts)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        if new_attempts >= 3 {
            notify_teacher_token_disabled(&state, id).await;
            return Ok(gate_error(StatusCode::FORBIDDEN, "disabled"));
        }
        return Ok(gate_error(StatusCode::FORBIDDEN, "wrong_email"));
    }

    // Email matches. Set accessed_at on first successful verify.
    sqlx::query(
        "UPDATE recordings SET accessed_at = CASE WHEN accessed_at IS NULL THEN $1 ELSE accessed_at END WHERE id = $2",
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

fn gate_error(status: StatusCode, error: &'static str) -> Response {
    (status, Json(serde_json::json!({ "error": error }))).into_response()
}

fn is_valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

async fn notify_teacher_token_disabled(state: &AppState, recording_id: i64) {
    // Best-effort: look up teacher email + slug and send notification.
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT t.email, t.slug FROM recordings r
         JOIN teachers t ON t.id = r.teacher_id
         WHERE r.id = $1",
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
            .send_token_disabled_notification(&teacher_email, &notify_url)
            .await
        {
            tracing::warn!(error = %e, recording_id, "failed to notify teacher of disabled token");
        }
    }
}
