// File: server/tests/ws_lobby.rs
// Purpose: Lobby join + admit + signal relay end-to-end at the signalling layer.
// Covers exit-criteria from SPRINTS.md Sprint 1.
// Last updated: Sprint 30 (2026-05-15) -- fix race in teacher_cookie_for_slug_a test

mod common;

use common::{recv_json, send_ws, spawn_app};

#[tokio::test]
async fn student_join_visible_to_teacher() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("teach@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let snapshot = recv_json(&mut teacher).await;
    assert_eq!(snapshot["type"], "lobby_state");
    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 0);

    let mut student = app.open_ws(None, None).await;
    send_ws(
        &mut student,
        &serde_json::json!({
            "type":"lobby_join","slug":"alice",
            "email":"s@example.test","browser":"Firefox/999","device_class":"desktop",
            "tier":"degraded","tier_reason":"iOS Safari forces voice processing"
        }),
    )
    .await;

    let update = recv_json(&mut teacher).await;
    assert_eq!(update["type"], "lobby_state");
    let entries = update["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["email"], "s@example.test");
    assert_eq!(entries[0]["tier"], "degraded");
    assert_eq!(
        entries[0]["tier_reason"],
        "iOS Safari forces voice processing"
    );

    app.shutdown().await;
}

#[tokio::test]
async fn teacher_cookie_for_slug_a_watching_slug_b_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    // Alice's cookie cannot watch bob's room.
    sqlx::query("INSERT INTO teachers (email, slug, created_at) VALUES ($1, $2, $3)")
        .bind("bob@example.test")
        .bind("bob")
        .bind(0_i64)
        .execute(&app.state.db)
        .await
        .unwrap();

    let mut ws = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut ws,
        &serde_json::json!({"type":"lobby_watch","slug":"bob"}),
    )
    .await;

    let msg = recv_json(&mut ws).await;
    assert_eq!(msg["type"], "error");
    assert_eq!(msg["code"], "not_owner");

    app.shutdown().await;
}

#[tokio::test]
async fn teacher_cookie_for_slug_a_joining_slug_b_as_student_succeeds() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    let bob_cookie = app.signup_teacher("bob@example.test", "bob").await;

    // Bob watches first so we can wait for the push rather than racing on a snapshot.
    let mut teacher = app.open_ws(Some(&bob_cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"bob"}),
    )
    .await;
    let initial = recv_json(&mut teacher).await;
    assert_eq!(initial["type"], "lobby_state");
    assert_eq!(initial["entries"].as_array().unwrap().len(), 0);

    // Alice joins Bob's room using her teacher cookie — should succeed, not error.
    let mut ws = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut ws,
        &serde_json::json!({
            "type":"lobby_join","slug":"bob",
            "email":"x@example.test","browser":"F/1","device_class":"desktop"
        }),
    )
    .await;

    // Bob receives the push update — proves Alice's join was accepted.
    let update = recv_json(&mut teacher).await;
    assert_eq!(update["type"], "lobby_state");
    assert_eq!(update["entries"].as_array().unwrap().len(), 1);
    app.shutdown().await;
}

#[tokio::test]
async fn admit_with_mismatched_slug_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("alice@example.test", "alice").await;
    sqlx::query("INSERT INTO teachers (email, slug, created_at) VALUES ($1, $2, $3)")
        .bind("bob@example.test")
        .bind("bob")
        .bind(0_i64)
        .execute(&app.state.db)
        .await
        .unwrap();

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    // Fabricated entry_id for a different slug.
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_admit","slug":"bob","entry_id": uuid::Uuid::new_v4()}),
    )
    .await;
    let msg = recv_json(&mut teacher).await;
    assert_eq!(msg["type"], "error");
    assert_eq!(msg["code"], "invalid_route");
    app.shutdown().await;
}
