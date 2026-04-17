// File: server/tests/magic_link.rs
// Purpose: Magic-link concurrency + token invariants.
// R1 finding #9 property test (concurrent consume → exactly one winner).
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::spawn_app;
use singing_bridge_server::auth::magic_link;

#[tokio::test]
async fn concurrent_consume_has_exactly_one_winner() {
    let app = spawn_app().await;
    // Create a teacher + issue a link.
    sqlx::query("INSERT INTO teachers (email, slug, created_at) VALUES (?, ?, ?)")
        .bind("c@example.test")
        .bind("concurrent")
        .bind(0_i64)
        .execute(&app.state.db)
        .await
        .unwrap();
    let (tid,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE email = ?")
        .bind("c@example.test")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let link = magic_link::issue(&app.state.db, tid, 600).await.unwrap();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let pool = app.state.db.clone();
        let token = link.raw_token.clone();
        handles.push(tokio::spawn(
            async move { magic_link::consume(&pool, &token).await },
        ));
    }
    let mut wins = 0;
    for h in handles {
        if h.await.unwrap().is_ok() {
            wins += 1;
        }
    }
    assert_eq!(wins, 1);
    app.shutdown().await;
}
