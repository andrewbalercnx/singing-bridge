// File: server/src/ws/session_history.rs
// Purpose: Session history persistence — upsert student, open/close session events,
//          durable recording-linkage slot.
// Role: Parallel to session_log but stores plain email (teacher-visible only).
//       All operations are best-effort; callers log warnings on failure and
//       continue.
// Exports: StudentId, SessionEventId, upsert_student, open_event, close_event,
//          set_recording_slot, consume_recording_slot, link_recording,
//          archive_old_events
// Depends: sqlx, time, session_log::EndedReason
// Invariants: email always stored as lower(email). close_event is first-writer-wins
//             (WHERE ended_at IS NULL). close_event and link_recording enforce
//             teacher_id ownership in SQL. upsert_student uses INSERT ... ON CONFLICT
//             DO NOTHING + SELECT to return correct id regardless of conflict.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; $N placeholders

use sqlx::PgPool;

use crate::auth::magic_link::TeacherId;
use crate::error::Result;
use crate::ws::session_log::EndedReason;

/// Opaque identifier for a student row. The `#[sqlx(transparent)]` derive
/// encodes/decodes as the inner i64; the newtype prevents accidental
/// cross-use with `SessionEventId` at compile time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, sqlx::Type)]
#[sqlx(transparent)]
pub struct StudentId(i64);

/// Opaque identifier for a session_event row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, sqlx::Type)]
#[sqlx(transparent)]
pub struct SessionEventId(i64);

pub const SESSION_ARCHIVE_DAYS: i64 = 90;
pub const HISTORY_PAGE_LIMIT: i64 = 100;
pub const RECORDING_SLOT_TTL_SECS: i64 = 86_400;

/// Upsert a student row; returns the student id regardless of whether the row
/// already existed. Email is normalised to lowercase before insertion.
/// Two-step: INSERT ... ON CONFLICT DO NOTHING then SELECT — never relies on
/// RETURNING after a conflict (which would return nothing on conflict).
pub async fn upsert_student(
    pool: &PgPool,
    teacher_id: TeacherId,
    email: &str,
) -> Result<StudentId> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    sqlx::query(
        "INSERT INTO students (teacher_id, email, first_seen_at) VALUES ($1, lower($2), $3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(teacher_id)
    .bind(email)
    .bind(now)
    .execute(pool)
    .await?;

    let (id,): (StudentId,) =
        sqlx::query_as("SELECT id FROM students WHERE teacher_id = $1 AND email = lower($2)")
            .bind(teacher_id)
            .bind(email)
            .fetch_one(pool)
            .await?;
    Ok(id)
}

/// Open a session event row. ended_at, duration_secs, ended_reason are all NULL.
pub async fn open_event(
    pool: &PgPool,
    teacher_id: TeacherId,
    student_id: StudentId,
    started_at: i64,
) -> Result<SessionEventId> {
    let (id,): (SessionEventId,) = sqlx::query_as(
        "INSERT INTO session_events (teacher_id, student_id, started_at) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(teacher_id)
    .bind(student_id)
    .bind(started_at)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// Close a session event row. First-writer-wins: if ended_at is already set
/// (concurrent close), the update matches zero rows and returns Ok.
/// teacher_id is enforced in the WHERE clause to prevent cross-teacher mutation.
pub async fn close_event(
    pool: &PgPool,
    event_id: SessionEventId,
    teacher_id: TeacherId,
    ended_at: i64,
    reason: EndedReason,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_events \
         SET ended_at = $1, \
             duration_secs = GREATEST(0, $2 - started_at), \
             ended_reason = $3 \
         WHERE id = $4 AND teacher_id = $5 AND ended_at IS NULL",
    )
    .bind(ended_at)
    .bind(ended_at)
    .bind(reason.as_str())
    .bind(event_id)
    .bind(teacher_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Store the recording-linkage slot. One slot per teacher (upsert).
pub async fn set_recording_slot(
    pool: &PgPool,
    teacher_id: TeacherId,
    event_id: SessionEventId,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    sqlx::query(
        "INSERT INTO recording_sessions (teacher_id, session_event_id, created_at) \
         VALUES ($1, $2, $3) \
         ON CONFLICT(teacher_id) DO UPDATE SET session_event_id = excluded.session_event_id, \
                                               created_at = excluded.created_at",
    )
    .bind(teacher_id)
    .bind(event_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Consume and clear the recording slot. Returns None if absent or expired
/// (TTL = RECORDING_SLOT_TTL_SECS). The slot is deleted atomically on consume.
pub async fn consume_recording_slot(
    pool: &PgPool,
    teacher_id: TeacherId,
) -> Result<Option<SessionEventId>> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    // Atomic consume: DELETE ... RETURNING eliminates any TOCTOU window.
    let row: Option<(SessionEventId, i64)> = sqlx::query_as(
        "DELETE FROM recording_sessions WHERE teacher_id = $1 RETURNING session_event_id, created_at",
    )
    .bind(teacher_id)
    .fetch_optional(pool)
    .await?;

    let Some((event_id, created_at)) = row else {
        return Ok(None);
    };

    if now - created_at > RECORDING_SLOT_TTL_SECS {
        return Ok(None);
    }
    Ok(Some(event_id))
}

/// Link a recording to a session event. teacher_id is enforced in the WHERE
/// clause to prevent cross-teacher mutation.
pub async fn link_recording(
    pool: &PgPool,
    event_id: SessionEventId,
    teacher_id: TeacherId,
    recording_id: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_events SET recording_id = $1 WHERE id = $2 AND teacher_id = $3",
    )
    .bind(recording_id)
    .bind(event_id)
    .bind(teacher_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Soft-archive session events whose completion time is older than SESSION_ARCHIVE_DAYS.
/// Completion time = COALESCE(ended_at, started_at) — so live sessions only archive
/// if they were started more than 90 days ago without ever closing.
pub async fn archive_old_events(pool: &PgPool) -> Result<u64> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let cutoff = now - SESSION_ARCHIVE_DAYS * 86_400;
    let result = sqlx::query(
        "UPDATE session_events \
         SET archived_at = $1 \
         WHERE COALESCE(ended_at, started_at) < $2 AND archived_at IS NULL",
    )
    .bind(now)
    .bind(cutoff)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

