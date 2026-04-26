// File: server/src/ws/accompaniment.rs
// Purpose: WebSocket handlers for teacher-controlled in-session accompaniment playback.
// Role: Implements AccompanimentPlay, AccompanimentPause, AccompanimentStop with full
//       snapshot broadcasts. Manages media token lifecycle (issue/revoke).
// Exports: handle_accompaniment_play, handle_accompaniment_pause, handle_accompaniment_stop
// Depends: state, protocol, media_token, sidecar
// Invariants: All handlers reject students with ErrorCode::Forbidden.
//             AccompanimentPlay always revokes old tokens before issuing new ones.
//             AccompanimentStop and disconnect revoke tokens before clearing state.
//             No .await calls under RwLock write guard.
//             bar_coords sorted ascending by bar before storage.
// Last updated: Sprint 14 (2026-04-23) -- initial implementation

#![deny(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::sidecar::{BarCoord, BarTiming};
use crate::state::{AccompanimentSnapshot, AppState};
use crate::ws::connection::ConnContext;
use crate::ws::pump_send_error;
use crate::ws::protocol::{ErrorCode, PumpDirective, Role, ServerMsg};

const ACCOMPANIMENT_TOKEN_TTL_SECS: u64 = 7200;
const MAX_POSITION_MS: u64 = 14_400_000;
const MAX_TEMPO_PCT: i32 = 400;
const MIN_TEMPO_PCT: i32 = 1;
const MAX_PAGES: usize = 20;
const MAX_BAR_COORDS: usize = 2000;
const MAX_BAR_TIMINGS: usize = 2000;

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

pub async fn handle_accompaniment_play(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    asset_id: i64,
    variant_id: i64,
    position_ms: u64,
) -> bool {
    // Step 1: check_role
    if !check_role(ctx).await {
        return true;
    }
    let Some(teacher_id) = ctx.candidate_teacher_id else {
        pump_send_error(&ctx.tx, ErrorCode::Forbidden, "not a teacher").await;
        return true;
    };

    // Step 2: validate_position_ms
    if !validate_position_ms(ctx, position_ms).await {
        return true;
    }

    // Step 3: fetch_and_validate_variant
    let variant = match fetch_and_validate_variant(state, asset_id, variant_id, teacher_id).await {
        Ok(v) => v,
        Err(code) => {
            pump_send_error(&ctx.tx, code, "variant not found or invalid").await;
            return true;
        }
    };

    // Validate tempo_pct from DB.
    if variant.tempo_pct < MIN_TEMPO_PCT || variant.tempo_pct > MAX_TEMPO_PCT {
        pump_send_error(&ctx.tx, ErrorCode::Malformed, "tempo_pct out of range").await;
        return true;
    }

    // Validate bar_timings monotonicity.
    if let Err(()) = validate_bar_timings_monotone(&variant.bar_timings) {
        pump_send_error(&ctx.tx, ErrorCode::Internal, "bar_timings non-monotone").await;
        return true;
    }

    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    // Step 4: revoke old tokens BEFORE issuing new ones (read lock to extract
    // old blob keys; revoke outside the lock so no .await under guard).
    let old_blob_keys = {
        let rs = room.read().await;
        rs.active_session
            .as_ref()
            .and_then(|s| s.accompaniment.as_ref())
            .map(|snap| snap.all_blob_keys())
            .unwrap_or_default()
    };
    state.media_tokens.invalidate_by_blob_keys(&old_blob_keys);

    // Step 5: issue new tokens (old tokens are now dead; same blob keys are safe).
    let ttl = Duration::from_secs(ACCOMPANIMENT_TOKEN_TTL_SECS);
    let base = state.config.base_url.as_str().trim_end_matches('/');
    let wav_url = format!(
        "{}/api/media/{}",
        base,
        state.media_tokens.insert(variant.wav_blob_key.clone(), ttl, true)
    );
    let page_urls: Vec<String> = variant
        .page_blob_keys
        .iter()
        .map(|k| {
            format!(
                "{}/api/media/{}",
                base,
                state.media_tokens.insert(k.clone(), ttl, true)
            )
        })
        .collect();

    // Step 6: build snapshot.
    let snapshot = AccompanimentSnapshot {
        asset_id,
        variant_id,
        tempo_pct: variant.tempo_pct,
        position_ms,
        is_playing: true,
        wav_blob_key: variant.wav_blob_key,
        page_blob_keys: variant.page_blob_keys,
        wav_url: wav_url.clone(),
        page_urls: page_urls.clone(),
        bar_coords: variant.bar_coords.clone(),
        bar_timings: variant.bar_timings.clone(),
    };

    let server_time_ms = now_unix_ms();
    let broadcast = ServerMsg::AccompanimentState {
        asset_id: Some(asset_id),
        variant_id: Some(variant_id),
        is_playing: true,
        position_ms,
        tempo_pct: Some(variant.tempo_pct),
        wav_url: Some(wav_url),
        page_urls: Some(page_urls),
        bar_coords: Some(variant.bar_coords),
        bar_timings: Some(variant.bar_timings),
        server_time_ms,
    };

    // Step 7: write snapshot under write lock (no .await under guard).
    let (teacher_tx, student_tx) = {
        let mut rs = room.write().await;
        let Some(session) = rs.active_session.as_mut() else {
            drop(rs);
            // Session ended between our lock acquisitions — revoke the just-issued tokens.
            state.media_tokens.invalidate_by_blob_keys(&snapshot.all_blob_keys());
            pump_send_error(&ctx.tx, ErrorCode::NotInSession, "no active session").await;
            return true;
        };
        session.accompaniment = Some(snapshot);
        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let student_tx = rs.active_session.as_ref().map(|s| s.student.conn.tx.clone());
        (teacher_tx, student_tx)
    };

    broadcast_to_session(teacher_tx, student_tx, broadcast).await;
    true
}

