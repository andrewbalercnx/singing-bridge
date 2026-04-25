# PLAN_Sprint19.md — PostgreSQL application migration

## Problem Statement

The singing-bridge server currently uses SQLite. Sprint 18 provisioned a shared PostgreSQL server (`vvp-postgres`) and stored a live `SB_DATABASE_URL` in Key Vault and in the Container App's secret configuration. The application code still references SQLite — `sqlx`'s `sqlite` feature, `SqlitePool`/`SqlitePoolOptions`, PRAGMA statements, SQLite-dialect SQL in all queries, and a `SB_DATA_DIR`-based URL construction in `config.rs`. Until the application is switched, sessions continue to be lost on every redeploy because `SB_DATA_DIR=/tmp` is ephemeral.

## User Outcome

**Who benefits and what job are they doing?**
Teachers. A teacher logs in, teaches a lesson — and after a routine deploy (a bug fix or feature update), she expects to still be logged in and find her session active. Currently every deploy resets her session and she must re-authenticate, which is disruptive enough that she avoids updates.

**What does success look like from the user's perspective?**
A teacher logs in. We deploy a new version of the server. She refreshes the page and is still logged in. She never notices a deploy happened.

Note: accompaniment library assets (blobs) are stored separately from the database. Blob storage durability is not changed by this sprint and is tracked separately.

**Why is this sprint the right next step for the product?**
Sprint 18 wired the infrastructure; nothing else can unblock durable session persistence. Until this sprint is done every redeploy destroys every active session, making the product unreliable to use in real lessons.

---

## Current State

From codebase analysis (2026-04-25):

| File | SQLite coupling |
|------|----------------|
| `server/Cargo.toml` | `sqlx = { features = ["sqlite", ...] }` |
| `server/src/db.rs` | `SqlitePool`, `SqlitePoolOptions`, three PRAGMA statements, startup migrations |
| `server/src/config.rs` | `db_url` constructed from `SB_DATA_DIR`; dev default `"sqlite::memory:"` |
| `server/src/state.rs` | `pub db: SqlitePool` |
| `server/src/cleanup.rs` | `SqlitePool` params; inline tests use `"sqlite::memory:"` |
| `server/src/auth/{mod,magic_link,password,rate_limit}.rs` | `&SqlitePool` params |
| `server/src/ws/{session_log,session_history}.rs` | `&SqlitePool` params; `INSERT OR IGNORE` |
| `server/src/http/{library,teach}.rs` | `&sqlx::SqlitePool` params |
| All `server/src/**/*.rs` queries | `?` parameter placeholders (invalid for Postgres) |
| `server/migrations/*.sql` | SQLite types: `BLOB`, `INTEGER PRIMARY KEY AUTOINCREMENT`, `COLLATE NOCASE` |
| `server/tests/common/mod.rs` | `"sqlite:file:testmem{n}?mode=memory&cache=shared"` |
| `server/tests/db_pragmas.rs` | Entire file is SQLite PRAGMA tests |
| `infra/bicep/container-app.bicep` | NFS volume + `SB_DATA_DIR=/data` (NFS never deployed; clean up) |

`config.rs` uses `SB_DATA_DIR` for three purposes: (1) SQLite DB path (removed here), (2) `dev_mail_dir` (kept; dev-only), (3) `dev_blob_dir` (kept; dev-only). The `data_dir` field and env var remain in config for dev convenience.

Sprint 18 ADR gate from `knowledge/decisions/0002-shared-postgres-platform.md`: `tls-rustls` must be added alongside `postgres` in this sprint to satisfy the mandatory Sprint 19 entry condition.

---

## Proposed Solution

Eight phases implemented in one pass and committed before code review.

### Phase 1 — `server/Cargo.toml`: swap sqlx features

```toml
# Before:
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "macros", "migrate"] }

# After:
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "tls-rustls", "macros", "migrate"] }
```

`tls-rustls` satisfies the ADR gate and enables `sslmode=verify-full` (enforced in production config validation — see Phase 3).

