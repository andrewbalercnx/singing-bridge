// File: server/src/db.rs
// Purpose: SQLite connection pool setup + migrations with WAL + busy_timeout.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool
// Depends: sqlx
// Invariants: every connection has WAL mode, busy_timeout=5000ms, foreign_keys=ON.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

use crate::error::Result;

pub async fn init_pool(db_url: &str) -> Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("PRAGMA journal_mode=WAL")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA synchronous=NORMAL")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA busy_timeout=5000")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA foreign_keys=ON")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect(db_url)
        .await?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| crate::error::AppError::Internal(format!("migrate: {e}").into()))?;

    Ok(pool)
}
