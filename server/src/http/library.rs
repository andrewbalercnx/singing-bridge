// File: server/src/http/library.rs
// Purpose: Accompaniment library HTTP API — asset CRUD, sidecar pipeline proxy,
//          and authenticated media token delivery.
// Role: Teacher-authenticated endpoints for library lifecycle management;
//       public GET /api/media/:token for WAV + page-image delivery.
// Exports: get_library_page, list_assets, post_asset, get_asset, delete_asset,
//          post_parts, post_midi, post_rasterise, post_variant, delete_variant,
//          get_media
// Depends: axum, sqlx, blob, sidecar, media_token, uuid, bytes, serde_json
// Invariants: All /teach/:slug/library/* routes require valid teacher session cookie.
//             All asset/variant DB queries join through teacher_id — no cross-teacher access.
//             Upload validates magic bytes: PDF (25 50 44 46), MIDI (4D 54 68 64),
//             WAV (RIFF + any 4 bytes + WAVE at bytes 8-11).
//             Stored JSON sizes: bar_coords_json ≤ 500 KB, bar_timings_json ≤ 100 KB,
//             page_blob_keys_json ≤ 10 KB.
//             GET /api/media/:token returns 404 for both unknown and expired tokens (no oracle).
//             Blob keys are never returned directly — callers receive short-lived media tokens.
// Last updated: Sprint 12a (2026-04-21) -- WAV upload, 413 guard, typed upload errors

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncRead;

use crate::auth::resolve_teacher_from_cookie;
use crate::blob::BlobStore;
use crate::error::{AppError, Result};
use crate::sidecar::SynthesiseRequest;
use crate::state::AppState;

const PDF_MAGIC: [u8; 4] = [0x25, 0x50, 0x44, 0x46]; // %PDF
const MIDI_MAGIC: [u8; 4] = [0x4D, 0x54, 0x68, 0x64]; // MThd
const RIFF_MAGIC: [u8; 4] = *b"RIFF";
const WAVE_MARKER: [u8; 4] = *b"WAVE";

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
    headers: HeaderMap,
) -> Result<Response> {
    require_auth(&state, &headers).await?;
    Ok((
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
        ],
        Html(r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Accompaniment Library — singing-bridge</title></head>
<body><h1>Accompaniment Library</h1>
<p>Library management UI coming in Sprint 13.</p>
</body></html>"#),
    ).into_response())
}

// ---------------------------------------------------------------------------
// List assets
// ---------------------------------------------------------------------------

pub(crate) async fn list_assets(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    let rows: Vec<(i64, String, Option<String>, Option<String>, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT a.id, a.title, a.pdf_blob_key, a.midi_blob_key,
                    a.page_blob_keys_json, a.bar_timings_json, a.created_at
             FROM accompaniments a
             WHERE a.teacher_id = ? AND a.deleted_at IS NULL
             ORDER BY a.created_at DESC",
        )
        .bind(teacher_id)
        .fetch_all(&state.db)
        .await?;

    let mut summaries = Vec::with_capacity(rows.len());
    for (id, title, pdf_key, midi_key, pages_json, timings_json, created_at) in rows {
        let variant_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM accompaniment_variants
             WHERE accompaniment_id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;

        summaries.push(AssetSummary {
            id,
            title,
            has_pdf: pdf_key.is_some(),
            has_midi: midi_key.is_some(),
            has_pages: pages_json.as_deref().map(|s| s != "[]").unwrap_or(false),
            has_bar_data: timings_json.is_some(),
            variant_count: variant_count.0,
            created_at,
        });
    }

    Ok(Json(summaries).into_response())
}

// ---------------------------------------------------------------------------
// Upload asset (PDF, MIDI, or WAV)
// ---------------------------------------------------------------------------

enum FileKind { Pdf, Midi, Wav }

impl FileKind {
    fn ext(&self) -> &'static str {
        match self { FileKind::Pdf => "pdf", FileKind::Midi => "mid", FileKind::Wav => "wav" }
    }
    fn kind_str(&self) -> &'static str {
        match self { FileKind::Pdf => "pdf", FileKind::Midi => "midi", FileKind::Wav => "wav" }
    }
}

