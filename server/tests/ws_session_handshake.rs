// File: server/tests/ws_session_handshake.rs
// Purpose: Full signalling handshake — lobby_join → admit → signal relay
//          → disconnect cleanup. Covers the SPRINTS.md exit criterion at
//          the signalling layer.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};

#[tokio::test]
async fn full_sdp_exchange_over_signalling() {
    let app = spawn_app().await;
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
            "email":"s@example.test","browser":"F/1","device_class":"desktop"
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

    // Student gets "admitted" then "peer_connected"
    let admitted = recv_json(&mut student).await;
    assert_eq!(admitted["type"], "admitted");
    let pc_s = recv_json(&mut student).await;
    assert_eq!(pc_s["type"], "peer_connected");
    // Teacher gets "peer_connected" + updated lobby_state
    let pc_t = recv_json(&mut teacher).await;
    assert_eq!(pc_t["type"], "peer_connected");
    let _ = recv_json(&mut teacher).await;

    // Student sends a signal to teacher; teacher receives with from=student.
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"signal","to":"teacher",
            "payload":{"sdp":{"type":"offer","sdp":"v=0"}}
        }),
    )
    .await;
    let relayed = recv_json(&mut teacher).await;
    assert_eq!(relayed["type"], "signal");
    assert_eq!(relayed["from"], "student");

    // Teacher replies; student receives with from=teacher.
    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type":"signal","to":"student",
            "payload":{"sdp":{"type":"answer","sdp":"v=0"}}
        }),
    )
    .await;
    let back = recv_json(&mut student).await;
    assert_eq!(back["type"], "signal");
    assert_eq!(back["from"], "teacher");

    app.shutdown().await;
}

#[tokio::test]
async fn student_disconnect_clears_session() {
    let app = spawn_app().await;
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
            "email":"s@example.test","browser":"F/1","device_class":"desktop"
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
    let _ = recv_json(&mut teacher).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // updated lobby_state (empty)

    drop(student);

    let peer_gone = recv_json(&mut teacher).await;
    assert_eq!(peer_gone["type"], "peer_disconnected");

    app.shutdown().await;
}