### Phase 2 — `server/src/db.rs`: switch pool type, remove PRAGMAs, separate migrations

Migrations require DDL capability (`sbmigrate` role). The runtime application uses `sbapp` (DML only) and must not run DDL. `init_pool` creates the pool without running migrations. A separate exported `run_migrations` function is called by the test harness and the deployment workflow.

```rust
// File: server/src/db.rs
// Purpose: PostgreSQL connection pool setup + migration runner.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool, run_migrations
// Depends: sqlx (postgres + tls-rustls features)
// Invariants: max_connections=5; PostgreSQL enforces FK constraints by default.
//             init_pool does NOT run migrations — caller is responsible.
//             run_migrations requires a DDL-capable credential (sbmigrate role).
//             Production connection strings must include sslmode=verify-full.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; separate migrations

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
```

**`max_connections`**: `vvp-postgres` Standard_B1ms allows approximately 50 connections total across all databases. With 3 potential consumers (singing-bridge runtime, a migration job, and headroom for VVP apps), `max_connections=5` leaves the budget balanced. This can be tuned after observing production connection usage.

**No `after_connect` block**: Postgres enforces FK constraints by default; no PRAGMAs needed.

**Credential separation** (from ADR 0002):
- `sbmigrate` — DDL-capable role; used only for migrations; held in `sb-migrate-url` KV secret; never accessible to the Container App runtime identity.
- `sbapp` — DML-only role; held in `sb-database-url` KV secret; used by the running application via `SB_DATABASE_URL`.

`init_pool(db_url)` uses `sbapp` credentials → runtime.
`run_migrations(migrate_url)` uses `sbmigrate` credentials → operator/CI only.

**Deployment workflow** (operator step before each deploy):
```bash
MIGRATE_URL=$(az keyvault secret show --vault-name rcnx-shared-kv \
  --name sb-migrate-url --query value -o tsv)
sqlx migrate run --database-url "$MIGRATE_URL" --source server/migrations/
# Confirm migration complete, then deploy new image:
az containerapp update --name sb-server --resource-group sb-prod-rg \
  --image <acr>/<new-image-tag>
```

The server binary's `main.rs` does NOT call `run_migrations`. The runtime pool uses `sbapp` credentials from `SB_DATABASE_URL` (which does not have DDL permission). The schema is guaranteed to exist because migrations are always run by the operator before the image is deployed.

Optionally, add a `migrate` subcommand to `main.rs` that calls `run_migrations(db_url)` where `db_url` is read from the first CLI argument or `SB_DATABASE_URL`. This keeps the migration toolchain self-contained in the binary.

### Phase 3 — `server/src/config.rs`: read `SB_DATABASE_URL`, add TLS validation

**`parse_env` changes**:
```rust
// Remove:
let db_url = if dev {
    "sqlite::memory:".to_string()
} else {
    format!("sqlite:{}/singing-bridge.db?mode=rwc", data_dir.display())
};

// Replace with:
let db_url = std::env::var("SB_DATABASE_URL")
    .map_err(|_| ConfigError::Missing("SB_DATABASE_URL"))?;
```

`SB_DATABASE_URL` is required with no default — the server will not start without it. Dev developers set it in a `.env` file or shell profile (e.g., `postgres://localhost:5432/singing_bridge`).

`data_dir` field and `SB_DATA_DIR` env var remain in config. Their uses (`dev_mail_dir = data_dir.join("dev-mail")`, `dev_blob_dir = data_dir.join("dev-blobs")`) are unchanged — these remain opt-in dev conveniences and are not used in production. In dev, `SB_DATA_DIR` defaults to `"data"` if not set, which is sufficient for both mail and blob directories.

