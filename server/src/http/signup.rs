// File: server/src/http/signup.rs
// Purpose: /, /signup, /auth/verify, /auth/consume handlers — magic-link flow.
// Role: Teacher identity + room-slug claiming.
// Exports: get_root, get_signup, post_signup, get_verify, post_consume
// Depends: axum, sqlx, serde
// Invariants: raw magic-link tokens never appear in query strings or span
//             fields; fragment-based URL keeps them client-side only.
//             Re-signup with an active session → 409; else rebind.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

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
    issue_session_cookie, magic_link, mailer::MailerError, rate_limit,
    slug::{suggest_alternatives, validate as validate_slug},
    SESSION_COOKIE_NAME,
};
use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SignupForm {
    pub email: String,
    pub slug: String,
}

#[derive(Serialize)]
pub struct SignupOk {
    pub message: &'static str,
}

#[derive(Serialize)]
pub struct ConflictBody {
    pub code: &'static str,
    pub message: &'static str,
    pub suggestions: Vec<String>,
}

pub async fn get_root() -> Html<&'static str> {
    Html(ROOT_HTML)
}

pub async fn get_signup() -> Html<&'static str> {
    Html(SIGNUP_HTML)
}

pub async fn post_signup(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(form): Json<SignupForm>,
) -> Result<Response> {
    let (email, slug) = validate_signup_input(&form)?;
    enforce_signup_rate_limit(&state, &email, addr.ip().to_string()).await?;

    let teacher_id = match resolve_or_create_teacher(&state, &email, &slug).await? {
        ResolveTeacher::Id(tid) => tid,
        ResolveTeacher::SlugConflict => return Ok(slug_conflict_response(&slug)),
    };

    issue_and_mail_magic_link(&state, teacher_id, &email).await?;
    Ok((StatusCode::OK, Json(SignupOk { message: "check your email" })).into_response())
}

