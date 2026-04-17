// File: server/tests/http_csp.rs
// Purpose: Strict CSP is present on every HTML route; verify pages have no
//          inline script. R2 finding #29, R3 finding #44.
// Last updated: Sprint 2 (2026-04-17) -- +dev/prod parameterisation + /loopback

mod common;

use common::{spawn_app, spawn_app_with, TestOpts};
use singing_bridge_server::http::security_headers::EXPECTED_CSP;

#[tokio::test]
async fn csp_header_is_strict() {
    let app = spawn_app().await;
    let r = app.client.get(app.url("/auth/verify")).send().await.unwrap();
    let csp = r
        .headers()
        .get("content-security-policy")
        .expect("csp header")
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(csp, EXPECTED_CSP);
    app.shutdown().await;
}

fn assert_no_inline_script(body: &str, path: &str) {
    let script_tags: Vec<&str> =
        body.match_indices("<script").map(|(i, _)| &body[i..]).collect();
    for s in &script_tags {
        let head = s.split('>').next().unwrap_or("");
        assert!(head.contains("src="), "inline <script> in {path}: {head}");
    }
    assert!(!body.contains("onerror="), "inline event handler in {path}");
    assert!(!body.contains("onload="), "inline event handler in {path}");
}

#[tokio::test]
async fn verify_html_has_no_inline_script() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@test.example", "myroom").await;

    // /auth/verify
    let body = app.client.get(app.url("/auth/verify")).send().await.unwrap()
        .text().await.unwrap();
    assert_no_inline_script(&body, "/auth/verify");

    // /teach/<slug> — both student view (no cookie) and teacher view
    let (_, _, body) = app.get_html("/teach/myroom", None).await;
    assert_no_inline_script(&body, "/teach/myroom (student)");
    let (_, _, body) = app.get_html("/teach/myroom", Some(&cookie)).await;
    assert_no_inline_script(&body, "/teach/myroom (teacher)");

    // /loopback (dev only)
    let body = app.client.get(app.url("/loopback")).send().await.unwrap()
        .text().await.unwrap();
    assert_no_inline_script(&body, "/loopback");

    drop(cookie);
    app.shutdown().await;
}

#[tokio::test]
async fn all_html_responses_carry_csp_dev() {
    let app = spawn_app().await;
    for path in ["/", "/signup", "/auth/verify", "/loopback"] {
        let r = app.client.get(app.url(path)).send().await.unwrap();
        assert!(
            r.headers().contains_key("content-security-policy"),
            "CSP missing on {path} (status {})",
            r.status()
        );
    }
    app.shutdown().await;
}

#[tokio::test]
async fn all_html_responses_carry_csp_prod() {
    let app = spawn_app_with(TestOpts { dev: false, ..Default::default() }).await;
    for path in ["/", "/signup", "/auth/verify"] {
        let r = app.client.get(app.url(path)).send().await.unwrap();
        assert!(
            r.headers().contains_key("content-security-policy"),
            "CSP missing on {path} (status {})",
            r.status()
        );
    }
    // /loopback returns 404 in prod but the error response still carries CSP.
    let r = app.client.get(app.url("/loopback")).send().await.unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(
        r.headers().contains_key("content-security-policy"),
        "CSP missing on 404 /loopback in prod"
    );
    app.shutdown().await;
}
