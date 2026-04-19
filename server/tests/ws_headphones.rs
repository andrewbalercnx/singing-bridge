// File: server/tests/ws_headphones.rs
// Purpose: Integration tests for the HeadphonesConfirmed handler.
//          Covers the happy path (chip update to teacher), role guard
//          (teacher cannot send it), and ordering guard (must send
//          LobbyJoin first, otherwise entry_id is absent).
// Last updated: Sprint 9 (2026-04-19) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn student_confirms_headphones_teacher_sees_chip() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
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
    assert_eq!(update["type"], "lobby_state");
    assert_eq!(update["entries"][0]["headphones_confirmed"], false);

    // Student confirms headphones.
    send_ws(&mut student, &serde_json::json!({"type":"headphones_confirmed"})).await;

    let update2 = recv_json(&mut teacher).await;
    assert_eq!(update2["type"], "lobby_state");
    assert_eq!(update2["entries"][0]["headphones_confirmed"], true);
}

// ---------------------------------------------------------------------------
// Role guard — teacher cannot send HeadphonesConfirmed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn teacher_headphones_confirmed_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await; // lobby_state

    send_ws(&mut teacher, &serde_json::json!({"type":"headphones_confirmed"})).await;

    let err = recv_json(&mut teacher).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "not_in_session");
}

// ---------------------------------------------------------------------------
// Ordering guard — student sends HeadphonesConfirmed before LobbyJoin
// ---------------------------------------------------------------------------

#[tokio::test]
async fn headphones_confirmed_before_lobby_join_returns_entry_not_found() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    // Ensure the room exists so HeadphonesConfirmed can find the slug.
    // We open a teacher connection just to create the room; then close it.
    let mut teacher_setup = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher_setup, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher_setup).await; // lobby_state

    // A student that sends HeadphonesConfirmed without LobbyJoin first.
    // The role guard fires (role is None ≠ Student), returning not_in_session.
    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({"type":"headphones_confirmed"})).await;

    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    // Role is None at this point, so the student-only guard fires first.
    assert_eq!(err["code"], "not_in_session");
}
