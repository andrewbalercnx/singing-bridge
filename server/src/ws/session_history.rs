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
//             teacher_id ownership in SQL. upsert_student uses INSERT OR IGNORE
//             + SELECT to return correct id regardless of conflict.
// Last updated: Sprint 11 (2026-04-21) -- initial implementation

use sqlx::SqlitePool;

use crate::auth::magic_link::TeacherId;
use crate::error::Result;
use crate::ws::session_log::EndedReason;

pub type StudentId = i64;
pub type SessionEventId = i64;

pub const SESSION_ARCHIVE_DAYS: i64 = 90;
pub const HISTORY_PAGE_LIMIT: i64 = 100;
pub const RECORDING_SLOT_TTL_SECS: i64 = 86_400;

/// Upsert a student row; returns the student id regardless of whether the row
/// already existed. Email is normalised to lowercase before insertion.
/// Two-step: INSERT OR IGNORE then SELECT — never relies on last_insert_rowid().
pub async fn upsert_student(
    pool: &SqlitePool,
    teacher_id: TeacherId,
    email: &str,
) -> Result<StudentId> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    sqlx::query(
        "INSERT OR IGNORE INTO students (teacher_id, email, first_seen_at) VALUES (?, lower(?), ?)",
    )
    .bind(teacher_id)
    .bind(email)
    .bind(now)
    .execute(pool)
    .await?;

    let (id,): (StudentId,) =
        sqlx::query_as("SELECT id FROM students WHERE teacher_id = ? AND email = lower(?)")
            .bind(teacher_id)
            .bind(email)
            .fetch_one(pool)
            .await?;
    Ok(id)
}

