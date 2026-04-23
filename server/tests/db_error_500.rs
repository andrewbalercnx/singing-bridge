// File: server/tests/db_error_500.rs
// Purpose: Verify that a closed DB pool propagates as HTTP 500, not a panic.
// Last updated: Sprint 16 (2026-04-23) -- initial

mod common;
use common::spawn_app;

/// Close the pool before a DB-backed request and assert HTTP 500.
/// Uses POST /auth/register — an unauthenticated endpoint that writes to the DB —
/// so the error surfaces as AppError::Sqlx → 500 rather than being swallowed by
/// the auth layer (which converts DB errors to 401 to avoid leaking internals).
/// Exercises the sqlx::Error::PoolClosed → AppError::Sqlx → 500 propagation path.
#[tokio::test]
async fn db_pool_closed_returns_500() {
    let app = spawn_app().await;

    // Close the pool — all subsequent pool.acquire() calls return PoolClosed.
    app.state.db.close().await;

    let resp = app
        .client
        .post(app.url("/auth/register"))
        .json(&serde_json::json!({
            "email": "t@test.com",
            "slug": "testroom",
            "password": "test-passphrase-12"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        "expected 500 when pool is closed"
    );

    app.shutdown.cancel();
}
