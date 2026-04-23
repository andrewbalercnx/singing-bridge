// File: server/src/http/login.rs
// Purpose: Password-auth HTTP handlers: register, login, logout.
// Role: Replaces magic-link signup with email+password credential flow.
// Exports: get_login, post_login, post_logout, get_signup_form, post_register
// Depends: axum, sqlx, serde, auth::password, auth::slug
// Invariants: post_login always performs one Argon2 verify + one DB write
//             regardless of whether the email is known, making timing
//             indistinguishable across all failure paths.
//             peer_ip always derived from ConnectInfo<SocketAddr>.
// Last updated: Sprint 10 (2026-04-21) -- initial implementation

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::auth::{
    cookie_hash, extract_cookie_value, issue_session_cookie, magic_link,
    password::{self, LimitConfig, LimitResult, DUMMY_PHC},
    slug::{suggest_alternatives, validate as validate_slug},
    SESSION_COOKIE_NAME,
};
use crate::error::{AppError, Result};
use crate::state::AppState;

// ── Register ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RegisterForm {
    pub email: String,
    pub slug: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct ConflictBody {
    pub code: &'static str,
    pub message: &'static str,
    pub suggestions: Vec<String>,
}

pub async fn get_signup_form() -> Html<&'static str> {
    Html(SIGNUP_HTML)
}

pub async fn post_register(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(form): Json<RegisterForm>,
) -> Result<Response> {
    let email = form.email.trim().to_ascii_lowercase();
    if email.is_empty() || !email.contains('@') || email.len() > crate::ws::protocol::MAX_EMAIL_LEN
    {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    let slug = validate_slug(&form.slug)?;

    // Server-side password policy.
    if form.password.len() < 12 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "code": "password_too_short" })),
        )
            .into_response());
    }
    if form.password.len() > 128 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "code": "password_too_long" })),
        )
            .into_response());
    }

    // Enforce signup rate limit (reuses existing rate_limit module).
    let limits = crate::auth::rate_limit::Limits {
        per_email: state.config.signup_rate_limit_per_email,
        per_ip: state.config.signup_rate_limit_per_ip,
        window_secs: state.config.signup_rate_limit_window_secs,
    };
    crate::auth::rate_limit::check_and_record(&state.db, &email, &addr.ip().to_string(), &limits)
        .await?;

    // Check slug uniqueness.
    let taken: Option<(magic_link::TeacherId,)> =
        sqlx::query_as("SELECT id FROM teachers WHERE slug = ?")
            .bind(&slug)
            .fetch_optional(&state.db)
            .await?;
    if taken.is_some() {
        let body = ConflictBody {
            code: "slug_taken",
            message: "that slug is taken",
            suggestions: suggest_alternatives(&slug),
        };
        return Ok((StatusCode::CONFLICT, Json(body)).into_response());
    }

    // Check email uniqueness.
    let email_taken: Option<(magic_link::TeacherId,)> =
        sqlx::query_as("SELECT id FROM teachers WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    if email_taken.is_some() {
        return Ok((
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "code": "email_taken", "message": "email already registered" })),
        )
            .into_response());
    }

    let hash = password::hash_password(&form.password).await?;
    let created = time::OffsetDateTime::now_utc().unix_timestamp();
    let (tid,): (magic_link::TeacherId,) = sqlx::query_as(
        "INSERT INTO teachers (email, slug, created_at, password_hash) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(&email)
    .bind(&slug)
    .bind(created)
    .bind(&hash)
    .fetch_one(&state.db)
    .await?;

    let cookie = issue_session_cookie(&state.db, tid, state.config.session_ttl_secs).await?;
    Ok(session_cookie_response(
        &state,
        &cookie,
        &format!("/teach/{slug}"),
    )?)
}

// ── Login ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginForm {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginOk {
    pub redirect: String,
}

pub async fn get_login() -> Response {
    let mut resp = Html(LOGIN_HTML).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    resp
}

pub async fn post_login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(form): Json<LoginForm>,
) -> Result<Response> {
    let email = form.email.trim().to_ascii_lowercase();
    let peer_ip = addr.ip().to_string();

    // 1. Look up teacher.
    let row: Option<(magic_link::TeacherId, Option<String>)> =
        sqlx::query_as("SELECT id, password_hash FROM teachers WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;

    let (teacher_id_opt, candidate_phc) = match &row {
        Some((tid, Some(phc))) => (Some(*tid), phc.as_str()),
        Some((tid, None)) => (Some(*tid), DUMMY_PHC.as_str()),
        None => (None, DUMMY_PHC.as_str()),
    };

    // 2. Constant-time verify (always runs regardless of account existence).
    let verified = password::verify_password(&form.password, candidate_phc);

    // 3. Record attempt + check limits (always writes DB).
    let limit_cfg = LimitConfig {
        account_window_secs: state.config.login_account_window_secs,
        account_max_failures: state.config.login_account_max_failures,
        ip_window_secs: state.config.login_ip_window_secs,
        ip_max_attempts: state.config.login_ip_max_attempts,
    };
    match password::record_and_check_limits(&state.db, teacher_id_opt, &peer_ip, &limit_cfg)
        .await?
    {
        LimitResult::IpThrottled | LimitResult::AccountLocked => {
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({ "code": "too_many_attempts" })),
            )
                .into_response());
        }
        LimitResult::Allow => {}
    }

    // 4. Reject if verify failed, no account, or NULL hash.
    let tid = match &row {
        Some((tid, Some(_))) if verified => *tid,
        Some((_, None)) => {
            // NULL hash path: different message when reset is enabled.
            let msg = if state.config.password_reset_enabled {
                "no password set — use the magic link sent to your email"
            } else {
                "invalid credentials"
            };
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "code": "invalid_credentials", "message": msg })),
            )
                .into_response());
        }
        _ => {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "code": "invalid_credentials", "message": "invalid credentials" })),
            )
                .into_response());
        }
    };

    // 5. Record success + issue session.
    sqlx::query(
        "UPDATE login_attempts SET succeeded = 1 WHERE teacher_id = ? AND attempted_at = (SELECT MAX(attempted_at) FROM login_attempts WHERE teacher_id = ?)",
    )
    .bind(tid)
    .bind(tid)
    .execute(&state.db)
    .await?;

    let (slug,): (String,) = sqlx::query_as("SELECT slug FROM teachers WHERE id = ?")
        .bind(tid)
        .fetch_one(&state.db)
        .await?;

    let cookie = issue_session_cookie(&state.db, tid, state.config.session_ttl_secs).await?;
    let mut resp = Json(LoginOk { redirect: format!("/teach/{slug}") }).into_response();
    set_session_cookie_header(&mut resp, &state, &cookie)?;
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

