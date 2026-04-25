# PLAN_Sprint19.md — PostgreSQL application migration

## Problem Statement

The singing-bridge server currently uses SQLite. Sprint 18 provisioned a shared PostgreSQL server (`vvp-postgres`) and stored a live `SB_DATABASE_URL` in Key Vault and in the Container App's secret configuration. The application code still references SQLite — `sqlx`'s `sqlite` feature, `SqlitePool`/`SqlitePoolOptions`, PRAGMA statements, SQLite-dialect SQL in all queries, and a `SB_DATA_DIR`-based URL construction in `config.rs`. Until the application is switched, sessions continue to be lost on every redeploy because `SB_DATA_DIR=/tmp` is ephemeral.

## User Outcome

**Who benefits and what job are they doing?**
Teachers and students. A teacher logs in, conducts a lesson, uploads an accompaniment — and after a routine deploy (a bug fix or a new feature), she expects to still be logged in and to find her library intact. Currently every deploy resets her session and she must log in again, which is disruptive enough that she avoids updates.

**What does success look like from the user's perspective?**
A teacher logs in. We deploy a new version of the server. She refreshes the page and is still logged in. Her accompaniment library still has all her files. She never notices a deploy happened.

**Why is this sprint the right next step for the product?**
Sprint 18 wired the infrastructure; nothing else can unblock durable persistence. Until this sprint is done every redeploy destroys every active session, making the product unreliable to use in real lessons.

---

## Current State

From codebase analysis (2026-04-25):

| File | SQLite coupling |
|------|----------------|
| `server/Cargo.toml` | `sqlx = { features = ["sqlite", ...] }` |
| `server/src/db.rs` | `SqlitePool`, `SqlitePoolOptions`, three PRAGMA statements |
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
| `infra/bicep/container-app.bicep` | NFS volume + `SB_DATA_DIR=/data` (never deployed; clean up) |

Sprint 18 ADR gate: `tls-rustls` must be added alongside `postgres` in this sprint to satisfy the mandatory Sprint 19 entry condition recorded in `knowledge/decisions/0002-shared-postgres-platform.md`.

---

## Proposed Solution

Eight phases, implemented in one implementation pass, committed before code review.

### Phase 1 — `server/Cargo.toml`: swap sqlx features

```toml
# Before:
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "macros", "migrate"] }

# After:
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "tls-rustls", "macros", "migrate"] }
```

`tls-rustls` satisfies the ADR gate: the TLS backend is now compiled in. Connection strings still use `sslmode=require`; `verify-full` can be enabled later by changing the connection string only.

### Phase 2 — `server/src/db.rs`: switch pool type, remove PRAGMAs

```rust
// File: server/src/db.rs
// Purpose: PostgreSQL connection pool setup + migrations.
// Role: Shared DB access; applied at startup and in the integration-test harness.
// Exports: init_pool
// Depends: sqlx (postgres + tls-rustls features)
// Invariants: max_connections=10; PostgreSQL enforces FK constraints by default.
//             Connection string must include sslmode=require or stronger.
// Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; remove PRAGMAs

use sqlx::{postgres::PgPoolOptions, PgPool};
use crate::error::Result;

pub async fn init_pool(db_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(db_url)
        .await?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| crate::error::AppError::Internal(format!("migrate: {e}").into()))?;

    Ok(pool)
}
```

No `after_connect` block: Postgres enforces FK constraints by default and needs no PRAGMAs. `max_connections` raised to 10 — Postgres handles concurrent writers natively.

### Phase 3 — `server/src/config.rs`: read `SB_DATABASE_URL`, remove `SB_DATA_DIR`

Remove `data_dir` field and all `SB_DATA_DIR` env-var reads. The database URL comes from the environment directly.

**Dev default** (no `SB_DATABASE_URL` set):
```rust
db_url: "postgres://postgres:postgres@localhost:5432/singing_bridge".to_string(),
```

**Runtime** (env var set, both dev and prod):
```rust
if let Ok(db_url) = std::env::var("SB_DATABASE_URL") {
    config.db_url = db_url;
}
```

Any other `Config` fields that previously defaulted off `data_dir` (e.g., `dev_mail_dir`) must switch to a `TMPDIR`-based default. Check at compile time — removing `data_dir` will break any field that references it, making the scope explicit.

### Phase 4 — `state.rs` + all `SqlitePool` imports: mechanical rename

Every file that imports or accepts `SqlitePool` gets updated:

```rust
// Remove:   use sqlx::SqlitePool;
// Add:      use sqlx::PgPool;
// Remove:   use sqlx::{Executor, SqlitePool};
// Add:      use sqlx::{Executor, PgPool};
// Inline:   sqlx::SqlitePool  →  sqlx::PgPool
```

Files: `state.rs`, `cleanup.rs`, `auth/mod.rs`, `auth/magic_link.rs`, `auth/password.rs`, `auth/rate_limit.rs`, `ws/session_log.rs`, `ws/session_history.rs`, `http/library.rs`.

`AppState.db` type changes from `SqlitePool` to `PgPool`.

### Phase 5 — Migration files: rewrite for Postgres dialect

All 6 files rewritten in-place. Type mapping table:

| SQLite | Postgres |
|--------|----------|
| `INTEGER PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
| `INTEGER NOT NULL REFERENCES t(id)` | `BIGINT NOT NULL REFERENCES t(id)` |
| `INTEGER REFERENCES t(id)` | `BIGINT REFERENCES t(id)` |
| `BLOB PRIMARY KEY` | `BYTEA PRIMARY KEY` |
| `BLOB NOT NULL` | `BYTEA NOT NULL` |
| `TEXT NOT NULL COLLATE NOCASE` | `CITEXT NOT NULL` |
| `TEXT NOT NULL COLLATE NOCASE` (email) | `CITEXT NOT NULL` |
| `REAL` | `DOUBLE PRECISION` |
| `INTEGER NOT NULL DEFAULT 0` | unchanged |
| `INTEGER DEFAULT 0` | unchanged |
| `AUTOINCREMENT` keyword | drop (BIGSERIAL is self-incrementing) |

`respect_repeats INTEGER NOT NULL DEFAULT 0 CHECK (respect_repeats IN (0, 1))` stays as integer — no Rust-side bind change needed and avoids a type mismatch risk.

`UNIQUE(teacher_id, email)` on `students` with `CITEXT` email: the CITEXT type makes this constraint case-insensitive automatically — correct behaviour matches the `COLLATE NOCASE` intent.

**File-by-file changes:**

`0001_initial.sql`:
- `teachers`: `id INTEGER PRIMARY KEY` → `BIGSERIAL PRIMARY KEY`; `email/slug TEXT ... COLLATE NOCASE` → `CITEXT NOT NULL`
- `magic_links`: `token_hash BLOB` → `BYTEA`; `teacher_id INTEGER` → `BIGINT`
- `sessions`: `cookie_hash BLOB` → `BYTEA`; `teacher_id INTEGER` → `BIGINT`
- `signup_attempts`: `id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`; `email TEXT ... COLLATE NOCASE` → `CITEXT NOT NULL`

`0002_session_log.sql`:
- `id BLOB PRIMARY KEY` → `BYTEA PRIMARY KEY`
- `teacher_id INTEGER` → `BIGINT`
- `student_email_hash BLOB NOT NULL` → `BYTEA NOT NULL`

`0003_recordings.sql`:
- `recordings.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `teacher_id INTEGER` → `BIGINT`; `student_email_hash BLOB` → `BYTEA`; `token_hash BLOB` → `BYTEA`
- `recording_gate_attempts.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`

`0004_password_auth.sql`:
- `ALTER TABLE teachers ADD COLUMN password_hash TEXT` — unchanged
- `login_attempts.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `teacher_id INTEGER` → `BIGINT`

`0005_session_history.sql`:
- `students.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`; `teacher_id INTEGER` → `BIGINT`; `email TEXT ... COLLATE NOCASE` → `CITEXT NOT NULL`
- `session_events.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`; `teacher_id, student_id, recording_id INTEGER` → `BIGINT`
- `recording_sessions.teacher_id INTEGER PRIMARY KEY` → `BIGINT PRIMARY KEY`

`0006_accompaniments.sql`:
- `accompaniments.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`; `teacher_id INTEGER` → `BIGINT`; `duration_s REAL` → `DOUBLE PRECISION`
- `accompaniment_variants.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`; `accompaniment_id INTEGER` → `BIGINT`; `duration_s REAL` → `DOUBLE PRECISION`

### Phase 6 — Query strings: `?` → `$N`, `INSERT OR IGNORE` → `ON CONFLICT`

Every `sqlx::query(...)` and `sqlx::query_as(...)` with `?` placeholders must be renumbered. The replacement is positional in `.bind()` call order.

**`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`** (one occurrence, `ws/session_history.rs`):
```rust
// Before:
"INSERT OR IGNORE INTO students (teacher_id, email, first_seen_at) VALUES (?, lower(?), ?)"
// After:
"INSERT INTO students (teacher_id, email, first_seen_at) VALUES ($1, lower($2), $3) ON CONFLICT DO NOTHING"
```

Files requiring `?` → `$N` substitution: `cleanup.rs`, `auth/mod.rs`, `auth/magic_link.rs`, `auth/password.rs`, `auth/rate_limit.rs`, `ws/session_log.rs`, `ws/session_history.rs`, `http/teach.rs`, `http/library.rs`, `http/recordings.rs`, `http/recording_gate.rs`, `http/login.rs`.

`RETURNING id` in `library.rs` is valid in both dialects — no change needed beyond `?` → `$N`.

### Phase 7 — Test harness: per-test Postgres databases

**`server/tests/common/mod.rs`**: Replace the in-memory SQLite pattern with per-test Postgres databases.

```rust
// New imports:
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

