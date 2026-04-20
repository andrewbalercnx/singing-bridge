// File: server/src/http/health.rs
// Purpose: GET /healthz — liveness probe. Returns 200 {"status":"ok","sha":"<git>"}
//          in normal state and 503 after the shutdown signal fires.
// Role: Single liveness endpoint for the load balancer / Container App probe.
// Exports: get_healthz
// Depends: axum, AppState
// Invariants: sha is baked in at compile time by build.rs (GIT_SHA env).
//             Returns 503 after shutdown.cancel() has been called.
// Last updated: Sprint 9 (2026-04-20) -- add git sha to response body

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::state::AppState;

const GIT_SHA: &str = env!("GIT_SHA");

pub async fn get_healthz(State(state): State<Arc<AppState>>) -> Response {
    if state.shutdown.is_cancelled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"status":"shutting_down"}"#,
        )
            .into_response();
    }
    let body = format!(r#"{{"status":"ok","sha":"{GIT_SHA}"}}"#);
    (StatusCode::OK, body).into_response()
}
