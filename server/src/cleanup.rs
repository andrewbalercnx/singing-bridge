// File: server/src/cleanup.rs
// Purpose: Background cleanup for soft-deleted recordings and stale gate attempts.
// Role: Periodically purges blobs whose grace period has elapsed; prunes old
//       recording_gate_attempts rows; sets blob_key=NULL on successful delete.
// Exports: run_one_cleanup_cycle, cleanup_loop
// Depends: sqlx, blob, tokio_util::sync::CancellationToken
// Invariants: Uses time::OffsetDateTime::now_utc().unix_timestamp() for timestamps.
//             blob_key set to NULL only after successful BlobStore::delete.
//             Gate attempts pruned per gate_attempt_ttl_secs passed at call time.
//             cleanup_loop exits cleanly on CancellationToken cancellation.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; $N placeholders

use std::sync::Arc;

use sqlx::PgPool;
use tokio_util::sync::CancellationToken;

use crate::blob::BlobStore;
use crate::ws::session_history;

/// Grace period in seconds before a soft-deleted recording's blob is purged.
pub const BLOB_GRACE_SECS: i64 = 86_400;
/// How often the loop wakes up (seconds).
const LOOP_INTERVAL_SECS: u64 = 300;

pub async fn run_one_cleanup_cycle(
    db: &PgPool,
    blob: &Arc<dyn BlobStore>,
    gate_attempt_ttl_secs: i64,
) -> crate::error::Result<usize> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let cutoff = now - BLOB_GRACE_SECS;

    // Find soft-deleted rows whose grace period has elapsed and blob_key is still set.
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, blob_key FROM recordings
         WHERE deleted_at IS NOT NULL
           AND deleted_at < $1
           AND blob_key IS NOT NULL",
    )
    .bind(cutoff)
    .fetch_all(db)
    .await
    .map_err(|e| crate::error::AppError::Internal(e.to_string().into()))?;

    let mut purged = 0usize;
    for (id, key) in rows {
        match blob.delete(&key).await {
            Ok(()) => {
                // Set blob_key = NULL only after successful delete.
                if let Err(e) = sqlx::query(
                    "UPDATE recordings SET blob_key = NULL WHERE id = $1",
                )
                .bind(id)
                .execute(db)
                .await
                {
                    tracing::warn!(recording_id = id, error = %e, "cleanup: failed to null blob_key after delete");
                } else {
                    purged += 1;
                }
            }
            Err(e) => {
                tracing::warn!(recording_id = id, error = %e, "cleanup: BlobStore::delete failed; retaining blob_key");
            }
        }
    }

    // Prune stale gate attempts (TTL from config to match the rate-limit window).
    let gate_cutoff = now - gate_attempt_ttl_secs;
    if let Err(e) = sqlx::query(
        "DELETE FROM recording_gate_attempts WHERE attempted_at < $1",
    )
    .bind(gate_cutoff)
    .execute(db)
    .await
    {
        tracing::warn!(error = %e, "cleanup: failed to prune recording_gate_attempts");
    }

    // Prune login attempts older than 24 h.
    let login_cutoff = now - 86400;
    if let Err(e) = sqlx::query("DELETE FROM login_attempts WHERE attempted_at < $1")
        .bind(login_cutoff)
        .execute(db)
        .await
    {
        tracing::warn!(error = %e, "cleanup: failed to prune login_attempts");
    }

    // Soft-archive old session events.
    if let Err(e) = session_history::archive_old_events(db).await {
        tracing::warn!(error = %e, "cleanup: failed to archive session_events");
    }

    Ok(purged)
}

pub async fn cleanup_loop(
    db: PgPool,
    blob: Arc<dyn BlobStore>,
    gate_attempt_ttl_secs: i64,
    shutdown: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(std::time::Duration::from_secs(LOOP_INTERVAL_SECS)) => {
                match run_one_cleanup_cycle(&db, &blob, gate_attempt_ttl_secs).await {
                    Ok(n) => tracing::debug!(purged = n, "cleanup cycle complete"),
                    Err(e) => tracing::warn!(error = %e, "cleanup cycle error"),
                }
            }
        }
    }
}

