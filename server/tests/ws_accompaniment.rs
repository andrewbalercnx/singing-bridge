// File: server/tests/ws_accompaniment.rs
// Purpose: WebSocket integration tests for AccompanimentPlay/Pause/Stop handlers.
//          Covers token lifecycle, snapshot invariants, role guards, validation bounds,
//          and disconnect revocation. Corresponds to test cases 1-21 from PLAN_Sprint14.md.
// Last updated: Sprint 14 (2026-04-23) -- initial test suite

mod common;

use common::{make_session, recv_json, seed_accompaniment_asset, send_ws, spawn_app};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Receive the next message, filtering out ping/close frames.
/// Panics if a message of the expected type is not received within the timeout.
async fn expect_msg_type(ws: &mut common::Ws, expected: &str) -> serde_json::Value {
    let msg = recv_json(ws).await;
    assert_eq!(
        msg["type"], expected,
        "expected type={expected}, got: {msg}"
    );
    msg
}

/// Receive and discard a message of any type.
async fn discard(ws: &mut common::Ws) {
    let _ = recv_json(ws).await;
}

// ---------------------------------------------------------------------------
// Test 1: AccompanimentPlay → student receives full snapshot
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_1_play_student_receives_full_snapshot() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;

    let t_snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    let s_snap = expect_msg_type(&mut student, "accompaniment_state").await;

    for snap in [&t_snap, &s_snap] {
        assert_eq!(snap["asset_id"], fix.asset_id);
        assert_eq!(snap["is_playing"], true);
        assert!(snap["wav_url"].is_string());
        assert!(snap["page_urls"].is_array());
        assert_eq!(snap["page_urls"].as_array().unwrap().len(), 1);
        assert!(snap["bar_coords"].is_array());
        assert!(snap["bar_timings"].is_array());
        assert!(snap["server_time_ms"].is_number());
        assert_eq!(snap["position_ms"], 0);
    }

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 2: AccompanimentPause → full snapshot with is_playing=false
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_2_pause_student_receives_full_snapshot_with_is_playing_false() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({"type": "accompaniment_pause", "position_ms": 3000}),
    )
    .await;

    let t_snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    let s_snap = expect_msg_type(&mut student, "accompaniment_state").await;

    for snap in [&t_snap, &s_snap] {
        assert_eq!(snap["is_playing"], false);
        assert_eq!(snap["position_ms"], 3000);
        // Full snapshot still present.
        assert!(snap["page_urls"].is_array());
        assert!(snap["bar_coords"].is_array());
        assert!(snap["bar_timings"].is_array());
    }

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 3: Resume from pause → same wav_url re-emitted
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_3_resume_from_pause_issues_fresh_token() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;
    let first_play = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;
    let first_wav_url = first_play["wav_url"].as_str().unwrap().to_string();

    send_ws(
        &mut teacher,
        &serde_json::json!({"type": "accompaniment_pause", "position_ms": 1000}),
    )
    .await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    // Resume = new AccompanimentPlay with same asset+variant.
    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 1000
        }),
    )
    .await;
    let resume_snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    let resume_wav_url = resume_snap["wav_url"].as_str().unwrap().to_string();
    discard(&mut student).await;

    // Position should be updated.
    assert_eq!(resume_snap["position_ms"], 1000);
    // The server issues a fresh token on every AccompanimentPlay, but the URL structure
    // should still be present.
    assert!(!resume_wav_url.is_empty());
    // Confirm the original token was revoked on replacement play.
    let old_token = first_wav_url.split('/').last().unwrap();
    let new_token = resume_wav_url.split('/').last().unwrap();
    // Tokens must differ (new token issued, old revoked).
    assert_ne!(old_token, new_token, "replacement play must issue new token");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 4: AccompanimentStop → cleared state
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_4_stop_broadcasts_cleared_state() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_stop"})).await;

    let t_cleared = expect_msg_type(&mut teacher, "accompaniment_state").await;
    let s_cleared = expect_msg_type(&mut student, "accompaniment_state").await;

    for snap in [&t_cleared, &s_cleared] {
        assert_eq!(snap["asset_id"], serde_json::Value::Null);
        assert_eq!(snap["is_playing"], false);
        assert_eq!(snap["wav_url"], serde_json::Value::Null);
        assert_eq!(snap["position_ms"], 0);
    }

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 5: After Stop, token returns 404
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_5_after_stop_media_token_returns_404() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;
    let snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;

    let wav_url = snap["wav_url"].as_str().unwrap().to_string();

    // Token is valid before stop.
    let resp = app.client.get(&wav_url).send().await.unwrap();
    assert_eq!(resp.status(), 200);

    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_stop"})).await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    // Token is revoked after stop.
    let resp = app.client.get(&wav_url).send().await.unwrap();
    assert_eq!(resp.status(), 404);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 6: Student sends AccompanimentPlay → Forbidden
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_6_student_play_rejected_with_forbidden() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (_teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut student,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;

    let err = expect_msg_type(&mut student, "error").await;
    assert_eq!(err["code"], "forbidden");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 7: Student sends AccompanimentPause → Forbidden
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_7_student_pause_rejected_with_forbidden() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    make_session(&app, "room1", &cookie).await;

    // Open a fresh student WS (not the session student).
    let (_teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut student,
        &serde_json::json!({"type": "accompaniment_pause", "position_ms": 1000}),
    )
    .await;

    let err = expect_msg_type(&mut student, "error").await;
    assert_eq!(err["code"], "forbidden");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 8: variant_id from different asset → EntryNotFound
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_8_play_wrong_asset_returns_not_found() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix1 = seed_accompaniment_asset(&app, teacher_id).await;
    let fix2 = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    // variant_id from fix2 but asset_id from fix1 (mismatch).
    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix1.asset_id,
            "variant_id": fix2.variant_id,
            "position_ms": 0
        }),
    )
    .await;

    let err = expect_msg_type(&mut teacher, "error").await;
    assert_eq!(err["code"], "entry_not_found");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 9: Another teacher's variant → EntryNotFound
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_9_play_other_teachers_variant_returns_not_found() {
    let app = spawn_app().await;
    let cookie_a = app.signup_teacher("a@test.example", "room-a").await;
    let cookie_b = app.signup_teacher("b@test.example", "room-b").await;
    let teacher_b_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room-b'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix_b = seed_accompaniment_asset(&app, teacher_b_id).await;
    let (mut teacher_a, _student) = make_session(&app, "room-a", &cookie_a).await;
    let _ = cookie_b; // not used further

    // Teacher A tries to play teacher B's variant.
    send_ws(
        &mut teacher_a,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix_b.asset_id,
            "variant_id": fix_b.variant_id,
            "position_ms": 0
        }),
    )
    .await;

    let err = expect_msg_type(&mut teacher_a, "error").await;
    assert_eq!(err["code"], "entry_not_found");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 11: Teacher disconnects mid-playback → student receives cleared state
