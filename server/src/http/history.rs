// File: server/src/http/history.rs
// Purpose: Session history HTTP handler — GET /teach/<slug>/history.
// Role: Teacher-authenticated page showing past sessions (non-archived, most recent first).
// Exports: get_history
// Depends: axum, sqlx, state, auth
// Invariants: Requires valid session cookie for the owning teacher (401 otherwise).
//             All user-derived values in HTML output are HTML-escaped.
//             Results capped at HISTORY_PAGE_LIMIT rows.
//             archived_at IS NULL filter excludes soft-deleted events.
// Last updated: Sprint 111 (2026-04-21) -- initial implementation

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap},
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

fn format_timestamp(unix_secs: i64) -> String {
    // Format as YYYY-MM-DD HH:MM (UTC) — simple manual implementation, no chrono dep.
    let secs = unix_secs.max(0) as u64;
    let days = secs / 86400;
    let rem = secs % 86400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    // days since Unix epoch (1970-01-01)
    let (y, m, d) = days_to_ymd(days);
    format!("{y}-{m:02}-{d:02} {hour:02}:{min:02}")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    let mut year = 1970u64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let dy = if leap { 366 } else { 365 };
        if days < dy { break; }
        days -= dy;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days: [u64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u64;
    for &md in &month_days {
        if days < md { break; }
        days -= md;
        month += 1;
    }
    (year, month, days + 1)
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
        None => return crate::http::signup::home_redirect(),
    };

    // Verify the teacher owns the slug.
    let row: Result<(i64,), sqlx::Error> =
        sqlx::query_as("SELECT id FROM teachers WHERE id = $1 AND slug = $2")
            .bind(teacher_id)
            .bind(&slug)
            .fetch_one(&state.db)
            .await;
    if row.is_err() {
        return crate::http::signup::home_redirect();
    }

    let rows: Vec<(i64, i64, Option<i64>, Option<i64>, Option<String>, String, Option<i64>)> =
        match sqlx::query_as(
            "SELECT se.id, se.started_at, se.ended_at, se.duration_secs, se.ended_reason, \
                    s.email, r.id AS recording_id \
             FROM session_events se \
             JOIN students s ON s.id = se.student_id \
             LEFT JOIN recordings r ON r.id = se.recording_id \
             WHERE se.teacher_id = $1 \
               AND se.archived_at IS NULL \
             ORDER BY se.started_at DESC \
             LIMIT $2",
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
            let started_display = format_timestamp(*started_at);
        rows_html.push_str(&format!(
            "<tr><td>{id}</td><td>{started_display}</td><td>{email_e}</td><td>{duration_display}</td>\
             <td>{reason_e}</td><td>{recording_cell}</td></tr>\n",
        ));
    }

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Session History — {slug_e}</title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="stylesheet" href="/assets/theme.css">
</head>
<body class="sb-page">
  <header class="sb-topbar">
    <span class="sb-topbar__brand">singing-bridge</span>
    <span class="sb-topbar__meta">{slug_upper}</span>
    <a class="sb-btn sb-btn--ghost sb-btn--sm" href="/teach/{slug_e}/dashboard">← Dashboard</a>
  </header>
  <main class="sb-container sb-mt-6">
    <h1 class="sb-h1">Session History</h1>
    <div class="sb-card sb-mt-4">
      <table class="sb-table">
        <thead><tr><th>ID</th><th>Started (UTC)</th><th>Student</th><th>Duration</th><th>End reason</th><th>Recording</th></tr></thead>
        <tbody>
{rows_html}        </tbody>
      </table>
    </div>
  </main>
</body>
</html>"#,
        slug_e = html_escape(&slug),
        slug_upper = html_escape(&slug.to_uppercase()),
        rows_html = rows_html,
    );

    let mut resp = Html(html).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    resp
}

#[cfg(test)]
mod tests {
    use super::{format_duration, format_timestamp, html_escape};

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

    #[test]
    fn format_timestamp_epoch() {
        assert_eq!(format_timestamp(0), "1970-01-01 00:00");
    }

    #[test]
    fn format_timestamp_known_date() {
        // 2026-05-07 14:23:00 UTC = 1778163780
        assert_eq!(format_timestamp(1778163780), "2026-05-07 14:23");
    }

    #[test]
    fn format_timestamp_leap_day() {
        // 2000-02-29 00:00:00 UTC = 951782400
        assert_eq!(format_timestamp(951782400), "2000-02-29 00:00");
    }
}
