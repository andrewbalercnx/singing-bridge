// File: server/tests/ws_acoustic_profile.rs
// Purpose: Integration tests for Sprint 20 acoustic profile features:
//          LobbyJoin with acoustic_profile, SetAcousticProfile (teacher override),
//          ChattingMode relay, HeadphonesConfirmed no-op for IosForced, role guards.
// Last updated: Sprint 20 (2026-04-25) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app, make_session};
use futures_util::StreamExt as _;

// ---------------------------------------------------------------------------
// LobbyJoin with ios_forced acoustic_profile
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lobby_join_with_ios_forced_profile_visible_to_teacher() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await; // initial lobby_state

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type": "lobby_join",
        "slug": "alice",
        "email": "s@example.test",
        "browser": "CriOS/120",
        "device_class": "phone",
        "acoustic_profile": "ios_forced"
    })).await;

    let update = recv_json(&mut teacher).await;
    assert_eq!(update["type"], "lobby_state");
    assert_eq!(update["entries"][0]["acoustic_profile"], "ios_forced");
}

#[tokio::test]
async fn lobby_join_without_acoustic_profile_defaults_to_speakers() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type": "lobby_join",
        "slug": "alice",
        "email": "s@example.test",
        "browser": "Chrome/120",
        "device_class": "desktop"
    })).await;

    let update = recv_json(&mut teacher).await;
    assert_eq!(update["type"], "lobby_state");
    assert_eq!(update["entries"][0]["acoustic_profile"], "speakers");
}

// ---------------------------------------------------------------------------
// HeadphonesConfirmed is a no-op for IosForced (no second broadcast)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn headphones_confirmed_noop_for_ios_forced() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type": "lobby_join",
        "slug": "alice",
        "email": "s@example.test",
        "browser": "CriOS/120",
        "device_class": "phone",
        "acoustic_profile": "ios_forced"
    })).await;
    let _ = recv_json(&mut teacher).await; // lobby_state with ios_forced

    // iOS student (incorrectly) sends HeadphonesConfirmed — must be silent no-op.
    send_ws(&mut student, &serde_json::json!({"type":"headphones_confirmed"})).await;

    // Teacher must NOT receive a second lobby_state.
    let no_extra = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        teacher.next(),
    ).await;
    assert!(no_extra.is_err(), "teacher must not receive broadcast for IosForced HeadphonesConfirmed");
}

// ---------------------------------------------------------------------------
// SetAcousticProfile — teacher can override lobby entry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn teacher_set_acoustic_profile_lobby_entry() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type": "lobby_join",
        "slug": "alice",
        "email": "s@example.test",
        "browser": "Chrome/120",
        "device_class": "desktop"
    })).await;

    let update = recv_json(&mut teacher).await;
    let entry_id = update["entries"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(update["entries"][0]["acoustic_profile"], "speakers");

    // Teacher overrides the profile to headphones.
    send_ws(&mut teacher, &serde_json::json!({
        "type": "set_acoustic_profile",
        "entry_id": entry_id,
        "profile": "headphones"
    })).await;

    let lobby_update = recv_json(&mut teacher).await;
    assert_eq!(lobby_update["type"], "lobby_state");
    assert_eq!(lobby_update["entries"][0]["acoustic_profile"], "headphones");
}

// ---------------------------------------------------------------------------
// SetAcousticProfile — teacher can override active-session entry; both peers notified
// ---------------------------------------------------------------------------

