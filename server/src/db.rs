// File: server/src/db.rs
// Purpose: PostgreSQL connection pool setup + migration runner.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool, run_migrations
// Depends: sqlx (postgres + tls-rustls features)
// Invariants: max_connections=5; PostgreSQL enforces FK constraints by default.
//             init_pool does NOT run migrations — caller is responsible.
//             run_migrations requires a DDL-capable credential (sbmigrate role).
//             Production connection strings must include sslmode=verify-full.
// Last updated: Sprint 27 (2026-05-08) -- fingerprint-based template name eliminates deadlock

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
pub mod test_helpers {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use sqlx::{PgPool, postgres::PgPoolOptions};

    static DB_COUNTER: AtomicU64 = AtomicU64::new(0);
    // Per-process template DB (created once, reused by all make_test_db calls).
    static TEMPLATE_DB: Mutex<Option<String>> = Mutex::new(None);

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

    /// Fingerprint of all embedded migrations — used as part of the template DB name so
    /// that a schema change automatically produces a new template without invalidating old ones.
    fn migration_fingerprint() -> u64 {
        sqlx::migrate!("./migrations")
            .migrations
            .iter()
            .fold(0u64, |acc, m| {
                let csum = m.checksum.iter().copied()
                    .fold(0u64, |a, b| a.wrapping_mul(257).wrapping_add(b as u64));
                acc.wrapping_add(m.version as u64).wrapping_add(csum)
            })
    }

    /// Return (or lazily create) the shared template database with all migrations applied.
    ///
    /// The template name encodes the migration fingerprint, so a changed schema creates a
    /// new template automatically.  A PostgreSQL session-level advisory lock coordinates
    /// across concurrent nextest processes: only the first creates+migrates the template;
    /// others wait, then see it exists and skip — crucially without connecting to it.
    /// Avoiding a connection to the template when it already exists is what prevents the
    /// deadlock where `CREATE DATABASE … TEMPLATE` (which locks the template for new
    /// connections during the copy) races with a migration-check connection.
    pub async fn ensure_template_db(admin_url: &str) -> String {
        if let Some(name) = TEMPLATE_DB.lock().unwrap().as_ref() {
            return name.clone();
        }
        let admin_url = admin_url.to_string();
        tokio::task::spawn_blocking(move || {
            let mut guard = TEMPLATE_DB.lock().unwrap();
            if let Some(name) = guard.as_ref() {
                return name.clone();
            }
            let fp = migration_fingerprint();
            let name = format!("singing_bridge_test_template_{fp:016x}");
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("template DB init runtime");
            rt.block_on(async {
                let admin = PgPoolOptions::new()
                    .max_connections(1)
                    .connect(&admin_url)
                    .await
                    .expect("template: connect admin");
                // Advisory lock serialises template creation across all concurrent processes.
                // Session-level: released automatically when admin connection closes.
                sqlx::query("SELECT pg_advisory_lock(9876543210)")
                    .execute(&admin)
                    .await
                    .expect("template: advisory lock");
                let (exists,): (bool,) = sqlx::query_as(
                    "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)"
                )
                .bind(&name)
                .fetch_one(&admin)
                .await
                .expect("template: check exists");
                if !exists {
                    // First process: create + migrate. The fingerprint in the name guarantees
                    // this template is fully migrated — no process ever connects to it again
                    // for migration checks, eliminating the CREATE DATABASE … TEMPLATE deadlock.
                    sqlx::query(&format!("CREATE DATABASE \"{name}\""))
                        .execute(&admin)
                        .await
                        .expect("template: create");
                    let db_url = replace_db_name(&admin_url, &name);
                    crate::db::run_migrations(&db_url)
                        .await
                        .expect("template: run_migrations");
                }
                // Closing admin releases the advisory lock.
                admin.close().await;
            });
            *guard = Some(name.clone());
            name
        })
        .await
        .expect("ensure_template_db")
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
            // Do NOT call pool.close().await here: the pool's background tasks run
            // on the test's tokio runtime, which is blocked waiting for this Drop to
            // finish — calling close() from a new runtime deadlocks. DROP WITH (FORCE)
            // terminates any remaining connections server-side.
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("TestDb cleanup runtime")
                    .block_on(async move {
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

    /// Create a fresh per-test PostgreSQL database using the per-process template
    /// (migrations already applied), and return a RAII guard that drops it on
    /// cleanup — including on test panic.
    pub async fn make_test_db() -> TestDb {
        let admin_url = std::env::var("DATABASE_TEST_URL")
            .expect("DATABASE_TEST_URL must be set for inline tests");
        let template = ensure_template_db(&admin_url).await;

        let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let db_name = format!("singing_bridge_test_{pid}_{n}");

        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&admin_url)
            .await
            .expect("connect admin for test DB creation");
        // Drop stale DB left by a crashed/killed previous run (same PID reused).
        // WITH (FORCE) terminates any open connections immediately rather than blocking.
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS \"{db_name}\" WITH (FORCE)"))
            .execute(&admin)
            .await;
        sqlx::query(&format!(
            "CREATE DATABASE \"{db_name}\" TEMPLATE \"{template}\""
        ))
        .execute(&admin)
        .await
        .expect("create test database from template");
        admin.close().await;

        let db_url = replace_db_name(&admin_url, &db_name);
        let pool = crate::db::init_pool(&db_url).await.expect("init_pool");

        TestDb { pool, db_name, admin_url }
    }
}
