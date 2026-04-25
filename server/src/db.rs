// File: server/src/db.rs
// Purpose: PostgreSQL connection pool setup + migration runner.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool, run_migrations
// Depends: sqlx (postgres + tls-rustls features)
// Invariants: max_connections=5; PostgreSQL enforces FK constraints by default.
//             init_pool does NOT run migrations — caller is responsible.
//             run_migrations requires a DDL-capable credential (sbmigrate role).
//             Production connection strings must include sslmode=verify-full.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; separate migrations; test_helpers

use sqlx::{postgres::PgPoolOptions, PgPool};

use crate::error::Result;

pub async fn init_pool(db_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(db_url)
        .await?;
    Ok(pool)
}

pub async fn run_migrations(db_url: &str) -> Result<()> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(db_url)
        .await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| crate::error::AppError::Internal(format!("migrate: {e}").into()))?;
    pool.close().await;
    Ok(())
}

/// Shared helpers for inline unit tests that need a per-test PostgreSQL database.
/// Addresses R1 findings #34 (panic-safe cleanup), #37 (deduplication), #31 (URL
/// construction preserves query parameters).
#[cfg(test)]
pub mod test_helpers {
    use std::sync::atomic::{AtomicU64, Ordering};
    use sqlx::{PgPool, postgres::PgPoolOptions};

    static DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Replace the database-name segment of a PostgreSQL URL while preserving
    /// all other components (scheme, credentials, host, port, query string).
    pub fn replace_db_name(url: &str, new_db: &str) -> String {
        if let Ok(mut parsed) = url::Url::parse(url) {
            parsed.set_path(&format!("/{new_db}"));
            return parsed.to_string();
        }
        // Fallback: replace after the last '/'.
        match url.rfind('/') {
            Some(idx) => format!("{}/{}", &url[..idx], new_db),
            None => format!("{}/{}", url, new_db),
        }
    }

    /// Per-test database handle. The database is created in `make_test_db()` and
    /// **automatically dropped when this guard is dropped**, even on test panic.
    pub struct TestDb {
        pub pool: PgPool,
        db_name: String,
        admin_url: String,
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let db_name = std::mem::take(&mut self.db_name);
            if db_name.is_empty() {
                return;
            }
            let admin_url = self.admin_url.clone();
            let pool = self.pool.clone();
            // Spawn a dedicated thread with its own runtime so we can run async
            // cleanup from a synchronous Drop context.
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("TestDb cleanup runtime")
                    .block_on(async move {
                        pool.close().await;
                        if let Ok(admin) = PgPoolOptions::new()
                            .max_connections(1)
                            .connect(&admin_url)
                            .await
                        {
                            let _ = sqlx::query(&format!(
                                "DROP DATABASE \"{db_name}\" WITH (FORCE)"
                            ))
                            .execute(&admin)
                            .await;
                            admin.close().await;
                        }
                    });
            })
            .join()
            .ok();
        }
    }

    /// Create a fresh per-test PostgreSQL database, run migrations, and return a
    /// RAII guard that drops the database on cleanup — including on test panic.
    ///
    /// Reads `DATABASE_TEST_URL` for admin-level access. The per-test database
    /// name includes the process ID and a monotonic counter so parallel test
    /// processes (each with a unique PID) never collide.
    pub async fn make_test_db() -> TestDb {
        let admin_url = std::env::var("DATABASE_TEST_URL")
            .expect("DATABASE_TEST_URL must be set for inline tests");
        let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let db_name = format!("singing_bridge_test_{pid}_{n}");

        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&admin_url)
            .await
            .expect("connect admin for test DB creation");
        sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
            .execute(&admin)
            .await
            .expect("create test database");
        admin.close().await;

        let db_url = replace_db_name(&admin_url, &db_name);
        crate::db::run_migrations(&db_url).await.expect("run_migrations");
        let pool = crate::db::init_pool(&db_url).await.expect("init_pool");

        TestDb { pool, db_name, admin_url }
    }
}
