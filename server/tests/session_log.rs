// File: server/tests/session_log.rs
// Purpose: Integration tests for session_log — open/close rows, record_peak, privacy invariants.
// Last updated: Sprint 27 (2026-05-08) -- moved from inline #[cfg(test)] block in session_log.rs

mod common;

use singing_bridge_server::db::test_helpers::make_test_db;
use singing_bridge_server::ws::protocol::Tier;
use singing_bridge_server::ws::session_log::{
    close_row, hash_email, open_row, record_peak, EndedReason, SessionLogId, DEV_PEPPER,
};

async fn make_db() -> (
    singing_bridge_server::db::test_helpers::TestDb,
    sqlx::PgPool,
) {
    let td = make_test_db().await;
    sqlx::query(
        "INSERT INTO teachers (email, slug, created_at) VALUES ('teacher@test.com', 'testslug', 0)",
    )
    .execute(&td.pool)
    .await
    .unwrap();
    let pool = td.pool.clone();
    (td, pool)
}

fn sample_hash() -> [u8; 32] {
    hash_email("student@example.com", DEV_PEPPER)
}

#[tokio::test]
async fn open_row_creates_row_with_null_ended_at() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    let (teacher_id,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'testslug'")
        .fetch_one(&pool)
        .await
        .unwrap();
    open_row(&pool, &id, teacher_id, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000)
        .await
        .unwrap();
    let row: (Option<i64>,) = sqlx::query_as("SELECT ended_at FROM session_log WHERE id = $1")
        .bind(id.as_bytes())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(row.0.is_none());
}

#[tokio::test]
async fn close_row_sets_ended_at_and_duration() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    let (teacher_id,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'testslug'")
        .fetch_one(&pool)
        .await
        .unwrap();
    open_row(&pool, &id, teacher_id, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000)
        .await
        .unwrap();
    close_row(&pool, &id, 1060, EndedReason::Hangup).await.unwrap();
    let row: (Option<i64>, Option<i64>, Option<String>) =
        sqlx::query_as("SELECT ended_at, duration_secs, ended_reason FROM session_log WHERE id = $1")
            .bind(id.as_bytes())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.0, Some(1060));
    assert_eq!(row.1, Some(60));
    assert_eq!(row.2.as_deref(), Some("hangup"));
}

#[tokio::test]
async fn duration_secs_never_negative() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    let (teacher_id,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'testslug'")
        .fetch_one(&pool)
        .await
        .unwrap();
    open_row(&pool, &id, teacher_id, &sample_hash(), "Chrome/99", "mobile", Tier::Degraded, 1000)
        .await
        .unwrap();
    close_row(&pool, &id, 999, EndedReason::Disconnect).await.unwrap();
    let row: (Option<i64>,) =
        sqlx::query_as("SELECT duration_secs FROM session_log WHERE id = $1")
            .bind(id.as_bytes())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.0, Some(0));
}

#[tokio::test]
async fn close_row_is_idempotent() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    let (teacher_id,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'testslug'")
        .fetch_one(&pool)
        .await
        .unwrap();
    open_row(&pool, &id, teacher_id, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000)
        .await
        .unwrap();
    close_row(&pool, &id, 1060, EndedReason::Hangup).await.unwrap();
    close_row(&pool, &id, 9999, EndedReason::Disconnect).await.unwrap();
    let row: (Option<i64>,) = sqlx::query_as("SELECT ended_at FROM session_log WHERE id = $1")
        .bind(id.as_bytes())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, Some(1060));
}

#[tokio::test]
async fn record_peak_updates_high_watermark() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    let (teacher_id,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'testslug'")
        .fetch_one(&pool)
        .await
        .unwrap();
    open_row(&pool, &id, teacher_id, &sample_hash(), "Firefox/99", "desktop", Tier::Supported, 1000)
        .await
        .unwrap();
    record_peak(&pool, &id, 200, 50).await.unwrap();
    record_peak(&pool, &id, 100, 80).await.unwrap();
    let row: (i32, i32) =
        sqlx::query_as("SELECT peak_loss_bp, peak_rtt_ms FROM session_log WHERE id = $1")
            .bind(id.as_bytes())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.0, 200);
    assert_eq!(row.1, 80);
}

#[tokio::test]
async fn record_peak_noop_on_missing_row() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    record_peak(&pool, &id, 500, 100).await.unwrap();
}

#[test]
fn hash_email_no_plaintext() {
    let hash = hash_email("student@example.com", DEV_PEPPER);
    let hex_hash = hex::encode(hash);
    assert!(!hex_hash.contains("student"));
    assert!(!hex_hash.contains("example"));
}

#[tokio::test]
async fn session_log_no_plaintext_email_or_ip() {
    let (_td, pool) = make_db().await;
    let id = SessionLogId::new();
    let (teacher_id,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'testslug'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let email = "noshow@secret.com";
    let hash = hash_email(email, DEV_PEPPER);
    open_row(&pool, &id, teacher_id, &hash, "Firefox/99", "desktop", Tier::Supported, 1000)
        .await
        .unwrap();
    record_peak(&pool, &id, 100, 50).await.unwrap();
    close_row(&pool, &id, 1060, EndedReason::Hangup).await.unwrap();

    let rows: Vec<(Option<String>, String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT ended_reason, browser, device_class, tier, ended_reason FROM session_log",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for (a, b, c, d, e) in &rows {
        for col in [
            a.as_deref().unwrap_or(""),
            b.as_str(),
            c.as_str(),
            d.as_str(),
            e.as_deref().unwrap_or(""),
        ] {
            assert!(!col.contains("noshow"), "found email in column: {col}");
            assert!(!col.contains("secret.com"), "found email in column: {col}");
        }
    }
}