#[tokio::test]
async fn teacher_set_acoustic_profile_in_session_notifies_both_peers() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, mut student) = make_session(&app, "alice", &cookie).await;

    // Teacher gets a lobby_state with 1 entry (the admitted student now in session).
    // The active session entry id is surfaced in LobbyState entries:
    // we need to look it up. Read the current lobby state first.
    // (make_session already consumed the peer_connected + lobby_state;
    //  we get the entry_id by querying state directly instead.)
    // Easier: teacher sends a lobby_watch refresh — but a shortcut is to use
    // the slot in active_session. We instead look it up via a second LobbyState:
    // send a no-op that triggers none. Instead use the in-memory state.
    // Simplest: re-read it from the last lobby_state in make_session.
    // make_session returns (teacher, student) after consuming all init messages.
    // The lobby_state after admit has 0 lobby entries (student moved to session).
    // We need the active_session entry id — it is not in the lobby anymore.
    // Query the room state directly.
    use singing_bridge_server::state::SlugKey;
    let slug_key = SlugKey::new("alice").unwrap();
    let room = app.state.room(&slug_key).unwrap();
    let entry_id = {
        let rs = room.read().await;
        rs.active_session.as_ref().unwrap().student.id.0.to_string()
    };

    send_ws(&mut teacher, &serde_json::json!({
        "type": "set_acoustic_profile",
        "entry_id": entry_id,
        "profile": "headphones"
    })).await;

    // Teacher receives lobby_state + acoustic_profile_changed.
    let m1 = recv_json(&mut teacher).await;
    let m2 = recv_json(&mut teacher).await;
    let t1 = m1["type"].as_str().unwrap_or("");
    let t2 = m2["type"].as_str().unwrap_or("");
    assert!(
        t1 == "lobby_state" || t2 == "lobby_state",
        "teacher should receive lobby_state (got {t1}, {t2})"
    );
    assert!(
        t1 == "acoustic_profile_changed" || t2 == "acoustic_profile_changed",
        "teacher should receive acoustic_profile_changed (got {t1}, {t2})"
    );

    // Student receives acoustic_profile_changed.
    let student_msg = recv_json(&mut student).await;
    assert_eq!(student_msg["type"], "acoustic_profile_changed");
    assert_eq!(student_msg["profile"], "headphones");
}

// ---------------------------------------------------------------------------
// SetAcousticProfile — student cannot call it (Forbidden)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn student_set_acoustic_profile_forbidden() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type": "lobby_join",
        "slug": "alice",
        "email": "s@example.test",
        "browser": "Chrome/120",
        "device_class": "desktop"
    })).await;
    let update = recv_json(&mut teacher).await;
    let entry_id = update["entries"][0]["id"].as_str().unwrap().to_string();

    // Student tries to call set_acoustic_profile.
    send_ws(&mut student, &serde_json::json!({
        "type": "set_acoustic_profile",
        "entry_id": entry_id,
        "profile": "headphones"
    })).await;

    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "forbidden");
}

// ---------------------------------------------------------------------------
// ChattingMode — teacher relays to session student
// ---------------------------------------------------------------------------

#[tokio::test]
async fn teacher_chatting_mode_relayed_to_student() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, mut student) = make_session(&app, "alice", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({"type":"chatting_mode","enabled":true})).await;

    let msg = recv_json(&mut student).await;
    assert_eq!(msg["type"], "chatting_mode");
    assert_eq!(msg["enabled"], true);
}

#[tokio::test]
async fn teacher_chatting_mode_disabled_relayed_to_student() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (mut teacher, mut student) = make_session(&app, "alice", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({"type":"chatting_mode","enabled":false})).await;

    let msg = recv_json(&mut student).await;
    assert_eq!(msg["type"], "chatting_mode");
    assert_eq!(msg["enabled"], false);
}

// ---------------------------------------------------------------------------
// ChattingMode — student cannot send it (Forbidden)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn student_chatting_mode_forbidden() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;
    let (_teacher, mut student) = make_session(&app, "alice", &cookie).await;

    send_ws(&mut student, &serde_json::json!({"type":"chatting_mode","enabled":true})).await;

    let err = recv_json(&mut student).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "forbidden");
}

// ---------------------------------------------------------------------------
// ChattingMode — no active session returns NotInSession
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chatting_mode_no_session_returns_not_in_session() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    send_ws(&mut teacher, &serde_json::json!({"type":"chatting_mode","enabled":true})).await;

    let err = recv_json(&mut teacher).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "not_in_session");
}

// ---------------------------------------------------------------------------
// SetAcousticProfile — unknown profile normalizes to speakers
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_acoustic_profile_unknown_normalizes_to_speakers() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(&mut teacher, &serde_json::json!({"type":"lobby_watch","slug":"alice"})).await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    send_ws(&mut student, &serde_json::json!({
        "type": "lobby_join",
        "slug": "alice",
        "email": "s@example.test",
        "browser": "Chrome/120",
        "device_class": "desktop",
        "acoustic_profile": "headphones"
    })).await;
    let update = recv_json(&mut teacher).await;
    let entry_id = update["entries"][0]["id"].as_str().unwrap().to_string();

    // Send unknown profile value — serde should not reject (has #[serde(other)]),
    // and server normalizes to speakers.
    send_ws(&mut teacher, &serde_json::json!({
        "type": "set_acoustic_profile",
        "entry_id": entry_id,
        "profile": "unknown_future_value"
    })).await;

    let lobby_update = recv_json(&mut teacher).await;
    assert_eq!(lobby_update["type"], "lobby_state");
    assert_eq!(lobby_update["entries"][0]["acoustic_profile"], "speakers");
}
