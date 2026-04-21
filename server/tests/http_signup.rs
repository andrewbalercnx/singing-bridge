// File: server/tests/http_signup.rs
// Purpose: POST /auth/register + POST /auth/login + POST /auth/logout +
//          magic-link gating tests. Replaces the old magic-link signup suite.
// Last updated: Sprint 10 (2026-04-21) -- rewritten for password-auth flow

mod common;

use common::{spawn_app, spawn_app_with, TestOpts};

// ── Register ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn register_and_login_issues_cookie() {
    let app = spawn_app().await;
    let cookie = app.register_teacher("alice@example.test", "alice", "correct-password-123").await;
    assert!(!cookie.is_empty());
    app.shutdown().await;
}

#[tokio::test]
async fn register_rejects_invalid_slug() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "ad", "password": "test-passphrase-12"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn register_rejects_reserved_slug() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "admin", "password": "test-passphrase-12"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn register_409_on_slug_taken() {
    let app = spawn_app().await;
    let _ = app.signup("a@example.test", "alice").await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "b@example.test", "slug": "alice", "password": "test-passphrase-12"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "slug_taken");
    assert!(body["suggestions"].as_array().unwrap().len() >= 1);
    app.shutdown().await;
}

#[tokio::test]
async fn register_409_on_email_taken() {
    let app = spawn_app().await;
    let _ = app.signup("dup@example.test", "slot-a").await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "dup@example.test", "slug": "slot-b", "password": "test-passphrase-12"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "email_taken");
    app.shutdown().await;
}

#[tokio::test]
async fn register_password_too_short() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "valid-slug", "password": "short12345"})) // 10 chars
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "password_too_short");
    app.shutdown().await;
}

#[tokio::test]
async fn register_password_exactly_11_chars_rejected() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "valid-slug", "password": "11charpass!"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "password_too_short");
    app.shutdown().await;
}

#[tokio::test]
async fn register_password_exactly_12_chars_accepted() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "valid-slug", "password": "12charpass!!"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "body: {}", r.text().await.unwrap());
    app.shutdown().await;
}

#[tokio::test]
async fn register_password_exactly_128_chars_accepted() {
    let app = spawn_app().await;
    let pw = "a".repeat(128);
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "valid-slug", "password": pw}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "body: {}", r.text().await.unwrap());
    app.shutdown().await;
}

#[tokio::test]
async fn register_password_exactly_129_chars_rejected() {
    let app = spawn_app().await;
    let pw = "a".repeat(129);
    let r = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({"email": "x@test", "slug": "valid-slug", "password": pw}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "password_too_long");
    app.shutdown().await;
}

#[tokio::test]
async fn password_hash_not_stored_as_plaintext() {
    let app = spawn_app().await;
    let _ = app.register_teacher("x@test", "myslug", "my-secret-password").await;
    let (hash,): (String,) =
        sqlx::query_as("SELECT password_hash FROM teachers WHERE email = 'x@test'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_ne!(hash, "my-secret-password");
    assert!(hash.starts_with("$argon2id$"));
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
    let retry = r
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .expect("Retry-After")
        .to_str()
        .unwrap();
    assert!(retry.parse::<u32>().is_ok(), "Retry-After should be seconds");
    app.shutdown().await;
}

// ── Login ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn login_unknown_email_returns_401() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "nobody@test", "password": "any-password-here"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn login_correct_email_wrong_password_returns_401() {
    let app = spawn_app().await;
    let _ = app.register_teacher("t@test", "myroom", "correct-password-123").await;
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "t@test", "password": "wrong-password-xyz"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn login_null_hash_reset_disabled_returns_401_invalid_credentials() {
    let app = spawn_app().await;
    let _ = app.insert_teacher_no_password("null@test", "nullroom").await;
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "null@test", "password": "any-password-here"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["message"], "invalid credentials");
    app.shutdown().await;
}

#[tokio::test]
async fn login_null_hash_reset_enabled_returns_401_no_password_set() {
    let opts = TestOpts { password_reset_enabled: true, ..Default::default() };
    let app = spawn_app_with(opts).await;
    let _ = app.insert_teacher_no_password("null@test", "nullroom").await;
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "null@test", "password": "any-password-here"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let body: serde_json::Value = r.json().await.unwrap();
    assert!(body["message"].as_str().unwrap().contains("no password set"));
    app.shutdown().await;
}

#[tokio::test]
async fn login_correct_credentials_issues_cookie() {
    let app = spawn_app().await;
    let _ = app.register_teacher("t@test", "myroom", "correct-password-123").await;
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "t@test", "password": "correct-password-123"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().get("set-cookie").is_some());
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["redirect"], "/teach/myroom");
    app.shutdown().await;
}

