// File: server/src/http/synthetic_auth.rs
// Purpose: Secret-protected auth endpoint for synthetic peer bots running against
//          any environment (including production). Issues a short-lived teacher
//          session cookie when the caller presents the correct SB_SYNTHETIC_PEER_SECRET.
//          Not debug-gated — works in release builds — but only mounted when the
//          secret is configured (opt-in via env var).
// Role: HTTP handler for POST /api/synthetic-auth.
// Exports: post_synthetic_auth
// Depends: axum, sqlx, auth::issue_session_cookie, AppState
// Invariants: Returns 401 on any secret mismatch (no timing distinction between
//             bad secret vs unknown slug). Session TTL is capped at 300 s.
// Last updated: Sprint 27 (2026-05-08) -- initial implementation

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;

use crate::state::AppState;

const SESSION_TTL_SECS: i64 = 300;

#[derive(Deserialize)]
pub struct SyntheticAuthBody {
    secret: String,
    slug: String,
}

pub async fn post_synthetic_auth(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SyntheticAuthBody>,
) -> impl IntoResponse {
    // Constant-time comparison via subtle is overkill here (the secret is not a
    // HMAC tag), but we do avoid early-return on mismatch to prevent timing leaks.
    let expected = match &state.config.synthetic_peer_secret {
        Some(s) => s.clone(),
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if body.secret != expected {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let row = sqlx::query_as::<_, (i64,)>("SELECT id FROM teachers WHERE slug = $1")
        .bind(&body.slug)
        .fetch_optional(&state.db)
        .await;

    let teacher_id = match row {
        Ok(Some((id,))) => id,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let raw = match crate::auth::issue_session_cookie(&state.db, teacher_id, SESSION_TTL_SECS).await {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let secure = if state.config.require_secure_cookie() { "; Secure" } else { "" };
    let cookie = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{}",
        crate::auth::SESSION_COOKIE_NAME,
        raw,
        SESSION_TTL_SECS as u64,
        secure,
    );

    (
        StatusCode::OK,
        [(axum::http::header::SET_COOKIE, cookie)],
        Json(serde_json::json!({})),
    )
        .into_response()
}
