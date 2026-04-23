// File: server/src/db.rs
// Purpose: SQLite connection pool setup + migrations.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool
// Depends: sqlx
// Invariants: WAL journal mode (journal_mode=WAL); concurrent readers, one serialised writer.
//             foreign_keys=ON; busy_timeout=30000ms; synchronous=NORMAL.
//             max_connections=4 serves read concurrency (history, library) without serialising
//             on read paths. WAL single-writer constraint is enforced by SQLite, not the pool.
//             CRITICAL: minReplicas=maxReplicas=1 in infra/bicep/container-app.bicep must stay
//             at 1 while SQLite is the DB engine — WAL locks are node-local and a second
//             replica would corrupt the database.
// Last updated: Sprint 16 (2026-04-23) -- re-enable WAL (NFS Azure Files supports POSIX locks);
//               lift max_connections 1→4; remove SMB workaround comment

use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

use crate::error::Result;

pub async fn init_pool(db_url: &str) -> Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("PRAGMA journal_mode=WAL")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA synchronous=NORMAL")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA busy_timeout=30000")
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