#[tokio::test]
async fn login_account_lockout_after_max_failures() {
    let opts = TestOpts { login_account_max_failures: 3, ..Default::default() };
    let app = spawn_app_with(opts).await;
    let _ = app.register_teacher("t@test", "myroom", "correct-password-123").await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (tid,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE email = 't@test'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    // Seed 3 failures via direct SQL (avoids DUMMY_PHC cost in test).
    for i in 0..3_i64 {
        sqlx::query(
            "INSERT INTO login_attempts (teacher_id, peer_ip, attempted_at, succeeded) VALUES (?, '127.0.0.1', ?, 0)",
        )
        .bind(tid)
        .bind(now - 100 + i)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    // The 4th attempt (via HTTP) should hit AccountLocked → 429.
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "t@test", "password": "wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 429);
    app.shutdown().await;
}

#[tokio::test]
async fn login_ip_throttle_fires_on_unknown_email() {
    let opts = TestOpts { login_ip_max_attempts: 3, ..Default::default() };
    let app = spawn_app_with(opts).await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    // Seed 3 IP attempts via SQL (unknown-email, teacher_id = NULL).
    for i in 0..3_i64 {
        sqlx::query(
            "INSERT INTO login_attempts (teacher_id, peer_ip, attempted_at, succeeded) VALUES (NULL, '127.0.0.1', ?, 0)",
        )
        .bind(now - 100 + i)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    // The 4th attempt should fire IpThrottled → 429.
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "nobody@test", "password": "any-pass-here"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 429);
    app.shutdown().await;
}

#[tokio::test]
async fn login_window_boundary_excluded() {
    // Strict > predicate: attempt at exactly now-window_secs is NOT counted.
    // We set max_failures = 2. We seed 1 boundary row (at now-window, excluded).
    // The HTTP attempt itself inserts 1 more row (in-window, counted: 1 total).
    // 1 < 2 → Allow → 401. If the boundary row were counted, total = 2 → 429.
    let opts = TestOpts { login_account_max_failures: 2, ..Default::default() };
    let app = spawn_app_with(opts).await;
    let _ = app.register_teacher("t@test", "myroom", "correct-password-123").await;
    let (tid,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE email = 't@test'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let window = app.state.config.login_account_window_secs;
    // Insert a failure at exactly the boundary second — should NOT count.
    sqlx::query(
        "INSERT INTO login_attempts (teacher_id, peer_ip, attempted_at, succeeded) VALUES (?, '127.0.0.1', ?, 0)",
    )
    .bind(tid)
    .bind(now - window)
    .execute(&app.state.db)
    .await
    .unwrap();
    // The HTTP attempt adds 1 counted failure (the boundary row is excluded).
    // Total in-window failures = 1 < max_failures(2) → Allow → 401.
    let r = app
        .client
        .post(app.url("/auth/login"))
        .json(&serde_json::json!({"email": "t@test", "password": "wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401, "boundary attempt should not count; expected 401 not 429");
    app.shutdown().await;
}

// ── Logout ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn logout_no_cookie_returns_401() {
    let app = spawn_app().await;
    let r = app.client.post(app.url("/auth/logout")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn logout_valid_cookie_succeeds_and_clears_cookie() {
    let app = spawn_app().await;
    let cookie = app.register_teacher("t@test", "myroom", "test-passphrase-12").await;
    let r = app
        .client
        .post(app.url("/auth/logout"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let set = r
        .headers()
        .get("set-cookie")
        .expect("Set-Cookie on logout")
        .to_str()
        .unwrap();
    assert!(set.contains("Max-Age=0"), "logout must expire cookie");
    app.shutdown().await;
}

#[tokio::test]
async fn logout_second_call_returns_401() {
    let app = spawn_app().await;
    let cookie = app.register_teacher("t@test", "myroom", "test-passphrase-12").await;
    let r1 = app
        .client
        .post(app.url("/auth/logout"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r1.status(), 204);
    let r2 = app
        .client
        .post(app.url("/auth/logout"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), 401);
    app.shutdown().await;
}

// ── Magic-link gate ──────────────────────────────────────────────────────────

#[tokio::test]
async fn get_verify_returns_403_when_reset_disabled() {
    let app = spawn_app().await;
    let r = app.client.get(app.url("/auth/verify")).send().await.unwrap();
    assert_eq!(r.status(), 403);
    app.shutdown().await;
}

#[tokio::test]
async fn post_consume_returns_403_when_reset_disabled() {
    let app = spawn_app().await;
    let r = app
        .client
        .post(app.url("/auth/consume"))
        .json(&serde_json::json!({"token": "deadbeef"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    app.shutdown().await;
}

#[tokio::test]
async fn consume_rejects_unknown_token_when_reset_enabled() {
    let opts = TestOpts { password_reset_enabled: true, ..Default::default() };
    let app = spawn_app_with(opts).await;
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
