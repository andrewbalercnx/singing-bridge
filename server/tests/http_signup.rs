// File: server/tests/http_signup.rs
// Purpose: /signup + /auth/consume flow, rate limits, re-signup idempotency.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::{spawn_app, spawn_app_with, TestOpts};

#[tokio::test]
async fn signup_and_consume_issues_cookie() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    assert!(!cookie.is_empty());
    app.shutdown().await;
}

#[tokio::test]
async fn signup_rejects_invalid_slug() {
    let app = spawn_app().await;
    let r = app.signup("x@example.test", "ad").await;
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn signup_rejects_reserved_slug() {
    let app = spawn_app().await;
    let r = app.signup("x@example.test", "admin").await;
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn signup_409_on_slug_taken() {
    let app = spawn_app().await;
    let _ = app.signup_teacher("a@example.test", "alice").await;
    let r = app.signup("b@example.test", "alice").await;
    assert_eq!(r.status(), 409);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "slug_taken");
    assert!(body["suggestions"].as_array().unwrap().len() >= 1);
    app.shutdown().await;
}

#[tokio::test]
async fn resignup_without_active_session_rebinds() {
    let app = spawn_app().await;
    let _ = app.signup_teacher("t@example.test", "alice").await;
    // Simulate "no active session" by expiring the existing session directly.
    sqlx::query("UPDATE sessions SET expires_at = 0")
        .execute(&app.state.db)
        .await
        .unwrap();
    let r = app.signup("t@example.test", "bob").await;
    assert!(r.status().is_success(), "expected 200; got {}", r.status());
    let (slug,): (String,) = sqlx::query_as("SELECT slug FROM teachers WHERE email = ?")
        .bind("t@example.test")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(slug, "bob");
    app.shutdown().await;
}

#[tokio::test]
async fn resignup_with_active_session_returns_409() {
    let app = spawn_app().await;
    let _ = app.signup_teacher("t@example.test", "alice").await;
    let r = app.signup("t@example.test", "bob").await;
    assert_eq!(r.status(), 409);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "session_in_progress");
    app.shutdown().await;
}

#[tokio::test]
async fn resignup_invalidates_prior_unconsumed_links() {
    let app = spawn_app().await;
    // First issue a link but don't consume it.
    let _ = app.signup("t@example.test", "alice").await;
    let first_url = app.latest_magic_link("t@example.test").await;
    let first_token = first_url
        .fragment()
        .unwrap()
        .strip_prefix("token=")
        .unwrap()
        .to_string();
    // Re-signup (no active session yet, so this rebinds).
    let r = app.signup("t@example.test", "bob").await;
    assert!(r.status().is_success());
    // The old token must no longer consume.
    let resp = app
        .client
        .post(app.url("/auth/consume"))
        .json(&serde_json::json!({"token": first_token}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn signup_rate_limit_per_email() {
    let opts = TestOpts {
        signup_rate_limit_per_email: 2,
        signup_rate_limit_per_ip: 999,
        ..Default::default()
    };
    let app = spawn_app_with(opts).await;
    // Use distinct slugs so we don't hit slug_taken before the limit.
    let _ = app.signup("same@example.test", "slug-one").await;
    let _ = app.signup("same@example.test", "slug-two").await;
    let r = app.signup("same@example.test", "slug-three").await;
    assert_eq!(r.status(), 429);
    app.shutdown().await;
}

#[tokio::test]
async fn signup_rate_limit_per_ip() {
    let opts = TestOpts {
        signup_rate_limit_per_email: 999,
        signup_rate_limit_per_ip: 2,
        ..Default::default()
    };
    let app = spawn_app_with(opts).await;
    let _ = app.signup("a@example.test", "slug-one").await;
    let _ = app.signup("b@example.test", "slug-two").await;
    let r = app.signup("c@example.test", "slug-three").await;
    assert_eq!(r.status(), 429);
    // R1 code-review finding #56: 429 must carry Retry-After.
    let retry = r
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .expect("Retry-After")
        .to_str()
        .unwrap();
    assert!(retry.parse::<u32>().is_ok(), "Retry-After should be seconds");
    app.shutdown().await;
}

#[tokio::test]
async fn consume_rejects_unknown_token() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/consume"))
        .json(&serde_json::json!({"token": "deadbeef"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn consume_is_single_use() {
    let app = spawn_app().await;
    let _ = app.signup("once@example.test", "once-slug").await;
    let url = app.latest_magic_link("once@example.test").await;
    let token = url
        .fragment()
        .unwrap()
        .strip_prefix("token=")
        .unwrap()
        .to_string();
    let r1 = app
        .client
        .post(app.url("/auth/consume"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert!(r1.status().is_success());
    let r2 = app
        .client
        .post(app.url("/auth/consume"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), 400);
    app.shutdown().await;
}
