// File: server/src/http/teach.rs
// Purpose: GET /teach/<slug> — redirects authenticated owner to dashboard; serves
//          student.html to unauthenticated visitors. GET /teach/<slug>/session —
//          serves teacher.html (session + lobby) to authenticated owner.
// Role: Entry point for all /teach/<slug> traffic; slug auth gating.
// Exports: get_teach, get_session, ensure_slug_exists, is_owner, serve_html,
//          private_redirect, set_private_headers, inject_debug_marker
// Depends: axum, tokio::fs
// Invariants: failing to read the session cookie does NOT differ observably
//             from a missing cookie — both fall through to student view / redirect.
//             Debug marker injection is driven solely by Config.dev.
//             All owner-only responses carry Cache-Control: private, no-store
//             and Vary: Cookie. Non-owner dashboard/session requests redirect to
//             /teach/<slug> (student entry point).
// Last updated: Sprint 17 (2026-04-23) -- dashboard redirect + /session route

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
};

use crate::auth::{resolve_teacher_from_cookie, slug::validate};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// GET /teach/<slug> — authenticated owner → redirect to dashboard;
/// unauthenticated → serve student.html.
pub async fn get_teach(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response> {
    let slug = validate(&slug).map_err(|_| AppError::NotFound)?;
    ensure_slug_exists(&state, &slug).await?;

    if is_owner(&state, &headers, &slug).await {
        let location = format!("/teach/{}/dashboard", slug);
        return Ok(private_redirect(location));
    }

    serve_html(&state, "student.html", false).await
}

/// GET /teach/<slug>/session — authenticated owner → teacher.html (lobby + session);
/// unauthenticated → redirect to /teach/<slug>.
pub async fn get_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response> {
    let slug = validate(&slug).map_err(|_| AppError::NotFound)?;
    ensure_slug_exists(&state, &slug).await?;

    if !is_owner(&state, &headers, &slug).await {
        return Ok(private_redirect(format!("/teach/{}", slug)));
    }

    serve_html(&state, "teacher.html", state.config.dev).await
}

// ---- helpers (pub for dashboard.rs reuse) ----

pub async fn ensure_slug_exists(state: &AppState, slug: &str) -> Result<()> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM teachers WHERE slug = ?")
        .bind(slug)
        .fetch_one(&state.db)
        .await?;
    if count == 0 { Err(AppError::NotFound) } else { Ok(()) }
}

pub async fn is_owner(state: &AppState, headers: &HeaderMap, slug: &str) -> bool {
    let Some(tid) = resolve_teacher_from_cookie(&state.db, headers).await else {
        return false;
    };
    let Ok((owned,)): std::result::Result<(i64,), _> = sqlx::query_as(
        "SELECT COUNT(*) FROM teachers WHERE id = ? AND slug = ?",
    )
    .bind(tid)
    .bind(slug)
    .fetch_one(&state.db)
    .await else {
        return false;
    };
    owned > 0
}

pub async fn serve_html(state: &AppState, page: &str, dev: bool) -> Result<Response> {
    let path = state.config.static_dir.join(page);
    let html = tokio::fs::read_to_string(&path).await?;
    let html = inject_debug_marker(html, dev);
    let mut resp = Html(html).into_response();
    set_private_headers(resp.headers_mut());
    Ok(resp)
}

/// 302 redirect with private cache headers so proxies never cache it.
pub fn private_redirect(location: String) -> Response {
    let mut resp = (
        StatusCode::FOUND,
        [(header::LOCATION, location)],
    ).into_response();
    set_private_headers(resp.headers_mut());
    resp
}

pub fn set_private_headers(h: &mut axum::http::HeaderMap) {
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    h.insert(header::VARY, HeaderValue::from_static("Cookie"));
}

pub const DEBUG_MARKER_PLACEHOLDER: &str = "<!-- sb:debug -->";
const DEBUG_MARKER_TAG: &str = "<meta name=\"sb-debug\" content=\"1\">";

pub fn inject_debug_marker(html: String, dev: bool) -> String {
    let replacement = if dev { DEBUG_MARKER_TAG } else { "" };
    html.replace(DEBUG_MARKER_PLACEHOLDER, replacement)
}
