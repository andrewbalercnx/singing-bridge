// File: server/tests/ws_chat.rs
// Purpose: Integration tests for Chat and LobbyMessage handlers.
//          Covers relay, auth, validation, and failure paths.
// Last updated: Sprint 7 (2026-04-18) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};

/// Admit a student into the teacher's room and drain the handshake messages.
/// Returns (teacher_ws, student_ws, entry_id).
async fn make_session(
    app: &common::TestApp,
    cookie: &str,
) -> (
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let mut teacher = app.open_ws(Some(cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await; // lobby_state (empty)

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

    let _ = recv_json(&mut student).await; // admitted
    let _ = recv_json(&mut student).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // lobby_state (empty)

    (teacher, student)
}

// ---------------------------------------------------------------------------
// Chat relay
// ---------------------------------------------------------------------------

#[tokio::test]
async fn teacher_chat_relayed_to_both() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, mut student) = make_session(&app, &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({"type":"chat","text":"hello"})).await;

    // Teacher gets own echo.
    let teacher_msg = recv_json(&mut teacher).await;
    assert_eq!(teacher_msg["type"], "chat");
    assert_eq!(teacher_msg["from"], "teacher");
    assert_eq!(teacher_msg["text"], "hello");

    // Student receives it.
    let student_msg = recv_json(&mut student).await;
    assert_eq!(student_msg["type"], "chat");
    assert_eq!(student_msg["from"], "teacher");
    assert_eq!(student_msg["text"], "hello");

    app.shutdown().await;
}

#[tokio::test]
async fn student_chat_relayed_to_both() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, mut student) = make_session(&app, &cookie).await;

    send_ws(&mut student, &serde_json::json!({"type":"chat","text":"hi teacher"})).await;

    let student_echo = recv_json(&mut student).await;
    assert_eq!(student_echo["from"], "student");
    assert_eq!(student_echo["text"], "hi teacher");

    let teacher_recv = recv_json(&mut teacher).await;
    assert_eq!(teacher_recv["from"], "student");
    assert_eq!(teacher_recv["text"], "hi teacher");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_empty_text_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, _student) = make_session(&app, &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({"type":"chat","text":""})).await;

    let err = recv_json(&mut teacher).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "payload_too_large");

    app.shutdown().await;
}

#[tokio::test]
async fn chat_501_chars_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, _student) = make_session(&app, &cookie).await;

    let long: String = "a".repeat(501);
    send_ws(&mut teacher, &serde_json::json!({"type":"chat","text":long})).await;

    let err = recv_json(&mut teacher).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "payload_too_large");

    app.shutdown().await;
}

#[tokio::test]
async fn chat_500_chars_accepted() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, mut student) = make_session(&app, &cookie).await;

    let exactly500: String = "a".repeat(500);
    send_ws(&mut teacher, &serde_json::json!({"type":"chat","text":exactly500})).await;

    let msg = recv_json(&mut teacher).await;
    assert_eq!(msg["type"], "chat");
    let _ = recv_json(&mut student).await; // echo to student

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Chat with no active session
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_without_session_returns_not_in_session() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    send_ws(&mut teacher, &serde_json::json!({"type":"chat","text":"hello?"})).await;
    let err = recv_json(&mut teacher).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "not_in_session");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// LobbyMessage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lobby_message_delivered_to_waiting_student() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
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
        &serde_json::json!({"type":"lobby_message","entry_id":entry_id,"text":"be right with you"}),
    )
    .await;

    let msg = recv_json(&mut student).await;
    assert_eq!(msg["type"], "lobby_message");
    assert_eq!(msg["text"], "be right with you");

    app.shutdown().await;
}

#[tokio::test]
async fn lobby_message_unknown_entry_returns_not_found() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    let fake_id = uuid::Uuid::new_v4().to_string();
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_message","entry_id":fake_id,"text":"hello"}),
    )
    .await;

    let err = recv_json(&mut teacher).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "entry_not_found");

    app.shutdown().await;
}

#[tokio::test]
async fn lobby_message_student_cannot_send() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
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
    let _ = recv_json(&mut teacher).await; // lobby_state update

    // Student tries to send a lobby_message — must get NotOwner.
    let fake_id = uuid::Uuid::new_v4().to_string();
    send_ws(
        &mut student,
        &serde_json::json!({"type":"lobby_message","entry_id":fake_id,"text":"hi"}),
    )
    .await;

    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "not_owner");

    app.shutdown().await;
}
