// File: server/src/http/recordings.rs
// Purpose: Recording management HTTP API — upload, list, send link, delete.
// Role: Teacher-authenticated endpoints for recording lifecycle management.
// Exports: post_upload, get_list, post_send, delete_recording, get_recordings_page
// Depends: axum, sqlx, blob, sha2, hex, rand, mailer, futures, tokio-util
// Invariants: All endpoints require valid teacher session cookie; auth is by
//             teacher_id from cookie, never by slug alone.
//             Upload validates WebM magic bytes (\x1A\x45\xDF\xA3) and MIME type.
//             Upload streams body to blob store (no full in-memory buffer) bounded
//             by recording_max_bytes via AsyncReadExt::take.
//             token_hex is never persisted — only token_hash (SHA-256) is stored.
//             Resend always issues a fresh random token (old link becomes invalid).
//             RecordingView excludes token_hash, blob_key, teacher_id, deleted_at.
//             Blob compensation: if DB insert fails after successful put, delete blob.
// Last updated: Sprint 6 (2026-04-18) -- R2 fixes: streaming upload, token_hex removed

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use futures::StreamExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio_util::io::{ReaderStream, StreamReader};

use crate::auth::resolve_teacher_from_cookie;
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::ws::session_history;

const WEBM_MAGIC: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordingStatus {
    Live,
    LinkDisabled,
}

#[derive(Serialize)]
pub(crate) struct RecordingView {
    id: i64,
    student_email: String,
    created_at: i64,
    duration_s: Option<i64>,
    status: RecordingStatus,
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct UploadQuery {
    duration_s: Option<i64>,
}

pub(crate) async fn post_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    let student_email = headers
        .get("x-student-email")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("X-Student-Email header required".into()))?
        .to_string();

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

    let max_bytes = state.config.recording_max_bytes as u64;

    // Build a streaming reader over the body, mapped to std::io::Error.
    let body_stream = body
        .into_data_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let mut body_reader = StreamReader::new(body_stream);

    // Read first 4 bytes for WebM magic-byte validation without buffering the rest.
    let mut magic = [0u8; 4];
    body_reader
        .read_exact(&mut magic)
        .await
        .map_err(|_| AppError::BadRequest("upload body too short".into()))?;

    if magic != WEBM_MAGIC {
        return Ok((StatusCode::UNSUPPORTED_MEDIA_TYPE, "not a WebM file").into_response());
    }

    // Reconstruct the full stream: prepend magic bytes, then stream remaining body
    // bounded to max_bytes (the 4 magic bytes already consumed don't count toward limit).
    let magic_stream = futures::stream::once(futures::future::ready(
        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(magic.to_vec())),
    ));
    let rest_stream = ReaderStream::new(body_reader.take(max_bytes - 4));
    let full_reader: std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>> =
        Box::pin(StreamReader::new(magic_stream.chain(rest_stream)));

    // Generate blob key and token.
    let key = format!("{}.webm", uuid::Uuid::new_v4());
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token_hex = hex::encode(token_bytes);
    let token_hash: Vec<u8> = sha256_bytes(&token_bytes);
    let email_hash: Vec<u8> = sha256_str(&student_email.to_lowercase());
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Store blob via streaming reader.
    state
        .blob
        .put(&key, full_reader)
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
    .bind(&student_email)
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

    // Best-effort: link the recording to its session event via durable slot.
    match session_history::consume_recording_slot(&state.db, teacher_id).await {
        Ok(Some(event_id)) => {
            if let Err(e) = session_history::link_recording(&state.db, event_id, teacher_id, id).await {
                tracing::warn!(error = %e, "link_recording failed");
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = %e, "consume_recording_slot failed"),
    }

    Ok(Json(serde_json::json!({ "id": id, "token": token_hex })).into_response())
}

// ---------------------------------------------------------------------------
// List recordings
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    #[serde(default)]
    sort: SortBy,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SortBy {
    #[default]
    Date,
    Student,
}

pub(crate) async fn get_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<RecordingView>>> {
    let teacher_id = require_auth(&state, &headers).await?;

    let rows: Vec<(i64, String, i64, Option<i64>, i64, Option<String>)> = match q.sort {
        SortBy::Date => sqlx::query_as(
            "SELECT id, student_email, created_at, duration_s, failed_attempts, blob_key
             FROM recordings
             WHERE teacher_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(teacher_id)
        .fetch_all(&state.db)
        .await?,
        SortBy::Student => sqlx::query_as(
            "SELECT id, student_email, created_at, duration_s, failed_attempts, blob_key
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
        .map(|(id, student_email, created_at, duration_s, failed_attempts, blob_key)| {
            let status = if blob_key.is_none() || failed_attempts >= 3 {
                RecordingStatus::LinkDisabled
            } else {
                RecordingStatus::Live
            };
            RecordingView { id, student_email, created_at, duration_s, status }
        })
        .collect();

    Ok(Json(views))
}

// ---------------------------------------------------------------------------
// Send recording link
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct SendBody {
    override_email: Option<String>,
}

pub(crate) async fn post_send(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<SendBody>,
) -> Result<StatusCode> {
    let teacher_id = require_auth(&state, &headers).await?;

    // Fetch recording row (ownership verified by teacher_id).
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT student_email
         FROM recordings
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    let (student_email,) = row.ok_or(AppError::NotFound)?;

    // Recipient: DB value by default; override if non-empty.
    let recipient = match &body.override_email {
        Some(e) if !e.trim().is_empty() => e.trim().to_string(),
        _ => student_email,
    };

    // Always issue a fresh random token (old link becomes invalid; failed_attempts reset).
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token_hex = hex::encode(token_bytes);
    let new_hash = sha256_bytes(&token_bytes);
    let new_email_hash = sha256_str(&recipient.to_lowercase());

    sqlx::query(
        "UPDATE recordings
         SET token_hash = ?, student_email = ?, student_email_hash = ?, failed_attempts = 0
         WHERE id = ? AND teacher_id = ?",
    )
    .bind(&new_hash)
    .bind(&recipient)
    .bind(&new_email_hash)
    .bind(id)
    .bind(teacher_id)
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

pub(crate) async fn delete_recording(
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

pub(crate) async fn get_recordings_page(
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
pub(crate) async fn get_dev_blob(
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
