// File: server/tests/session_history.rs
// Purpose: Integration tests for session_history — upsert_student, open/close events,
//          recording slot, archive_old_events.
// Last updated: Sprint 27 (2026-05-08) -- moved from inline #[cfg(test)] block in session_history.rs

mod common;

use singing_bridge_server::auth::magic_link::TeacherId;
use singing_bridge_server::db::test_helpers::make_test_db;
use singing_bridge_server::ws::session_history::{
    archive_old_events, close_event, consume_recording_slot, link_recording, open_event,
    set_recording_slot, upsert_student, RECORDING_SLOT_TTL_SECS, SESSION_ARCHIVE_DAYS,
};
use singing_bridge_server::ws::session_log::EndedReason;

async fn make_pool() -> (singing_bridge_server::db::test_helpers::TestDb, TeacherId, TeacherId) {
    let td = make_test_db().await;
    sqlx::query("INSERT INTO teachers (email, slug, created_at) VALUES ('t@test.com', 'slug1', 0)")
        .execute(&td.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO teachers (email, slug, created_at) VALUES ('t2@test.com', 'slug2', 0)",
    )
    .execute(&td.pool)
    .await
    .unwrap();
    let (t1,): (TeacherId,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'slug1'")
        .fetch_one(&td.pool)
        .await
        .unwrap();
    let (t2,): (TeacherId,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'slug2'")
        .fetch_one(&td.pool)
        .await
        .unwrap();
    (td, t1, t2)
}

#[tokio::test]
async fn upsert_student_idempotent() {
    let (td, t1, _) = make_pool().await;
    let id1 = upsert_student(&td.pool, t1, "alice@test.com").await.unwrap();
    let id2 = upsert_student(&td.pool, t1, "alice@test.com").await.unwrap();
    assert_eq!(id1, id2);
}

#[tokio::test]
async fn upsert_student_case_insensitive() {
    let (td, t1, _) = make_pool().await;
    let id1 = upsert_student(&td.pool, t1, "ALICE@TEST.COM").await.unwrap();
    let id2 = upsert_student(&td.pool, t1, "alice@test.com").await.unwrap();
    let id3 = upsert_student(&td.pool, t1, "Alice@Test.Com").await.unwrap();
    assert_eq!(id1, id2);
    assert_eq!(id2, id3);
}

#[tokio::test]
async fn upsert_student_different_teachers_separate() {
    let (td, t1, t2) = make_pool().await;
    let id1 = upsert_student(&td.pool, t1, "alice@test.com").await.unwrap();
    let id2 = upsert_student(&td.pool, t2, "alice@test.com").await.unwrap();
    assert_ne!(id1, id2);
}

#[tokio::test]
async fn open_event_has_null_ended_at() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    let row: (Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT ended_at, duration_secs FROM session_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(row.0.is_none());
    assert!(row.1.is_none());
}

#[tokio::test]
async fn close_event_sets_duration() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    close_event(&td.pool, event_id, t1, 1060, EndedReason::Hangup)
        .await
        .unwrap();
    let row: (Option<i64>, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT ended_at, duration_secs, ended_reason FROM session_events WHERE id = $1",
    )
    .bind(event_id)
    .fetch_one(&td.pool)
    .await
    .unwrap();
    assert_eq!(row.0, Some(1060));
    assert_eq!(row.1, Some(60));
    assert_eq!(row.2.as_deref(), Some("hangup"));
}

#[tokio::test]
async fn close_event_duration_clamps_negative() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    close_event(&td.pool, event_id, t1, 999, EndedReason::Disconnect)
        .await
        .unwrap();
    let (duration,): (Option<i64>,) =
        sqlx::query_as("SELECT duration_secs FROM session_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert_eq!(duration, Some(0));
}

#[tokio::test]
async fn close_event_first_writer_wins() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    close_event(&td.pool, event_id, t1, 1060, EndedReason::Hangup)
        .await
        .unwrap();
    close_event(&td.pool, event_id, t1, 9999, EndedReason::Disconnect)
        .await
        .unwrap();
    let (ended_at,): (Option<i64>,) =
        sqlx::query_as("SELECT ended_at FROM session_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert_eq!(ended_at, Some(1060));
}

#[tokio::test]
async fn close_event_wrong_teacher_is_noop() {
    let (td, t1, t2) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    close_event(&td.pool, event_id, t2, 1060, EndedReason::Hangup)
        .await
        .unwrap();
    let (ended_at,): (Option<i64>,) =
        sqlx::query_as("SELECT ended_at FROM session_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(ended_at.is_none());
}

#[tokio::test]
async fn link_recording_sets_recording_id() {
    let (td, t1, _) = make_pool().await;
    let token_hash: Vec<u8> = vec![0u8; 32];
    let email_hash: Vec<u8> = vec![0u8; 32];
    let (recording_id,): (i64,) = sqlx::query_as(
        "INSERT INTO recordings (teacher_id, student_email, student_email_hash, created_at, token_hash) \
         VALUES ($1, 's@test.com', $2, 0, $3) RETURNING id",
    )
    .bind(t1)
    .bind(&email_hash)
    .bind(&token_hash)
    .fetch_one(&td.pool)
    .await
    .unwrap();

    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    link_recording(&td.pool, event_id, t1, recording_id)
        .await
        .unwrap();
    let (rid,): (Option<i64>,) =
        sqlx::query_as("SELECT recording_id FROM session_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert_eq!(rid, Some(recording_id));
}

#[tokio::test]
async fn link_recording_wrong_teacher_is_noop() {
    let (td, t1, t2) = make_pool().await;
    let token_hash: Vec<u8> = vec![0u8; 32];
    let email_hash: Vec<u8> = vec![0u8; 32];
    let (recording_id,): (i64,) = sqlx::query_as(
        "INSERT INTO recordings (teacher_id, student_email, student_email_hash, created_at, token_hash) \
         VALUES ($1, 's@test.com', $2, 0, $3) RETURNING id",
    )
    .bind(t1)
    .bind(&email_hash)
    .bind(&token_hash)
    .fetch_one(&td.pool)
    .await
    .unwrap();
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    link_recording(&td.pool, event_id, t2, recording_id)
        .await
        .unwrap();
    let (rid,): (Option<i64>,) =
        sqlx::query_as("SELECT recording_id FROM session_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(rid.is_none());
}

#[tokio::test]
async fn recording_slot_roundtrip() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    set_recording_slot(&td.pool, t1, event_id).await.unwrap();
    let got = consume_recording_slot(&td.pool, t1).await.unwrap();
    assert_eq!(got, Some(event_id));
    let got2 = consume_recording_slot(&td.pool, t1).await.unwrap();
    assert!(got2.is_none());
}

#[tokio::test]
async fn recording_slot_absent_returns_none() {
    let (td, t1, _) = make_pool().await;
    let got = consume_recording_slot(&td.pool, t1).await.unwrap();
    assert!(got.is_none());
}

#[tokio::test]
async fn recording_slot_expired_returns_none() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let event_id = open_event(&td.pool, t1, student_id, 1000).await.unwrap();
    let expired_at =
        time::OffsetDateTime::now_utc().unix_timestamp() - RECORDING_SLOT_TTL_SECS - 1;
    sqlx::query(
        "INSERT INTO recording_sessions (teacher_id, session_event_id, created_at) VALUES ($1, $2, $3)",
    )
    .bind(t1)
    .bind(event_id)
    .bind(expired_at)
    .execute(&td.pool)
    .await
    .unwrap();
    let got = consume_recording_slot(&td.pool, t1).await.unwrap();
    assert!(got.is_none());
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM recording_sessions WHERE teacher_id = $1")
            .bind(t1)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert_eq!(count, 0, "expired slot must be deleted on consume attempt");
}

#[tokio::test]
async fn archive_old_events_by_completion_time() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let cutoff_secs = SESSION_ARCHIVE_DAYS * 86_400;

    let e_boundary =
        open_event(&td.pool, t1, student_id, now - cutoff_secs - 100).await.unwrap();
    close_event(&td.pool, e_boundary, t1, now - cutoff_secs + 100, EndedReason::Hangup)
        .await
        .unwrap();

    let e_old = open_event(&td.pool, t1, student_id, now - cutoff_secs - 200).await.unwrap();
    close_event(&td.pool, e_old, t1, now - cutoff_secs - 1, EndedReason::Hangup)
        .await
        .unwrap();

    let e_live_old =
        open_event(&td.pool, t1, student_id, now - cutoff_secs - 1).await.unwrap();

    let archived = archive_old_events(&td.pool).await.unwrap();
    assert_eq!(archived, 2, "expected e_old and e_live_old archived");

    let (a1,): (Option<i64>,) =
        sqlx::query_as("SELECT archived_at FROM session_events WHERE id = $1")
            .bind(e_boundary)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(a1.is_none(), "boundary event must not be archived");

    let (a2,): (Option<i64>,) =
        sqlx::query_as("SELECT archived_at FROM session_events WHERE id = $1")
            .bind(e_old)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(a2.is_some(), "old event must be archived");

    let (a3,): (Option<i64>,) =
        sqlx::query_as("SELECT archived_at FROM session_events WHERE id = $1")
            .bind(e_live_old)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(a3.is_some(), "live old session must be archived via started_at");
}

#[tokio::test]
async fn ended_reason_all_variants_stored() {
    let (td, t1, _) = make_pool().await;
    let student_id = upsert_student(&td.pool, t1, "s@test.com").await.unwrap();
    let cases = [
        (EndedReason::Hangup, "hangup"),
        (EndedReason::Disconnect, "disconnect"),
        (EndedReason::FloorViolation, "floor_violation"),
        (EndedReason::Blocked, "blocked"),
        (EndedReason::ServerShutdown, "server_shutdown"),
    ];
    for (i, (reason, expected_str)) in cases.into_iter().enumerate() {
        let started = 1000 + i as i64 * 100;
        let event_id = open_event(&td.pool, t1, student_id, started).await.unwrap();
        close_event(&td.pool, event_id, t1, started + 60, reason)
            .await
            .unwrap();
        let (stored,): (Option<String>,) =
            sqlx::query_as("SELECT ended_reason FROM session_events WHERE id = $1")
                .bind(event_id)
                .fetch_one(&td.pool)
                .await
                .unwrap();
        assert_eq!(stored.as_deref(), Some(expected_str));
    }
}
