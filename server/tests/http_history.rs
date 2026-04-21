// File: server/tests/http_history.rs
// Purpose: Integration tests for GET /teach/<slug>/history.
// Last updated: Sprint 11 (2026-04-21) -- initial implementation

mod common;
use common::spawn_app;

#[tokio::test]
async fn history_no_cookie_returns_401() {
    let app = spawn_app().await;
    app.signup_teacher("alice@example.test", "alice").await;
    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn history_wrong_teacher_cookie_returns_401() {
    let app = spawn_app().await;
    app.signup_teacher("alice@example.test", "alice").await;
    let bob_cookie = app.signup_teacher("bob@example.test", "bob").await;
    // Bob's cookie against Alice's slug → 401.
    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={bob_cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn history_with_no_events_returns_empty_table() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(body.contains("<tbody>"));
    app.shutdown().await;
}

#[tokio::test]
async fn history_shows_session_events() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let teacher_id: i64 = sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'alice'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    app.make_session_event(teacher_id, "student@example.test", now - 300, Some(now - 240))
        .await;

    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(body.contains("student@example.test"), "email should appear in history");
    app.shutdown().await;
}

#[tokio::test]
async fn history_respects_100_row_limit() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let teacher_id: i64 = sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'alice'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    for i in 0..150i64 {
        app.make_session_event(teacher_id, "s@example.test", now - i * 10, Some(now - i * 10 + 5))
            .await;
    }

    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    // Count <tr> rows in tbody (each event = one <tr>). 100 data rows + 1 header = 101.
    let tr_count = body.matches("<tr>").count();
    assert_eq!(tr_count, 101, "header + 100 data rows expected, got {tr_count}");
    app.shutdown().await;
}

#[tokio::test]
async fn history_escapes_xss_in_email() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let teacher_id: i64 = sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'alice'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    // Bypass WS validation to insert raw XSS payload directly.
    app.make_session_event(teacher_id, "<script>@evil.com", now - 10, Some(now - 5))
        .await;

    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(!body.contains("<script>"), "raw <script> must not appear in output");
    assert!(body.contains("&lt;script&gt;"), "script tag should be escaped");
    app.shutdown().await;
}

#[tokio::test]
async fn history_response_has_cache_control_no_store() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store"),
        "history page must carry Cache-Control: no-store to prevent PII caching"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn history_no_cookie_401_has_cache_control_no_store() {
    let app = spawn_app().await;
    app.signup_teacher("alice@example.test", "alice").await;
    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store"),
        "unauthenticated 401 must carry Cache-Control: no-store"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn history_wrong_teacher_401_has_cache_control_no_store() {
    let app = spawn_app().await;
    app.signup_teacher("alice@example.test", "alice").await;
    let bob_cookie = app.signup_teacher("bob@example.test", "bob").await;
    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={bob_cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store"),
        "wrong-teacher 401 must carry Cache-Control: no-store"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn history_excludes_archived_events() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let teacher_id: i64 = sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'alice'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let event_id = app
        .make_session_event(teacher_id, "old@example.test", now - 100, Some(now - 90))
        .await;
    // Manually archive.
    sqlx::query("UPDATE session_events SET archived_at = ? WHERE id = ?")
        .bind(now)
        .bind(event_id)
        .execute(&app.state.db)
        .await
        .unwrap();

    let resp = app
        .client
        .get(app.url("/teach/alice/history"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(!body.contains("old@example.test"), "archived event must not appear");
    app.shutdown().await;
}