// Replace the sqlite:file:testmem{n}?... block:
let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
let db_name = format!("singing_bridge_test_{n}");

let admin_url = std::env::var("DATABASE_TEST_URL")
    .expect("DATABASE_TEST_URL must be set (e.g. postgres://postgres:pass@localhost:5432/postgres)");
let admin_opts = PgConnectOptions::from_str(&admin_url)
    .expect("parse DATABASE_TEST_URL");

// Create the test database
let admin = PgPoolOptions::new()
    .max_connections(1)
    .connect_with(admin_opts.clone())
    .await
    .expect("connect admin");
sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
    .execute(&admin)
    .await
    .expect("create test db");
admin.close().await;

// Connect to the new database (runs migrations)
let test_opts = admin_opts.database(&db_name);
config.db_url = test_opts.to_url_lossy().to_string();
let pool = init_pool(&config.db_url).await.unwrap();
```

**Cleanup** — add `db_name` and `admin_url` fields to `TestApp`. The existing `TestApp::cleanup()` or `Drop` impl calls:
```rust
pool.close().await;
let admin = PgPoolOptions::new()
    .max_connections(1)
    .connect_with(admin_opts)
    .await
    .unwrap();
sqlx::query(&format!("DROP DATABASE IF EXISTS \"{db_name}\""))
    .execute(&admin)
    .await
    .unwrap();
admin.close().await;
```

If `TestApp` currently has no cleanup method, add one. If tests don't call it today, add `app.cleanup().await` at the end of each integration test (or wrap tests to call it automatically via a `TestApp::run` method). Check actual `TestApp` definition — 23 test files exist and the cleanup path must not require editing each test body if `Drop` can handle it (note: `Drop` cannot be async; prefer an explicit cleanup call or `tokio::runtime::Handle::current().block_on(...)` in a sync `Drop`).

**`server/tests/db_pragmas.rs`**: Delete. Replace with `server/tests/db_pool.rs`:

```rust
// File: server/tests/db_pool.rs
// Purpose: Verify init_pool connects to Postgres and allows concurrent connections.
// Last updated: Sprint 19 (2026-04-25) -- replaces db_pragmas.rs (SQLite-specific)

mod common;
use common::spawn_app;

#[tokio::test]
async fn pool_concurrent_connections() {
    let app = spawn_app().await;
    // Two simultaneous acquires must both succeed within 100 ms
    use tokio::time::{timeout, Duration};
    let c1 = timeout(Duration::from_millis(100), app.state.db.acquire()).await
        .expect("first acquire timed out").expect("first acquire error");
    let c2 = timeout(Duration::from_millis(100), app.state.db.acquire()).await
        .expect("second acquire blocked").expect("second acquire error");
    drop(c1);
    drop(c2);
    app.cleanup().await;
}
```

**`server/src/cleanup.rs` inline tests**: the `#[cfg(test)]` module's `make_db()` helper uses `init_pool("sqlite::memory:")`. Replace with a `DATABASE_TEST_URL`-backed pool using the same create/drop pattern above. These tests are `#[tokio::test]` already.

### Phase 8 — `infra/bicep/container-app.bicep`: remove NFS, remove `SB_DATA_DIR`

The NFS volume and storage mount were written for Sprint 16 but the VNet-integrated environment rebuild never succeeded — the actual deployed environment is consumption-only with no NFS. Remove all NFS-related resources, parameters, and env vars. The file becomes significantly simpler.

**Remove:**
- `nfsStorageAccountName` param + `nfsStorageAccount` resource + `nfsFileShare` resource
- `caStorage` resource (NFS storage binding on the environment)
- `acaSubnetId` and `storageSubnetId` params
- `vnetConfiguration` block in `caEnv` (the real environment has no VNet integration)
- `volumes` array from `template`
- `volumeMounts` array from server container
- `{ name: 'SB_DATA_DIR', value: '/data' }` env var entry

