// File: server/src/http/mod.rs
// Purpose: Router composition, middleware stack, response-security headers.
// Role: Only place routes are declared; shape of the HTTP surface.
// Exports: router
// Depends: axum, tower-http, tower
// Invariants: every HTML route carries the strict CSP; /auth/* carries
//             Cache-Control: no-store. /healthz body is fixed JSON.
//             /api/dev-blob/* is only compiled and mounted in debug builds + dev mode.
//             /api/media/:token is public — the token itself is the auth.
// Last updated: Sprint 25 (2026-04-27) -- add /teach/:slug/dashboard and /teach/:slug/session routes

pub mod dashboard;
pub mod health;
pub mod history;
pub mod library;
pub mod login;
pub mod loopback;
pub mod media_token;
pub mod recording_gate;
pub mod recordings;
pub mod security_headers;
pub mod signup;
pub mod static_assets;
pub mod teach;
pub mod turn;
#[cfg(debug_assertions)]
pub mod test_peer;

use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    middleware,
    response::Html,
    routing::{delete, get, post},
    Router,
};

use crate::state::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    let dev = state.config.dev;
    #[allow(unused_mut)]
    let mut r = Router::new()
        .route("/signup", get(login::get_signup_form))
        .route("/auth/register", post(login::post_register))
        .route("/auth/login", get(login::get_login).post(login::post_login))
        .route("/auth/logout", post(login::post_logout))
        .route("/auth/verify", get(signup::get_verify))
        .route("/auth/consume", post(signup::post_consume))
        .route("/teach/:slug", get(teach::get_teach))
        .route("/teach/:slug/dashboard", get(dashboard::get_dashboard))
        .route("/teach/:slug/session", get(teach::get_session))
        .route("/teach/:slug/history", get(history::get_history))
        .route("/teach/:slug/recordings", get(recordings::get_recordings_page))
        // Accompaniment library
        .route("/teach/:slug/library", get(library::get_library_page))
        .route("/teach/:slug/library/assets",
            get(library::list_assets)
            .post(library::post_asset).layer(DefaultBodyLimit::disable()))
        .route("/teach/:slug/library/assets/:id",
            get(library::get_asset).delete(library::delete_asset))
        .route("/teach/:slug/library/assets/:id/parts", post(library::post_parts))
        .route("/teach/:slug/library/assets/:id/parts/:job_id", get(library::get_parts_status))
        .route("/teach/:slug/library/assets/:id/midi", post(library::post_midi))
        .route("/teach/:slug/library/assets/:id/rasterise", post(library::post_rasterise))
        .route("/teach/:slug/library/assets/:id/variants", post(library::post_variant))
        .route("/teach/:slug/library/assets/:id/variants/:vid",
            delete(library::delete_variant))
        // Media token delivery (public — token is the auth)
        .route("/api/media/:token", get(library::get_media))
        .route("/loopback", get(loopback::get_loopback))
        .route("/ws", get(crate::ws::ws_upgrade))
        .route("/healthz", get(health::get_healthz))
        .route("/turn-credentials", get(turn::get_turn_credentials))
        .route("/", get(signup::get_root))
        // Recording API
        .route("/api/recordings/upload", post(recordings::post_upload)
            .layer(DefaultBodyLimit::disable()))
        .route("/api/recordings", get(recordings::get_list))
        .route("/api/recordings/:id/send", post(recordings::post_send))
        .route("/api/recordings/:id", delete(recordings::delete_recording))
        // Student gate
        .route("/recording/:token", get(recording_gate::get_recording_page))
        .route("/recording/:token/verify", post(recording_gate::post_verify))
        .merge(static_assets::routes(&state.config));

    // Dev-only blob serving (compile-time gated to debug builds).
    #[cfg(debug_assertions)]
    if dev {
        r = r.route("/api/dev-blob/:key", get(recordings::get_dev_blob));
    }

    // Test-peer bot endpoint (compile-time gated; also requires SB_TEST_PEER=true).
    #[cfg(debug_assertions)]
    if state.config.test_peer {
        r = r
            .route("/test-peer", get(test_peer::get_test_peer))
            .route("/test-peer/session", post(test_peer::post_test_peer_session));
    }

    r.fallback(not_found)
     .layer(middleware::from_fn(move |req, next| {
        security_headers::apply_headers(dev, req, next)
    }))
    .with_state(state)
}

async fn not_found() -> (axum::http::StatusCode, Html<&'static str>) {
    (
        axum::http::StatusCode::NOT_FOUND,
        Html(r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page not found — singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main>
<h1>Page not found</h1>
<p>If your teacher sent you a link, it should look like <code>singing.rcnx.io/teach/roomname</code>.</p>
<p><a href="/">Go to singing-bridge</a></p>
</main></body></html>"#),
    )
}
