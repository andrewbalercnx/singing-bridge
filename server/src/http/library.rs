// File: server/src/http/library.rs
// Purpose: Accompaniment library HTTP API — asset CRUD, sidecar pipeline proxy,
//          and authenticated media token delivery.
// Role: Teacher-authenticated endpoints for library lifecycle management;
//       public GET /api/media/:token for WAV + page-image delivery.
// Exports: get_library_page, list_assets, post_asset, get_asset, delete_asset,
//          post_parts, get_parts_status, post_midi, post_rasterise, post_variant,
//          delete_variant, get_media
// Depends: axum, sqlx, blob, sidecar, media_token, uuid, bytes, serde_json
// Invariants: All /teach/:slug/library/* routes require valid teacher session cookie.
//             All asset/variant DB queries join through teacher_id — no cross-teacher access.
//             Upload validates magic bytes: PDF (25 50 44 46), MIDI (4D 54 68 64),
//             WAV (RIFF + any 4 bytes + WAVE at bytes 8-11).
//             Stored JSON sizes: bar_coords_json ≤ 500 KB, bar_timings_json ≤ 100 KB,
//             page_blob_keys_json ≤ 10 KB.
//             GET /api/media/:token returns 404 for both unknown and expired tokens (no oracle).
//             Blob keys are never returned directly — callers receive short-lived media tokens.
//             post_variant: tempo_pct [25,300], transpose_semitones [-12,12] enforced server-side.
//             post_midi: part_indices length capped at 32.
// Last updated: Sprint 24 (2026-04-26) -- server-side bounds on tempo_pct, transpose_semitones, part_indices

use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncRead;

use crate::auth::{resolve_teacher_from_cookie, slug::validate};
use crate::blob::BlobStore;
use crate::error::{AppError, Result};
use crate::sidecar::SynthesiseRequest;
use crate::state::{AppState, OmrJob, OmrJobState};

const PDF_MAGIC: [u8; 4] = [0x25, 0x50, 0x44, 0x46]; // %PDF
const MIDI_MAGIC: [u8; 4] = [0x4D, 0x54, 0x68, 0x64]; // MThd
const RIFF_MAGIC: [u8; 4] = *b"RIFF";
const WAVE_MARKER: [u8; 4] = *b"WAVE";
const ID3_MAGIC: [u8; 3] = *b"ID3"; // ID3v2 tag — present on virtually all MP3 files

const BAR_COORDS_LIMIT: usize = 512 * 1024;
const BAR_TIMINGS_LIMIT: usize = 100 * 1024;
const PAGE_KEYS_LIMIT: usize = 10 * 1024;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(crate) struct AssetSummary {
    id: i64,
    title: String,
    has_pdf: bool,
    has_midi: bool,
    has_pages: bool,
    has_bar_data: bool,
    variant_count: i64,
    created_at: i64,
}

#[derive(Serialize)]
pub(crate) struct AssetDetail {
    id: i64,
    title: String,
    has_pdf: bool,
    has_midi: bool,
    page_tokens: Vec<String>,
    bar_coords: serde_json::Value,
    bar_timings: serde_json::Value,
    variants: Vec<VariantView>,
    created_at: i64,
}

#[derive(Serialize)]
pub(crate) struct VariantView {
    id: i64,
    label: String,
    token: String,
    tempo_pct: i32,
    transpose_semitones: i32,
    respect_repeats: bool,
    duration_s: Option<f64>,
    created_at: i64,
}

// ---------------------------------------------------------------------------
// Library page
// ---------------------------------------------------------------------------

pub(crate) async fn get_library_page(
    State(state): State<Arc<AppState>>,
    Path((slug,)): Path<(String,)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    let slug = validate(&slug).map_err(|_| AppError::NotFound)?;
    let (owned,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM teachers WHERE id = $1 AND slug = $2",
    )
    .bind(teacher_id)
    .bind(&slug)
    .fetch_one(&state.db)
    .await?;
    if owned == 0 {
        return Err(AppError::Forbidden);
    }
    let html_path = state.config.static_dir.join("library.html");
    let html = tokio::fs::read_to_string(&html_path).await?;
    Ok((
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
        ],
        Html(html),
    ).into_response())
}

// ---------------------------------------------------------------------------
// List assets
// ---------------------------------------------------------------------------