pub async fn handle_accompaniment_pause(
    ctx: &ConnContext,
    state: &Arc<AppState>,
    position_ms: u64,
) -> bool {
    // Step 1: check_role
    if !check_role(ctx).await {
        return true;
    }

    // Validate position_ms.
    if !validate_position_ms(ctx, position_ms).await {
        return true;
    }

    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let server_time_ms = now_unix_ms();
    let (teacher_tx, student_tx, broadcast) = {
        let mut rs = room.write().await;
        let Some(session) = rs.active_session.as_mut() else {
            drop(rs);
            pump_send_error(&ctx.tx, ErrorCode::NotInSession, "no active session").await;
            return true;
        };

        let Some(snap) = session.accompaniment.as_mut() else {
            // No active accompaniment — no-op.
            return true;
        };

        snap.is_playing = false;
        snap.position_ms = position_ms;

        let msg = ServerMsg::AccompanimentState {
            asset_id: Some(snap.asset_id),
            variant_id: Some(snap.variant_id),
            is_playing: false,
            position_ms,
            tempo_pct: Some(snap.tempo_pct),
            wav_url: Some(snap.wav_url.clone()),
            page_urls: Some(snap.page_urls.clone()),
            bar_coords: Some(snap.bar_coords.clone()),
            bar_timings: Some(snap.bar_timings.clone()),
            server_time_ms,
        };

        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let student_tx = rs.active_session.as_ref().map(|s| s.student.conn.tx.clone());
        (teacher_tx, student_tx, msg)
    };

    broadcast_to_session(teacher_tx, student_tx, broadcast).await;
    true
}

pub async fn handle_accompaniment_stop(
    ctx: &ConnContext,
    state: &Arc<AppState>,
) -> bool {
    // Step 1: check_role
    if !check_role(ctx).await {
        return true;
    }

    let Some(slug) = ctx.slug.as_ref() else { return true };
    let Some(room) = state.room(slug) else { return true };

    let (teacher_tx, student_tx) = {
        let mut rs = room.write().await;
        let Some(session) = rs.active_session.as_mut() else {
            drop(rs);
            pump_send_error(&ctx.tx, ErrorCode::NotInSession, "no active session").await;
            return true;
        };

        // No-op if no accompaniment is active (matches Pause behavior).
        let Some(snap) = session.accompaniment.as_ref() else {
            return true;
        };

        // Revoke tokens before clearing (no .await under guard).
        state.media_tokens.invalidate_by_blob_keys(&snap.all_blob_keys());
        session.accompaniment = None;

        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let student_tx = rs.active_session.as_ref().map(|s| s.student.conn.tx.clone());
        (teacher_tx, student_tx)
    };

    broadcast_to_session(teacher_tx, student_tx, cleared_state()).await;
    true
}

