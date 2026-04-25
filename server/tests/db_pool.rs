// File: server/tests/db_pool.rs
// Purpose: Verify that init_pool allows concurrent connections to PostgreSQL.
// Last updated: Sprint 19 (2026-04-25) -- replaces db_pragmas.rs (SQLite-specific)

use singing_bridge_server::db::{init_pool, run_migrations};
use sqlx::postgres::PgPoolOptions;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static DB_COUNTER: AtomicU64 = AtomicU64::new(0);

async fn make_test_pool() -> sqlx::PgPool {
    let admin_url = std::env::var("DATABASE_TEST_URL")
        .expect("DATABASE_TEST_URL must be set for db_pool tests");
    let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let db_name = format!("singing_bridge_test_{pid}_{n}");
    let admin = PgPoolOptions::new().max_connections(1).connect(&admin_url).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE \"{db_name}\"")).execute(&admin).await.unwrap();
    admin.close().await;
    let db_url = match admin_url.rfind('/') {
        Some(idx) => format!("{}/{}", &admin_url[..idx], db_name),
        None => format!("{}/{}", admin_url, db_name),
    };
    run_migrations(&db_url).await.unwrap();
    init_pool(&db_url).await.unwrap()
}

/// Verify the pool allows at least 2 simultaneous connections.
/// With max_connections(1), the second acquire blocks indefinitely and the
/// 100 ms timeout fires, failing the test.
#[tokio::test]
async fn db_pool_allows_concurrent_connections() {
    let pool = make_test_pool().await;

    let conn1 = tokio::time::timeout(Duration::from_millis(500), pool.acquire())
        .await
        .expect("first acquire timed out")
        .expect("first acquire error");

    let conn2 = tokio::time::timeout(Duration::from_millis(500), pool.acquire())
        .await
        .expect("second acquire blocked — max_connections is likely set to 1")
        .expect("second acquire error");

    drop(conn1);
    drop(conn2);
    pool.close().await;
}