pub(crate) async fn list_assets(
    State(state): State<Arc<AppState>>,
    Path((slug,)): Path<(String,)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;

    let rows: Vec<(i64, String, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64)> =
        sqlx::query_as(
            "SELECT a.id, a.title, a.pdf_blob_key, a.midi_blob_key,
                    a.page_blob_keys_json, a.bar_timings_json, a.created_at,
                    COALESCE(vc.cnt, 0)
             FROM accompaniments a
             LEFT JOIN (
                 SELECT accompaniment_id, COUNT(*) AS cnt
                 FROM accompaniment_variants
                 WHERE deleted_at IS NULL
                 GROUP BY accompaniment_id
             ) vc ON vc.accompaniment_id = a.id
             WHERE a.teacher_id = $1 AND a.deleted_at IS NULL
             ORDER BY a.created_at DESC",
        )
        .bind(teacher_id)
        .fetch_all(&state.db)
        .await?;

    let summaries: Vec<AssetSummary> = rows
        .into_iter()
        .map(|(id, title, pdf_key, midi_key, pages_json, timings_json, created_at, variant_count)| {
            AssetSummary {
                id,
                title,
                has_pdf: pdf_key.is_some(),
                has_midi: midi_key.is_some(),
                has_pages: pages_json.as_deref().map(|s| s != "[]").unwrap_or(false),
                has_bar_data: timings_json.is_some(),
                variant_count,
                created_at,
            }
        })
        .collect();

    Ok(Json(summaries).into_response())
}

// ---------------------------------------------------------------------------
// Upload asset (PDF, MIDI, WAV, or MP3)
// ---------------------------------------------------------------------------

enum FileKind { Pdf, Midi, Wav, Mp3 }

impl FileKind {
    fn ext(&self) -> &'static str {
        match self { FileKind::Pdf => "pdf", FileKind::Midi => "mid", FileKind::Wav => "wav", FileKind::Mp3 => "mp3" }
    }
    fn kind_str(&self) -> &'static str {
        match self { FileKind::Pdf => "pdf", FileKind::Midi => "midi", FileKind::Wav => "wav", FileKind::Mp3 => "mp3" }
    }
}

/// Identify file type from the first 12 magic bytes and optional declared Content-Type.
/// `declared_ct`: the raw Content-Type header value (parameters are stripped internally).
/// Returns Err(ContentTypeMismatch) when declared type is a known MIME but disagrees with magic.
/// Returns Err(UnsupportedFileType) when magic bytes are not PDF, MIDI, WAV, or MP3.
fn detect_file_type(magic: &[u8; 12], declared_ct: Option<&str>) -> Result<FileKind> {
    let kind = if magic[0..4] == PDF_MAGIC {
        FileKind::Pdf
    } else if magic[0..4] == MIDI_MAGIC {
        FileKind::Midi
    } else if magic[0..4] == RIFF_MAGIC && magic[8..12] == WAVE_MARKER {
        FileKind::Wav
    } else if magic[0..3] == ID3_MAGIC
        || (magic[0] == 0xFF && matches!(magic[1], 0xFB | 0xF3 | 0xF2))
    {
        FileKind::Mp3
    } else {
        return Err(AppError::UnsupportedFileType);
    };

    // Strip MIME parameters (e.g. "application/pdf; charset=utf-8" → "application/pdf").
    if let Some(ct) = declared_ct {
        let base = ct.split(';').next().unwrap_or(ct).trim();
        let expected = match kind {
            FileKind::Pdf => "application/pdf",
            FileKind::Midi => "audio/midi",
            FileKind::Wav => "audio/wav",
            FileKind::Mp3 => "audio/mpeg",
        };
        // Only fire ContentTypeMismatch when the declared type is itself a known type.
        let known = ["application/pdf", "audio/midi", "audio/wav", "audio/mpeg"];
        if known.contains(&base) && base != expected {
            return Err(AppError::ContentTypeMismatch);
        }
    }

    Ok(kind)
}

/// Store the upload body to the blob store. The 12 magic bytes are prepended back
/// so the stored blob is byte-identical to the source.
async fn store_asset_blob(
    blob: &dyn BlobStore,
    magic: [u8; 12],
    body_reader: impl AsyncRead + Send + Unpin + 'static,
    max_remaining: u64,
    ext: &str,
) -> Result<String> {
    use futures::StreamExt;
    use tokio_util::io::{ReaderStream, StreamReader};

    let magic_stream = futures::stream::once(futures::future::ready(
        Ok::<Bytes, std::io::Error>(Bytes::from(magic.to_vec())),
    ));
    let rest = ReaderStream::new(tokio::io::AsyncReadExt::take(body_reader, max_remaining));
    let full: Pin<Box<dyn AsyncRead + Send>> =
        Box::pin(StreamReader::new(magic_stream.chain(rest)));

    let key = format!("{}.{ext}", uuid::Uuid::new_v4());
    blob.put(&key, full)
        .await
        .map_err(|e| AppError::Internal(e.to_string().into()))?;
    Ok(key)
}

