// File: server/tests/http_dashboard.rs
// Purpose: Integration tests for GET /teach/<slug>/dashboard — auth gating,
//          cache headers, redirect paths, and 404 on unknown slug.
// Last updated: Sprint 17 (2026-04-23) -- initial

mod common;

use common::{spawn_app, TestApp};

/// Helper: GET /teach/<slug>/dashboard, returns (status, location-header, cache-control, body).
async fn get_dashboard(app: &TestApp, slug: &str, cookie: Option<&str>) -> (reqwest::StatusCode, Option<String>, Option<String>, Option<String>) {
    let (status, headers, body) = app.get_html(&format!("/teach/{}/dashboard", slug), cookie).await;
    let location = headers.get("location").and_then(|v| v.to_str().ok()).map(String::from);
    let cc = headers.get("cache-control").and_then(|v| v.to_str().ok()).map(String::from);
    let vary = headers.get("vary").and_then(|v| v.to_str().ok()).map(String::from);
    // Return body as fourth element for convenience; caller can ignore
    let _ = vary;
    (status, location, cc, Some(body))
}

#[tokio::test]
async fn authenticated_owner_gets_200_with_private_headers() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@example.com", "myroom").await;
    let (status, _loc, cc, body) = get_dashboard(&app, "myroom", Some(&cookie)).await;
    assert_eq!(status, reqwest::StatusCode::OK, "owner should get 200");
    assert_eq!(cc.as_deref(), Some("private, no-store"));
    assert!(body.unwrap_or_default().contains("dashboard"), "body should be dashboard.html");
    app.shutdown().await;
}

#[tokio::test]
async fn vary_cookie_header_present_for_owner() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@example.com", "myroom").await;
    let (_status, _loc, _cc, _body) = get_dashboard(&app, "myroom", Some(&cookie)).await;
    let (_, headers, _) = app.get_html("/teach/myroom/dashboard", Some(&cookie)).await;
    assert_eq!(
        headers.get("vary").and_then(|v| v.to_str().ok()),
        Some("Cookie"),
    );
    app.shutdown().await;
}

#[tokio::test]
async fn unauthenticated_redirects_to_teach_slug() {
    let app = spawn_app().await;
    app.signup_teacher("teacher@example.com", "myroom").await;
    let (status, location, cc, _) = get_dashboard(&app, "myroom", None).await;
    assert_eq!(status, reqwest::StatusCode::FOUND);
    assert_eq!(location.as_deref(), Some("/teach/myroom"));
    assert_eq!(cc.as_deref(), Some("private, no-store"));
    app.shutdown().await;
}

#[tokio::test]
async fn wrong_owner_redirects_to_teach_slug() {
    let app = spawn_app().await;
    app.signup_teacher("owner@example.com", "myroom").await;
    let other_cookie = app.signup_teacher("other@example.com", "otherroom").await;
    // other teacher is authenticated but does not own "myroom"
    let (status, location, _, _) = get_dashboard(&app, "myroom", Some(&other_cookie)).await;
    assert_eq!(status, reqwest::StatusCode::FOUND);
    assert_eq!(location.as_deref(), Some("/teach/myroom"));
    app.shutdown().await;
}

#[tokio::test]
async fn unknown_slug_is_404() {
    let app = spawn_app().await;
    let (status, _, _, _) = get_dashboard(&app, "nosuchslug", None).await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    app.shutdown().await;
}

#[tokio::test]
async fn teach_slug_redirects_owner_to_dashboard() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@example.com", "myroom").await;
    let (status, headers, _body) = app.get_html("/teach/myroom", Some(&cookie)).await;
    assert_eq!(status, reqwest::StatusCode::FOUND);
    assert_eq!(
        headers.get("location").and_then(|v| v.to_str().ok()),
        Some("/teach/myroom/dashboard")
    );
    assert_eq!(
        headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("private, no-store")
    );
    assert_eq!(
        headers.get("vary").and_then(|v| v.to_str().ok()),
        Some("Cookie")
    );
    app.shutdown().await;
}

#[tokio::test]
async fn teach_slug_unauthenticated_serves_student_html() {
    let app = spawn_app().await;
    app.signup_teacher("teacher@example.com", "myroom").await;
    let (status, _headers, body) = app.get_html("/teach/myroom", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(body.contains(r#"id="session-root""#), "unauthenticated should get student.html");
    app.shutdown().await;
}

#[tokio::test]
async fn session_route_serves_teacher_html_to_owner() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@example.com", "myroom").await;
    let (status, headers, body) = app.get_html("/teach/myroom/session", Some(&cookie)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(headers.get("cache-control").and_then(|v| v.to_str().ok()), Some("private, no-store"));
    assert_eq!(headers.get("vary").and_then(|v| v.to_str().ok()), Some("Cookie"));
    assert!(body.contains(r#"id="session-root""#));
    app.shutdown().await;
}
