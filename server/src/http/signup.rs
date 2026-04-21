// File: server/src/http/signup.rs
// Purpose: /, /auth/verify, /auth/consume handlers. Magic-link flow retained
//          as password-reset escape hatch behind config.password_reset_enabled.
//          Primary registration is POST /auth/register in http/login.rs.
// Role: Root page, magic-link password-reset path.
// Exports: get_root, get_verify, post_consume
// Depends: axum, sqlx, serde
// Invariants: get_verify and post_consume return 403 when password_reset_enabled=false.
//             raw magic-link tokens never appear in query strings or span fields;
//             fragment-based URL keeps them client-side only.
// Last updated: Sprint 10 (2026-04-21) -- gate magic-link behind password_reset_enabled

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::auth::{issue_session_cookie, magic_link, SESSION_COOKIE_NAME};
use crate::error::{AppError, Result};
use crate::state::AppState;

pub async fn get_root() -> Html<&'static str> {
    Html(ROOT_HTML)
}

pub async fn get_verify(State(state): State<Arc<AppState>>) -> Response {
    if !state.config.password_reset_enabled {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut resp = Html(VERIFY_HTML).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    resp
}

#[derive(Deserialize)]
pub struct ConsumeBody {
    pub token: String,
}

#[derive(Serialize)]
pub struct ConsumeOk {
    pub redirect: String,
}

pub async fn post_consume(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ConsumeBody>,
) -> Result<Response> {
    if !state.config.password_reset_enabled {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }
    let teacher_id = magic_link::consume(&state.db, &body.token).await?;
    let cookie = issue_session_cookie(&state.db, teacher_id, state.config.session_ttl_secs).await?;

    let (slug,): (String,) = sqlx::query_as("SELECT slug FROM teachers WHERE id = ?")
        .bind(teacher_id)
        .fetch_one(&state.db)
        .await?;

    let secure = if state.config.require_secure_cookie() { "; Secure" } else { "" };
    let cookie_header = format!(
        "{SESSION_COOKIE_NAME}={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max}{secure}",
        max = state.config.session_ttl_secs
    );

    let mut resp = Json(ConsumeOk { redirect: format!("/teach/{slug}") }).into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie_header)
            .map_err(|e| AppError::Internal(format!("cookie header: {e}").into()))?,
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

const ROOT_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main><h1>singing-bridge</h1>
<p>Teachers: <a href="/signup">sign up</a> or <a href="/auth/login">log in</a>.</p>
<p>Students: your teacher will share a URL of the form <code>/teach/&lt;slug&gt;</code>.</p>
</main></body></html>"#;

const VERIFY_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Verifying — singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main><h1>Verifying…</h1><p id="status">Checking your link.</p>
<script src="/assets/verify.js"></script>
</main></body></html>"#;
