// File: server/tests/ws_headphones.rs
// Purpose: Integration tests for the HeadphonesConfirmed handler.
//          Covers the happy path (chip update to teacher), role guard
//          (teacher cannot send it), and ordering guard (must send
//          LobbyJoin first, otherwise entry_id is absent).
// Last updated: Sprint 9 (2026-04-19) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};
use futures_util::StreamExt as _;

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
// Duplicate confirm idempotence — second confirm produces no second broadcast
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_headphones_confirmed_suppresses_second_broadcast() {
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
    let _ = recv_json(&mut teacher).await; // lobby_state with student

    // First confirm — teacher receives exactly one broadcast.
    send_ws(&mut student, &serde_json::json!({"type":"headphones_confirmed"})).await;
    let u1 = recv_json(&mut teacher).await;
    assert_eq!(u1["entries"][0]["headphones_confirmed"], true);

    // Second confirm — state already true; server must NOT broadcast again.
    send_ws(&mut student, &serde_json::json!({"type":"headphones_confirmed"})).await;

    // Verify no second broadcast: a short-window timeout on teacher's WS must expire.
    // We use a 200 ms deadline — enough for the duplicate to be processed server-side
    // without waiting a full 2 s for the normal recv_json timeout.
    let no_extra = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        teacher.next(),
    ).await;
    assert!(no_extra.is_err(), "teacher must NOT receive a second lobby_state for duplicate confirm");
}

// ---------------------------------------------------------------------------
// Post-admission confirm — entry has moved out of lobby → entry_not_found
// ---------------------------------------------------------------------------

#[tokio::test]
async fn headphones_confirmed_after_admission_returns_entry_not_found() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await; // lobby_state

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

    // Admit the student — this moves the entry from lobby to active_session.
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_admit","slug":"alice","entry_id":entry_id}),
    )
    .await;
    let _ = recv_json(&mut student).await; // admitted
    let _ = recv_json(&mut student).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // peer_connected
    let _ = recv_json(&mut teacher).await; // lobby_state (empty)

    // Now student sends HeadphonesConfirmed — entry is gone from lobby.
    send_ws(&mut student, &serde_json::json!({"type":"headphones_confirmed"})).await;
    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "entry_not_found");
}

// ---------------------------------------------------------------------------
// Role guard — student sends HeadphonesConfirmed without LobbyJoin first
// ---------------------------------------------------------------------------

#[tokio::test]
async fn headphones_confirmed_without_lobby_join_returns_not_in_session() {
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
