// File: server/src/http/teach.rs
// Purpose: GET /teach/<slug> — serves teacher.html when the caller owns the
//          slug via session cookie; otherwise student.html.
// Role: The one page students actually visit.
// Exports: get_teach
// Depends: axum, tokio::fs
// Invariants: failing to read the session cookie does NOT differ observably
//             from a missing cookie — both fall through to student view.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

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

    Ok(Html(html).into_response())
}
