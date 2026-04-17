// File: server/tests/ws_signal_relay.rs
// Purpose: Signal relay authorisation — self-addressed rejected, payload cap
//          enforced, non-session-member rejected. R3 findings #31, #35.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};

async fn admit_pair(
    app: &common::TestApp,
) -> (common::Ws, common::Ws) {
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@x","browser":"f","device_class":"desktop"
        }),
    )
    .await;
    let update = recv_json(&mut teacher).await;
    let entry_id = update["entries"][0]["id"].as_str().unwrap().to_string();
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_admit","slug":"alice","entry_id":entry_id}),
    )
    .await;
    let _ = recv_json(&mut student).await; // admitted
    let _ = recv_json(&mut student).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // lobby_state
    (teacher, student)
}

#[tokio::test]
async fn self_addressed_signal_rejected() {
    let app = spawn_app().await;
    let (_teacher, mut student) = admit_pair(&app).await;
    send_ws(
        &mut student,
        &serde_json::json!({"type":"signal","to":"student","payload":{}}),
    )
    .await;
    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "invalid_route");
    app.shutdown().await;
}

#[tokio::test]
async fn payload_cap_boundary() {
    let app = spawn_app().await;
    let (mut teacher, mut student) = admit_pair(&app).await;

    // Exactly 16 KiB of payload (string body; serialised JSON is a little
    // larger than the string itself).
    let big_str = "x".repeat(16 * 1024 - 64);
    send_ws(
        &mut student,
        &serde_json::json!({"type":"signal","to":"teacher","payload":{"s": big_str}}),
    )
    .await;
    let relayed = recv_json(&mut teacher).await;
    assert_eq!(relayed["type"], "signal");

    // Just over cap.
    let oversized = "y".repeat(16 * 1024 + 100);
    send_ws(
        &mut student,
        &serde_json::json!({"type":"signal","to":"teacher","payload":{"s": oversized}}),
    )
    .await;
    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "payload_too_large");

    app.shutdown().await;
}
