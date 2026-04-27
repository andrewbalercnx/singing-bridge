// File: server/src/http/test_peer.rs
// Purpose: Dev-only bot-peer endpoint. Spawns a Playwright bot subprocess that
//          emulates a teacher or student for manual UX testing.
// Role: HTTP handlers for GET /test-peer and POST /test-peer/session; TokenStore.
// Exports: get_test_peer, post_test_peer_session, TokenStore
// Depends: axum, tokio::process, dashmap, rand, hex, auth::issue_session_cookie
// Invariants: Token consumed exactly once; slug inserted into active_bots before
//             cleanup watcher spawned; token store capped at TOKEN_CAP live entries;
//             bot session TTL = 180 s (matches bot lifetime by construction).
//             Routes only compiled in debug builds; SB_TEST_PEER=true also required at runtime.
// Last updated: Sprint 25 (2026-04-27) -- initial implementation

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use dashmap::DashMap;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

const TOKEN_TTL: Duration = Duration::from_secs(30);
const TOKEN_CAP: usize = 100;

struct TokenEntry {
    slug: String,
    expires: Instant,
}

pub struct TokenStore {
    inner: DashMap<String, TokenEntry>,
    cap: usize,
}

#[derive(Debug, PartialEq)]
pub enum TokenError {
    NotFound,
    CapExceeded,
}

impl TokenStore {
    pub fn new() -> Self {
        Self {
            inner: DashMap::new(),
            cap: TOKEN_CAP,
        }
    }

    pub fn insert(&self, slug: String) -> Result<String, TokenError> {
        let now = Instant::now();
        self.inner.retain(|_, v| v.expires > now);
        if self.inner.len() >= self.cap {
            return Err(TokenError::CapExceeded);
        }
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        self.inner.insert(token.clone(), TokenEntry { slug, expires: now + TOKEN_TTL });
        Ok(token)
    }

    pub fn consume(&self, token: &str) -> Result<String, TokenError> {
        let now = Instant::now();
        match self.inner.remove(token) {
            Some((_, entry)) if entry.expires > now => Ok(entry.slug),
            Some(_) => Err(TokenError::NotFound),
            None => Err(TokenError::NotFound),
        }
    }
}

// ---------------------------------------------------------------------------
// Handler: GET /test-peer
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TestPeerQuery {
    slug: String,
    mode: String,
}

#[derive(Serialize)]
struct TestPeerResponse {
    mode: String,
    slug: String,
}

pub async fn get_test_peer(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TestPeerQuery>,
) -> impl IntoResponse {
    match validate_and_reserve(&q.slug, &q.mode, &state).await {
        Ok((token, asset_id, variant_id)) => {
            spawn_bot(q.slug, q.mode, token, asset_id, variant_id, &state).await
        }
        Err(resp) => resp,
    }
}

fn is_valid_mode(mode: &str) -> bool {
    mode == "teacher" || mode == "student"
}

async fn validate_and_reserve(
    slug: &str,
    mode: &str,
    state: &Arc<AppState>,
) -> Result<(String, Option<i64>, Option<i64>), axum::response::Response> {
    if !is_valid_mode(mode) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid_mode"})),
        ).into_response());
    }

    // Atomic check-and-reserve: the DashMap shard lock is held for the duration
    // of the match, so two concurrent requests for the same slug cannot both
    // pass the duplicate check before either inserts.
    match state.active_bots.entry(slug.to_string()) {
        dashmap::mapref::entry::Entry::Occupied(_) => {
            return Err((
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": "bot_already_running"})),
            ).into_response());
        }
        dashmap::mapref::entry::Entry::Vacant(v) => { v.insert(()); }
    }

    // Slug is now in active_bots. Remove it on any failure path below.
    let (asset_id, variant_id) = if mode == "teacher" {
        match find_teacher_asset(&state.db, slug).await {
            Ok(Some((aid, vid))) => (Some(aid), Some(vid)),
            Ok(None) => {
                state.active_bots.remove(slug);
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "no_wav_variant"})),
                ).into_response());
            }
            Err(DbError::NoTeacher) => {
                state.active_bots.remove(slug);
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "no_teacher"})),
                ).into_response());
            }
            Err(DbError::Query) => {
                state.active_bots.remove(slug);
                return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
        }
    } else {
        (None, None)
    };

    let token = match state.token_store.insert(slug.to_string()) {
        Ok(t) => t,
        Err(TokenError::CapExceeded) => {
            state.active_bots.remove(slug);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "bot_capacity"})),
            ).into_response());
        }
        Err(_) => {
            state.active_bots.remove(slug);
            return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    };

    Ok((token, asset_id, variant_id))
}

async fn spawn_bot(
    slug: String,
    mode: String,
    token: String,
    asset_id: Option<i64>,
    variant_id: Option<i64>,
    state: &Arc<AppState>,
) -> axum::response::Response {
    let base_url = state.config.base_url.as_str().trim_end_matches('/').to_string();
    let cmd = state.config.test_peer_script.as_deref().unwrap_or("python3");

    let mut args = vec![
        "scripts/test_peer.py".to_string(),
        "--server".to_string(), base_url,
        "--slug".to_string(), slug.clone(),
        "--mode".to_string(), mode.clone(),
    ];
    if let (Some(aid), Some(vid)) = (asset_id, variant_id) {
        args.push("--asset-id".to_string());
        args.push(aid.to_string());
        args.push("--variant-id".to_string());
        args.push(vid.to_string());
    }

    let mut child = match tokio::process::Command::new(cmd)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => {
            state.active_bots.remove(&slug);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "bot_unavailable"})),
            ).into_response();
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{token}\n").as_bytes()).await;
        // Drop closes the pipe, signalling EOF to the subprocess.
    }

    // Slug was already inserted into active_bots atomically in validate_and_reserve.
    let active_bots = Arc::clone(&state.active_bots);
    let slug_owned = slug.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        active_bots.remove(&slug_owned);
    });

    (StatusCode::ACCEPTED, Json(TestPeerResponse { mode, slug })).into_response()
}

