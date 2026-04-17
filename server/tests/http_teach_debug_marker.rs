// File: server/tests/http_teach_debug_marker.rs
// Purpose: Verifies the server injects (or withholds) the sb-debug meta tag
//          correctly and that both HTML pages carry the required DOM structure.
//          Sprint 4 adds asserts for the new quality-badge, reconnect-banner,
//          and floor-violation elements.
// Last updated: Sprint 4 (2026-04-17) -- +quality badge, reconnect, floor asserts

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
    // muted on #local-video is critical: removing it causes immediate
    // self-audio feedback. This assertion would fail silently otherwise.
    assert!(
        body[local_idx..local_tag_end].contains("muted"),
        "student.html #local-video missing `muted` — self-audio feedback risk"
    );
    // Control buttons (mute / video-off / hangup) and tile container.
    assert!(body.contains(r#"id="mute""#), "student.html missing #mute button");
    assert!(body.contains(r#"id="video-off""#), "student.html missing #video-off button");
    assert!(body.contains(r#"id="hangup""#), "student.html missing #hangup button");
    assert!(body.contains(r#"class="tiles""#), "student.html missing .tiles container");
    // Landing-page gating notices (student-only).
    assert!(body.contains(r#"id="block-notice""#), "student.html missing #block-notice");
    assert!(body.contains(r#"id="degraded-notice""#), "student.html missing #degraded-notice");
    // Sprint 4: quality badge + reconnect banner + floor violation notice.
    assert!(body.contains(r#"id="quality-badge""#), "student.html missing #quality-badge");
    assert!(body.contains(r#"id="reconnect-banner""#), "student.html missing #reconnect-banner");
    assert!(body.contains(r#"id="floor-violation""#), "student.html missing #floor-violation");
    // Sprint 4: new script tags for adapt/quality/reconnect/session-core loaded in order.
    let adapt_idx = body.find(r#"src="/assets/adapt.js""#).expect("student.html missing adapt.js");
    let quality_idx = body.find(r#"src="/assets/quality.js""#).expect("student.html missing quality.js");
    let reconnect_idx = body.find(r#"src="/assets/reconnect.js""#).expect("student.html missing reconnect.js");
    let sessioncore_idx = body.find(r#"src="/assets/session-core.js""#).expect("student.html missing session-core.js");
    let signalling_idx = body.find(r#"src="/assets/signalling.js""#).expect("student.html missing signalling.js");
    assert!(adapt_idx < quality_idx, "adapt.js must load before quality.js");
    assert!(quality_idx < reconnect_idx, "quality.js must load before reconnect.js");
    assert!(reconnect_idx < sessioncore_idx, "reconnect.js must load before session-core.js");
    assert!(sessioncore_idx < signalling_idx, "session-core.js must load before signalling.js");
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
    assert!(
        body[local_idx..local_tag_end].contains("muted"),
        "teacher.html #local-video missing `muted` — self-audio feedback risk"
    );
    assert!(body.contains(r#"id="mute""#), "teacher.html missing #mute button");
    assert!(body.contains(r#"id="video-off""#), "teacher.html missing #video-off button");
    assert!(body.contains(r#"id="hangup""#), "teacher.html missing #hangup button");
    assert!(body.contains(r#"class="tiles""#), "teacher.html missing .tiles container");
    // Sprint 4: quality badge + reconnect banner + floor violation notice.
    assert!(body.contains(r#"id="quality-badge""#), "teacher.html missing #quality-badge");
    assert!(body.contains(r#"id="reconnect-banner""#), "teacher.html missing #reconnect-banner");
    assert!(body.contains(r#"id="floor-violation""#), "teacher.html missing #floor-violation");
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
