// File: server/src/http/mod.rs
// Purpose: Router composition, middleware stack, response-security headers.
// Role: Only place routes are declared; shape of the HTTP surface.
// Exports: router
// Depends: axum, tower-http, tower
// Invariants: every HTML route carries the strict CSP; /auth/* carries
//             Cache-Control: no-store. /healthz body is fixed JSON.
// Last updated: Sprint 5 (2026-04-18) -- add /healthz, /turn-credentials

pub mod health;
pub mod loopback;
pub mod security_headers;
pub mod signup;
pub mod static_assets;
pub mod teach;
pub mod turn;

use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};

use crate::state::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    let dev = state.config.dev;
    Router::new()
        .route("/signup", post(signup::post_signup).get(signup::get_signup))
        .route("/auth/verify", get(signup::get_verify))
        .route("/auth/consume", post(signup::post_consume))
        .route("/teach/:slug", get(teach::get_teach))
        .route("/loopback", get(loopback::get_loopback))
        .route("/ws", get(crate::ws::ws_upgrade))
        .route("/healthz", get(health::get_healthz))
        .route("/turn-credentials", get(turn::get_turn_credentials))
        .route("/", get(signup::get_root))
        .merge(static_assets::routes(&state.config))
        .layer(middleware::from_fn(move |req, next| {
            security_headers::apply_headers(dev, req, next)
        }))
        .with_state(state)
}