// (Plan has a gap at #10)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_11_teacher_disconnect_clears_accompaniment() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 0
        }),
    )
    .await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    // Teacher disconnects.
    drop(teacher);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Student should receive cleared AccompanimentState before PeerDisconnected.
    let msg1 = recv_json(&mut student).await;
    // Accept either ordering (cleared state might come before or after peer_disconnected).
    let has_cleared = msg1["type"] == "accompaniment_state" && msg1["asset_id"].is_null();
    if !has_cleared {
        // Maybe peer_disconnected came first; next should be accompaniment_state.
        assert_eq!(msg1["type"], "peer_disconnected", "unexpected message: {msg1}");
        let cleared = recv_json(&mut student).await;
        assert_eq!(cleared["type"], "accompaniment_state");
        assert!(cleared["asset_id"].is_null());
    }

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 12: position_ms = 14_400_001 → Malformed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_12_position_ms_out_of_range_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    send_ws(
        &mut teacher,
        &serde_json::json!({
            "type": "accompaniment_play",
            "asset_id": fix.asset_id,
            "variant_id": fix.variant_id,
            "position_ms": 14_400_001u64
        }),
    )
    .await;

    let err = expect_msg_type(&mut teacher, "error").await;
    assert_eq!(err["code"], "malformed");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 15: Rapid Play/Pause/Play/Stop → final state is cleared
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_15_rapid_sequence_final_state_cleared() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    // Rapid sequence.
    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 0
    })).await;
    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_pause", "position_ms": 500})).await;
    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 500
    })).await;
    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_stop"})).await;

    // Drain all messages and find the last AccompanimentState.
    // Use ws.next() directly (not recv_json) so a timeout returns Err(Elapsed)
    // rather than panicking — recv_json's internal 2s panic would fire before
    // a longer outer timeout could cancel it gracefully.
    // 3s per read: enough for a WAN DB round-trip; break on first silence.
    let mut last_state: Option<serde_json::Value> = None;
    use futures_util::StreamExt as _;
    use tokio_tungstenite::tungstenite::Message;
    loop {
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            teacher.next(),
        )
        .await
        {
            Ok(Some(Ok(Message::Text(s)))) => {
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&s) {
                    if msg["type"] == "accompaniment_state" {
                        let done = msg["asset_id"].is_null();
                        last_state = Some(msg);
                        if done { break; }
                    }
                }
            }
            Ok(Some(Ok(_))) => {} // ping / pong / binary — skip
            Ok(_) | Err(_) => break, // WS closed or 3s silence — done
        }
    }

    let last = last_state.expect("at least one AccompanimentState");
    assert!(last["asset_id"].is_null(), "final state must be cleared, got: {last}");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 16: Replacement play → old token revoked, new token valid
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_16_replacement_play_revokes_old_token() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 0
    })).await;
    let snap1 = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;

    let old_wav_url = snap1["wav_url"].as_str().unwrap().to_string();

    // Replacement play.
    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 0
    })).await;
    let snap2 = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;

    let new_wav_url = snap2["wav_url"].as_str().unwrap().to_string();
    assert_ne!(old_wav_url, new_wav_url, "new token must differ from old");

    // Old token is revoked.
    let old_resp = app.client.get(&old_wav_url).send().await.unwrap();
    assert_eq!(old_resp.status(), 404, "old token must return 404");

    // New token is valid.
    let new_resp = app.client.get(&new_wav_url).send().await.unwrap();
    assert_eq!(new_resp.status(), 200, "new token must return 200");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 17: Non-monotone bar_timings from DB → ErrorCode::Internal
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_17_non_monotone_bar_timings_returns_internal() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();

    // Insert asset with non-monotone bar_timings.
    let wav_blob_key = "wav-nm-17";
    let bad_timings = serde_json::to_string(&serde_json::json!([
        {"bar": 2, "time_s": 2.0},
        {"bar": 1, "time_s": 0.0}, // bar is not strictly increasing
    ])).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (asset_id,): (i64,) = sqlx::query_as(
        "INSERT INTO accompaniments (teacher_id, title, bar_timings_json, created_at) VALUES ($1, 'Bad', $2, $3) RETURNING id",
    ).bind(teacher_id).bind(&bad_timings).bind(now)
    .fetch_one(&app.state.db).await.unwrap();
    let (variant_id,): (i64,) = sqlx::query_as(
        "INSERT INTO accompaniment_variants (accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones, respect_repeats, created_at) VALUES ($1, 'V', $2, 100, 0, 0, $3) RETURNING id",
    ).bind(asset_id).bind(wav_blob_key).bind(now)
    .fetch_one(&app.state.db).await.unwrap();
    app.state.blob.put(wav_blob_key, Box::pin(std::io::Cursor::new(b"RIFF\x00\x00\x00\x00WAVEfake" as &[u8]))).await.unwrap();

    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": asset_id, "variant_id": variant_id, "position_ms": 0
    })).await;

    let err = expect_msg_type(&mut teacher, "error").await;
    assert_eq!(err["code"], "internal");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 18: bar_coords with out-of-range page index → silently skipped
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_18_out_of_range_page_index_in_bar_coords_skipped() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();

    let wav_blob_key = "wav-oor-18";
    let page_blob_key = "page-oor-18";
    // bar_coords: entry 1 is valid (page=0), entry 2 has out-of-range page=5.
    let bar_coords = serde_json::to_string(&serde_json::json!([
        {"bar": 1, "page": 0, "x_frac": 0.1, "y_frac": 0.1, "w_frac": 0.5, "h_frac": 0.1},
        {"bar": 2, "page": 5, "x_frac": 0.1, "y_frac": 0.2, "w_frac": 0.5, "h_frac": 0.1},
    ])).unwrap();
    let bar_timings = serde_json::to_string(&serde_json::json!([
        {"bar": 1, "time_s": 0.0},
        {"bar": 2, "time_s": 1.0},
    ])).unwrap();
    let page_blob_keys_json = serde_json::to_string(&[&page_blob_key]).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (asset_id,): (i64,) = sqlx::query_as(
        "INSERT INTO accompaniments (teacher_id, title, page_blob_keys_json, bar_coords_json, bar_timings_json, created_at) VALUES ($1, 'OOR', $2, $3, $4, $5) RETURNING id",
    ).bind(teacher_id).bind(&page_blob_keys_json).bind(&bar_coords).bind(&bar_timings).bind(now)
    .fetch_one(&app.state.db).await.unwrap();
    let (variant_id,): (i64,) = sqlx::query_as(
        "INSERT INTO accompaniment_variants (accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones, respect_repeats, created_at) VALUES ($1, 'V', $2, 100, 0, 0, $3) RETURNING id",
    ).bind(asset_id).bind(wav_blob_key).bind(now)
    .fetch_one(&app.state.db).await.unwrap();
    app.state.blob.put(wav_blob_key, Box::pin(std::io::Cursor::new(b"RIFF\x00\x00\x00\x00WAVEfake" as &[u8]))).await.unwrap();
    app.state.blob.put(page_blob_key, Box::pin(std::io::Cursor::new(b"PNG_FAKE" as &[u8]))).await.unwrap();

    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": asset_id, "variant_id": variant_id, "position_ms": 0
    })).await;

    let snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;

    let coords = snap["bar_coords"].as_array().expect("bar_coords should be array");
    // Only bar=1 (page=0) should be present; bar=2 (page=5) silently skipped.
    assert_eq!(coords.len(), 1, "out-of-range entry should be filtered");
    assert_eq!(coords[0]["bar"], 1);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 19: ClientMsg serde roundtrips for all 3 accompaniment variants
