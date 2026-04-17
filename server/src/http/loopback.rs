// File: server/src/http/loopback.rs
// Purpose: GET /loopback — serves the dev-only mic→speaker latency
//          harness. Returns 404 in release (config.dev == false) so
//          the route has zero surface in prod.
// Role: Dev-tool entry point; never touched during a real lesson.
// Exports: get_loopback
// Depends: axum, tokio::fs
// Invariants: returns NotFound in release without reading the file;
//             the response carries the standard security-headers
//             middleware output (no COOP/COEP — the worklet
//             transport is MessagePort, not SharedArrayBuffer).
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

use std::sync::Arc;

use axum::{
    extract::State,
    response::{Html, IntoResponse, Response},
};

use crate::error::{AppError, Result};
use crate::state::AppState;

pub async fn get_loopback(State(state): State<Arc<AppState>>) -> Result<Response> {
    if !state.config.dev {
        return Err(AppError::NotFound);
    }
    let html_path = state.config.static_dir.join("loopback.html");
    let html = tokio::fs::read_to_string(&html_path).await?;
    Ok(Html(html).into_response())
}