fn validate_signup_input(form: &SignupForm) -> Result<(String, String)> {
    let email = form.email.trim().to_ascii_lowercase();
    if email.is_empty() || !email.contains('@') || email.len() > crate::ws::protocol::MAX_EMAIL_LEN
    {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    let slug = validate_slug(&form.slug)?;
    Ok((email, slug))
}

async fn enforce_signup_rate_limit(
    state: &Arc<AppState>,
    email: &str,
    peer_ip: String,
) -> Result<()> {
    let limits = rate_limit::Limits {
        per_email: state.config.signup_rate_limit_per_email,
        per_ip: state.config.signup_rate_limit_per_ip,
        window_secs: state.config.signup_rate_limit_window_secs,
    };
    rate_limit::check_and_record(&state.db, email, &peer_ip, &limits).await
}

enum ResolveTeacher {
    Id(magic_link::TeacherId),
    SlugConflict,
}

async fn resolve_or_create_teacher(
    state: &Arc<AppState>,
    email: &str,
    slug: &str,
) -> Result<ResolveTeacher> {
    let existing: Option<(magic_link::TeacherId, String)> =
        sqlx::query_as("SELECT id, slug FROM teachers WHERE email = ?")
            .bind(email)
            .fetch_optional(&state.db)
            .await?;

    if let Some((tid, _)) = existing {
        return rebind_existing_teacher(state, tid, slug).await;
    }
    create_new_teacher(state, email, slug).await
}

async fn rebind_existing_teacher(
    state: &Arc<AppState>,
    tid: magic_link::TeacherId,
    slug: &str,
) -> Result<ResolveTeacher> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let (active,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM sessions WHERE teacher_id = ? AND expires_at > ?")
            .bind(tid)
            .bind(now)
            .fetch_one(&state.db)
            .await?;
    if active > 0 {
        return Err(AppError::SessionInProgress);
    }
    let taken: Option<(magic_link::TeacherId,)> =
        sqlx::query_as("SELECT id FROM teachers WHERE slug = ? AND id != ?")
            .bind(slug)
            .bind(tid)
            .fetch_optional(&state.db)
            .await?;
    if taken.is_some() {
        return Ok(ResolveTeacher::SlugConflict);
    }
    sqlx::query("UPDATE teachers SET slug = ? WHERE id = ?")
        .bind(slug)
        .bind(tid)
        .execute(&state.db)
        .await?;
    magic_link::invalidate_pending(&state.db, tid).await?;
    Ok(ResolveTeacher::Id(tid))
}

async fn create_new_teacher(
    state: &Arc<AppState>,
    email: &str,
    slug: &str,
) -> Result<ResolveTeacher> {
    let taken: Option<(magic_link::TeacherId,)> =
        sqlx::query_as("SELECT id FROM teachers WHERE slug = ?")
            .bind(slug)
            .fetch_optional(&state.db)
            .await?;
    if taken.is_some() {
        return Ok(ResolveTeacher::SlugConflict);
    }
    let created = time::OffsetDateTime::now_utc().unix_timestamp();
    let (tid,): (magic_link::TeacherId,) = sqlx::query_as(
        "INSERT INTO teachers (email, slug, created_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(email)
    .bind(slug)
    .bind(created)
    .fetch_one(&state.db)
    .await?;
    Ok(ResolveTeacher::Id(tid))
}

fn slug_conflict_response(slug: &str) -> Response {
    let body = ConflictBody {
        code: "slug_taken",
        message: "that slug is taken",
        suggestions: suggest_alternatives(slug),
    };
    (StatusCode::CONFLICT, Json(body)).into_response()
}

async fn issue_and_mail_magic_link(
    state: &Arc<AppState>,
    teacher_id: magic_link::TeacherId,
    email: &str,
) -> Result<()> {
    let link = magic_link::issue(&state.db, teacher_id, state.config.magic_link_ttl_secs).await?;
    let mut verify_url = state
        .config
        .base_url
        .join("/auth/verify")
        .map_err(|e| AppError::Internal(format!("url: {e}").into()))?;
    verify_url.set_fragment(Some(&format!("token={}", link.raw_token)));
    state
        .mailer
        .send_magic_link(email, &verify_url)
        .await
        .map_err(|e: MailerError| AppError::Internal(format!("mailer: {e}").into()))?;
    Ok(())
}

pub async fn get_verify() -> Response {
    let mut resp = Html(VERIFY_HTML).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    resp
}

#[derive(Deserialize)]
pub struct ConsumeBody {
    pub token: String,
}

#[derive(Serialize)]
pub struct ConsumeOk {
    pub redirect: String,
}

pub async fn post_consume(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ConsumeBody>,
) -> Result<Response> {
    let teacher_id = magic_link::consume(&state.db, &body.token).await?;
    let cookie = issue_session_cookie(&state.db, teacher_id, state.config.session_ttl_secs).await?;

    let (slug,): (String,) = sqlx::query_as("SELECT slug FROM teachers WHERE id = ?")
        .bind(teacher_id)
        .fetch_one(&state.db)
        .await?;

    let secure = if state.config.require_secure_cookie() {
        "; Secure"
    } else {
        ""
    };
    let cookie_header = format!(
        "{SESSION_COOKIE_NAME}={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max}{secure}",
        max = state.config.session_ttl_secs
    );

    let mut resp = Json(ConsumeOk {
        redirect: format!("/teach/{slug}"),
    })
    .into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie_header)
            .map_err(|e| AppError::Internal(format!("cookie header: {e}").into()))?,
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

const ROOT_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main><h1>singing-bridge</h1>
<p>Teachers: <a href="/signup">sign up</a> to claim your room URL.</p>
<p>Students: your teacher will share a URL of the form <code>/teach/&lt;slug&gt;</code>.</p>
</main></body></html>"#;

const SIGNUP_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign up — singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main>
<h1>Teacher signup</h1>
<form id="f">
  <label>Email <input type="email" name="email" required></label>
  <label>Room slug <input type="text" name="slug" required pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]"></label>
  <button type="submit">Send magic link</button>
</form>
<p id="status"></p>
<script src="/assets/signup.js"></script>
</main></body></html>"#;

const VERIFY_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Verifying — singing-bridge</title>
<link rel="stylesheet" href="/assets/styles.css"></head>
<body><main><h1>Verifying…</h1><p id="status">Checking your link.</p>
<script src="/assets/verify.js"></script>
</main></body></html>"#;
