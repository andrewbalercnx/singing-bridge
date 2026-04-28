// File: server/tests/ws_lobby_cap.rs
// Purpose: LOBBY_CAP_PER_ROOM + MAX_ACTIVE_ROOMS enforcement. R1 finding #5.
// Last updated: Sprint 25 (2026-04-28) -- synchronise lobby fills via teacher watch to remove race

mod common;

use common::{recv_json, send_ws, spawn_app_with, TestOpts};

#[tokio::test]
async fn lobby_cap_rejects_extra_joins() {
    let opts = TestOpts {
        lobby_cap_per_room: 2,
        ..Default::default()
    };
    let app = spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@example.test", "alice").await;

    // Open a teacher watch socket so we can observe lobby growth and
    // serialise the joins. Without this, the three lobby_join messages
    // race for `room.write()` in ws/lobby.rs and the third lock-acquirer
    // (which may not be ws3) is the one that sees `lobby_full`.
    let mut teacher = app.open_ws(Some(&cookie), None).await;
    send_ws(
        &mut teacher,
        &serde_json::json!({"type":"lobby_watch","slug":"alice"}),
    )
    .await;
    let init = recv_json(&mut teacher).await;
    assert_eq!(init["type"], "lobby_state");
    assert_eq!(init["entries"].as_array().unwrap().len(), 0);

    // Fill the lobby — wait for each join to land before issuing the next.
    let mut ws1 = app.open_ws(None, None).await;
    send_ws(
        &mut ws1,
        &serde_json::json!({"type":"lobby_join","slug":"alice","email":"a@x","browser":"f","device_class":"desktop"}),
    )
    .await;
    let after_first = recv_json(&mut teacher).await;
    assert_eq!(after_first["type"], "lobby_state");
    assert_eq!(after_first["entries"].as_array().unwrap().len(), 1);

    let mut ws2 = app.open_ws(None, None).await;
    send_ws(
        &mut ws2,
        &serde_json::json!({"type":"lobby_join","slug":"alice","email":"b@x","browser":"f","device_class":"desktop"}),
    )
    .await;
    let after_second = recv_json(&mut teacher).await;
    assert_eq!(after_second["type"], "lobby_state");
    assert_eq!(after_second["entries"].as_array().unwrap().len(), 2);

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
