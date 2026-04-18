// File: server/src/http/turn.rs
// Purpose: GET /turn-credentials — issues time-limited coturn REST API creds.
// Role: Single source of TURN credentials for teacher RTCPeerConnection setup.
//       Student credentials are delivered in ServerMsg::Admitted via the WS
//       handshake; this endpoint is teacher-only (validated session cookie).
// Exports: get_turn_credentials, build_ice_servers
// Depends: axum, hmac, sha1, base64, AppState, auth
// Invariants: In dev mode (no turn_host), returns empty iceServers list with
//             ttl=60 — no rate limiting applied. In prod, computes HMAC-SHA1
//             credentials per coturn "use-auth-secret" spec. Returns 401 if
//             no valid teacher session cookie is present. Returns 429 on
//             per-IP rate limit breach. turns:// omitted until TLS cert is
//             provisioned on the TURN VM (Finding #53).
// Last updated: Sprint 5 (2026-04-18) -- cookie auth, no turns://, R1 fixes

use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use std::net::SocketAddr;

use crate::config::Config;
use crate::state::AppState;
use crate::ws::resolve_peer_ip;
use crate::ws::rate_limit::check_and_inc;

type HmacSha1 = Hmac<Sha1>;

/// Compute ICE server configuration using the coturn HMAC-SHA1 REST API spec.
/// Returns `None` in dev mode (no TURN host configured).
/// `turns://` is intentionally omitted until TLS is provisioned on the TURN VM.
pub(crate) fn build_ice_servers(config: &Config, now_unix: i64) -> Option<(Value, i64)> {
    let turn_host = config.turn_host.as_deref()?;
    let shared_secret = config.turn_shared_secret.as_ref()?;
    let ttl = config.turn_ttl_secs;
    let expiry = now_unix + ttl;
    let realm = "singing.rcnx.io";
    let username = format!("{expiry}:{realm}");

    let mut mac = HmacSha1::new_from_slice(shared_secret.expose().as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(username.as_bytes());
    let credential = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

    let ice_servers = json!([
        { "urls": [format!("stun:{turn_host}:3478")] },
        {
            "urls": [
                format!("turn:{turn_host}:3478?transport=udp"),
                format!("turn:{turn_host}:3478?transport=tcp"),
            ],
            "username": username,
            "credential": credential,
            "credentialType": "password",
        }
    ]);
    Some((ice_servers, ttl))
}

pub async fn get_turn_credentials(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // Only teachers (authenticated via session cookie) may call this endpoint.
    // Students receive TURN credentials in ServerMsg::Admitted.
    if crate::auth::resolve_teacher_from_cookie(&state.db, &headers).await.is_none() {
        return (StatusCode::UNAUTHORIZED, "authentication required").into_response();
    }

    // Dev mode: no TURN host configured → return empty ice servers.
    let Some(turn_host) = state.config.turn_host.as_deref() else {
        let body = json!({ "iceServers": [], "ttl": 60 });
        return no_store_json(body);
    };
    let _ = turn_host; // used via build_ice_servers below

    let peer_ip = resolve_peer_ip(&state.config, &headers, addr);

    // Per-IP rate limit (independent of WS join limiter).
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp();
    let over = check_and_inc(
        &*state.turn_cred_rate_limits,
        peer_ip,
        state.config.turn_cred_rate_limit_per_ip,
        state.config.turn_cred_rate_limit_window_secs,
        now_unix,
    );
    if over {
        return (StatusCode::TOO_MANY_REQUESTS, "rate limited").into_response();
    }

    match build_ice_servers(&state.config, now_unix) {
        Some((ice_servers, ttl)) => {
            let body = json!({ "iceServers": ice_servers, "ttl": ttl });
            no_store_json(body)
        }
        None => {
            tracing::error!("turn_shared_secret or turn_host missing in prod");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn no_store_json(body: Value) -> Response {
    let mut resp = Json(body).into_response();
    resp.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    resp
}
