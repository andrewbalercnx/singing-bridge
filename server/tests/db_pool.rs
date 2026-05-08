// File: server/tests/db_pool.rs
// Purpose: Verify that init_pool allows concurrent connections to PostgreSQL.
// Last updated: Sprint 19 (2026-04-25) -- use spawn_app() harness; panic-safe cleanup

mod common;
use common::spawn_app;
use std::time::Duration;

/// Verify the pool allows at least 2 simultaneous connections.
/// With max_connections(1), the second acquire blocks indefinitely and the
/// timeout fires, failing the test.
#[tokio::test]
async fn db_pool_allows_concurrent_connections() {
    let app = spawn_app().await;
    let pool = &app.state.db;

    // 30s: allows for WAN TLS to Azure PostgreSQL even under load. Still fails
    // immediately if max_connections=1 (second acquire blocks indefinitely).
    // This test runs in the 'serial' nextest group to avoid connection contention
    // with the 30+ other parallel test binaries.
    let conn1 = tokio::time::timeout(Duration::from_secs(30), pool.acquire())
        .await
        .expect("first acquire timed out")
        .expect("first acquire error");

    let conn2 = tokio::time::timeout(Duration::from_secs(30), pool.acquire())
        .await
        .expect("second acquire blocked — max_connections is likely set to 1")
        .expect("second acquire error");

    drop(conn1);
    drop(conn2);
    app.shutdown().await;
}