// ---------------------------------------------------------------------------
// Handler: POST /test-peer/session
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SessionBody {
    token: String,
}

pub async fn post_test_peer_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionBody>,
) -> impl IntoResponse {
    let slug = match state.token_store.consume(&body.token) {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "invalid_token"})),
            ).into_response();
        }
    };

    let row = sqlx::query_as::<_, (i64,)>("SELECT id FROM teachers WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await;

    let teacher_id: crate::auth::magic_link::TeacherId = match row {
        Ok(Some((id,))) => id,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "no_teacher"})),
            ).into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let raw = match crate::auth::issue_session_cookie(&state.db, teacher_id, 180).await {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let secure = if state.config.base_url.scheme() == "https" { "; Secure" } else { "" };
    let cookie = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=180{}",
        crate::auth::SESSION_COOKIE_NAME,
        raw,
        secure
    );

    (
        StatusCode::OK,
        [(axum::http::header::SET_COOKIE, cookie)],
        Json(serde_json::json!({})),
    ).into_response()
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

enum DbError {
    NoTeacher,
    Query,
}

async fn find_teacher_asset(
    pool: &sqlx::PgPool,
    slug: &str,
) -> Result<Option<(i64, i64)>, DbError> {
    let teacher = sqlx::query_as::<_, (i64,)>("SELECT id FROM teachers WHERE slug = $1")
        .bind(slug)
        .fetch_optional(pool)
        .await
        .map_err(|_| DbError::Query)?;

    let teacher_id = match teacher {
        Some((id,)) => id,
        None => return Err(DbError::NoTeacher),
    };

    sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT a.id, v.id
           FROM accompaniments a
           JOIN accompaniment_variants v ON v.accompaniment_id = a.id
           WHERE a.teacher_id = $1
             AND a.deleted_at IS NULL
             AND v.deleted_at IS NULL
           ORDER BY (a.title ILIKE '%rainbow%') DESC, v.created_at ASC
           LIMIT 1"#,
    )
    .bind(teacher_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| DbError::Query)
}

// ---------------------------------------------------------------------------
// Unit tests (token store)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn insert_and_consume_returns_correct_slug() {
        let store = TokenStore::new();
        let token = store.insert("myroom".to_string()).unwrap();
        assert_eq!(store.consume(&token).unwrap(), "myroom");
    }

    #[test]
    fn consume_same_token_twice_is_not_found() {
        let store = TokenStore::new();
        let token = store.insert("myroom".to_string()).unwrap();
        store.consume(&token).unwrap();
        assert_eq!(store.consume(&token), Err(TokenError::NotFound));
    }

    #[test]
    fn consume_expired_token_is_not_found() {
        let store = TokenStore { inner: DashMap::new(), cap: TOKEN_CAP };
        let token = {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let t = hex::encode(bytes);
            store.inner.insert(t.clone(), TokenEntry {
                slug: "myroom".to_string(),
                expires: Instant::now() - Duration::from_secs(1),
            });
            t
        };
        assert_eq!(store.consume(&token), Err(TokenError::NotFound));
    }

    #[test]
    fn insert_at_cap_returns_cap_exceeded() {
        let store = TokenStore { inner: DashMap::new(), cap: 3 };
        store.insert("a".to_string()).unwrap();
        store.insert("b".to_string()).unwrap();
        store.insert("c".to_string()).unwrap();
        assert_eq!(store.insert("d".to_string()), Err(TokenError::CapExceeded));
    }

    #[test]
    fn sweep_expired_removes_stale_keeps_live() {
        let store = TokenStore { inner: DashMap::new(), cap: TOKEN_CAP };
        // Insert an already-expired entry directly.
        store.inner.insert("expired".to_string(), TokenEntry {
            slug: "x".to_string(),
            expires: Instant::now() - Duration::from_secs(1),
        });
        // Insert a live entry via the public API.
        let live_token = store.insert("live".to_string()).unwrap();
        // sweep_expired runs inside insert; expired entry should be gone.
        assert!(!store.inner.contains_key("expired"));
        assert!(store.inner.contains_key(&live_token));
    }

    #[test]
    fn mode_validation_table() {
        for bad in &["", "wizard", "TEACHER", "student ", "Teacher"] {
            assert!(!is_valid_mode(bad), "mode '{bad}' should be invalid");
        }
        for good in &["teacher", "student"] {
            assert!(is_valid_mode(good), "mode '{good}' should be valid");
        }
    }

    #[test]
    fn active_bots_entry_api_is_atomic() {
        let bots: DashMap<String, ()> = DashMap::new();
        // Vacant entry inserts atomically.
        let inserted = match bots.entry("myroom".to_string()) {
            dashmap::mapref::entry::Entry::Vacant(v) => { v.insert(()); true }
            dashmap::mapref::entry::Entry::Occupied(_) => false,
        };
        assert!(inserted);
        // Second entry call sees the occupied entry.
        let conflict = match bots.entry("myroom".to_string()) {
            dashmap::mapref::entry::Entry::Occupied(_) => true,
            dashmap::mapref::entry::Entry::Vacant(_) => false,
        };
        assert!(conflict);
        // Removal clears for the next request.
        bots.remove("myroom");
        assert!(!bots.contains_key("myroom"));
    }
}
