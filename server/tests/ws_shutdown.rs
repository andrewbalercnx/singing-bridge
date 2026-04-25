// File: server/tests/ws_shutdown.rs
// Purpose: Server shutdown broadcasts ServerShutdown then closes with code 1012.
// Last updated: Sprint 19 (2026-04-25) -- use public TestApp API; panic-safe cleanup

mod common;

use common::{recv_json, send_ws, spawn_app};

#[tokio::test]
async fn server_shutdown_delivered_before_close() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let _ = recv_json(&mut teacher).await;

    // Trigger shutdown via the public token (same token the server listens to).
    // Using this instead of app.shutdown() so we can observe the WS messages
    // before handing control back to the harness.
    app.shutdown.cancel();

    let msg = recv_json(&mut teacher).await;
    assert_eq!(msg["type"], "server_shutdown");
    let close = recv_json(&mut teacher).await;
    assert_eq!(close["__close_code"], 1012);

    // Full teardown (server is already cancelled; this awaits the task and drops DB).
    app.shutdown().await;
}