/// Insert the accompaniment (and for WAV/MP3, the variant) row(s).
/// On any DB error the blob is deleted before returning.
/// Returns (accompaniment_id, variant_id). variant_id is Some only for WAV/MP3.
async fn db_insert_accompaniment(
    db: &sqlx::PgPool,
    blob: &dyn BlobStore,
    teacher_id: i64,
    title: &str,
    blob_key: &str,
    kind: &FileKind,
    now: i64,
) -> Result<(i64, Option<i64>)> {
    match kind {
        FileKind::Pdf | FileKind::Midi => {
            let sql = match kind {
                FileKind::Pdf => "INSERT INTO accompaniments (teacher_id, title, pdf_blob_key, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
                FileKind::Midi => "INSERT INTO accompaniments (teacher_id, title, midi_blob_key, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
                FileKind::Wav | FileKind::Mp3 => unreachable!(),
            };
            let r: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(sql)
                .bind(teacher_id).bind(title).bind(blob_key).bind(now)
                .fetch_one(db).await;
            match r {
                Ok((id,)) => Ok((id, None)),
                Err(e) => { let _ = blob.delete(blob_key).await; Err(AppError::Sqlx(e)) }
            }
        }
        FileKind::Wav | FileKind::Mp3 => {
            // Two inserts wrapped in a transaction to avoid orphan accompaniment rows.
            let mut tx = match db.begin().await {
                Ok(tx) => tx,
                Err(e) => { let _ = blob.delete(blob_key).await; return Err(AppError::Sqlx(e)); }
            };
            let acc_r: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
                "INSERT INTO accompaniments (teacher_id, title, created_at)
                 VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(teacher_id).bind(title).bind(now)
            .fetch_one(&mut *tx).await;
            let (acc_id,) = match acc_r {
                Ok(row) => row,
                Err(e) => {
                    let _ = tx.rollback().await;
                    let _ = blob.delete(blob_key).await;
                    return Err(AppError::Sqlx(e));
                }
            };
            let var_r: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
                "INSERT INTO accompaniment_variants
                   (accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones,
                    respect_repeats, created_at)
                 VALUES ($1, $2, $3, 100, 0, 0, $4) RETURNING id",
            )
            .bind(acc_id).bind(title).bind(blob_key).bind(now)
            .fetch_one(&mut *tx).await;
            let (var_id,) = match var_r {
                Ok(row) => row,
                Err(e) => {
                    let _ = tx.rollback().await;
                    let _ = blob.delete(blob_key).await;
                    return Err(AppError::Sqlx(e));
                }
            };
            tx.commit().await.map_err(AppError::Sqlx)?;
            Ok((acc_id, Some(var_id)))
        }
    }
}

/// POST /teach/:slug/library/assets
/// Headers: X-Title (required, ≤255 bytes), Content-Type (application/pdf, audio/midi, audio/wav)
/// Body: raw file bytes. Content-Length > 50 MB → 413 before any body read.
pub(crate) async fn post_asset(
    State(state): State<Arc<AppState>>,
    Path((slug,)): Path<(String,)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    use futures::StreamExt;
    use tokio::io::AsyncReadExt;
    use tokio_util::io::StreamReader;

    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;

    // Step 1: Parse and validate title (header only — no body read yet).
    let title = headers
        .get("x-title")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("X-Title header required".into()))?
        .to_string();
    if title.len() > 255 {
        return Err(AppError::BadRequest("title exceeds 255 bytes".into()));
    }

    let max_bytes = state.config.accomp_upload_max_bytes;

    // Step 2: Content-Length early check — reject before reading any body bytes.
    if let Some(cl) = headers.get(header::CONTENT_LENGTH) {
        if let Ok(s) = cl.to_str() {
            if let Ok(n) = s.parse::<u64>() {
                if n > max_bytes {
                    return Err(AppError::PayloadTooLarge);
                }
            }
        }
    }

    let declared_ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    // Step 3: Read exactly 12 bytes for magic detection.
    let body_stream = body
        .into_data_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let mut body_reader = StreamReader::new(body_stream);

    let mut magic = [0u8; 12];
    body_reader
        .read_exact(&mut magic)
        .await
        .map_err(|_| AppError::UnsupportedFileType)?;

    // Step 4: Detect file type (may return ContentTypeMismatch or UnsupportedFileType).
    let kind = detect_file_type(&magic, declared_ct.as_deref())?;

    // Step 5: Store blob (magic bytes prepended back so stored file is byte-identical).
    let blob_key = store_asset_blob(
        state.blob.as_ref(),
        magic,
        body_reader,
        max_bytes.saturating_sub(12),
        kind.ext(),
    )
    .await?;

    // Step 6: Insert DB row(s); blob is deleted on failure (inside helper).
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let (id, variant_id) =
        db_insert_accompaniment(&state.db, state.blob.as_ref(), teacher_id, &title, &blob_key, &kind, now)
            .await?;

    // Step 7: Return uniform upload response.
    let mut resp = serde_json::json!({ "id": id, "title": title, "kind": kind.kind_str() });
    if let Some(vid) = variant_id {
        resp["variant_id"] = serde_json::json!(vid);
    }
    Ok((StatusCode::CREATED, Json(resp)).into_response())
}

