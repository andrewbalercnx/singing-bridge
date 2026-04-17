// File: server/tests/ws_shutdown.rs
// Purpose: Server shutdown broadcasts ServerShutdown then closes with code 1012.
// R1 findings #11, #13.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

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

    let shutdown_token = app.state.shutdown.clone();
    let server_handle = app.server_handle;
    let addr = app.addr;
    let mail_dir = app.mail_dir;
    let state = app.state.clone();
    shutdown_token.cancel();

    // Next two messages should be server_shutdown then close 1012.
    let msg = recv_json(&mut teacher).await;
    assert_eq!(msg["type"], "server_shutdown");
    let close = recv_json(&mut teacher).await;
    assert_eq!(close["__close_code"], 1012);

    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), server_handle).await;
    drop(state);
    drop(mail_dir);
    let _ = addr;
}