**Production TLS validation** — add to `validate_prod_config`:
```rust
// Require TLS-protected database connections in production.
// sslmode=verify-full is required: tls-rustls verifies the server certificate chain.
// sslmode=require (encryption without cert verification) is rejected.
if !c.db_url.contains("sslmode=verify-full") {
    return Err(ConfigError::Invalid(
        "SB_DATABASE_URL",
        "production database URL must include sslmode=verify-full".into(),
    ));
}
// Reject localhost connections in production (prevents test DB misconfiguration).
if c.db_url.contains("localhost") || c.db_url.contains("127.0.0.1") {
    return Err(ConfigError::Invalid(
        "SB_DATABASE_URL",
        "production database URL must not point at localhost".into(),
    ));
}
```

**Key Vault secret update** (Sprint 18 set `sslmode=require`; update to `sslmode=verify-full` before deploy):
```bash
az keyvault secret set --vault-name rcnx-shared-kv --name sb-database-url \
  --value 'postgres://sbapp:<pw-B>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full'
az keyvault secret set --vault-name rcnx-shared-kv --name sb-migrate-url \
  --value 'postgres://sbmigrate:<pw-A>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full'
```

### Phase 4 — `state.rs` + all `SqlitePool` imports: mechanical rename

Every file that imports or accepts `SqlitePool`:

```rust
// Remove:   use sqlx::SqlitePool;
// Add:      use sqlx::PgPool;
```

Files: `state.rs`, `cleanup.rs`, `auth/mod.rs`, `auth/magic_link.rs`, `auth/password.rs`, `auth/rate_limit.rs`, `ws/session_log.rs`, `ws/session_history.rs`, `http/library.rs`.

`AppState.db` type changes from `SqlitePool` to `PgPool`.

### Phase 5 — Migration files: rewrite for Postgres dialect

**First**: add `CREATE EXTENSION IF NOT EXISTS citext;` as the first executable statement in `0001_initial.sql`. This ensures citext is provisioned in every new database — including per-test databases — before any `CITEXT` column is created. On the production `singing_bridge` database, Sprint 18 already ran `CREATE EXTENSION citext`; the `IF NOT EXISTS` guard makes this idempotent.

Type mapping:

| SQLite | Postgres |
|--------|----------|
| `INTEGER PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
| `INTEGER NOT NULL REFERENCES t(id)` | `BIGINT NOT NULL REFERENCES t(id)` |
| `INTEGER REFERENCES t(id)` | `BIGINT REFERENCES t(id)` |
| `BLOB PRIMARY KEY` | `BYTEA PRIMARY KEY` |
| `BLOB NOT NULL` | `BYTEA NOT NULL` |
| `TEXT NOT NULL COLLATE NOCASE` | `CITEXT NOT NULL` |
| `REAL` | `DOUBLE PRECISION` |
| `INTEGER PRIMARY KEY REFERENCES t(id)` | `BIGINT PRIMARY KEY REFERENCES t(id)` |

`AUTOINCREMENT` keyword is dropped (BIGSERIAL is self-incrementing). Boolean-encoded integers (`respect_repeats INTEGER CHECK (respect_repeats IN (0, 1))`) stay as INTEGER — no Rust-side bind change needed.

`UNIQUE(teacher_id, email)` on `students` with `CITEXT` email: CITEXT makes this constraint case-insensitive automatically, matching the SQLite `COLLATE NOCASE` intent.

**File-by-file changes:**

`0001_initial.sql`: Add `CREATE EXTENSION IF NOT EXISTS citext;` first. `teachers`: `BIGSERIAL`, `CITEXT`. `magic_links`: `BYTEA`, `BIGINT`. `sessions`: `BYTEA`, `BIGINT`. `signup_attempts`: `BIGSERIAL`, `CITEXT`.

`0002_session_log.sql`: `id BYTEA`, `teacher_id BIGINT`, `student_email_hash BYTEA`.

`0003_recordings.sql`: `recordings.id BIGSERIAL`, `teacher_id BIGINT`, hashes `BYTEA`. `recording_gate_attempts.id BIGSERIAL`.

`0004_password_auth.sql`: `login_attempts.id BIGSERIAL`, `teacher_id BIGINT`.

`0005_session_history.sql`: `students.id BIGSERIAL`, `teacher_id BIGINT`, `email CITEXT`. `session_events.id BIGSERIAL`, `teacher_id/student_id/recording_id BIGINT`. `recording_sessions.teacher_id BIGINT PRIMARY KEY`; `recording_sessions.session_event_id INTEGER NOT NULL` → `BIGINT NOT NULL` (FK must match `session_events.id BIGSERIAL` which produces `BIGINT`).

`0006_accompaniments.sql`: `accompaniments.id BIGSERIAL`, `teacher_id BIGINT`, `duration_s DOUBLE PRECISION`. `accompaniment_variants.id BIGSERIAL`, `accompaniment_id BIGINT`, `duration_s DOUBLE PRECISION`.

### Phase 6 — Query strings: `?` → `$N`, `INSERT OR IGNORE` → `ON CONFLICT`

Every `sqlx::query(...)` and `sqlx::query_as(...)` with `?` placeholders must be renumbered. First `?` → `$1`, second → `$2`, etc., in the order `.bind()` calls appear.

**`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`** (one occurrence, `ws/session_history.rs`):
```rust
// Before:
"INSERT OR IGNORE INTO students (teacher_id, email, first_seen_at) VALUES (?, lower(?), ?)"
// After:
"INSERT INTO students (teacher_id, email, first_seen_at) VALUES ($1, lower($2), $3) ON CONFLICT DO NOTHING"
```

Note: `lower()` is kept for defence-in-depth but is redundant with CITEXT. It remains harmless.

Files requiring `?` → `$N` (complete list): `cleanup.rs` (production queries + `#[cfg(test)]` queries), `auth/mod.rs`, `auth/magic_link.rs`, `auth/password.rs`, `auth/rate_limit.rs`, `ws/mod.rs`, `ws/session_log.rs`, `ws/session_history.rs`, `http/signup.rs`, `http/teach.rs`, `http/library.rs`, `http/history.rs`, `http/recordings.rs`, `http/recording_gate.rs`, `http/login.rs`.