// ---------------------------------------------------------------------------
// Get asset detail
// ---------------------------------------------------------------------------

pub(crate) async fn get_asset(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;
    let ttl = Duration::from_secs(state.config.media_token_ttl_secs);

    let row: Option<(i64, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT id, title, pdf_blob_key, midi_blob_key, page_blob_keys_json,
                    bar_coords_json, bar_timings_json, created_at
             FROM accompaniments
             WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL",
        )
        .bind(asset_id)
        .bind(teacher_id)
        .fetch_optional(&state.db)
        .await?;

    let (id, title, pdf_key, midi_key, pages_json, coords_json, timings_json, created_at) =
        row.ok_or(AppError::NotFound)?;

    // Issue media tokens for page images.
    let page_keys: Vec<String> = pages_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let page_tokens: Vec<String> = page_keys
        .iter()
        .map(|k| state.media_tokens.insert(k.clone(), ttl, false))
        .collect();

    // Issue media tokens for WAV variants.
    let variants_db: Vec<(i64, String, String, i32, i32, i32, Option<f64>, i64)> =
        sqlx::query_as(
            "SELECT id, label, wav_blob_key, tempo_pct, transpose_semitones,
                    respect_repeats, duration_s, created_at
             FROM accompaniment_variants
             WHERE accompaniment_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?;

    let variants: Vec<VariantView> = variants_db
        .into_iter()
        .map(|(vid, label, wav_key, tempo_pct, transpose, repeats, duration_s, vcreated)| {
            let token = state.media_tokens.insert(wav_key, ttl, false);
            VariantView {
                id: vid,
                label,
                token,
                tempo_pct,
                transpose_semitones: transpose,
                respect_repeats: repeats != 0,
                duration_s,
                created_at: vcreated,
            }
        })
        .collect();

    let bar_coords: serde_json::Value = coords_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Array(vec![]));
    let bar_timings: serde_json::Value = timings_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Array(vec![]));

    Ok((
        StatusCode::OK,
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(AssetDetail {
            id,
            title,
            has_pdf: pdf_key.is_some(),
            has_midi: midi_key.is_some(),
            page_tokens,
            bar_coords,
            bar_timings,
            variants,
            created_at,
        }),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Delete asset (soft)
// ---------------------------------------------------------------------------

pub(crate) async fn delete_asset(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Collect blob keys for token invalidation before soft-deleting.
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT pdf_blob_key, midi_blob_key, page_blob_keys_json
         FROM accompaniments
         WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    let (pdf_key, midi_key, pages_json) = row.ok_or(AppError::NotFound)?;

    let variant_wav_keys: Vec<(String,)> = sqlx::query_as(
        "SELECT wav_blob_key FROM accompaniment_variants
         WHERE accompaniment_id = $1 AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .fetch_all(&state.db)
    .await?;

    // Soft-delete asset and all its variants.
    sqlx::query("UPDATE accompaniments SET deleted_at = $1 WHERE id = $2 AND teacher_id = $3")
        .bind(now)
        .bind(asset_id)
        .bind(teacher_id)
        .execute(&state.db)
        .await?;

    sqlx::query(
        "UPDATE accompaniment_variants SET deleted_at = $1
         WHERE accompaniment_id = $2",
    )
    .bind(now)
    .bind(asset_id)
    .execute(&state.db)
    .await?;

    // Invalidate all tokens for the deleted blobs.
    let mut all_keys: Vec<String> = Vec::new();
    if let Some(k) = pdf_key { all_keys.push(k); }
    if let Some(k) = midi_key { all_keys.push(k); }
    let page_keys: Vec<String> = pages_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    all_keys.extend(page_keys);
    all_keys.extend(variant_wav_keys.into_iter().map(|(k,)| k));
    state.media_tokens.invalidate_by_blob_keys(&all_keys);

    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// List parts (OMR + sidecar /list-parts)
// ---------------------------------------------------------------------------

/// POST /teach/:slug/library/assets/:id/parts
/// Submits an async OMR job. Returns 202 immediately with a poll URL.
/// The browser polls GET .../parts/:job_id until done (200) or failed (422).
pub(crate) async fn post_parts(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;
    // Validate PDF exists synchronously — returns 400 for WAV/MIDI-only assets
    // rather than accepting a job that will immediately fail in the background.
    require_pdf_key(&state, asset_id, teacher_id).await?;

    let job_id = uuid::Uuid::new_v4();
    state.omr_jobs.insert(job_id, OmrJob {
        teacher_id,
        asset_id,
        state: OmrJobState::Running,
        created_at: Instant::now(),
    });

    let state2 = Arc::clone(&state);
    tokio::spawn(async move {
        let result = run_omr_job(&state2, asset_id, teacher_id).await;
        if let Some(mut entry) = state2.omr_jobs.get_mut(&job_id) {
            entry.state = match result {
                Ok(parts) => OmrJobState::Done(parts),
                Err(e) => {
                    tracing::error!(asset_id, error = %e, "omr_job failed");
                    OmrJobState::Failed(e.to_string())
                }
            };
        }
    });

    let poll_url = format!("/teach/{slug}/library/assets/{asset_id}/parts/{job_id}");
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"job_id": job_id.to_string(), "poll_url": poll_url})),
    ).into_response())
}

