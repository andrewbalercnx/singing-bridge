// File: server/src/http/teach.rs
// Purpose: GET /teach/<slug> — serves teacher.html when the caller owns the
//          slug via session cookie; otherwise student.html. In dev mode,
//          injects the <meta name="sb-debug"> tag that enables the debug
//          overlay; in prod mode, injects nothing (hot path stays
//          allocation-light by short-circuiting the replace).
// Role: The one page students actually visit.
// Exports: get_teach
// Depends: axum, tokio::fs
// Invariants: failing to read the session cookie does NOT differ observably
//             from a missing cookie — both fall through to student view.
//             Debug marker injection is driven solely by Config.dev; no
//             other gate (cookie, query string, header) promotes to dev.
// Last updated: Sprint 2 (2026-04-17) -- +debug marker injection

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Response},
};

use crate::auth::{resolve_teacher_from_cookie, slug::validate};
use crate::error::{AppError, Result};
use crate::state::AppState;

pub async fn get_teach(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response> {
    let slug = validate(&slug).map_err(|_| AppError::NotFound)?;

    let (teacher_id_owns_slug,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM teachers WHERE slug = ?",
    )
    .bind(&slug)
    .fetch_one(&state.db)
    .await?;
    if teacher_id_owns_slug == 0 {
        return Err(AppError::NotFound);
    }

    let authed_teacher = resolve_teacher_from_cookie(&state.db, &headers).await;

    let is_owner = if let Some(tid) = authed_teacher {
        let (owned,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM teachers WHERE id = ? AND slug = ?",
        )
        .bind(tid)
        .bind(&slug)
        .fetch_one(&state.db)
        .await?;
        owned > 0
    } else {
        false
    };

    let page = if is_owner { "teacher.html" } else { "student.html" };
    let html_path = state.config.static_dir.join(page);
    let html = tokio::fs::read_to_string(&html_path)
        .await
        .map_err(|e| AppError::Internal(format!("read {page}: {e}").into()))?;

    let html = inject_debug_marker(html, state.config.dev);
    Ok(Html(html).into_response())
}

/// Placeholder token in `teacher.html` / `student.html` that is
/// replaced with the `<meta name="sb-debug">` tag when `dev == true`,
/// and with the empty string when `dev == false`. In prod we skip
/// the String::replace call entirely to keep the hot path allocation-
/// light (domain-reviewer R3 recommendation): the placeholder is a
/// visible HTML comment so leaving it in place is harmless.
const DEBUG_MARKER_PLACEHOLDER: &str = "<!-- sb:debug -->";
const DEBUG_MARKER_TAG: &str = "<meta name=\"sb-debug\" content=\"1\">";

fn inject_debug_marker(html: String, dev: bool) -> String {
    if !dev {
        return html;
    }
    html.replace(DEBUG_MARKER_PLACEHOLDER, DEBUG_MARKER_TAG)
}
