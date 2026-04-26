// File: server/src/http/health.rs
// Purpose: GET /healthz — liveness probe. Returns 200 with server sha, db reachability,
//          blob store write/read round-trip, and sidecar component health.
// Role: Single health endpoint for the load balancer, CI verify step, and ops dashboards.
// Exports: get_healthz
// Depends: axum, AppState, sidecar::SidecarClient, blob::BlobStore
// Invariants: sha is baked in at compile time by build.rs (GIT_SHA env).
//             Returns 503 after shutdown.cancel() has been called.
//             Sidecar probe uses a 5 s timeout; unreachable → {"status":"unreachable"}.
//             DB ping uses sqlx SELECT 1; failure → {"status":"error","detail":"..."}.
//             Blob probe writes 4 bytes under a fixed health-check key, reads back, deletes.
//             Overall status is "ok" only when db, blob, and sidecar are all ok.
// Last updated: Sprint 21 (2026-04-26) -- add blob store health probe; status degraded when any subsystem fails

use std::io::Cursor;
use std::pin::Pin;
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
const BLOB_HEALTH_KEY: &str = "_healthz_probe.bin";

pub async fn get_healthz(State(state): State<Arc<AppState>>) -> Response {
    if state.shutdown.is_cancelled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"status":"shutting_down"}"#,
        )
            .into_response();
    }

    let (db_health, blob_health, sidecar_health) = tokio::join!(
        probe_db(&state),
        probe_blob(&state),
        probe_sidecar(&state),
    );

    let all_ok = db_health["status"] == "ok"
        && blob_health["status"] == "ok"
        && sidecar_health["status"] == "ok";

    let body = json!({
        "status": if all_ok { "ok" } else { "degraded" },
        "sha": GIT_SHA,
        "db": db_health,
        "blob": blob_health,
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

async fn probe_blob(state: &AppState) -> Value {
    let probe_data: &[u8] = b"ping";
    let reader: Pin<Box<dyn tokio::io::AsyncRead + Send>> =
        Box::pin(tokio::io::BufReader::new(Cursor::new(probe_data)));

    if let Err(e) = state.blob.put(BLOB_HEALTH_KEY, reader).await {
        return json!({"status": "error", "detail": format!("write failed: {e}")});
    }
    match state.blob.get_bytes(BLOB_HEALTH_KEY).await {
        Err(e) => json!({"status": "error", "detail": format!("read failed: {e}")}),
        Ok(bytes) if bytes.as_ref() != probe_data => {
            json!({"status": "error", "detail": "read-back data mismatch"})
        }
        Ok(_) => {
            let _ = state.blob.delete(BLOB_HEALTH_KEY).await;
            json!({"status": "ok"})
        }
    }
}

async fn probe_sidecar(state: &AppState) -> Value {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(e) => return json!({"status": "error", "detail": e.to_string()}),
    };

    let base = state.sidecar.base_url().trim_end_matches('/');

    // Component check (unauthenticated).
    let components = match client.get(&format!("{base}/healthz")).send().await {
        Err(e) => return json!({"status": "unreachable", "detail": e.to_string()}),
        Ok(resp) => resp.json::<Value>().await.unwrap_or(json!({"status": "error"})),
    };

    // Auth check — POST /ping with the actual SIDECAR_SECRET.
    // Detects secret mismatches that would cause every tool call to fail.
    let auth = format!("Bearer {}", state.config.sidecar_secret.expose());
    let auth_status = match client
        .post(&format!("{base}/ping"))
        .header("Authorization", auth)
        .send()
        .await
    {
        Err(e) => json!({"status": "unreachable", "detail": e.to_string()}),
        Ok(r) if r.status().is_success() => json!({"status": "ok"}),
        Ok(r) => json!({"status": "auth_failed", "http_status": r.status().as_u16()}),
    };

    let overall = if components.get("status").and_then(|v| v.as_str()) == Some("ok")
        && auth_status.get("status").and_then(|v| v.as_str()) == Some("ok")
    {
        "ok"
    } else {
        "degraded"
    };

    let mut result = components;
    result["status"] = json!(overall);
    result["auth"] = auth_status;
    result
}
