// File: server/tests/http_origin.rs
// Purpose: WebSocket Origin enforcement — R1 finding #3.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use common::spawn_app;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[tokio::test]
async fn ws_upgrade_cross_origin_rejected() {
    let app = spawn_app().await;

    let url = format!("ws://{}/ws", app.addr);
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert(
        reqwest::header::ORIGIN,
        "https://evil.example".parse().unwrap(),
    );
    let err = tokio_tungstenite::connect_async(req).await.err();
    assert!(
        err.is_some(),
        "cross-origin WS connect should be rejected, got Ok"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn ws_upgrade_missing_origin_rejected() {
    let app = spawn_app().await;
    let url = format!("ws://{}/ws", app.addr);
    let req = url.into_client_request().unwrap();
    // Tungstenite sets its own Origin by default — strip it.
    let mut req = req;
    req.headers_mut().remove(reqwest::header::ORIGIN);
    let err = tokio_tungstenite::connect_async(req).await.err();
    assert!(err.is_some(), "missing-Origin WS connect should be rejected");
    app.shutdown().await;
}

#[tokio::test]
async fn ws_upgrade_matching_origin_accepted() {
    let app = spawn_app().await;
    let ws = app.open_ws(None, None).await;
    drop(ws);
    app.shutdown().await;
}