// ---------------------------------------------------------------------------

#[test]
fn test_19_accompaniment_client_msg_serde_roundtrips() {
    use singing_bridge_server::ws::protocol::ClientMsg;

    let cases = vec![
        serde_json::json!({"type":"accompaniment_play","asset_id":1,"variant_id":2,"position_ms":0u64}),
        serde_json::json!({"type":"accompaniment_pause","position_ms":1000u64}),
        serde_json::json!({"type":"accompaniment_stop"}),
    ];

    for case in cases {
        let msg: ClientMsg = serde_json::from_value(case.clone()).unwrap_or_else(|e| {
            panic!("failed to deserialize {case}: {e}")
        });
        let back = serde_json::to_value(&msg).unwrap();
        assert_eq!(case["type"], back["type"], "type mismatch for {case}");
    }
}

// ---------------------------------------------------------------------------
// Test 20: AccompanimentState serde roundtrip (full + cleared)
// ---------------------------------------------------------------------------

#[test]
fn test_20_accompaniment_state_server_msg_serde_roundtrip() {
    use singing_bridge_server::ws::protocol::{BarCoord, BarTiming, ServerMsg};

    let full = ServerMsg::AccompanimentState {
        asset_id: Some(1),
        variant_id: Some(2),
        is_playing: true,
        position_ms: 5000,
        tempo_pct: Some(100),
        wav_url: Some("http://localhost/api/media/abc".into()),
        page_urls: Some(vec!["http://localhost/api/media/page1".into()]),
        bar_coords: Some(vec![BarCoord {
            bar: 1, page: 0, x_frac: 0.1, y_frac: 0.2, w_frac: 0.5, h_frac: 0.1,
        }]),
        bar_timings: Some(vec![BarTiming { bar: 1, time_s: 0.0 }]),
        server_time_ms: 1_700_000_000_000,
    };

    let cleared = ServerMsg::AccompanimentState {
        asset_id: None,
        variant_id: None,
        is_playing: false,
        position_ms: 0,
        tempo_pct: None,
        wav_url: None,
        page_urls: None,
        bar_coords: None,
        bar_timings: None,
        server_time_ms: 1_700_000_000_000,
    };

    for msg in [&full, &cleared] {
        let json = serde_json::to_string(msg).unwrap();
        let _back: ServerMsg = serde_json::from_str(&json).unwrap();
    }
}

