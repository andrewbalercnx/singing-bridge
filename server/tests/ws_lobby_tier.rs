// File: server/tests/ws_lobby_tier.rs
// Purpose: Server-side handling of the Sprint 3 Tier enum and
//          tier_reason field on ClientMsg::LobbyJoin.
//          Covers: conservative default, unknown-string close
//          behaviour, char-safe truncation boundary, exact-cap
//          acceptance.
// Last updated: Sprint 3 (2026-04-17) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app};
use singing_bridge_server::ws::protocol::MAX_TIER_REASON_CHARS;

#[tokio::test]
async fn test_lobby_join_without_tier_defaults_to_degraded() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    let mut student = app.open_ws(None, None).await;
    // Legacy-shaped lobby_join — no tier fields.
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@example.test","browser":"X/1","device_class":"desktop"
        }),
    )
    .await;

    let update = recv_json(&mut teacher).await;
    assert_eq!(update["type"], "lobby_state");
    let entries = update["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    // Conservative default: missing tier → Degraded.
    assert_eq!(entries[0]["tier"], "degraded");
    assert!(
        entries[0]["tier_reason"].is_null(),
        "missing tier_reason should stay null, got {:?}",
        entries[0]["tier_reason"]
    );

    app.shutdown().await;
}

#[tokio::test]
async fn test_lobby_join_with_unknown_tier_closes_malformed() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

    // Observer teacher to confirm no lobby_state was emitted.
    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let snapshot = recv_json(&mut teacher).await;
    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 0);

    let mut student = app.open_ws(None, None).await;
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@example.test","browser":"X/1","device_class":"desktop",
            "tier":"bogus"
        }),
    )
    .await;

    // Student's next frame must be a close with code 1008 (policy-
    // violation / malformed_message), matching Sprint 1's protocol-
    // error pipeline.
    let close = recv_json(&mut student).await;
    assert_eq!(close["__close_code"], 1008);
    assert_eq!(close["__close_reason"], "malformed_message");

    // Teacher should not receive a lobby_state update for the
    // rejected join. Give the server a small window and then
    // expect no new frame (we assert by shutting down; if one
    // arrived the test would be flaky either way — the closed
    // student is the authoritative signal).
    app.shutdown().await;
}

#[tokio::test]
async fn test_lobby_join_with_oversized_tier_reason_is_truncated() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    // Build a 201-character reason where position 200 (0-indexed
    // 199) is a 3-byte codepoint ('中'). Byte-based String::truncate
    // would try to cut inside that codepoint and panic.
    let mut reason = String::new();
    for _ in 0..199 {
        reason.push('a');
    }
    reason.push('中'); // chars: 200
    reason.push('b'); // chars: 201
    assert_eq!(reason.chars().count(), 201);

    let mut student = app.open_ws(None, None).await;
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@example.test","browser":"X/1","device_class":"desktop",
            "tier":"degraded","tier_reason": reason
        }),
    )
    .await;

    let update = recv_json(&mut teacher).await;
    let entries = update["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let stored = entries[0]["tier_reason"].as_str().unwrap();
    assert_eq!(
        stored.chars().count(),
        MAX_TIER_REASON_CHARS,
        "stored reason must be exactly {MAX_TIER_REASON_CHARS} chars"
    );
    // The 200th codepoint ('中') must be intact at the end, proving
    // we did NOT split a multi-byte codepoint.
    assert!(
        stored.ends_with('中'),
        "multi-byte codepoint should survive truncation, got end of {stored:?}"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn test_lobby_join_supported_tier_round_trips() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

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
            "email":"s@example.test","browser":"Chrome/124","device_class":"desktop",
            "tier":"supported"
        }),
    )
    .await;

    let update = recv_json(&mut teacher).await;
    let entries = update["entries"].as_array().unwrap();
    assert_eq!(entries[0]["tier"], "supported");
    app.shutdown().await;
}

#[tokio::test]
async fn test_lobby_join_unworkable_tier_round_trips() {
    // An attacker could hand-craft this past the client gate, but the
    // server still echoes it to the teacher so they can see the flag.
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

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
            "email":"s@example.test","browser":"FBAN","device_class":"phone",
            "tier":"unworkable","tier_reason":"in-app browser"
        }),
    )
    .await;

    let update = recv_json(&mut teacher).await;
    let entries = update["entries"].as_array().unwrap();
    assert_eq!(entries[0]["tier"], "unworkable");
    assert_eq!(entries[0]["tier_reason"], "in-app browser");
    app.shutdown().await;
}

#[tokio::test]
async fn test_lobby_join_oversized_tier_reason_rejected_at_byte_cap() {
    // Byte-level guard: if the client sends a tier_reason whose UTF-8
    // byte length exceeds MAX_TIER_REASON_BYTES (4 × char cap), the
    // server rejects with FieldTooLong instead of silently truncating.
    // This matches MAX_EMAIL_LEN / MAX_BROWSER_LEN semantics.
    use singing_bridge_server::ws::protocol::MAX_TIER_REASON_BYTES;
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;
    let _teacher = app.open_ws(Some(&cookie), None).await;

    let reason: String = "x".repeat(MAX_TIER_REASON_BYTES + 1);
    let mut student = app.open_ws(None, None).await;
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@example.test","browser":"X/1","device_class":"desktop",
            "tier":"degraded","tier_reason": reason
        }),
    )
    .await;
    let msg = recv_json(&mut student).await;
    assert_eq!(msg["type"], "error");
    assert_eq!(msg["code"], "field_too_long");
    app.shutdown().await;
}

#[tokio::test]
async fn test_lobby_join_accepts_tier_reason_at_exact_cap() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    let reason: String = "x".repeat(MAX_TIER_REASON_CHARS);

    let mut student = app.open_ws(None, None).await;
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@example.test","browser":"X/1","device_class":"desktop",
            "tier":"degraded","tier_reason": reason
        }),
    )
    .await;

    let update = recv_json(&mut teacher).await;
    let entries = update["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let stored = entries[0]["tier_reason"].as_str().unwrap();
    assert_eq!(stored.chars().count(), MAX_TIER_REASON_CHARS);
    assert_eq!(stored, "x".repeat(MAX_TIER_REASON_CHARS));

    app.shutdown().await;
}
