// File: server/tests/db_pragmas.rs
// Purpose: Verify that init_pool configures the expected SQLite pragmas on a file-backed DB.
// Last updated: Sprint 16 (2026-04-23) -- initial

use singing_bridge_server::db::init_pool;
use tempfile::TempDir;

/// Build a file-backed pool URL from a TempDir.
async fn file_pool(dir: &TempDir) -> sqlx::SqlitePool {
    let path = dir.path().join("test.db");
    let url = format!("sqlite:{}?mode=rwc", path.display());
    init_pool(&url).await.expect("init_pool")
}

#[tokio::test]
async fn db_pragma_journal_mode_is_wal() {
    let dir = TempDir::new().unwrap();
    let pool = file_pool(&dir).await;

    let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
        .fetch_one(&pool)
        .await
        .unwrap();

    pool.close().await;
    assert_eq!(mode, "wal", "expected WAL mode; SMB storage may have been re-introduced");
}

#[tokio::test]
async fn db_pragma_foreign_keys_on() {
    let dir = TempDir::new().unwrap();
    let pool = file_pool(&dir).await;

    let (fk,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();

    pool.close().await;
    assert_eq!(fk, 1, "expected foreign_keys=ON");
}

#[tokio::test]
async fn db_pragma_busy_timeout() {
    let dir = TempDir::new().unwrap();
    let pool = file_pool(&dir).await;

    let (timeout,): (i64,) = sqlx::query_as("PRAGMA busy_timeout")
        .fetch_one(&pool)
        .await
        .unwrap();

    pool.close().await;
    assert_eq!(timeout, 30000, "expected busy_timeout=30000ms");
}

#[tokio::test]
async fn db_pragma_synchronous_normal() {
    let dir = TempDir::new().unwrap();
    let pool = file_pool(&dir).await;

    // SQLite returns 1 for NORMAL, 2 for FULL, 0 for OFF.
    let (sync,): (i64,) = sqlx::query_as("PRAGMA synchronous")
        .fetch_one(&pool)
        .await
        .unwrap();

    pool.close().await;
    assert_eq!(sync, 1, "expected synchronous=NORMAL (1)");
}

/// Verify the pool allows at least 2 simultaneous connections.
/// With max_connections(1), the second acquire blocks indefinitely and the
/// 100 ms timeout fires, failing the test.
#[tokio::test]
async fn db_pool_allows_concurrent_connections() {
    use std::time::Duration;
    use tokio::time::timeout;

    let dir = TempDir::new().unwrap();
    let pool = file_pool(&dir).await;

    let conn1 = timeout(Duration::from_millis(100), pool.acquire())
        .await
        .expect("first acquire timed out")
        .expect("first acquire error");

    let conn2 = timeout(Duration::from_millis(100), pool.acquire())
        .await
        .expect("second acquire blocked — max_connections is likely set to 1")
        .expect("second acquire error");

    drop(conn1);
    drop(conn2);
    pool.close().await;
}

/// Verify after_connect pragmas apply to a lazily-created second pool connection.
/// Acquires two connections simultaneously so sqlx must open both, then reads
/// pragmas on the second one to confirm after_connect ran for it too.
#[tokio::test]
async fn db_pragmas_apply_to_second_connection() {
    use std::time::Duration;
    use tokio::time::timeout;

    let dir = TempDir::new().unwrap();
    let pool = file_pool(&dir).await;

    let mut conn1 = timeout(Duration::from_millis(100), pool.acquire())
        .await
        .expect("first acquire timed out")
        .expect("first acquire error");

    let mut conn2 = timeout(Duration::from_millis(100), pool.acquire())
        .await
        .expect("second acquire timed out")
        .expect("second acquire error");

    let (fk,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
        .fetch_one(&mut *conn2)
        .await
        .unwrap();
    let (timeout_ms,): (i64,) = sqlx::query_as("PRAGMA busy_timeout")
        .fetch_one(&mut *conn2)
        .await
        .unwrap();
    let (sync,): (i64,) = sqlx::query_as("PRAGMA synchronous")
        .fetch_one(&mut *conn2)
        .await
        .unwrap();

    drop(conn1);
    drop(conn2);
    pool.close().await;

    assert_eq!(fk, 1, "second connection: expected foreign_keys=ON");
    assert_eq!(timeout_ms, 30000, "second connection: expected busy_timeout=30000ms");
    assert_eq!(sync, 1, "second connection: expected synchronous=NORMAL (1)");
}
