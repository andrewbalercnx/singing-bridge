// File: server/src/http/signup.rs
// Purpose: /, /auth/verify, /auth/consume handlers. Magic-link flow retained
//          as password-reset escape hatch behind config.password_reset_enabled.
//          Primary registration is POST /auth/register in http/login.rs.
// Role: Root page, magic-link password-reset path, home_redirect helper.
// Exports: get_root, get_verify, post_consume, home_redirect, serve_home
// Depends: axum, sqlx, serde
// Invariants: get_verify and post_consume return 403 when password_reset_enabled=false.
//             raw magic-link tokens never appear in query strings or span fields;
//             fragment-based URL keeps them client-side only.
//             home_redirect always returns 302 / with no-store headers.
// Last updated: Sprint 26 (2026-05-07) -- home.html from file; home_redirect helper; 404 injection

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

/// Serve home.html from disk (no injections needed for the normal root view).
pub async fn get_root(State(state): State<Arc<AppState>>) -> Result<Response> {
    let html = serve_home(&state, None).await?;
    Ok(Html(html).into_response())
}

/// Read home.html and optionally inject a 404 notice for an unknown path.
/// `not_found_path`: the raw path the browser requested (HTML-escaped before injection).
pub async fn serve_home(state: &AppState, not_found_path: Option<&str>) -> Result<String> {
    let path = state.config.static_dir.join("home.html");
    let html = tokio::fs::read_to_string(&path).await?;
    let panel = match not_found_path {
        None => String::new(),
        Some(p) => {
            let escaped = html_escape_attr(p);
            format!(
                r#"<div class="not-found-notice" role="alert">
  <div class="sb-notice">
    <p class="not-found-notice__label">Page not found</p>
    <p class="not-found-notice__url">{escaped}</p>
  </div>
</div>"#
            )
        }
    };
    Ok(html.replace("<!-- sb:not-found-panel -->", &panel))
}

/// 302 redirect to / with no-store headers — used by authenticated pages when auth fails.
pub fn home_redirect() -> Response {
    let mut resp = (StatusCode::FOUND, [(header::LOCATION, "/")]).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn html_escape_attr(s: &str) -> String {
    s.chars().fold(String::with_capacity(s.len()), |mut out, c| {
        match c {
            '&'  => out.push_str("&amp;"),
            '<'  => out.push_str("&lt;"),
            '>'  => out.push_str("&gt;"),
            '"'  => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c    => out.push(c),
        }
        out
    })
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

    let (slug,): (String,) = sqlx::query_as("SELECT slug FROM teachers WHERE id = $1")
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

const VERIFY_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Verifying — singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main><h1>Verifying…</h1><p id="status">Checking your link.</p>
<script src="/assets/verify.js"></script>
</main></body></html>"#;