/// GET /teach/:slug/library/assets/:id/parts/:job_id
/// Returns 202 (pending), 200 (done + parts array), or 422 (failed).
pub(crate) async fn get_parts_status(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id, job_id_str)): Path<(String, i64, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;

    let job_id = uuid::Uuid::parse_str(&job_id_str).map_err(|_| AppError::NotFound)?;

    enum Outcome {
        Running,
        Done(Vec<crate::sidecar::PartInfo>),
        Failed(String),
    }
    let outcome = {
        let entry = state.omr_jobs.get(&job_id).ok_or(AppError::NotFound)?;
        if entry.teacher_id != teacher_id || entry.asset_id != asset_id {
            return Err(AppError::NotFound);
        }
        match &entry.state {
            OmrJobState::Running => Outcome::Running,
            OmrJobState::Done(parts) => Outcome::Done(parts.clone()),
            OmrJobState::Failed(msg) => Outcome::Failed(msg.clone()),
        }
    };

    match outcome {
        Outcome::Running => Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({"status": "pending"})),
        ).into_response()),
        Outcome::Done(parts) => {
            state.omr_jobs.remove(&job_id);
            Ok(Json(serde_json::json!({"status": "done", "parts": parts})).into_response())
        }
        Outcome::Failed(msg) => {
            state.omr_jobs.remove(&job_id);
            Ok((
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"status": "failed", "message": msg})),
            ).into_response())
        }
    }
}

async fn run_omr_job(
    state: &AppState,
    asset_id: i64,
    teacher_id: i64,
) -> crate::error::Result<Vec<crate::sidecar::PartInfo>> {
    let pdf_key = require_pdf_key(state, asset_id, teacher_id).await?;
    tracing::info!(asset_id, pdf_key, "omr_job: fetching pdf from blob");
    let pdf = state
        .blob
        .get_bytes(&pdf_key)
        .await
        .map_err(|_| AppError::Internal("pdf blob read".into()))?;

    tracing::info!(asset_id, pdf_bytes = pdf.len(), "omr_job: calling sidecar omr");
    let omr = state.sidecar.omr(pdf).await?;
    tracing::info!(asset_id, parts = omr.parts.len(), "omr_job: omr complete");

    // Store MusicXML to blob so post_midi can skip re-running Audiveris.
    let xml_key = format!("{}.musicxml", uuid::Uuid::new_v4());
    state
        .blob
        .put(&xml_key, Box::pin(std::io::Cursor::new(omr.musicxml.to_vec())))
        .await
        .map_err(|e| AppError::Internal(e.to_string().into()))?;

    // Store bar_coords now so post_rasterise only needs to rasterise the PDF.
    let coords_json = if !omr.bar_coords.is_empty() {
        let j = serde_json::to_string(&omr.bar_coords)
            .map_err(|_| AppError::Internal("coords json".into()))?;
        if j.len() <= BAR_COORDS_LIMIT { Some(j) } else { None }
    } else {
        None
    };

    // Delete any previous MusicXML blob (re-running OMR replaces it).
    let old_xml: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT musicxml_blob_key FROM accompaniments WHERE id = $1 AND teacher_id = $2",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((Some(old),)) = old_xml {
        let _ = state.blob.delete(&old).await;
    }

    let update = if let Some(ref cj) = coords_json {
        sqlx::query(
            "UPDATE accompaniments SET musicxml_blob_key = $1, bar_coords_json = $2
             WHERE id = $3 AND teacher_id = $4 AND deleted_at IS NULL",
        )
        .bind(&xml_key)
        .bind(cj)
        .bind(asset_id)
        .bind(teacher_id)
        .execute(&state.db)
        .await
    } else {
        sqlx::query(
            "UPDATE accompaniments SET musicxml_blob_key = $1
             WHERE id = $2 AND teacher_id = $3 AND deleted_at IS NULL",
        )
        .bind(&xml_key)
        .bind(asset_id)
        .bind(teacher_id)
        .execute(&state.db)
        .await
    };

    if let Err(e) = update {
        let _ = state.blob.delete(&xml_key).await;
        return Err(AppError::Sqlx(e));
    }

    Ok(omr.parts)
}

