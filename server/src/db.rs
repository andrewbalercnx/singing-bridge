// File: server/src/db.rs
// Purpose: SQLite connection pool setup + migrations.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool
// Depends: sqlx
// Invariants: DELETE journal mode (default); works on both SMB and NFS Azure Files.
//             foreign_keys=ON; busy_timeout=30000ms; synchronous=NORMAL.
//             max_connections=4; SQLite serialises writers internally via busy_timeout.
//             CRITICAL: minReplicas=maxReplicas=1 in infra/bicep/container-app.bicep must stay
//             at 1 while SQLite is the DB engine — a second replica would corrupt the database.
// Last updated: Sprint 17 (2026-04-24) -- revert WAL → DELETE (SMB Azure Files does not
//               support POSIX byte-range locks required by WAL)

use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

use crate::error::Result;

pub async fn init_pool(db_url: &str) -> Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _| {
            Box::pin(async move {
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
