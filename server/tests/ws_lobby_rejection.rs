// File: server/tests/ws_lobby_rejection.rs
// Purpose: Teacher-initiated reject → Rejected msg + close code 1000.
// R1 finding #6, R2 finding #33.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};

#[tokio::test]
async fn reject_closes_student_with_1000() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _initial = recv_json(&mut teacher).await;

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
        &serde_json::json!({"type":"lobby_reject","slug":"alice","entry_id": entry_id}),
    )
    .await;

    // Student sees "rejected" then close frame with code 1000.
    let first = recv_json(&mut student).await;
    assert_eq!(first["type"], "rejected");
    let close = recv_json(&mut student).await;
    assert_eq!(close["__close_code"], 1000);

    app.shutdown().await;
}

#[tokio::test]
async fn reject_unknown_entry_id_errors_but_keeps_socket() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_reject","slug":"alice","entry_id": uuid::Uuid::new_v4()}),
    )
    .await;
    let msg = recv_json(&mut teacher).await;
    assert_eq!(msg["type"], "error");
    assert_eq!(msg["code"], "entry_not_found");

    app.shutdown().await;
}
