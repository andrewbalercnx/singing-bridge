// File: server/tests/http_csp.rs
// Purpose: Strict CSP is present on every HTML route; verify page has no
//          inline script. R2 finding #29, R3 finding #44.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::spawn_app;
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

#[tokio::test]
async fn verify_html_has_no_inline_script() {
    let app = spawn_app().await;
    let r = app.client.get(app.url("/auth/verify")).send().await.unwrap();
    let body = r.text().await.unwrap();
    // Every <script must carry src=, and there must be no inline on* handlers.
    let script_tags: Vec<&str> = body.match_indices("<script").map(|(i, _)| &body[i..]).collect();
    for s in &script_tags {
        let head = s.split('>').next().unwrap_or("");
        assert!(head.contains("src="), "inline <script> in body: {head}");
    }
    assert!(
        !body.contains("onerror="),
        "inline event handler attribute in body"
    );
    assert!(!body.contains("onload="));
    app.shutdown().await;
}

#[tokio::test]
async fn all_html_responses_carry_csp() {
    let app = spawn_app().await;
    for path in ["/", "/signup", "/auth/verify"] {
        let r = app.client.get(app.url(path)).send().await.unwrap();
        assert!(r.headers().contains_key("content-security-policy"), "path: {path}");
    }
    app.shutdown().await;
}