**Update header invariants:**
- Remove the `min=max=1 replica (WAL file locks)` note — the SQLite constraint is gone
- Remove the `NFS share uses NoRootSquash` invariant
- Keep `minReplicas: 1, maxReplicas: 1` for now with a note that scale-out requires sticky session consideration

---

## Files Changing

| File | Change |
|------|--------|
| `server/Cargo.toml` | `sqlite` → `postgres` + `tls-rustls` |
| `server/src/db.rs` | `PgPool`, `PgPoolOptions`, no PRAGMAs, `max_connections(10)` |
| `server/src/config.rs` | `SB_DATABASE_URL` env var; remove `SB_DATA_DIR` / `data_dir` |
| `server/src/state.rs` | `SqlitePool` → `PgPool` |
| `server/src/cleanup.rs` | `SqlitePool` → `PgPool`; inline tests use `DATABASE_TEST_URL` |
| `server/src/auth/mod.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/auth/magic_link.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/auth/password.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/auth/rate_limit.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/ws/session_log.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/ws/session_history.rs` | `SqlitePool` → `PgPool`; `?` → `$N`; `INSERT OR IGNORE` → `ON CONFLICT` |
| `server/src/http/library.rs` | `SqlitePool` → `PgPool`; `?` → `$N` |
| `server/src/http/teach.rs` | `?` → `$N` |
| `server/src/http/recordings.rs` | `?` → `$N` |
| `server/src/http/recording_gate.rs` | `?` → `$N` |
| `server/src/http/login.rs` | `?` → `$N` |
| `server/migrations/0001_initial.sql` | `BIGSERIAL`, `BYTEA`, `CITEXT`; drop `AUTOINCREMENT` |
| `server/migrations/0002_session_log.sql` | `BYTEA`, `BIGINT` |
| `server/migrations/0003_recordings.sql` | `BIGSERIAL`, `BYTEA`, `BIGINT` |
| `server/migrations/0004_password_auth.sql` | `BIGSERIAL`, `BIGINT` |
| `server/migrations/0005_session_history.sql` | `BIGSERIAL`, `BIGINT`, `CITEXT` |
| `server/migrations/0006_accompaniments.sql` | `BIGSERIAL`, `BIGINT`, `DOUBLE PRECISION` |
| `server/tests/common/mod.rs` | `DATABASE_TEST_URL` pattern; create/drop per-test Postgres DB; add cleanup |
| `server/tests/db_pragmas.rs` | **Delete** |
| `server/tests/db_pool.rs` | **New**: concurrent connection test |
| `infra/bicep/container-app.bicep` | Remove NFS resources; remove `SB_DATA_DIR`; update header |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `$N` placeholder numbering error | Medium | `cargo build` fails on mismatched bind count at runtime on first bind; caught immediately |
| `BIGINT` vs `i64` mismatch in Rust fetch | Low | `BIGSERIAL` produces `BIGINT` → maps to `i64` in sqlx — matches all existing Rust types |
| `CITEXT` not installed | Low | Sprint 18 Phase 3 installs it; migration will fail fast with clear Postgres error if absent |
| `TestApp` has no async cleanup today | Medium | Read `TestApp` definition in `common/mod.rs` before implementing; if no cleanup method exists, add one and call it in every test file |
| Test Postgres unavailable in CI | Medium | `spawn_app` panics with a descriptive message; CI must set `DATABASE_TEST_URL` |
| `cleanup.rs` inline tests need DATABASE_TEST_URL | Low | Same pattern as integration tests; annotate with `#[ignore]` if CI doesn't always have Postgres, and document |
| NFS Bicep removal surprises on redeploy | Very low | NFS was never successfully deployed; removal cleans up dead code. Document in commit message |
| Production data migration | None | Production is on `/tmp` (ephemeral); no existing data to migrate. Fresh Postgres DB starts clean |

---

## Exit Criteria

- `cargo test` green with `DATABASE_TEST_URL` pointing to a live Postgres 16 instance
- `cargo build --release` succeeds; `grep -r SqlitePool server/src/` returns empty
- All 14 pre-existing integration tests plus `db_pool.rs` pass
- Session persistence confirmed: teacher logs in → `cargo test` app restarts → cookie still valid (covered by signup tests against Postgres)
- `infra/bicep/container-app.bicep` has no NFS resources, no `SB_DATA_DIR`
- Sprint 18 TLS posture maintained: connection string uses `sslmode=require`
