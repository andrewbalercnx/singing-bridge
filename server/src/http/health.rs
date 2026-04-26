// File: server/src/http/health.rs
// Purpose: GET /healthz — liveness probe. Returns 200 with server sha, db reachability,
//          and sidecar component health (audiveris, fluidsynth, ghostscript, sf2).
// Role: Single health endpoint for the load balancer, CI verify step, and ops dashboards.
// Exports: get_healthz
// Depends: axum, AppState, sidecar::SidecarClient
// Invariants: sha is baked in at compile time by build.rs (GIT_SHA env).
//             Returns 503 after shutdown.cancel() has been called.
//             Sidecar probe uses a 5 s timeout; unreachable → {"status":"unreachable"}.
//             DB ping uses sqlx SELECT 1; failure → {"status":"error","detail":"..."}.
// Last updated: Sprint 21 (2026-04-26) -- include sidecar + db health in response

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};

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

    let db_health = probe_db(&state).await;
    let sidecar_health = probe_sidecar(&state).await;

    let status = if db_health["status"] == "ok" && sidecar_health["status"] != "error" {
        "ok"
    } else {
        "degraded"
    };

    let body = json!({
        "status": status,
        "sha": GIT_SHA,
        "db": db_health,
        "sidecar": sidecar_health,
    });
    (StatusCode::OK, body.to_string()).into_response()
}

async fn probe_db(state: &AppState) -> Value {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => json!({"status": "ok"}),
        Err(e) => json!({"status": "error", "detail": e.to_string()}),
    }
}

async fn probe_sidecar(state: &AppState) -> Value {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(e) => return json!({"status": "error", "detail": e.to_string()}),
    };

    let base = state.sidecar.base_url().trim_end_matches('/');
    let url = format!("{base}/healthz");

    match client.get(&url).send().await {
        Err(e) => json!({"status": "unreachable", "detail": e.to_string()}),
        Ok(resp) => {
            if let Ok(body) = resp.json::<Value>().await {
                body
            } else {
                json!({"status": "error", "detail": "invalid json from sidecar"})
            }
        }
    }
}