/// Identify file type from the first 12 magic bytes and optional declared Content-Type.
/// `declared_ct`: the raw Content-Type header value (parameters are stripped internally).
/// Returns Err(ContentTypeMismatch) when declared type is a known MIME but disagrees with magic.
/// Returns Err(UnsupportedFileType) when magic bytes are not PDF, MIDI, or WAV.
fn detect_file_type(magic: &[u8; 12], declared_ct: Option<&str>) -> Result<FileKind> {
    let kind = if magic[0..4] == PDF_MAGIC {
        FileKind::Pdf
    } else if magic[0..4] == MIDI_MAGIC {
        FileKind::Midi
    } else if magic[0..4] == RIFF_MAGIC && magic[8..12] == WAVE_MARKER {
        FileKind::Wav
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
        };
        // Only fire ContentTypeMismatch when the declared type is itself a known type.
        let known = ["application/pdf", "audio/midi", "audio/wav"];
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

/// Insert the accompaniment (and for WAV, the variant) row(s).
/// On any DB error the blob is deleted before returning.
/// Returns (accompaniment_id, variant_id). variant_id is Some only for WAV.
async fn db_insert_accompaniment(
    db: &sqlx::SqlitePool,
    blob: &dyn BlobStore,
    teacher_id: i64,
    title: &str,
    blob_key: &str,
    kind: &FileKind,
    now: i64,
) -> Result<(i64, Option<i64>)> {
    match kind {
        FileKind::Pdf => {
            let r: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
                "INSERT INTO accompaniments (teacher_id, title, pdf_blob_key, created_at)
                 VALUES (?, ?, ?, ?) RETURNING id",
            )
            .bind(teacher_id).bind(title).bind(blob_key).bind(now)
            .fetch_one(db).await;
            match r {
                Ok((id,)) => Ok((id, None)),
                Err(e) => { let _ = blob.delete(blob_key).await; Err(AppError::Sqlx(e)) }
            }
        }
        FileKind::Midi => {
            let r: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
                "INSERT INTO accompaniments (teacher_id, title, midi_blob_key, created_at)
                 VALUES (?, ?, ?, ?) RETURNING id",
            )
            .bind(teacher_id).bind(title).bind(blob_key).bind(now)
            .fetch_one(db).await;
            match r {
                Ok((id,)) => Ok((id, None)),
                Err(e) => { let _ = blob.delete(blob_key).await; Err(AppError::Sqlx(e)) }
            }
        }
        FileKind::Wav => {
            // Two inserts wrapped in a transaction to avoid orphan accompaniment rows.
            let mut tx = match db.begin().await {
                Ok(tx) => tx,
                Err(e) => { let _ = blob.delete(blob_key).await; return Err(AppError::Sqlx(e)); }
            };
            let acc_r: std::result::Result<(i64,), sqlx::Error> = sqlx::query_as(
                "INSERT INTO accompaniments (teacher_id, title, created_at)
                 VALUES (?, ?, ?) RETURNING id",
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
                 VALUES (?, ?, ?, 100, 0, 0, ?) RETURNING id",
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
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    use futures::StreamExt;
    use tokio::io::AsyncReadExt;
    use tokio_util::io::StreamReader;

    let teacher_id = require_auth(&state, &headers).await?;

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
    Path((_slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    let ttl = Duration::from_secs(state.config.media_token_ttl_secs);

    let row: Option<(i64, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT id, title, pdf_blob_key, midi_blob_key, page_blob_keys_json,
                    bar_coords_json, bar_timings_json, created_at
             FROM accompaniments
             WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
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
        .map(|k| state.media_tokens.insert(k.clone(), ttl))
        .collect();

    // Issue media tokens for WAV variants.
    let variants_db: Vec<(i64, String, String, i32, i32, i32, Option<f64>, i64)> =
        sqlx::query_as(
            "SELECT id, label, wav_blob_key, tempo_pct, transpose_semitones,
                    respect_repeats, duration_s, created_at
             FROM accompaniment_variants
             WHERE accompaniment_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?;

    let variants: Vec<VariantView> = variants_db
        .into_iter()
        .map(|(vid, label, wav_key, tempo_pct, transpose, repeats, duration_s, vcreated)| {
            let token = state.media_tokens.insert(wav_key, ttl);
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

    Ok(Json(AssetDetail {
        id,
        title,
        has_pdf: pdf_key.is_some(),
        has_midi: midi_key.is_some(),
        page_tokens,
        bar_coords,
        bar_timings,
        variants,
        created_at,
    })
    .into_response())
}

// ---------------------------------------------------------------------------
// Delete asset (soft)
// ---------------------------------------------------------------------------

pub(crate) async fn delete_asset(
    State(state): State<Arc<AppState>>,
    Path((_slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Collect blob keys for token invalidation before soft-deleting.
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT pdf_blob_key, midi_blob_key, page_blob_keys_json
         FROM accompaniments
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    let (pdf_key, midi_key, pages_json) = row.ok_or(AppError::NotFound)?;

    let variant_wav_keys: Vec<(String,)> = sqlx::query_as(
        "SELECT wav_blob_key FROM accompaniment_variants
         WHERE accompaniment_id = ? AND deleted_at IS NULL",
    )
    .bind(asset_id)
    .fetch_all(&state.db)
    .await?;

    // Soft-delete asset and all its variants.
    sqlx::query("UPDATE accompaniments SET deleted_at = ? WHERE id = ? AND teacher_id = ?")
        .bind(now)
        .bind(asset_id)
        .bind(teacher_id)
        .execute(&state.db)
        .await?;

    sqlx::query(
        "UPDATE accompaniment_variants SET deleted_at = ?
         WHERE accompaniment_id = ?",
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

pub(crate) async fn post_parts(
    State(state): State<Arc<AppState>>,
    Path((_slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    let pdf_key = require_pdf_key(&state, asset_id, teacher_id).await?;
    let pdf = state
        .blob
        .get_bytes(&pdf_key)
        .await
        .map_err(|_| AppError::Internal("pdf blob read".into()))?;

    let omr = state.sidecar.omr(pdf).await?;
    let parts = state.sidecar.list_parts(omr.musicxml).await?;

    Ok(Json(parts).into_response())
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
    Path((_slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
    Json(req): Json<MidiRequest>,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    let pdf_key = require_pdf_key(&state, asset_id, teacher_id).await?;
    let pdf = state
        .blob
        .get_bytes(&pdf_key)
        .await
        .map_err(|_| AppError::Internal("pdf blob read".into()))?;

    let omr = state.sidecar.omr(pdf).await?;
    let midi = state
        .sidecar
        .extract_midi(omr.musicxml, &req.part_indices)
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
        "SELECT midi_blob_key FROM accompaniments WHERE id = ? AND teacher_id = ?",
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
        "UPDATE accompaniments SET midi_blob_key = ?, bar_timings_json = ?
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
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
    Path((_slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    let pdf_key = require_pdf_key(&state, asset_id, teacher_id).await?;
    let pdf = state
        .blob
        .get_bytes(&pdf_key)
        .await
        .map_err(|_| AppError::Internal("pdf blob read".into()))?;

    // Run bar-coords and rasterise in parallel.
    let (coords_result, pages_result) = tokio::join!(
        state.sidecar.bar_coords(pdf.clone()),
        state.sidecar.rasterise(pdf, 150),
    );
    let coords = coords_result?;
    let pages = pages_result?;

    let coords_json =
        serde_json::to_string(&coords).map_err(|_| AppError::Internal("coords json".into()))?;
    if coords_json.len() > BAR_COORDS_LIMIT {
        return Err(AppError::BadRequest(
            "bar coords JSON exceeds 500 KB limit".into(),
        ));
    }

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
        "SELECT page_blob_keys_json FROM accompaniments WHERE id = ? AND teacher_id = ?",
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
        "UPDATE accompaniments SET page_blob_keys_json = ?, bar_coords_json = ?
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
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
    Path((_slug, asset_id)): Path<(String, i64)>,
    headers: HeaderMap,
    Json(req): Json<VariantRequest>,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;

    if req.label.trim().is_empty() {
        return Err(AppError::BadRequest("label must not be empty".into()));
    }
    if req.label.len() > 255 {
        return Err(AppError::BadRequest("label exceeds 255 bytes".into()));
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
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
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
    Path((_slug, asset_id, variant_id)): Path<(String, i64, i64)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    // Confirm asset ownership, then find variant.
    let variant_row: Option<(String,)> = sqlx::query_as(
        "SELECT v.wav_blob_key
         FROM accompaniment_variants v
         JOIN accompaniments a ON a.id = v.accompaniment_id
         WHERE v.id = ? AND v.accompaniment_id = ? AND a.teacher_id = ?
           AND v.deleted_at IS NULL AND a.deleted_at IS NULL",
    )
    .bind(variant_id)
    .bind(asset_id)
    .bind(teacher_id)
    .fetch_optional(&state.db)
    .await?;

    let (wav_key,) = variant_row.ok_or(AppError::NotFound)?;

    sqlx::query(
        "UPDATE accompaniment_variants SET deleted_at = ?
         WHERE id = ? AND accompaniment_id = ?",
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
    let blob_key = state
        .media_tokens
        .get_blob_key(&token)
        .ok_or(AppError::NotFound)?;

    let data = state
        .blob
        .get_bytes(&blob_key)
        .await
        .map_err(|_| AppError::NotFound)?;

    let content_type = mime_for_key(&blob_key);

    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=300"),
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

async fn require_pdf_key(state: &AppState, asset_id: i64, teacher_id: i64) -> Result<String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT pdf_blob_key FROM accompaniments
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
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
         WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL",
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

fn mime_for_key(key: &str) -> &'static str {
    if key.ends_with(".wav") {
        "audio/wav"
    } else if key.ends_with(".png") {
        "image/png"
    } else if key.ends_with(".mid") {
        "audio/midi"
    } else {
        "application/octet-stream"
    }
}