// ── Logout ───────────────────────────────────────────────────────────────────

pub async fn post_logout(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<Response> {
    let raw = extract_cookie_value(&headers, SESSION_COOKIE_NAME)
        .ok_or_else(|| AppError::Unauthorized)?;
    let hash = cookie_hash(&raw);
    let deleted = sqlx::query("DELETE FROM sessions WHERE cookie_hash = ?")
        .bind(&hash)
        .execute(&state.db)
        .await?
        .rows_affected();
    if deleted == 0 {
        return Err(AppError::Unauthorized);
    }
    let expire_header = format!(
        "{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    );
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&expire_header)
            .map_err(|e| AppError::Internal(format!("cookie header: {e}").into()))?,
    );
    Ok(resp)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn session_cookie_response(state: &AppState, cookie: &str, redirect: &str) -> Result<Response> {
    let mut resp = Json(LoginOk { redirect: redirect.to_owned() }).into_response();
    set_session_cookie_header(&mut resp, state, cookie)?;
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

fn set_session_cookie_header(resp: &mut Response, state: &AppState, cookie: &str) -> Result<()> {
    let secure = if state.config.require_secure_cookie() { "; Secure" } else { "" };
    let header_val = format!(
        "{SESSION_COOKIE_NAME}={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max}{secure}",
        max = state.config.session_ttl_secs
    );
    resp.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&header_val)
            .map_err(|e| AppError::Internal(format!("cookie header: {e}").into()))?,
    );
    Ok(())
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const LOGIN_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in — Singing Bridge</title>
<link rel="stylesheet" href="/assets/styles.css">
<link rel="stylesheet" href="/assets/theme.css">
</head>
<body class="sb-page sb-auth-page">
<div class="sb-card sb-card--paper">
  <div class="sb-brand"><span class="sb-brand__dot"></span>Singing Bridge</div>
  <h1>Welcome back</h1>
  <p class="sb-lede">Sign in to your teacher account.</p>
  <form id="f" class="sb-stack sb-mt-8">
    <div class="sb-field">
      <label class="sb-label" for="f-email">Email</label>
      <input class="sb-input" id="f-email" type="email" name="email" required placeholder="you@email.com" autocomplete="email">
    </div>
    <div class="sb-field">
      <label class="sb-label" for="f-pass">Password</label>
      <input class="sb-input" id="f-pass" type="password" name="password" required>
    </div>
    <button class="sb-btn sb-btn--block sb-btn--lg sb-mt-2" type="submit">Sign in</button>
    <p class="sb-text-center sb-text-muted sb-text-sm sb-mt-4">
      New here? <a href="/signup">Create an account</a>
    </p>
  </form>
  <p id="status" class="sb-text-muted sb-text-sm sb-mt-3"></p>
</div>
<script src="/assets/login.js"></script>
</body>
</html>"#;

const SIGNUP_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create account — Singing Bridge</title>
<link rel="stylesheet" href="/assets/styles.css">
<link rel="stylesheet" href="/assets/theme.css">
</head>
<body class="sb-page sb-auth-page">
<div class="sb-card sb-card--paper">
  <div class="sb-brand"><span class="sb-brand__dot"></span>Singing Bridge</div>
  <h1>Join the studio</h1>
  <p class="sb-text-muted sb-text-sm">Teacher accounts only.</p>
  <form id="f" class="sb-stack sb-mt-4">
    <div class="sb-field">
      <label class="sb-label" for="f-email">Email</label>
      <input class="sb-input" id="f-email" type="email" name="email" required autocomplete="email">
    </div>
    <div class="sb-field">
      <label class="sb-label" for="f-slug">Room slug</label>
      <input class="sb-input" id="f-slug" type="text" name="slug" required pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]">
      <span class="sb-help">Appears in your lesson URL, e.g. /teach/your-name</span>
    </div>
    <div class="sb-field">
      <label class="sb-label" for="f-pass">Password</label>
      <input class="sb-input" id="f-pass" type="password" name="password" required minlength="12" maxlength="128">
    </div>
    <div class="sb-field">
      <label class="sb-label" for="f-confirm">Confirm password</label>
      <input class="sb-input" id="f-confirm" type="password" name="confirm" required>
    </div>
    <button class="sb-btn sb-btn--block sb-btn--lg sb-mt-2" type="submit">Create account</button>
    <p class="sb-text-center sb-text-muted sb-text-sm sb-mt-4">
      Already have an account? <a href="/auth/login">Sign in</a>
    </p>
  </form>
  <p id="status" class="sb-text-muted sb-text-sm sb-mt-3"></p>
</div>
<script src="/assets/signup.js"></script>
</body>
</html>"#;
