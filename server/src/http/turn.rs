// File: server/src/http/turn.rs
// Purpose: GET /turn-credentials — issues time-limited coturn REST API creds.
// Role: Single source of TURN credentials for client RTCPeerConnection setup.
// Exports: get_turn_credentials
// Depends: axum, hmac, sha1, base64, AppState
// Invariants: In dev mode (no turn_host), returns empty iceServers list with
//             ttl=60 — no rate limiting applied. In prod, computes HMAC-SHA1
//             credentials per coturn "use-auth-secret" spec. Returns 429 on
//             per-IP rate limit breach (independent of WS join limiter).
// Last updated: Sprint 5 (2026-04-18) -- initial implementation
#![allow(dead_code)]

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

use crate::state::AppState;
use crate::ws::resolve_peer_ip;
use crate::ws::rate_limit::check_and_inc;

type HmacSha1 = Hmac<Sha1>;

pub async fn get_turn_credentials(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // Dev mode: no TURN host configured → return empty ice servers.
    let Some(turn_host) = state.config.turn_host.as_deref() else {
        let body = json!({ "iceServers": [], "ttl": 60 });
        return no_store_json(body);
    };

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

    let Some(shared_secret) = state.config.turn_shared_secret.as_ref() else {
        tracing::error!("turn_shared_secret missing in prod");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    let ttl = state.config.turn_ttl_secs;
    let expiry = now_unix + ttl;
    let realm = "singing.rcnx.io";
    let username = format!("{expiry}:{realm}");

    // HMAC-SHA1(shared_secret, username) then base64-encode.
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
                format!("turns:{turn_host}:5349?transport=tcp"),
            ],
            "username": username,
            "credential": credential,
            "credentialType": "password",
        }
    ]);

    let body = json!({ "iceServers": ice_servers, "ttl": ttl });
    no_store_json(body)
}

fn no_store_json(body: Value) -> Response {
    let mut resp = Json(body).into_response();
    resp.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    resp
}