// ---------------------------------------------------------------------------
// Extract MIDI + compute bar timings
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct MidiRequest {
    part_indices: Vec<usize>,
}

pub(crate) async fn post_midi(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
    Json(req): Json<MidiRequest>,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;

    if req.part_indices.len() > 32 {
        return Err(AppError::BadRequest(
            "too many part_indices (max 32)".into(),
        ));
    }

    // Use cached MusicXML from a prior OMR run to avoid re-running Audiveris.
    let musicxml = get_cached_musicxml_or_rerun_omr(&state, asset_id, teacher_id).await?;

    let midi = state
        .sidecar
        .extract_midi(musicxml, &req.part_indices)
        .await?;
    let timings = state.sidecar.bar_timings(midi.clone()).await?;

    let timings_json =
        serde_json::to_string(&timings).map_err(|_| AppError::Internal("timings json".into()))?;
    if timings_json.len() > BAR_TIMINGS_LIMIT {
        return Err(AppError::BadRequest(
            "bar timings JSON exceeds 100 KB limit".into(),
        ));
    }

    // Store MIDI blob; compensate on DB failure.
    let midi_key = format!("{}.mid", uuid::Uuid::new_v4());
    state
        .blob
        .put(&midi_key, Box::pin(std::io::Cursor::new(midi.to_vec())))
        .await
        .map_err(|e| AppError::Internal(e.to_string().into()))?;

    // Invalidate any previous MIDI token (old key may change).
    let old_key: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT midi_blob_key FROM accompaniments WHERE id = $1 AND teacher_id = $2",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((Some(old),)) = old_key {
        state.media_tokens.invalidate_by_blob_keys(&[old.clone()]);
        let _ = state.blob.delete(&old).await;
    }

    let update = sqlx::query(
        "UPDATE accompaniments SET midi_blob_key = $1, bar_timings_json = $2
         WHERE id = $3 AND teacher_id = $4 AND deleted_at IS NULL",
    )
    .bind(&midi_key)
    .bind(&timings_json)
    .bind(asset_id)
    .bind(teacher_id)
    .execute(&state.db)
    .await;

    if let Err(e) = update {
        let _ = state.blob.delete(&midi_key).await;
        return Err(AppError::Sqlx(e));
    }

    Ok((StatusCode::OK, Json(serde_json::json!({ "bar_count": timings.len() }))).into_response())
}

// ---------------------------------------------------------------------------
// Rasterise pages
// ---------------------------------------------------------------------------