/// Called from cleanup on teacher disconnect or session teardown.
/// Revokes tokens and broadcasts cleared state to both participants.
pub async fn revoke_and_clear_accompaniment(
    state: &AppState,
    room: &Arc<tokio::sync::RwLock<crate::state::RoomState>>,
) {
    let (teacher_tx, student_tx) = {
        let mut rs = room.write().await;
        let Some(session) = rs.active_session.as_mut() else {
            return;
        };

        let Some(snap) = session.accompaniment.as_ref() else {
            return;
        };

        state.media_tokens.invalidate_by_blob_keys(&snap.all_blob_keys());
        session.accompaniment = None;

        let teacher_tx = rs.teacher_conn.as_ref().map(|c| c.tx.clone());
        let student_tx = rs.active_session.as_ref().map(|s| s.student.conn.tx.clone());
        (teacher_tx, student_tx)
    };

    broadcast_to_session(teacher_tx, student_tx, cleared_state()).await;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async fn check_role(ctx: &ConnContext) -> bool {
    if ctx.role != Some(Role::Teacher) {
        pump_send_error(&ctx.tx, ErrorCode::Forbidden, "teacher only").await;
        return false;
    }
    true
}

async fn validate_position_ms(ctx: &ConnContext, position_ms: u64) -> bool {
    if position_ms > MAX_POSITION_MS {
        pump_send_error(&ctx.tx, ErrorCode::Malformed, "position_ms out of range").await;
        return false;
    }
    true
}

struct VariantData {
    wav_blob_key: String,
    tempo_pct: i32,
    page_blob_keys: Vec<String>,
    bar_coords: Vec<BarCoord>,
    bar_timings: Vec<BarTiming>,
}

async fn fetch_and_validate_variant(
    state: &AppState,
    asset_id: i64,
    variant_id: i64,
    teacher_id: i64,
) -> Result<VariantData, ErrorCode> {
    let row: Option<(String, i32, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT av.wav_blob_key, av.tempo_pct,
                    a.page_blob_keys_json, a.bar_coords_json, a.bar_timings_json
             FROM accompaniment_variants av
             JOIN accompaniments a ON a.id = av.accompaniment_id
             WHERE av.id = $1
               AND av.accompaniment_id = $2
               AND a.teacher_id = $3
               AND av.deleted_at IS NULL
               AND a.deleted_at IS NULL",
        )
        .bind(variant_id)
        .bind(asset_id)
        .bind(teacher_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| ErrorCode::Internal)?;

    let (wav_blob_key, tempo_pct, pages_json, coords_json, timings_json) =
        row.ok_or(ErrorCode::EntryNotFound)?;

    let page_blob_keys: Vec<String> = pages_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    if page_blob_keys.len() > MAX_PAGES {
        return Err(ErrorCode::Malformed);
    }

    let mut bar_coords: Vec<BarCoord> = coords_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    if bar_coords.len() > MAX_BAR_COORDS {
        return Err(ErrorCode::Internal);
    }

    // Filter out coords with out-of-range page indices.
    let page_count = page_blob_keys.len();
    bar_coords.retain(|c| {
        let page_ok = c.page >= 0 && (c.page as usize) < page_count;
        let frac_ok = (0.0..=1.0).contains(&c.x_frac)
            && (0.0..=1.0).contains(&c.y_frac)
            && (0.0..=1.0).contains(&c.w_frac)
            && (0.0..=1.0).contains(&c.h_frac)
            && c.w_frac > 0.0
            && c.h_frac > 0.0;
        if !page_ok {
            tracing::debug!(bar = c.bar, page = c.page, "skipping bar_coord: out-of-range page");
        }
        page_ok && frac_ok
    });

    // Sort ascending by bar number (required invariant for binary search).
    bar_coords.sort_by_key(|c| c.bar);

    let bar_timings: Vec<BarTiming> = timings_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    if bar_timings.len() > MAX_BAR_TIMINGS {
        return Err(ErrorCode::Internal);
    }

    Ok(VariantData { wav_blob_key, tempo_pct, page_blob_keys, bar_coords, bar_timings })
}

/// Returns Err(()) if bar_timings are not monotonically non-decreasing in time_s
/// or bar values are not strictly increasing.
fn validate_bar_timings_monotone(timings: &[BarTiming]) -> Result<(), ()> {
    if timings.is_empty() {
        return Ok(());
    }
    if timings[0].time_s < 0.0 {
        return Err(());
    }
    for w in timings.windows(2) {
        if w[1].bar <= w[0].bar {
            return Err(());
        }
        if w[1].time_s < w[0].time_s {
            return Err(());
        }
    }
    Ok(())
}

fn cleared_state() -> ServerMsg {
    ServerMsg::AccompanimentState {
        asset_id: None,
        variant_id: None,
        is_playing: false,
        position_ms: 0,
        tempo_pct: None,
        wav_url: None,
        page_urls: None,
        bar_coords: None,
        bar_timings: None,
        server_time_ms: now_unix_ms(),
    }
}

async fn broadcast_to_session(
    teacher_tx: Option<mpsc::Sender<PumpDirective>>,
    student_tx: Option<mpsc::Sender<PumpDirective>>,
    msg: ServerMsg,
) {
    if let Some(ttx) = teacher_tx {
        let _ = ttx.send(PumpDirective::Send(msg.clone())).await;
    }
    if let Some(stx) = student_tx {
        let _ = stx.send(PumpDirective::Send(msg)).await;
    }
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
