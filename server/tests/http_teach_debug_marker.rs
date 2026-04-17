// File: server/tests/http_teach_debug_marker.rs
// Purpose: Verifies the server injects (or withholds) the sb-debug meta tag
//          correctly and that both HTML pages carry the required DOM structure.
// Last updated: Sprint 3 (2026-04-17) -- +remote/local video + playsinline asserts

mod common;

use common::{spawn_app, spawn_app_with, TestOpts};
use singing_bridge_server::http::security_headers::EXPECTED_CSP;

#[tokio::test]
async fn test_dev_teach_html_carries_debug_marker_student_view() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@test.example", "myroom").await;
    // Student view: no cookie
    let (status, headers, body) = app.get_html("/teach/myroom", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(headers.contains_key("content-security-policy"));
    assert_eq!(
        headers.get("content-security-policy").unwrap().to_str().unwrap(),
        EXPECTED_CSP
    );
    assert!(
        body.contains(r#"<meta name="sb-debug""#),
        "dev student view missing sb-debug meta tag"
    );
    assert!(
        !body.contains("<!-- sb:debug -->"),
        "dev student view still has placeholder"
    );
    // Structural assertions (Sprint 2 finding #2, finding #21; Sprint 3 extensions)
    assert!(body.contains(r#"id="remote-audio""#), "student.html missing #remote-audio");
    assert!(body.contains(r#"id="unmute-audio""#), "student.html missing #unmute-audio");
    assert!(body.contains(r#"id="remote-video""#), "student.html missing #remote-video");
    assert!(body.contains(r#"id="local-video""#), "student.html missing #local-video");
    // playsinline on both video elements (R2 iOS full-screen risk).
    let remote_idx = body.find(r#"id="remote-video""#).unwrap();
    let local_idx = body.find(r#"id="local-video""#).unwrap();
    let remote_tag_end = remote_idx + body[remote_idx..].find('>').unwrap();
    let local_tag_end = local_idx + body[local_idx..].find('>').unwrap();
    assert!(
        body[remote_idx..remote_tag_end].contains("playsinline"),
        "student.html #remote-video missing playsinline"
    );
    assert!(
        body[local_idx..local_tag_end].contains("playsinline"),
        "student.html #local-video missing playsinline"
    );
    drop(cookie);
    app.shutdown().await;
}

#[tokio::test]
async fn test_dev_teach_html_carries_debug_marker_teacher_view() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teacher@test.example", "myroom").await;
    // Teacher view: authenticated cookie
    let (status, headers, body) = app.get_html("/teach/myroom", Some(&cookie)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(headers.contains_key("content-security-policy"));
    assert!(
        body.contains(r#"<meta name="sb-debug""#),
        "dev teacher view missing sb-debug meta tag"
    );
    assert!(
        !body.contains("<!-- sb:debug -->"),
        "dev teacher view still has placeholder"
    );
    assert!(body.contains(r#"id="remote-audio""#), "teacher.html missing #remote-audio");
    assert!(body.contains(r#"id="unmute-audio""#), "teacher.html missing #unmute-audio");
    assert!(body.contains(r#"id="remote-video""#), "teacher.html missing #remote-video");
    assert!(body.contains(r#"id="local-video""#), "teacher.html missing #local-video");
    let remote_idx = body.find(r#"id="remote-video""#).unwrap();
    let local_idx = body.find(r#"id="local-video""#).unwrap();
    let remote_tag_end = remote_idx + body[remote_idx..].find('>').unwrap();
    let local_tag_end = local_idx + body[local_idx..].find('>').unwrap();
    assert!(
        body[remote_idx..remote_tag_end].contains("playsinline"),
        "teacher.html #remote-video missing playsinline"
    );
    assert!(
        body[local_idx..local_tag_end].contains("playsinline"),
        "teacher.html #local-video missing playsinline"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn test_prod_teach_html_has_no_debug_marker() {
    let app = spawn_app_with(TestOpts { dev: false, ..Default::default() }).await;
    let cookie = app.signup_teacher("teacher@test.example", "myroom").await;
    let (status, headers, body) = app.get_html("/teach/myroom", None).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(headers.contains_key("content-security-policy"));
    assert_eq!(
        headers.get("content-security-policy").unwrap().to_str().unwrap(),
        EXPECTED_CSP
    );
    // In prod the server strips the placeholder entirely; neither the
    // comment nor the injected meta tag should reach the client.
    assert!(
        !body.contains("<!-- sb:debug -->"),
        "prod view must not serve the sb:debug placeholder comment"
    );
    assert!(
        !body.contains(r#"<meta name="sb-debug" content="1""#),
        "prod view must not carry the injected meta tag"
    );
    drop(cookie);
    app.shutdown().await;
}