`RETURNING id` in `library.rs` is valid in both dialects — no change needed beyond `?` → `$N`.

### Phase 7 — Test harness: per-test Postgres databases

**`server/tests/common/mod.rs`**: Replace the in-memory SQLite pattern with per-test Postgres databases.

```rust
// New imports:
use sqlx::postgres::PgPoolOptions;
use singing_bridge_server::db::{init_pool, run_migrations};

// helper: build a test DB URL by replacing the database name in the admin URL
fn test_db_url(admin_url: &str, db_name: &str) -> String {
    // admin_url: postgres://user:pass@host:port/dbname
    // Replace last path segment with db_name
    match admin_url.rfind('/') {
        Some(idx) => format!("{}/{}", &admin_url[..idx], db_name),
        None => format!("{}/{}", admin_url, db_name),
    }
}

// In spawn_app_with, replace sqlite:file:testmem block:
let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
let db_name = format!("singing_bridge_test_{n}");

let admin_url = std::env::var("DATABASE_TEST_URL")
    .expect("DATABASE_TEST_URL must be set (e.g. postgres://postgres:pass@localhost:5432/postgres)");

// Create the test database using admin connection
let admin = PgPoolOptions::new()
    .max_connections(1)
    .connect(&admin_url)
    .await
    .expect("connect to admin postgres");
sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
    .execute(&admin)
    .await
    .expect("create test DB");
admin.close().await;

// Build test DB URL, run migrations with admin (DDL-capable) URL, then init app pool
let db_url = test_db_url(&admin_url, &db_name);
// Tests use the admin URL for migrations (superuser = DDL access; mirrors sbmigrate role)
run_migrations(&db_url).await.expect("run test migrations");
// App pool uses the same URL here (test DB owner = full access; not privilege-split in tests)
config.db_url = db_url.clone();
let pool = init_pool(&db_url).await.unwrap();
```

**Test cleanup** — add `db_name` and `admin_url` fields to `TestApp`. Add an explicit `cleanup()` async method:

```rust
pub async fn cleanup(self) {
    // Close pool before dropping database (Postgres requires no active connections)
    self.state.db.close().await;
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&self.admin_url)
        .await
        .expect("cleanup: connect admin");
    sqlx::query(&format!("DROP DATABASE IF EXISTS \"{}\"", self.db_name))
        .execute(&admin)
        .await
        .expect("cleanup: drop test DB");
    admin.close().await;
}
```

**Cleanup strategy — committed approach**: Every integration test body calls `app.cleanup().await` as the final statement. This is the uniform, explicit pattern — no "or wrapper" ambiguity. A search-and-replace across all 23 test files ensures every test cleans up. Leaked databases (from panicked tests) are named `singing_bridge_test_{n}` and can be cleaned up by running `DROP DATABASE "singing_bridge_test_N"` from the admin connection, or by a CI pre-run script: `SELECT datname FROM pg_database WHERE datname LIKE 'singing_bridge_test_%'` then drop each.

**`server/tests/db_pragmas.rs`**: Delete. Replace with `server/tests/db_pool.rs`:

```rust
// File: server/tests/db_pool.rs
// Purpose: Verify init_pool connects to Postgres and allows concurrent connections.
// Last updated: Sprint 19 (2026-04-25) -- replaces db_pragmas.rs

mod common;
use common::spawn_app;

#[tokio::test]
async fn pool_concurrent_connections() {
    use tokio::time::{timeout, Duration};
    let app = spawn_app().await;
    let c1 = timeout(Duration::from_millis(500), app.state.db.acquire())
        .await
        .expect("first acquire timed out")
        .expect("first acquire error");
    let c2 = timeout(Duration::from_millis(500), app.state.db.acquire())
        .await
        .expect("second acquire timed out")
        .expect("second acquire error");
    drop(c1);
    drop(c2);
    app.cleanup().await;
}
```

**CITEXT behavior tests** — add to one of the existing signup or magic_link tests, or add a new case to `http_signup.rs`:
```rust
// Verify CITEXT: email registered as "Teacher@Example.com" is found as "teacher@example.com"
// The existing magic_link tests exercise case-insensitive email lookup end-to-end.
// Verify that registering "A@B.com" and attempting signup with "a@b.com" returns the
// expected duplicate-email response (rate-limiting / "email in use" path).
```

**`server/src/cleanup.rs` inline tests**: Replace `init_pool("sqlite::memory:")` in the `#[cfg(test)]` module with the same create/migrate/init pattern as `common/mod.rs`. These tests run in CI unconditionally — no `#[ignore]`. `DATABASE_TEST_URL` is required for the full test suite including unit-style tests in `cleanup.rs`.

### Phase 8 — `infra/bicep/container-app.bicep`: remove NFS, remove `SB_DATA_DIR`

The NFS volume and storage mount were written for Sprint 16 but the VNet-integrated environment rebuild never succeeded — the actual deployed environment is consumption-only with no NFS storage. Remove all NFS-related resources, parameters, and `SB_DATA_DIR`. The production blob store does not use the filesystem path from `SB_DATA_DIR` (it uses Azure Blob Storage); the `dev_blob_dir` field is only used in dev mode.

**Remove from container-app.bicep:**
- `nfsStorageAccountName` param + `nfsStorageAccount` resource + `nfsFileShare` resource
- `caStorage` resource (NFS storage binding)
- `acaSubnetId` + `storageSubnetId` params
- `vnetConfiguration` block in `caEnv` (consumption-only; VNet never applied)
- `volumes` array from `template`
- `volumeMounts` from server container
- `{ name: 'SB_DATA_DIR', value: '/data' }` env var

**Update header**: remove SQLite/NFS invariants; remove the `min=max=1 replica` SQLite constraint. Keep `minReplicas: 1, maxReplicas: 1` for now (scale-out requires sticky session consideration).

---

## Test Strategy

