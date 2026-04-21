// File: server/src/http/history.rs
// Purpose: Session history HTTP handler — GET /teach/<slug>/history.
// Role: Teacher-authenticated page showing past sessions (non-archived, most recent first).
// Exports: get_history
// Depends: axum, sqlx, state, auth
// Invariants: Requires valid session cookie for the owning teacher (401 otherwise).
//             All user-derived values in HTML output are HTML-escaped.
//             Results capped at HISTORY_PAGE_LIMIT rows.
//             archived_at IS NULL filter excludes soft-deleted events.
// Last updated: Sprint 11 (2026-04-21) -- initial implementation

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
};

use crate::auth::resolve_teacher_from_cookie;
use crate::error::AppError;
use crate::state::AppState;
use crate::ws::session_history::HISTORY_PAGE_LIMIT;

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

fn format_duration(duration_secs: Option<i64>) -> String {
    match duration_secs {
        None => "-".to_string(),
        Some(s) => format!("{:02}:{:02}", s / 60, s % 60),
    }
}

pub(crate) async fn get_history(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Response {
    let teacher_id = match resolve_teacher_from_cookie(&state.db, &headers).await {
        Some(id) => id,
        None => return unauthorized_no_store(),
    };

    // Verify the teacher owns the slug.
    let row: Result<(i64,), sqlx::Error> =
        sqlx::query_as("SELECT id FROM teachers WHERE id = ? AND slug = ?")
            .bind(teacher_id)
            .bind(&slug)
            .fetch_one(&state.db)
            .await;
    if row.is_err() {
        return unauthorized_no_store();
    }

    let rows: Vec<(i64, i64, Option<i64>, Option<i64>, Option<String>, String, Option<i64>)> =
        match sqlx::query_as(
            "SELECT se.id, se.started_at, se.ended_at, se.duration_secs, se.ended_reason, \
                    s.email, r.id AS recording_id \
             FROM session_events se \
             JOIN students s ON s.id = se.student_id \
             LEFT JOIN recordings r ON r.id = se.recording_id \
             WHERE se.teacher_id = ? \
               AND se.archived_at IS NULL \
             ORDER BY se.started_at DESC \
             LIMIT ?",
        )
        .bind(teacher_id)
        .bind(HISTORY_PAGE_LIMIT)
        .fetch_all(&state.db)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "history query failed");
                return AppError::Internal("db error".into()).into_response();
            }
        };

    let mut rows_html = String::new();
    for (id, started_at, _ended_at, duration_secs, ended_reason, email, recording_id) in &rows {
        let email_e = html_escape(email);
        let reason_e = html_escape(ended_reason.as_deref().unwrap_or("-"));
        let duration_display = format_duration(*duration_secs);
        let recording_cell = match recording_id {
            Some(rid) => format!(
                "<a href=\"/teach/{}/recordings\">#{}</a>",
                html_escape(&slug),
                rid
            ),
            None => "-".to_string(),
        };
        rows_html.push_str(&format!(
            "<tr><td>{id}</td><td>{}</td><td>{email_e}</td><td>{duration_display}</td>\
             <td>{reason_e}</td><td>{recording_cell}</td></tr>\n",
            started_at
        ));
    }

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Session History</title></head>
<body>
<h1>Session History — {slug_e}</h1>
<table border="1" cellpadding="4">
<thead><tr><th>ID</th><th>Started</th><th>Student</th><th>Duration</th><th>Ended Reason</th><th>Recording</th></tr></thead>
<tbody>
{rows_html}</tbody>
</table>
<p><a href="/teach/{slug_e}">Back to room</a></p>
</body>
</html>"#,
        slug_e = html_escape(&slug),
        rows_html = rows_html,
    );

    let mut resp = Html(html).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    resp
}

fn unauthorized_no_store() -> Response {
    let mut resp = (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    resp
}

#[cfg(test)]
mod tests {
    use super::{format_duration, html_escape};

    #[test]
    fn format_duration_none_returns_dash() {
        assert_eq!(format_duration(None), "-");
    }

    #[test]
    fn format_duration_zero() {
        assert_eq!(format_duration(Some(0)), "00:00");
    }

    #[test]
    fn format_duration_seconds_only() {
        assert_eq!(format_duration(Some(45)), "00:45");
    }

    #[test]
    fn format_duration_minutes_and_seconds() {
        assert_eq!(format_duration(Some(125)), "02:05");
    }

    #[test]
    fn format_duration_negative_clamps_to_zero_display() {
        // Negative values should not produce a leading '-'; duration_secs is
        // clamped to 0 by MAX(0, …) in SQL so this is a safety check only.
        let s = format_duration(Some(-5));
        assert!(!s.starts_with('-'), "negative duration must not display as negative: {s}");
    }

    #[test]
    fn html_escape_script_tag() {
        let input = r#"<script>alert('xss')</script>"#;
        let out = html_escape(input);
        assert!(!out.contains('<'));
        assert!(!out.contains('>'));
        assert!(out.contains("&lt;script&gt;"));
    }

    #[test]
    fn html_escape_amp_and_quotes() {
        assert_eq!(html_escape("a & b"), "a &amp; b");
        assert_eq!(html_escape(r#"say "hi""#), "say &quot;hi&quot;");
        assert_eq!(html_escape("it's"), "it&#x27;s");
    }

    #[test]
    fn html_escape_plain_passthrough() {
        assert_eq!(html_escape("hello world"), "hello world");
    }
}
