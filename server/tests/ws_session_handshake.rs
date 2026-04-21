// File: server/tests/ws_session_handshake.rs
// Purpose: Full signalling handshake — lobby_join → admit → signal relay
//          → disconnect cleanup. Covers the SPRINTS.md exit criterion at
//          the signalling layer.
// Last updated: Sprint 11 (2026-04-21) -- email validation + session_event persistence

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

#[tokio::test]
async fn lobby_join_invalid_email_closes_malformed() {
    let app = spawn_app().await;
    app.signup_teacher("t@example.test", "alice").await;

    for bad_email in ["notanemail", "ab", "@"] {
        let mut student = app.open_ws(None, None).await;
        send_ws(
            &mut student,
            &serde_json::json!({
                "type":"lobby_join","slug":"alice",
                "email": bad_email,"browser":"F/1","device_class":"desktop"
            }),
        )
        .await;
        // Connection should be closed after invalid email.
        use futures_util::StreamExt;
        let msg = student.next().await;
        assert!(
            msg.map(|m| matches!(m, Ok(tokio_tungstenite::tungstenite::Message::Close(_)))).unwrap_or(true),
            "expected close frame for email={bad_email}"
        );
    }
    app.shutdown().await;
}

#[tokio::test]
async fn session_event_row_has_ended_at_after_disconnect() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let teacher_id: i64 = sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'alice'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();

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
    let _ = recv_json(&mut teacher).await; // lobby_state

    drop(student);
    let _ = recv_json(&mut teacher).await; // peer_disconnected

    // Give async cleanup a moment to flush DB writes.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let row: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT ended_at FROM session_events WHERE teacher_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(teacher_id)
    .fetch_optional(&app.state.db)
    .await
    .unwrap();

    assert!(row.is_some(), "session_event row must exist");
    assert!(
        row.unwrap().0.is_some(),
        "ended_at must be set after student disconnect"
    );

    app.shutdown().await;
}
