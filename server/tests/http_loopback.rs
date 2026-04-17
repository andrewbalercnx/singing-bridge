// File: server/tests/http_loopback.rs
// Purpose: Verifies the /loopback route returns HTML in dev and 404 in prod;
//          also asserts the io::Error propagation path and the absence of
//          COOP/COEP headers (MessagePort-only transport, finding #11).
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

mod common;

use common::{spawn_app, spawn_app_with, TestOpts};
use singing_bridge_server::http::security_headers::EXPECTED_CSP;

#[tokio::test]
async fn test_dev_loopback_serves_html() {
    let app = spawn_app().await;
    let (status, headers, body) = app.get_html("/loopback", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let ct = headers
        .get("content-type")
        .expect("content-type")
        .to_str()
        .unwrap();
    assert!(ct.contains("text/html"), "content-type: {ct}");
    assert!(
        body.trim_start().to_ascii_lowercase().starts_with("<!doctype"),
        "body does not start with <!doctype"
    );
    assert!(
        body.contains(r#"id="loopback-start""#),
        "loopback page missing #loopback-start"
    );
    // Finding #11 regression guard: no COOP/COEP (MessagePort transport only).
    assert!(
        !headers.contains_key("cross-origin-opener-policy"),
        "unexpected COOP header on /loopback"
    );
    assert!(
        !headers.contains_key("cross-origin-embedder-policy"),
        "unexpected COEP header on /loopback"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn test_prod_loopback_returns_404() {
    let app = spawn_app_with(TestOpts { dev: false, ..Default::default() }).await;
    let (status, headers, _body) = app.get_html("/loopback", None).await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        headers
            .get("content-security-policy")
            .expect("CSP present on 404")
            .to_str()
            .unwrap(),
        EXPECTED_CSP
    );
    app.shutdown().await;
}

#[tokio::test]
async fn test_loopback_missing_file_returns_internal_error() {
    let empty_dir = tempfile::tempdir().unwrap();
    let app = spawn_app_with(TestOpts {
        dev: true,
        static_dir: Some(empty_dir.path().to_path_buf()),
        ..Default::default()
    })
    .await;
    let (status, _headers, body) = app.get_html("/loopback", None).await;
    assert_eq!(status, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    let json: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(json["code"], "internal", "expected code=internal, got: {json}");
    drop(empty_dir);
    app.shutdown().await;
}
