// File: server/tests/regression.rs
// Purpose: Regression guards for findings from the PostgreSQL migration code review.
// Last updated: Sprint 19 (2026-04-25) -- initial implementation

mod common;
use common::spawn_app;
use singing_bridge_server::db::init_pool;

// ── #36: CITEXT case-insensitivity regression ────────────────────────────────

/// Verify that the `teachers.email` column is CITEXT: a row inserted with a
/// lowercase address must be retrievable using an uppercase address in the WHERE
/// clause without any explicit LOWER() normalisation.
#[tokio::test]
async fn citext_email_column_is_case_insensitive() {
    let app = spawn_app().await;

    sqlx::query(
        "INSERT INTO teachers (email, slug, created_at) VALUES ($1, $2, $3)",
    )
    .bind("alice@example.test")
    .bind("alice-citext")
    .bind(0_i64)
    .execute(&app.state.db)
    .await
    .unwrap();

    // Query with uppercase — CITEXT equality is case-insensitive.
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM teachers WHERE email = $1")
            .bind("ALICE@EXAMPLE.TEST")
            .fetch_optional(&app.state.db)
            .await
            .unwrap();
    assert!(
        row.is_some(),
        "CITEXT column must match 'ALICE@EXAMPLE.TEST' against 'alice@example.test'"
    );

    // Mixed case.
    let row2: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM teachers WHERE email = $1")
            .bind("Alice@Example.Test")
            .fetch_optional(&app.state.db)
            .await
            .unwrap();
    assert!(row2.is_some(), "CITEXT must also match mixed-case form");

    app.shutdown().await;
}

/// Verify that the UNIQUE constraint on `teachers.email` is case-insensitive
/// (CITEXT UNIQUE rejects duplicates regardless of case).
#[tokio::test]
async fn citext_unique_constraint_is_case_insensitive() {
    let app = spawn_app().await;

    sqlx::query(
        "INSERT INTO teachers (email, slug, created_at) VALUES ($1, $2, $3)",
    )
    .bind("bob@example.test")
    .bind("bob-citext")
    .bind(0_i64)
    .execute(&app.state.db)
    .await
    .unwrap();

    // Inserting the same address with different case must fail.
    let result = sqlx::query(
        "INSERT INTO teachers (email, slug, created_at) VALUES ($1, $2, $3)",
    )
    .bind("BOB@EXAMPLE.TEST")
    .bind("bob-citext-dup")
    .bind(0_i64)
    .execute(&app.state.db)
    .await;

    assert!(
        result.is_err(),
        "inserting BOB@EXAMPLE.TEST when bob@example.test exists must violate UNIQUE"
    );

    app.shutdown().await;
}

// ── #38 / #30: FK enforcement regression ────────────────────────────────────

/// Verify that PostgreSQL enforces the foreign-key constraint on
/// `session_events.teacher_id`. Inserting an event referencing a non-existent
/// teacher must fail with a FK violation, not silently succeed (SQLite without
/// PRAGMA foreign_keys = ON would have allowed it).
#[tokio::test]
async fn fk_session_event_requires_valid_teacher() {
    let app = spawn_app().await;

    // Use a teacher_id that definitely doesn't exist.
    let result = sqlx::query(
        "INSERT INTO session_events (teacher_id, student_id, started_at) VALUES ($1, $2, $3)",
    )
    .bind(999_999_i64)
    .bind(999_999_i64)
    .bind(0_i64)
    .execute(&app.state.db)
    .await;

    assert!(
        result.is_err(),
        "inserting session_event with non-existent teacher_id must fail (FK enforcement)"
    );

    app.shutdown().await;
}

/// Verify that deleting a teacher is blocked when referenced rows exist.
/// The FK on `sessions.teacher_id` has no CASCADE, so deleting a teacher
/// with active sessions must return an FK violation.
#[tokio::test]
async fn fk_prevents_teacher_deletion_with_active_session() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("fk-teacher@example.test", "fk-teacher").await;
    let _ = cookie; // session row now exists in DB

    let (tid,): (i64,) = sqlx::query_as("SELECT id FROM teachers WHERE slug = 'fk-teacher'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();

    let result = sqlx::query("DELETE FROM teachers WHERE id = $1")
        .bind(tid)
        .execute(&app.state.db)
        .await;

    assert!(
        result.is_err(),
        "deleting a teacher with a live session must fail (FK on sessions.teacher_id)"
    );

    app.shutdown().await;
}

// ── #26: Session persistence across server restart ───────────────────────────

/// Verify that session rows are stored in PostgreSQL (not in application memory)
/// by reading them through a second, independent connection pool — simulating
/// what a restarted server would see.
#[tokio::test]
async fn session_persists_in_postgresql_across_restart() {
    let app = spawn_app().await;
    let cookie = app.signup_teacher("persist@example.test", "persist-slug").await;

    // Confirm the session row exists via the application's own pool.
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sessions WHERE teacher_id = \
         (SELECT id FROM teachers WHERE slug = 'persist-slug')",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(count, 1, "session must be persisted in PostgreSQL");

    // Open an independent pool to the same database (simulating a server restart).
    let db_url = app.state.config.db_url.clone();
    let second_pool = init_pool(&db_url).await.unwrap();

    let (count2,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sessions WHERE teacher_id = \
         (SELECT id FROM teachers WHERE slug = 'persist-slug')",
    )
    .fetch_one(&second_pool)
    .await
    .unwrap();
    assert_eq!(
        count2, 1,
        "session must be visible via a fresh pool (cross-restart persistence)"
    );
    let _ = cookie;
    second_pool.close().await;
    app.shutdown().await;
}
