// File: server/src/http/recordings.rs
// Purpose: Recording management HTTP API — upload, list, send link, delete.
// Role: Teacher-authenticated endpoints for recording lifecycle management.
// Exports: post_upload, get_list, post_send, delete_recording, get_recordings_page
// Depends: axum, sqlx, blob, sha2, hex, rand, mailer
// Invariants: All endpoints require valid teacher session cookie; auth is by
//             teacher_id from cookie, never by slug alone.
//             Upload validates WebM magic bytes (\x1A\x45\xDF\xA3) and MIME type.
//             Resend always issues a fresh token and resets failed_attempts.
//             RecordingView excludes token_hash, blob_key, teacher_id, deleted_at.
//             Blob compensation: if DB insert fails after successful put, delete blob.
// Last updated: Sprint 6 (2026-04-18) -- initial implementation

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::auth::resolve_teacher_from_cookie;
use crate::error::{AppError, Result};
use crate::state::AppState;

const WEBM_MAGIC: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RecordingStatus {
    Live,
    LinkDisabled,
}

#[derive(Serialize)]
pub struct RecordingView {
    pub id: i64,
    pub student_email: String,
    pub created_at: i64,
    pub duration_s: Option<i64>,
    pub status: RecordingStatus,
}

#[derive(Serialize)]
pub struct UploadResponse {
    pub id: i64,
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UploadQuery {
    pub student_email: String,
    pub duration_s: Option<i64>,
}

pub async fn post_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    // Validate Content-Type.
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ct_base = content_type.split(';').next().unwrap_or("").trim();
    if ct_base != "video/webm" && ct_base != "audio/webm" {
        return Ok((StatusCode::UNSUPPORTED_MEDIA_TYPE, "expected video/webm or audio/webm")
            .into_response());
    }

    // Read bounded body.
    let max_bytes = state.config.recording_max_bytes as usize;
    let data = axum::body::to_bytes(body, max_bytes)
        .await
        .map_err(|_| AppError::BadRequest("upload too large".into()))?;

    // Magic-byte validation.
    if data.len() < 4 || &data[..4] != &WEBM_MAGIC {
        return Ok((StatusCode::UNSUPPORTED_MEDIA_TYPE, "not a WebM file").into_response());
    }

    // Generate blob key and token.
    let key = format!("{}.webm", uuid::Uuid::new_v4());
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token_hex = hex::encode(token_bytes);
    let token_hash: Vec<u8> = sha256_bytes(&token_bytes);
    let email_hash: Vec<u8> = sha256_str(&q.student_email.to_lowercase());
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Store blob (streaming from an in-memory cursor — bounded by recording_max_bytes).
    let reader: std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>> =
        Box::pin(std::io::Cursor::new(data.to_vec()));
    state
        .blob
        .put(&key, reader)
        .await
        .map_err(|e| AppError::Internal(e.to_string().into()))?;

    // Insert DB row; compensate by deleting blob on failure.
    let insert: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO recordings
           (teacher_id, student_email, student_email_hash, created_at, duration_s, blob_key, token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(teacher_id)
    .bind(&q.student_email)
    .bind(&email_hash)
    .bind(now)
    .bind(q.duration_s)
    .bind(&key)
    .bind(&token_hash)
    .fetch_one(&state.db)
    .await;

    let (id,) = match insert {
        Ok(row) => row,
        Err(e) => {
            if let Err(del) = state.blob.delete(&key).await {
                tracing::warn!(key, error = %del, "blob compensation delete failed");
            }
            return Err(AppError::Internal(e.to_string().into()));
        }
    };

    Ok(Json(serde_json::json!({ "id": id, "token": token_hex })).into_response())
}

// ---------------------------------------------------------------------------
// List recordings
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub sort: SortBy,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    #[default]
    Date,
    Student,
}

