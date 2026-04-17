// File: server/src/http/mod.rs
// Purpose: Router composition, middleware stack, response-security headers.
// Role: Only place routes are declared; shape of the HTTP surface.
// Exports: router
// Depends: axum, tower-http, tower
// Invariants: every HTML route carries the strict CSP; /auth/* carries
//             Cache-Control: no-store.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

pub mod security_headers;
pub mod signup;
pub mod static_assets;
pub mod teach;

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
        .route("/ws", get(crate::ws::ws_upgrade))
        .route("/", get(signup::get_root))
        .merge(static_assets::routes(&state.config))
        .layer(middleware::from_fn(move |req, next| {
            security_headers::apply_headers(dev, req, next)
        }))
        .with_state(state)
}