/// Open a session event row. ended_at, duration_secs, ended_reason are all NULL.
pub async fn open_event(
    pool: &SqlitePool,
    teacher_id: TeacherId,
    student_id: StudentId,
    started_at: i64,
) -> Result<SessionEventId> {
    let (id,): (SessionEventId,) = sqlx::query_as(
        "INSERT INTO session_events (teacher_id, student_id, started_at) VALUES (?, ?, ?) RETURNING id",
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
    pool: &SqlitePool,
    event_id: SessionEventId,
    teacher_id: TeacherId,
    ended_at: i64,
    reason: EndedReason,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_events \
         SET ended_at = ?, \
             duration_secs = MAX(0, ? - started_at), \
             ended_reason = ? \
         WHERE id = ? AND teacher_id = ? AND ended_at IS NULL",
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
    pool: &SqlitePool,
    teacher_id: TeacherId,
    event_id: SessionEventId,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    sqlx::query(
        "INSERT INTO recording_sessions (teacher_id, session_event_id, created_at) \
         VALUES (?, ?, ?) \
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
    pool: &SqlitePool,
    teacher_id: TeacherId,
) -> Result<Option<SessionEventId>> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    // Atomic consume: DELETE ... RETURNING eliminates any TOCTOU window.
    let row: Option<(SessionEventId, i64)> = sqlx::query_as(
        "DELETE FROM recording_sessions WHERE teacher_id = ? RETURNING session_event_id, created_at",
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
    pool: &SqlitePool,
    event_id: SessionEventId,
    teacher_id: TeacherId,
    recording_id: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE session_events SET recording_id = ? WHERE id = ? AND teacher_id = ?",
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
pub async fn archive_old_events(pool: &SqlitePool) -> Result<u64> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let cutoff = now - SESSION_ARCHIVE_DAYS * 86_400;
    let result = sqlx::query(
        "UPDATE session_events \
         SET archived_at = ? \
         WHERE COALESCE(ended_at, started_at) < ? AND archived_at IS NULL",
    )
    .bind(now)
    .bind(cutoff)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_pool() -> SqlitePool {
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        sqlx::query(
            "INSERT INTO teachers (id, email, slug, created_at) VALUES (1, 't@test.com', 'slug1', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO teachers (id, email, slug, created_at) VALUES (2, 't2@test.com', 'slug2', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn upsert_student_idempotent() {
        let pool = make_pool().await;
        let id1 = upsert_student(&pool, 1, "alice@test.com").await.unwrap();
        let id2 = upsert_student(&pool, 1, "alice@test.com").await.unwrap();
        assert_eq!(id1, id2);
    }

    #[tokio::test]
    async fn upsert_student_case_insensitive() {
        let pool = make_pool().await;
        let id1 = upsert_student(&pool, 1, "ALICE@TEST.COM").await.unwrap();
        let id2 = upsert_student(&pool, 1, "alice@test.com").await.unwrap();
        let id3 = upsert_student(&pool, 1, "Alice@Test.Com").await.unwrap();
        assert_eq!(id1, id2);
        assert_eq!(id2, id3);
    }

    #[tokio::test]
    async fn upsert_student_different_teachers_separate() {
        let pool = make_pool().await;
        let id1 = upsert_student(&pool, 1, "alice@test.com").await.unwrap();
        let id2 = upsert_student(&pool, 2, "alice@test.com").await.unwrap();
        assert_ne!(id1, id2);
    }

    #[tokio::test]
    async fn open_event_has_null_ended_at() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        let row: (Option<i64>, Option<i64>) =
            sqlx::query_as("SELECT ended_at, duration_secs FROM session_events WHERE id = ?")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_none());
        assert!(row.1.is_none());
    }

    #[tokio::test]
    async fn close_event_sets_duration() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        close_event(&pool, event_id, 1, 1060, EndedReason::Hangup)
            .await
            .unwrap();
        let row: (Option<i64>, Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT ended_at, duration_secs, ended_reason FROM session_events WHERE id = ?",
        )
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, Some(1060));
        assert_eq!(row.1, Some(60));
        assert_eq!(row.2.as_deref(), Some("hangup"));
    }

    #[tokio::test]
    async fn close_event_duration_clamps_negative() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        close_event(&pool, event_id, 1, 999, EndedReason::Disconnect)
            .await
            .unwrap();
        let (duration,): (Option<i64>,) =
            sqlx::query_as("SELECT duration_secs FROM session_events WHERE id = ?")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(duration, Some(0));
    }

    #[tokio::test]
    async fn close_event_first_writer_wins() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        close_event(&pool, event_id, 1, 1060, EndedReason::Hangup)
            .await
            .unwrap();
        // Second close should be a no-op (first-writer-wins).
        close_event(&pool, event_id, 1, 9999, EndedReason::Disconnect)
            .await
            .unwrap();
        let (ended_at,): (Option<i64>,) =
            sqlx::query_as("SELECT ended_at FROM session_events WHERE id = ?")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ended_at, Some(1060));
    }

    #[tokio::test]
    async fn close_event_wrong_teacher_is_noop() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        // teacher_id=2 should not be able to close teacher_id=1's event.
        close_event(&pool, event_id, 2, 1060, EndedReason::Hangup)
            .await
            .unwrap();
        let (ended_at,): (Option<i64>,) =
            sqlx::query_as("SELECT ended_at FROM session_events WHERE id = ?")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(ended_at.is_none());
    }

    #[tokio::test]
    async fn link_recording_sets_recording_id() {
        let pool = make_pool().await;
        // Insert a minimal recording row first.
        let token_hash: Vec<u8> = vec![0u8; 32];
        let email_hash: Vec<u8> = vec![0u8; 32];
        let (recording_id,): (i64,) = sqlx::query_as(
            "INSERT INTO recordings (teacher_id, student_email, student_email_hash, created_at, token_hash) \
             VALUES (1, 's@test.com', ?, 0, ?) RETURNING id",
        )
        .bind(&email_hash)
        .bind(&token_hash)
        .fetch_one(&pool)
        .await
        .unwrap();

        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        link_recording(&pool, event_id, 1, recording_id)
            .await
            .unwrap();
        let (rid,): (Option<i64>,) =
            sqlx::query_as("SELECT recording_id FROM session_events WHERE id = ?")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(rid, Some(recording_id));
    }

    #[tokio::test]
    async fn link_recording_wrong_teacher_is_noop() {
        let pool = make_pool().await;
        let token_hash: Vec<u8> = vec![0u8; 32];
        let email_hash: Vec<u8> = vec![0u8; 32];
        let (recording_id,): (i64,) = sqlx::query_as(
            "INSERT INTO recordings (teacher_id, student_email, student_email_hash, created_at, token_hash) \
             VALUES (1, 's@test.com', ?, 0, ?) RETURNING id",
        )
        .bind(&email_hash)
        .bind(&token_hash)
        .fetch_one(&pool)
        .await
        .unwrap();
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        // teacher 2 cannot link to teacher 1's event.
        link_recording(&pool, event_id, 2, recording_id)
            .await
            .unwrap();
        let (rid,): (Option<i64>,) =
            sqlx::query_as("SELECT recording_id FROM session_events WHERE id = ?")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(rid.is_none());
    }

    #[tokio::test]
    async fn recording_slot_roundtrip() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        set_recording_slot(&pool, 1, event_id).await.unwrap();
        let got = consume_recording_slot(&pool, 1).await.unwrap();
        assert_eq!(got, Some(event_id));
        // Second consume: slot deleted.
        let got2 = consume_recording_slot(&pool, 1).await.unwrap();
        assert!(got2.is_none());
    }

    #[tokio::test]
    async fn recording_slot_absent_returns_none() {
        let pool = make_pool().await;
        let got = consume_recording_slot(&pool, 1).await.unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn recording_slot_expired_returns_none() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let event_id = open_event(&pool, 1, student_id, 1000).await.unwrap();
        // Manually insert an expired slot.
        let expired_at = time::OffsetDateTime::now_utc().unix_timestamp() - RECORDING_SLOT_TTL_SECS - 1;
        sqlx::query(
            "INSERT INTO recording_sessions (teacher_id, session_event_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(1_i64)
        .bind(event_id)
        .bind(expired_at)
        .execute(&pool)
        .await
        .unwrap();
        let got = consume_recording_slot(&pool, 1).await.unwrap();
        assert!(got.is_none());
        // Row must be deleted even on TTL expiry (atomic DELETE RETURNING consumed it).
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM recording_sessions WHERE teacher_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "expired slot must be deleted on consume attempt");
    }

    #[tokio::test]
    async fn archive_old_events_by_completion_time() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let cutoff_secs = SESSION_ARCHIVE_DAYS * 86_400;

        // Event ended exactly at boundary — should NOT be archived (strict <).
        let e_boundary = open_event(&pool, 1, student_id, now - cutoff_secs - 100).await.unwrap();
        close_event(&pool, e_boundary, 1, now - cutoff_secs, EndedReason::Hangup)
            .await
            .unwrap();

        // Event ended 1 second past boundary — should be archived.
        let e_old = open_event(&pool, 1, student_id, now - cutoff_secs - 200).await.unwrap();
        close_event(&pool, e_old, 1, now - cutoff_secs - 1, EndedReason::Hangup)
            .await
            .unwrap();

        // Live session started 91 days ago — archived via started_at COALESCE.
        let e_live_old = open_event(&pool, 1, student_id, now - cutoff_secs - 1).await.unwrap();

        let archived = archive_old_events(&pool).await.unwrap();
        assert_eq!(archived, 2, "expected e_old and e_live_old archived");

        let (a1,): (Option<i64>,) =
            sqlx::query_as("SELECT archived_at FROM session_events WHERE id = ?")
                .bind(e_boundary)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(a1.is_none(), "boundary event must not be archived");

        let (a2,): (Option<i64>,) =
            sqlx::query_as("SELECT archived_at FROM session_events WHERE id = ?")
                .bind(e_old)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(a2.is_some(), "old event must be archived");

        let (a3,): (Option<i64>,) =
            sqlx::query_as("SELECT archived_at FROM session_events WHERE id = ?")
                .bind(e_live_old)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(a3.is_some(), "live old session must be archived via started_at");
    }

    #[tokio::test]
    async fn ended_reason_all_variants_stored() {
        let pool = make_pool().await;
        let student_id = upsert_student(&pool, 1, "s@test.com").await.unwrap();
        let cases = [
            (EndedReason::Hangup, "hangup"),
            (EndedReason::Disconnect, "disconnect"),
            (EndedReason::FloorViolation, "floor_violation"),
            (EndedReason::Blocked, "blocked"),
            (EndedReason::ServerShutdown, "server_shutdown"),
        ];
        for (i, (reason, expected_str)) in cases.into_iter().enumerate() {
            let started = 1000 + i as i64 * 100;
            let event_id = open_event(&pool, 1, student_id, started).await.unwrap();
            close_event(&pool, event_id, 1, started + 60, reason)
                .await
                .unwrap();
            let (stored,): (Option<String>,) =
                sqlx::query_as("SELECT ended_reason FROM session_events WHERE id = ?")
                    .bind(event_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(stored.as_deref(), Some(expected_str));
        }
    }
}
