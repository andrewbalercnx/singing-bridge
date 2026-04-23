// File: server/src/http/dashboard.rs
// Purpose: GET /teach/<slug>/dashboard — serves dashboard.html to the authenticated
//          slug owner; redirects all other callers to /teach/<slug>.
// Role: Between-session hub for teacher asset management (recordings, library, history).
// Exports: get_dashboard
// Depends: axum, tokio::fs, teach (shared helpers)
// Invariants: All responses carry Cache-Control: private, no-store and Vary: Cookie.
//             Non-owner callers (unauthenticated or wrong account) are redirected to
//             /teach/<slug> without revealing whether the slug exists to non-owners.
// Last updated: Sprint 17 (2026-04-23) -- initial

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Response},
};

use crate::auth::slug::validate;
use crate::error::{AppError, Result};
use crate::http::teach::{
    ensure_slug_exists, inject_debug_marker, is_owner, private_redirect, set_private_headers,
};
use crate::state::AppState;

pub async fn get_dashboard(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response> {
    let slug = validate(&slug).map_err(|_| AppError::NotFound)?;
    ensure_slug_exists(&state, &slug).await?;

    if !is_owner(&state, &headers, &slug).await {
        return Ok(private_redirect(format!("/teach/{}", slug)));
    }

    let path = state.config.static_dir.join("dashboard.html");
    let html = tokio::fs::read_to_string(&path).await?;
    let html = inject_debug_marker(html, state.config.dev);
    let mut resp = Html(html).into_response();
    set_private_headers(resp.headers_mut());
    Ok(resp)
}