pub(crate) async fn post_rasterise(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;

    let (pdf_key, existing_coords_json) = require_pdf_key_and_coords(&state, asset_id, teacher_id).await?;
    let pdf = state
        .blob
        .get_bytes(&pdf_key)
        .await
        .map_err(|_| AppError::Internal("pdf blob read".into()))?;

    // If bar_coords were computed during OMR, skip the /bar_coords sidecar call.
    let (coords_json, pages) = if let Some(cj) = existing_coords_json {
        let pages = state.sidecar.rasterise(pdf, 150).await?;
        (cj, pages)
    } else {
        let (coords_result, pages_result) = tokio::join!(
            state.sidecar.bar_coords(pdf.clone()),
            state.sidecar.rasterise(pdf, 150),
        );
        let coords = coords_result?;
        let pages = pages_result?;
        let cj = serde_json::to_string(&coords)
            .map_err(|_| AppError::Internal("coords json".into()))?;
        if cj.len() > BAR_COORDS_LIMIT {
            return Err(AppError::BadRequest("bar coords JSON exceeds 500 KB limit".into()));
        }
        (cj, pages)
    };

    // Store page image blobs, collecting their keys.
    let mut page_keys: Vec<String> = Vec::with_capacity(pages.len());
    for (_, page_bytes) in &pages {
        let k = format!("{}.png", uuid::Uuid::new_v4());
        state
            .blob
            .put(&k, Box::pin(std::io::Cursor::new(page_bytes.to_vec())))
            .await
            .map_err(|e| AppError::Internal(e.to_string().into()))?;
        page_keys.push(k);
    }

    let page_keys_json = serde_json::to_string(&page_keys)
        .map_err(|_| AppError::Internal("page keys json".into()))?;
    if page_keys_json.len() > PAGE_KEYS_LIMIT {
        for k in &page_keys {
            let _ = state.blob.delete(k).await;
        }
        return Err(AppError::BadRequest(
            "page blob keys JSON exceeds 10 KB limit".into(),
        ));
    }

    // Invalidate old page tokens and delete old page blobs.
    let old_pages: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT page_blob_keys_json FROM accompaniments WHERE id = $1 AND teacher_id = $2",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((Some(old_json),)) = old_pages {
        let old_keys: Vec<String> = serde_json::from_str(&old_json).unwrap_or_default();
        state.media_tokens.invalidate_by_blob_keys(&old_keys);
        for k in old_keys {
            let _ = state.blob.delete(&k).await;
        }
    }

    sqlx::query(
        "UPDATE accompaniments SET page_blob_keys_json = $1, bar_coords_json = $2
         WHERE id = $3 AND teacher_id = $4 AND deleted_at IS NULL",
    )
    .bind(&page_keys_json)
    .bind(&coords_json)
    .bind(asset_id)
    .bind(teacher_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::OK,
        Json(serde_json::json!({ "page_count": pages.len() })),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Create WAV variant
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct VariantRequest {
    label: String,
    tempo_pct: i32,
    transpose_semitones: i32,
    #[serde(default)]
    respect_repeats: bool,
}

pub(crate) async fn post_variant(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
    Json(req): Json<VariantRequest>,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;

    if req.label.trim().is_empty() {
        return Err(AppError::BadRequest("label must not be empty".into()));
    }
    if req.label.len() > 255 {
        return Err(AppError::BadRequest("label exceeds 255 bytes".into()));
    }
    if req.tempo_pct < 25 || req.tempo_pct > 300 {
        return Err(AppError::BadRequest(
            "tempo_pct must be between 25 and 300".into(),
        ));
    }
    if req.transpose_semitones < -12 || req.transpose_semitones > 12 {
        return Err(AppError::BadRequest(
            "transpose_semitones must be between -12 and 12".into(),
        ));
    }

    let midi_key = require_midi_key(&state, asset_id, teacher_id).await?;
    let midi = state
        .blob
        .get_bytes(&midi_key)
        .await
        .map_err(|_| AppError::Internal("midi blob read".into()))?;

    let wav = state
        .sidecar
        .synthesise(SynthesiseRequest {
            midi,
            tempo_pct: req.tempo_pct,
            transpose_semitones: req.transpose_semitones,
            respect_repeats: req.respect_repeats,
        })
        .await?;

    let wav_key = format!("{}.wav", uuid::Uuid::new_v4());
    state
        .blob
        .put(&wav_key, Box::pin(std::io::Cursor::new(wav.to_vec())))
        .await
        .map_err(|e| AppError::Internal(e.to_string().into()))?;

    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let insert: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO accompaniment_variants
           (accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones,
            respect_repeats, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(asset_id)
    .bind(&req.label)
    .bind(&wav_key)
    .bind(req.tempo_pct)
    .bind(req.transpose_semitones)
    .bind(if req.respect_repeats { 1i32 } else { 0i32 })
    .bind(now)
    .fetch_one(&state.db)
    .await;

    let (vid,) = match insert {
        Ok(row) => row,
        Err(e) => {
            let _ = state.blob.delete(&wav_key).await;
            return Err(AppError::Sqlx(e));
        }
    };

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": vid, "label": req.label })),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Delete variant (soft)
// ---------------------------------------------------------------------------

pub(crate) async fn delete_variant(
    State(state): State<Arc<AppState>>,
    Path((slug, asset_id, variant_id)): Path<(String, i64, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    require_slug_owner(&state, teacher_id, &slug).await?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Confirm asset ownership, then find variant.
    let variant_row: Option<(String,)> = sqlx::query_as(
        "SELECT v.wav_blob_key
         FROM accompaniment_variants v
         JOIN accompaniments a ON a.id = v.accompaniment_id
         WHERE v.id = $1 AND v.accompaniment_id = $2 AND a.teacher_id = $3
           AND v.deleted_at IS NULL AND a.deleted_at IS NULL",
    )
    .bind(variant_id)
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    let (wav_key,) = variant_row.ok_or(AppError::NotFound)?;

    sqlx::query(
        "UPDATE accompaniment_variants SET deleted_at = $1
         WHERE id = $2 AND accompaniment_id = $3",
    )
    .bind(now)
    .bind(variant_id)
    .bind(asset_id)
    .execute(&state.db)
    .await?;

    state.media_tokens.invalidate_by_blob_keys(&[wav_key]);

    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// Media token delivery
// ---------------------------------------------------------------------------

pub(crate) async fn get_media(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
) -> Result<Response> {
    let (blob_key, no_cache) = state
        .media_tokens
        .get_entry(&token)
        .ok_or(AppError::NotFound)?;

    let data = state
        .blob
        .get_bytes(&blob_key)
        .await
        .map_err(|_| AppError::NotFound)?;

    let content_type = mime_for_key(&blob_key);
    let cache_control: &'static str = if no_cache {
        "no-store"
    } else {
        "private, max-age=300"
    };

    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache_control),
            ),
            (
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ),
        ],
        Body::from(data),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn require_auth(state: &AppState, headers: &HeaderMap) -> Result<i64> {
    resolve_teacher_from_cookie(&state.db, headers)
        .await
        .ok_or(AppError::Unauthorized)
}

async fn require_slug_owner(state: &AppState, teacher_id: i64, raw_slug: &str) -> Result<()> {
    let slug = validate(raw_slug).map_err(|_| AppError::NotFound)?;
    let (owned,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM teachers WHERE id = $1 AND slug = $2",
    )
    .bind(teacher_id)
    .bind(&slug)
    .fetch_one(&state.db)
    .await?;
    if owned == 0 {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

async fn require_pdf_key(state: &AppState, asset_id: i64, teacher_id: i64) -> Result<String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT pdf_blob_key FROM accompaniments
         WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    match row {
        None => Err(AppError::NotFound),
        Some((None,)) => Err(AppError::BadRequest("asset has no PDF".into())),
        Some((Some(k),)) => Ok(k),
    }
}

async fn require_midi_key(state: &AppState, asset_id: i64, teacher_id: i64) -> Result<String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT midi_blob_key FROM accompaniments
         WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    match row {
        None => Err(AppError::NotFound),
        Some((None,)) => Err(AppError::BadRequest("asset has no MIDI — run /midi first".into())),
        Some((Some(k),)) => Ok(k),
    }
}

/// Returns (pdf_blob_key, Option<bar_coords_json>) for post_rasterise.
async fn require_pdf_key_and_coords(
    state: &AppState,
    asset_id: i64,
    teacher_id: i64,
) -> Result<(String, Option<String>)> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT pdf_blob_key, bar_coords_json FROM accompaniments
         WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;
    match row {
        None => Err(AppError::NotFound),
        Some((None, _)) => Err(AppError::BadRequest("asset has no PDF".into())),
        Some((Some(k), coords)) => Ok((k, coords)),
    }
}

/// Returns cached MusicXML bytes from blob if available, otherwise re-runs OMR on the PDF.
async fn get_cached_musicxml_or_rerun_omr(
    state: &AppState,
    asset_id: i64,
    teacher_id: i64,
) -> Result<bytes::Bytes> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT musicxml_blob_key, pdf_blob_key FROM accompaniments
         WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    match row {
        None => Err(AppError::NotFound),
        Some((None, None)) => Err(AppError::BadRequest("asset has no PDF".into())),
        Some((Some(xml_key), _)) => {
            match state.blob.get_bytes(&xml_key).await {
                Ok(b) => Ok(b),
                Err(crate::blob::BlobError::NotFound) => {
                    // Blob gone (e.g. pre-Sprint-22 upload) — fall back to OMR.
                    tracing::warn!(asset_id, "musicxml blob missing, re-running OMR");
                    rerun_omr_from_pdf(state, asset_id, teacher_id).await
                }
                Err(e) => Err(AppError::Internal(e.to_string().into())),
            }
        }
        Some((None, Some(pdf_key))) => {
            // OMR has not been run yet or predates Sprint 23.
            let _ = pdf_key; // pdf_key not needed; rerun_omr_from_pdf fetches it
            rerun_omr_from_pdf(state, asset_id, teacher_id).await
        }
    }
}

async fn rerun_omr_from_pdf(
    state: &AppState,
    asset_id: i64,
    teacher_id: i64,
) -> Result<bytes::Bytes> {
    let pdf_key = require_pdf_key(state, asset_id, teacher_id).await?;
    let pdf = state
        .blob
        .get_bytes(&pdf_key)
        .await
        .map_err(|_| AppError::Internal("pdf blob read".into()))?;
    let omr = state.sidecar.omr(pdf).await?;
    Ok(omr.musicxml)
}

fn mime_for_key(key: &str) -> &'static str {
    if key.ends_with(".wav") {
        "audio/wav"
    } else if key.ends_with(".mp3") {
        "audio/mpeg"
    } else if key.ends_with(".png") {
        "image/png"
    } else if key.ends_with(".mid") {
        "audio/midi"
    } else {
        "application/octet-stream"
    }
}