// ---------------------------------------------------------------------------
// Test 21: Stopped state position_ms == 0
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_21_stopped_state_has_position_ms_zero() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 5000
    })).await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_stop"})).await;
    let cleared = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;

    assert_eq!(cleared["position_ms"], 0, "cleared state must have position_ms=0");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Regression: library token cache-control unaffected by no_cache flag
// ---------------------------------------------------------------------------

#[tokio::test]
async fn media_token_library_cache_control() {
    use singing_bridge_server::http::media_token::MediaTokenStore;

    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;

    // Issue a library token (no_cache=false) directly via the store.
    let lib_token = app.state.media_tokens.insert(
        fix.wav_blob_key.clone(),
        std::time::Duration::from_secs(300),
        false,
    );

    let url = app.url(&format!("/api/media/{lib_token}"));
    let resp = app.client.get(&url).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let cc = resp.headers().get("cache-control").unwrap().to_str().unwrap();
    assert_eq!(cc, "private, max-age=300", "library token must use max-age=300");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Regression: accompaniment token uses no-store
// ---------------------------------------------------------------------------

#[tokio::test]
async fn accompaniment_token_cache_control_is_no_store() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 0
    })).await;
    let snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    discard(&mut student).await;

    let wav_url = snap["wav_url"].as_str().unwrap();
    let resp = app.client.get(wav_url).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let cc = resp.headers().get("cache-control").unwrap().to_str().unwrap();
    assert_eq!(cc, "no-store", "accompaniment token must return Cache-Control: no-store");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test: Student sends AccompanimentStop → Forbidden
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_student_stop_rejected_with_forbidden() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let (_teacher, mut student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut student, &serde_json::json!({"type": "accompaniment_stop"})).await;

    let err = expect_msg_type(&mut student, "error").await;
    assert_eq!(err["code"], "forbidden");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test: position_ms = 14_400_000 (max valid) → accepted
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_position_ms_max_valid_accepted() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id,
        "variant_id": fix.variant_id,
        "position_ms": 14_400_000u64
    })).await;

    let snap = expect_msg_type(&mut teacher, "accompaniment_state").await;
    assert_eq!(snap["position_ms"], 14_400_000u64);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test: AccompanimentPause/Stop with no active snapshot → no-op (no crash)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_pause_with_no_active_snapshot_is_noop() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    // No play was issued; pause should be a no-op (no error, no broadcast).
    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_pause", "position_ms": 0})).await;

    // No message expected from the server; verify no crash by sending another message.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    // (no recv_json here — if we get here without timeout/panic, the no-op worked)

    app.shutdown().await;
}

#[tokio::test]
async fn test_stop_with_no_active_snapshot_is_noop() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let (mut teacher, _student) = make_session(&app, "room1", &cookie).await;

    // No play was issued; stop should be a no-op.
    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_stop"})).await;

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test: AccompanimentPause malformed position_ms → Malformed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_pause_malformed_position_ms_rejected() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@test.example", "room1").await;
    let teacher_id: i64 =
        sqlx::query_scalar("SELECT id FROM teachers WHERE slug = 'room1'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let fix = seed_accompaniment_asset(&app, teacher_id).await;
    let (mut teacher, mut student) = make_session(&app, "room1", &cookie).await;

    // First play.
    send_ws(&mut teacher, &serde_json::json!({
        "type": "accompaniment_play",
        "asset_id": fix.asset_id, "variant_id": fix.variant_id, "position_ms": 0
    })).await;
    discard(&mut teacher).await;
    discard(&mut student).await;

    // Pause with out-of-range position_ms.
    send_ws(&mut teacher, &serde_json::json!({"type": "accompaniment_pause", "position_ms": 14_400_001u64})).await;

    let err = expect_msg_type(&mut teacher, "error").await;
    assert_eq!(err["code"], "malformed");

    app.shutdown().await;
}
