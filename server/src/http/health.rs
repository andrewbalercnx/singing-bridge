// File: server/src/http/health.rs
// Purpose: GET /healthz — liveness probe. Returns 200 {"status":"ok"} in
//          normal state and 503 after the shutdown signal fires.
// Role: Single liveness endpoint for the load balancer / Container App probe.
// Exports: get_healthz
// Depends: axum, AppState
// Invariants: body is a fixed JSON string — no version or internal state.
//             Returns 503 after shutdown.cancel() has been called.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::state::AppState;

pub async fn get_healthz(State(state): State<Arc<AppState>>) -> Response {
    if state.shutdown.is_cancelled() {
        return (StatusCode::SERVICE_UNAVAILABLE, r#"{"status":"shutting_down"}"#).into_response();
    }
    (StatusCode::OK, r#"{"status":"ok"}"#).into_response()
}