### Property / invariant coverage
- All pre-existing integration tests pass against Postgres (`DATABASE_TEST_URL` set)
- `db_pool.rs` confirms concurrent pool acquisition succeeds within 500 ms (Postgres pool is shared-writer safe, unlike SQLite)
- `cargo build --release` succeeds with no `sqlite` references: `grep -r SqlitePool server/src/` returns empty
- Production config validation rejects `SB_DATABASE_URL` without `sslmode=verify-full`
- Production config validation rejects localhost database URLs

### Failure-path coverage
- `spawn_app` panics immediately with a descriptive message if `DATABASE_TEST_URL` is absent
- `run_migrations` returns `AppError::Internal` on migration failure (propagated from sqlx migrate error)
- `init_pool` fails immediately on bad URL (Postgres connection error)
- Production server refuses to start if `SB_DATABASE_URL` lacks `sslmode=verify-full` (tested via config unit test)

### Regression guards (per prior-round findings)
| Prior SQLite behavior | PostgreSQL equivalent guard |
|----------------------|----------------------------|
| PRAGMA foreign_keys=ON | Postgres enforces FK by default; `on_delete_cascade` behaviour verified by any test that deletes a teacher |
| PRAGMA busy_timeout (no blocking) | Concurrent tests each get isolated DB; no shared-state contention |
| PRAGMA journal_mode (WAL) | Not applicable; Postgres MVCC handles concurrency |
| `db_pragma_*` tests (4 tests deleted) | Replaced by `db_pool.rs` concurrent-connection test |
| `INSERT OR IGNORE` upsert-student idempotency | `ws_session_handshake.rs` (or existing WS test): re-joining room with same student email must not error |
| `COLLATE NOCASE` case-insensitive email | `magic_link.rs` or `http_signup.rs`: register with mixed-case email, look up with lower-case → succeeds |
| SQLite in-memory per-test isolation | Per-test Postgres database (created + dropped each test) |

### CITEXT semantic test
Add one targeted assertion to an existing email-registration test:
- Register a teacher with email `"Test@Example.COM"`
- Attempt a magic link request with `"test@example.com"` (lower-case variant)
- PASS: the lower-case lookup finds the account (CITEXT uniqueness is case-insensitive)

This verifies that `CITEXT NOT NULL` provides the same behaviour as the old `COLLATE NOCASE`.

### Fixture reuse plan
Same `spawn_app` / `spawn_app_with` API surface. All 23 existing test bodies remain unchanged — only `common/mod.rs` internals change. Each test must add `app.cleanup().await` at its end (or this is handled by a shared wrapper if `Drop` async cleanup is added).

### Test runtime budget
- Target: < 90 s on developer hardware (SQLite suite was ~30 s; each test adds ~100 ms for DB create/drop = ~2.3 s overhead across 23 tests, plus Postgres query latency).
- If suite exceeds 90 s, investigate: run tests serially (`--test-threads 1`) to identify slow tests; consider reusing the migrated DB across related tests.
- Flaky policy: DB-creation failures in `spawn_app` are fatal panics (not retried); CI must have `DATABASE_TEST_URL` set. Tests are not marked `#[ignore]` by default.

---

## Files Changing

