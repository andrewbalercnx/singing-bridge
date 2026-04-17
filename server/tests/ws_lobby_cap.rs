// File: server/tests/ws_lobby_cap.rs
// Purpose: LOBBY_CAP_PER_ROOM + MAX_ACTIVE_ROOMS enforcement. R1 finding #5.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::{recv_json, send_ws, spawn_app_with, TestOpts};

#[tokio::test]
async fn lobby_cap_rejects_extra_joins() {
    let opts = TestOpts {
        lobby_cap_per_room: 2,
        ..Default::default()
    };
    let app = spawn_app_with(opts).await;
    let _ = app.signup_teacher("t@example.test", "alice").await;

    // Fill the lobby.
    let mut ws1 = app.open_ws(None, None).await;
    send_ws(
        &mut ws1,
        &serde_json::json!({"type":"lobby_join","slug":"alice","email":"a@x","browser":"f","device_class":"desktop"}),
    )
    .await;
    let mut ws2 = app.open_ws(None, None).await;
    send_ws(
        &mut ws2,
        &serde_json::json!({"type":"lobby_join","slug":"alice","email":"b@x","browser":"f","device_class":"desktop"}),
    )
    .await;

    // The third join must error with lobby_full and leave the socket open.
    let mut ws3 = app.open_ws(None, None).await;
    send_ws(
        &mut ws3,
        &serde_json::json!({"type":"lobby_join","slug":"alice","email":"c@x","browser":"f","device_class":"desktop"}),
    )
    .await;
    let msg = recv_json(&mut ws3).await;
    assert_eq!(msg["type"], "error");
    assert_eq!(msg["code"], "lobby_full");

    app.shutdown().await;
}
