// File: server/tests/ws_signal_relay.rs
// Purpose: Signal relay authorisation — self-addressed rejected, payload cap
//          enforced, non-session-member rejected. R3 findings #31, #35.
//          Sprint 4 adds an ICE-restart opacity test: the relay must
//          forward an "ice-restart-flavoured" SDP offer unchanged, pinning
//          that Sprint 4's client-side reconnect does not require server
//          changes.
// Last updated: Sprint 4 (2026-04-17) -- +ICE-restart opacity test

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
async fn ice_restart_offer_relays_opaquely() {
    // Sprint 4: pin that the signal relay is opaque with respect to SDP
    // shape. Client-side ICE restart produces a new offer with a fresh
    // ice-ufrag + ice-pwd; the server must forward it unchanged so the
    // teacher side can answer.
    let app = spawn_app().await;
    let (mut teacher, mut student) = admit_pair(&app).await;

    let restart_sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n\
        m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendrecv\r\n\
        a=ice-ufrag:NEW_UFRAG\r\na=ice-pwd:NEW_PWD_FOR_RESTART\r\n\
        a=rtpmap:111 opus/48000/2\r\n";
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"signal",
            "to":"teacher",
            "payload":{"sdp":{"type":"offer","sdp":restart_sdp}}
        }),
    )
    .await;
    let relayed = recv_json(&mut teacher).await;
    assert_eq!(relayed["type"], "signal");
    assert_eq!(relayed["payload"]["sdp"]["type"], "offer");
    assert_eq!(relayed["payload"]["sdp"]["sdp"], restart_sdp);
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