| File | Change |
|------|--------|
| `server/Cargo.toml` | `sqlite` → `postgres` + `tls-rustls` |
| `server/src/db.rs` | `PgPool`, `PgPoolOptions`, no PRAGMAs; `init_pool` no migrations; `run_migrations` exported |
| `server/src/config.rs` | `SB_DATABASE_URL` env var; remove SQLite URL construction; TLS validation in prod |
| `server/src/state.rs` | `SqlitePool` → `PgPool` |
| `server/src/cleanup.rs` | `SqlitePool` → `PgPool`; inline tests use `DATABASE_TEST_URL` |
| `server/src/auth/mod.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/auth/magic_link.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/auth/password.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/auth/rate_limit.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/ws/session_log.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/ws/session_history.rs` | `SqlitePool` → `PgPool`; `?` → `$N`; `INSERT OR IGNORE` → `ON CONFLICT` |
| `server/src/http/library.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/ws/mod.rs` | `?` → `$N` |
| `server/src/http/signup.rs` | `?` → `$N` |
| `server/src/http/teach.rs` | `?` → `$N` |
| `server/src/http/history.rs` | `?` → `$N` |
| `server/src/http/recordings.rs` | `?` → `$N` |
| `server/src/http/recording_gate.rs` | `?` → `$N` |
| `server/src/http/login.rs` | `?` → `$N` |
| `server/migrations/0001_initial.sql` | `CREATE EXTENSION IF NOT EXISTS citext`; `BIGSERIAL`, `BYTEA`, `CITEXT` |
| `server/migrations/0002_session_log.sql` | `BYTEA`, `BIGINT` |
| `server/migrations/0003_recordings.sql` | `BIGSERIAL`, `BYTEA`, `BIGINT` |
| `server/migrations/0004_password_auth.sql` | `BIGSERIAL`, `BIGINT` |
| `server/migrations/0005_session_history.sql` | `BIGSERIAL`, `BIGINT`, `CITEXT` |
| `server/migrations/0006_accompaniments.sql` | `BIGSERIAL`, `BIGINT`, `DOUBLE PRECISION` |
| `server/tests/common/mod.rs` | `DATABASE_TEST_URL`; create/drop per-test Postgres DB; add `cleanup()` |
| `server/tests/db_pragmas.rs` | **Delete** |
| `server/tests/db_pool.rs` | **New**: concurrent connection test |
| `infra/bicep/container-app.bicep` | Remove NFS resources + `SB_DATA_DIR`; update header |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `$N` numbering error in a query | Medium | `cargo build` catches bind-count mismatch at runtime on first bind; test suite exercises all query paths |
| `BIGINT` vs `i64` mismatch in Rust fetch | Low | `BIGSERIAL` → `BIGINT` → `i64` in sqlx — matches all existing Rust types |
| `CITEXT` not in test DB | Low | `CREATE EXTENSION IF NOT EXISTS citext` is first line of migration 0001; runs automatically |
| `CITEXT` not in production singing_bridge DB | Very low | Sprint 18 Phase 3 installed it; migration is idempotent via `IF NOT EXISTS` |
| Test Postgres unavailable | Medium | `spawn_app` panics with clear message; CI must set `DATABASE_TEST_URL` |
| Leaked test databases on panic | Low | Named `singing_bridge_test_{n}`; CI cleanup script: `DROP DATABASE` all matching names at run start |
| Migrations not run before server start | Low | Documented in deployment workflow; server returns SQL errors immediately if schema is missing (caught in smoke test) |
| `sslmode=verify-full` rejected by local Postgres (no TLS) | Low | Validation only runs when `SB_ENV=prod`; dev uses default URL without `sslmode=verify-full` |
| KV secret values need updating to `sslmode=verify-full` | Confirmed | Phase 3 includes explicit `az keyvault secret set` update commands |
| NFS Bicep removal surprises on redeploy | Very low | NFS was never successfully deployed; removal cleans up dead code |
| Session data migration | None | Production is on `/tmp` (ephemeral); all existing sessions expire. Fresh Postgres DB starts clean |

---

## Exit Criteria

- `cargo test` green with `DATABASE_TEST_URL` pointing to a live Postgres 16 instance (all 23 pre-existing tests + `db_pool.rs`)
- `cargo build --release` succeeds; `grep -r SqlitePool server/src/` returns empty
- Config unit test: `validate_prod_config` rejects `SB_DATABASE_URL` without `sslmode=verify-full`
- Session persistence confirmed: teacher logs in → server restarts (new test instance) → cookie still valid
- CITEXT test: mixed-case email lookup succeeds (case-insensitive lookup returns correct record)
- `infra/bicep/container-app.bicep` has no NFS resources, no `SB_DATA_DIR`
- Sprint 18 TLS posture upgraded: connection strings updated to `sslmode=verify-full`
