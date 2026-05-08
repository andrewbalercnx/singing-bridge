// File: server/tests/cleanup.rs
// Purpose: Integration tests for the cleanup cycle — blob purge, grace period,
//          NotFound-as-purged, and stale gate-attempt pruning.
// Last updated: Sprint 27 (2026-05-08) -- moved from inline #[cfg(test)] block in cleanup.rs

mod common;

use std::sync::Arc;

use singing_bridge_server::blob::{BlobStore, DevBlobStore};
use singing_bridge_server::cleanup::{run_one_cleanup_cycle, BLOB_GRACE_SECS};
use singing_bridge_server::db::test_helpers::make_test_db;

async fn make_blob() -> Arc<dyn BlobStore> {
    let dir = tempfile::tempdir().unwrap().into_path();
    Arc::new(DevBlobStore::new(dir).await.unwrap())
}

fn box_reader(data: &[u8]) -> std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>> {
    Box::pin(std::io::Cursor::new(data.to_vec()))
}

async fn insert_recording(
    db: &sqlx::PgPool,
    teacher_id: i64,
    blob_key: Option<&str>,
    deleted_at: Option<i64>,
) -> i64 {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let token_hash: Vec<u8> = rand::random::<[u8; 32]>().to_vec();
    let email_hash: Vec<u8> = rand::random::<[u8; 32]>().to_vec();
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO recordings
           (teacher_id, student_email, student_email_hash, created_at, blob_key, token_hash, deleted_at)
         VALUES ($1, 'test@test.com', $2, $3, $4, $5, $6)
         RETURNING id",
    )
    .bind(teacher_id)
    .bind(email_hash)
    .bind(now)
    .bind(blob_key)
    .bind(&token_hash)
    .bind(deleted_at)
    .fetch_one(db)
    .await
    .unwrap();
    id
}

async fn ensure_teacher(db: &sqlx::PgPool) -> i64 {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO teachers (email, slug, created_at) VALUES ('t@test.com', 'testslug', $1) RETURNING id",
    )
    .bind(now)
    .fetch_one(db)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn purges_old_blob_and_nulls_key() {
    let td = make_test_db().await;
    let blob = make_blob().await;
    let teacher_id = ensure_teacher(&td.pool).await;
    let key = "test-purge.webm";
    blob.put(key, box_reader(b"data")).await.unwrap();
    let old_deleted_at = time::OffsetDateTime::now_utc().unix_timestamp() - BLOB_GRACE_SECS - 1;
    let id = insert_recording(&td.pool, teacher_id, Some(key), Some(old_deleted_at)).await;

    let purged = run_one_cleanup_cycle(&td.pool, &blob, 300).await.unwrap();
    assert_eq!(purged, 1);

    let (blob_key,): (Option<String>,) =
        sqlx::query_as("SELECT blob_key FROM recordings WHERE id = $1")
            .bind(id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(blob_key.is_none());
}

#[tokio::test]
async fn does_not_purge_within_grace() {
    let td = make_test_db().await;
    let blob = make_blob().await;
    let teacher_id = ensure_teacher(&td.pool).await;
    let key = "test-grace.webm";
    blob.put(key, box_reader(b"data")).await.unwrap();
    let recent_deleted_at = time::OffsetDateTime::now_utc().unix_timestamp() - 100;
    insert_recording(&td.pool, teacher_id, Some(key), Some(recent_deleted_at)).await;

    let purged = run_one_cleanup_cycle(&td.pool, &blob, 300).await.unwrap();
    assert_eq!(purged, 0);
}

/// DevBlobStore treats NotFound as success, so a missing blob is considered
/// purged (blob_key is nulled). This test asserts the correct behavior.
#[tokio::test]
async fn blob_delete_not_found_is_treated_as_purged() {
    let td = make_test_db().await;
    let teacher_id = ensure_teacher(&td.pool).await;
    let blob = make_blob().await;
    let old_deleted_at = time::OffsetDateTime::now_utc().unix_timestamp() - BLOB_GRACE_SECS - 1;
    let id = insert_recording(&td.pool, teacher_id, Some("ghost.webm"), Some(old_deleted_at)).await;

    let purged = run_one_cleanup_cycle(&td.pool, &blob, 300).await.unwrap();
    assert_eq!(purged, 1);

    let (blob_key,): (Option<String>,) =
        sqlx::query_as("SELECT blob_key FROM recordings WHERE id = $1")
            .bind(id)
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert!(blob_key.is_none(), "blob_key must be nulled after DevBlobStore NotFound-as-success");
}

#[tokio::test]
async fn prunes_stale_gate_attempts() {
    let td = make_test_db().await;
    let blob = make_blob().await;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let old = now - 300 - 1;
    let fresh = now - 10;

    sqlx::query("INSERT INTO recording_gate_attempts (peer_ip, attempted_at) VALUES ($1, $2)")
        .bind("1.2.3.4")
        .bind(old)
        .execute(&td.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO recording_gate_attempts (peer_ip, attempted_at) VALUES ($1, $2)")
        .bind("1.2.3.4")
        .bind(fresh)
        .execute(&td.pool)
        .await
        .unwrap();

    run_one_cleanup_cycle(&td.pool, &blob, 300).await.unwrap();

    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM recording_gate_attempts")
            .fetch_one(&td.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}