pub async fn get_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<RecordingView>>> {
    let teacher_id = require_auth(&state, &headers).await?;

    let rows: Vec<(i64, String, i64, Option<i64>, i64)> = match q.sort {
        SortBy::Date => sqlx::query_as(
            "SELECT id, student_email, created_at, duration_s, failed_attempts
             FROM recordings
             WHERE teacher_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(teacher_id)
        .fetch_all(&state.db)
        .await?,
        SortBy::Student => sqlx::query_as(
            "SELECT id, student_email, created_at, duration_s, failed_attempts
             FROM recordings
             WHERE teacher_id = ? AND deleted_at IS NULL
             ORDER BY student_email ASC, created_at DESC",
        )
        .bind(teacher_id)
        .fetch_all(&state.db)
        .await?,
    };

    let views = rows
        .into_iter()
        .map(|(id, student_email, created_at, duration_s, failed_attempts)| RecordingView {
            id,
            student_email,
            created_at,
            duration_s,
            status: if failed_attempts >= 3 {
                RecordingStatus::LinkDisabled
            } else {
                RecordingStatus::Live
            },
        })
        .collect();

    Ok(Json(views))
}

// ---------------------------------------------------------------------------
// Send recording link
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SendBody {
    /// Overrides the student_email stored in the recording row when non-empty.
    pub override_email: Option<String>,
}

pub async fn post_send(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<SendBody>,
) -> Result<StatusCode> {
    let teacher_id = require_auth(&state, &headers).await?;

    // Fetch recording row (ownership verified by teacher_id).
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT student_email, failed_attempts
         FROM recordings
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    let (student_email, failed_attempts) = row.ok_or(AppError::NotFound)?;

    // Recipient: DB value by default; override if non-empty.
    let recipient = match &body.override_email {
        Some(e) if !e.trim().is_empty() => e.trim().to_string(),
        _ => student_email,
    };

    // Always issue a fresh token on send (re-enables a disabled link).
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token_hex = hex::encode(token_bytes);
    let new_hash = sha256_bytes(&token_bytes);
    let new_email_hash = sha256_str(&recipient.to_lowercase());

    let _ = failed_attempts; // reset in DB below
    sqlx::query(
        "UPDATE recordings
         SET token_hash = ?, student_email = ?, student_email_hash = ?, failed_attempts = 0
         WHERE id = ?",
    )
    .bind(&new_hash)
    .bind(&recipient)
    .bind(&new_email_hash)
    .bind(id)
    .execute(&state.db)
    .await?;

    // Build access URL and send email.
    let recording_url = state
        .config
        .base_url
        .join(&format!("recording/{token_hex}"))
        .map_err(|_| AppError::Internal("url join failed".into()))?;

    state
        .mailer
        .send_recording_link(&recipient, &recording_url)
        .await
        .map_err(|e| AppError::Internal(e.to_string().into()))?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Delete recording
// ---------------------------------------------------------------------------

pub async fn delete_recording(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    let teacher_id = require_auth(&state, &headers).await?;

    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let result = sqlx::query(
        "UPDATE recordings SET deleted_at = ?
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(id)
    .bind(teacher_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Recordings library page
// ---------------------------------------------------------------------------

pub async fn get_recordings_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    let (owns,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM teachers WHERE id = ? AND slug = ?",
    )
    .bind(teacher_id)
    .bind(&slug)
    .fetch_one(&state.db)
    .await?;
    if owns == 0 {
        return Err(AppError::NotFound);
    }

    let html_path = state.config.static_dir.join("recordings.html");
    let html = tokio::fs::read_to_string(&html_path).await?;
    let mut resp = Html(html).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(resp)
}

// ---------------------------------------------------------------------------
// Dev blob serving (debug builds only)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
pub async fn get_dev_blob(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<Response> {
    if !state.config.dev {
        return Err(AppError::NotFound);
    }
    // Traversal defense.
    if key.contains("..") || key.contains('/') {
        return Err(AppError::NotFound);
    }
    let blob_dir = &state.config.dev_blob_dir;
    let path = blob_dir.join(&key);
    let canonical = path.canonicalize().map_err(|_| AppError::NotFound)?;
    let root = blob_dir.canonicalize().map_err(|_| AppError::NotFound)?;
    if !canonical.starts_with(&root) {
        return Err(AppError::NotFound);
    }
    let data = tokio::fs::read(&canonical).await.map_err(|_| AppError::NotFound)?;
    let mut resp = Response::new(Body::from(data));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/webm"));
    Ok(resp)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn require_auth(state: &AppState, headers: &HeaderMap) -> Result<i64> {
    resolve_teacher_from_cookie(&state.db, headers)
        .await
        .ok_or(AppError::Unauthorized)
}

fn sha256_bytes(data: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().to_vec()
}

fn sha256_str(s: &str) -> Vec<u8> {
    sha256_bytes(s.as_bytes())
}
