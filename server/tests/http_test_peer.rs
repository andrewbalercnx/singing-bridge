// File: server/tests/http_test_peer.rs
// Purpose: Integration tests for GET /test-peer and POST /test-peer/session.
//          All tests use SB_TEST_PEER_SCRIPT=echo to avoid launching real Playwright.
// Last updated: Sprint 25 (2026-04-27) -- initial implementation

mod common;

#[cfg(debug_assertions)]
use common::{spawn_app, spawn_app_with, TestOpts};

// ---------------------------------------------------------------------------
// Route gating
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_disabled_returns_404() {
    let app = spawn_app_with(TestOpts {
        test_peer: Some(false),
        ..Default::default()
    })
    .await;
    let resp = app.client.get(app.url("/test-peer?slug=x&mode=student")).send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
    app.shutdown().await;
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_enabled_student_returns_202() {
    let app = spawn_app().await;
    let resp = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=student"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::ACCEPTED);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["mode"], "student");
    assert_eq!(body["slug"], "myroom");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Mode validation (table-driven)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_invalid_modes_return_400() {
    let app = spawn_app().await;
    for bad_mode in &["", "wizard", "TEACHER", "student "] {
        let resp = app
            .client
            .get(app.url("/test-peer"))
            .query(&[("slug", "myroom"), ("mode", bad_mode)])
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            reqwest::StatusCode::BAD_REQUEST,
            "expected 400 for mode={bad_mode:?}"
        );
    }
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// 409 active-bot guard (pre-populated, no timing dependency)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_duplicate_slug_returns_409() {
    let app = spawn_app().await;
    app.state.active_bots.insert("myroom".to_string(), ());

    let resp = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=student"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::CONFLICT);

    app.state.active_bots.remove("myroom");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Teacher mode: no_teacher (slug not in DB)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_teacher_mode_unknown_slug_returns_404() {
    let app = spawn_app().await;
    let resp = app
        .client
        .get(app.url("/test-peer?slug=nonexistent&mode=teacher"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "no_teacher");
    assert!(!app.state.active_bots.contains_key("nonexistent"));
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Teacher mode: no_wav_variant (teacher exists but no variants)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_teacher_mode_no_wav_variant_returns_404() {
    let app = spawn_app().await;
    app.register_teacher("t@example.com", "myroom", "pass123").await;

    let resp = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=teacher"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "no_wav_variant");
    assert!(!app.state.active_bots.contains_key("myroom"));
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Bot process exit → slug cleared from active_bots
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_bot_exit_clears_active_bots() {
    let app = spawn_app().await;
    let resp = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=student"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::ACCEPTED);

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        !app.state.active_bots.contains_key("myroom"),
        "active_bots should be cleared after subprocess exit"
    );

    let resp2 = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=student"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), reqwest::StatusCode::ACCEPTED);
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Spawn failure → 503
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_bad_script_returns_503() {
    let app = spawn_app_with(TestOpts {
        test_peer_script: Some("/nonexistent_binary_xyz".to_string()),
        ..Default::default()
    })
    .await;
    let resp = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=student"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "bot_unavailable");
    assert!(
        !app.state.active_bots.contains_key("myroom"),
        "active_bots must be cleared after spawn failure"
    );
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Teacher mode: 202 success (teacher has a wav variant)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_teacher_mode_with_variant_returns_202() {
    let app = spawn_app().await;
    app.register_teacher("t@example.com", "myroom", "pass123").await;
    let (tid,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'myroom'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    common::seed_accompaniment_asset(&app, tid).await;

    let resp = app
        .client
        .get(app.url("/test-peer?slug=myroom&mode=teacher"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::ACCEPTED);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["mode"], "teacher");
    assert_eq!(body["slug"], "myroom");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Token store at capacity → 503
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_token_cap_returns_503() {
    let app = spawn_app().await;
    // Fill the token store to capacity using direct insert, bypassing HTTP.
    for i in 0..100usize {
        let _ = app.state.token_store.insert(format!("slug{i}"));
    }
    let resp = app
        .client
        .get(app.url("/test-peer?slug=newslug&mode=student"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "bot_capacity");
    assert!(
        !app.state.active_bots.contains_key("newslug"),
        "active_bots must be cleared when token store is at capacity"
    );
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// POST /test-peer/session — invalid token
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_session_invalid_token_returns_401() {
    let app = spawn_app().await;
    let resp = app
        .client
        .post(app.url("/test-peer/session"))
        .json(&serde_json::json!({"token": "deadbeef"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// POST /test-peer/session — valid token issues cookie; replay → 401
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_session_consumes_token_and_issues_cookie() {
    let app = spawn_app().await;
    app.register_teacher("t@example.com", "myroom", "pass123").await;

    let token = app.state.token_store.insert("myroom".to_string()).unwrap();

    let resp = app
        .client
        .post(app.url("/test-peer/session"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let cookie_hdr = resp.headers().get("set-cookie").unwrap().to_str().unwrap();
    assert!(cookie_hdr.contains("sb_session="), "missing sb_session cookie");
    assert!(cookie_hdr.contains("Max-Age=180"), "expected Max-Age=180, got: {cookie_hdr}");
    assert!(cookie_hdr.contains("HttpOnly"), "missing HttpOnly");

    let resp2 = app
        .client
        .post(app.url("/test-peer/session"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), reqwest::StatusCode::UNAUTHORIZED);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// POST /test-peer/session — expires_at ≈ now + 180s
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_session_ttl_expires_at_180s() {
    let app = spawn_app().await;
    app.register_teacher("t@example.com", "myroom", "pass123").await;

    let token = app.state.token_store.insert("myroom".to_string()).unwrap();
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let resp = app
        .client
        .post(app.url("/test-peer/session"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let expected = now_unix + 180;
    // Filter to short-TTL sessions only so we don't pick up the long-lived
    // teacher session inserted by register_teacher.
    let row: (i64,) = sqlx::query_as(
        "SELECT expires_at FROM sessions WHERE expires_at < $1 ORDER BY expires_at DESC LIMIT 1",
    )
    .bind(now_unix + 300i64)
    .fetch_one(&app.state.db)
    .await
    .expect("session row");

    assert!(
        (row.0 - expected).abs() <= 5,
        "expires_at={} expected ~{expected}", row.0
    );

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// POST /test-peer/session — teacher deleted after token consume → 404, replay → 401
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tokio::test]
async fn test_peer_session_teacher_deleted_returns_404_no_replay() {
    let app = spawn_app().await;
    app.register_teacher("t@example.com", "myroom", "pass123").await;

    let token = app.state.token_store.insert("myroom".to_string()).unwrap();

    sqlx::query("DELETE FROM sessions WHERE teacher_id = (SELECT id FROM teachers WHERE slug = 'myroom')")
        .execute(&app.state.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM teachers WHERE slug = 'myroom'")
        .execute(&app.state.db)
        .await
        .unwrap();

    let resp = app
        .client
        .post(app.url("/test-peer/session"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);

    let resp2 = app
        .client
        .post(app.url("/test-peer/session"))
        .json(&serde_json::json!({"token": token}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), reqwest::StatusCode::UNAUTHORIZED);

    app.shutdown().await;
}
