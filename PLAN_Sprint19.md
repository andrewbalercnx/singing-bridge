# PLAN_Sprint19.md — PostgreSQL migration

## Problem Statement

Sessions (and all data) are lost on every redeploy because `SB_DATA_DIR=/tmp` — SQLite on Azure Files SMB is fundamentally broken, even in DELETE journal mode. The SMB protocol does not support POSIX byte-range advisory locks, which SQLite requires for any journal mode. NFS Azure Files would fix the lock issue but requires creating a new Container Apps environment, which is a bigger infra change than the database migration itself.

The correct fix is to migrate from SQLite to PostgreSQL, which:
- Provides proper concurrent-safe persistence across deploys
- Runs as a managed service (no storage mount concerns)
- Requires no changes to the Container Apps environment

## User Outcome

**Who benefits and what job are they doing?**
Teachers who set up their room (signup, choose a slug, upload accompaniment assets) expect those choices to survive across sessions and application deployments. Currently every deploy forces every teacher to re-signup, and all uploaded recordings and library assets are lost.

**What does success look like from the user's perspective?**
A teacher logs in on Monday, uploads a PDF accompaniment, and teaches a lesson. On Tuesday — after a deploy has happened — they navigate to `/teach/<slug>` and are still logged in. Their library still contains the PDF. No re-signup required.

**Why is this sprint the right next step for the product?**
The ephemeral-session bug makes the teacher-facing dashboard (Sprint 17) unusable in production: every deploy logs the teacher out and loses their library. PostgreSQL is the prerequisite for any meaningful production use of the product.

---

## Current State

From codegraph + code audit (2026-04-24):

| File | Relevant state |
|------|---------------|
| `server/src/db.rs` | `SqlitePool`, `SqlitePoolOptions`, DELETE journal mode; `init_pool(db_url: &str)` |
| `server/src/state.rs` | `AppState.db: SqlitePool` |
| `server/Cargo.toml` | `sqlx = { features = ["sqlite", "migrate", ...] }` |
| `server/migrations/*.sql` (×6) | SQLite types: `INTEGER PRIMARY KEY`, `BLOB`, `TEXT COLLATE NOCASE`, `AUTOINCREMENT`, `INSERT OR IGNORE` |
| `server/src/**/*.rs` | 10 files with `use sqlx::SqlitePool`; `?` bind placeholders throughout |
| `server/tests/common/mod.rs` | `sqlite::memory:` for test DB; named shared-cache URI for multi-connection isolation |
| `infra/bicep/container-app.bicep` | No postgres connection string; `SB_DATA_DIR=/tmp` active workaround |
| Azure | No postgres in `sb-prod-rg`. `vvp-postgres` exists in VVP resource group (different project, private access disabled) — **not reusable** |

### SQLite → Postgres translation table

| SQLite construct | Postgres equivalent |
|-----------------|---------------------|
| `INTEGER PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` (autoincrement) or `BIGINT PRIMARY KEY` (manual) |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
| `BLOB` | `BYTEA` |
| `INTEGER` (timestamps, integers) | `BIGINT` |
| `REAL` | `DOUBLE PRECISION` |
| `TEXT COLLATE NOCASE` | `CITEXT` (with `CREATE EXTENSION IF NOT EXISTS citext`) |
| `INSERT OR IGNORE INTO` | `INSERT INTO ... ON CONFLICT DO NOTHING` |
| `?` bind placeholder | `$1`, `$2`, `$3`, ... |
| `sqlite::memory:` (tests) | `postgres://.../<test_db>` (per-test isolated DB) |

---

## Proposed Solution

### Infrastructure

Provision a new **Azure Database for PostgreSQL Flexible Server** (Burstable B1ms, PG16) in `sb-prod-rg` with public-access enabled and Cloudflare IP firewall rules (same allow-list as the Container App ingress). Connection string stored as a Container App secret `sb-db-url`. `SB_DATA_DIR` env var is removed entirely.

A new `SB_DATABASE_URL` env var replaces the derived `db_url` in `config.rs`.

### Application

1. **`Cargo.toml`** — swap `sqlite` feature for `postgres` in sqlx; add `time` feature to match existing time crate usage.
2. **`server/src/db.rs`** — replace `SqlitePoolOptions` / `SqlitePool` with `PgPoolOptions` / `PgPool`; remove WAL/journal pragmas; keep `busy_timeout` equivalent via `connect_timeout`.
3. **`server/src/state.rs`** and all 10 `SqlitePool` callsites — replace type annotation `SqlitePool` → `PgPool`.
4. **`server/src/config.rs`** — add `database_url: String` field; read from `SB_DATABASE_URL`; remove `data_dir`-derived sqlite path; remove `SB_DATA_DIR` from prod validation.
5. **`server/migrations/`** — rewrite all 6 files for Postgres syntax (see translation table). Keep same migration numbers. Drop old SQLite files, add Postgres versions. sqlx migrate works with Postgres identically to SQLite.
6. **Bind placeholders** — `?` → `$N` throughout all query strings in `server/src/`. Mechanical but must be done accurately per query.
7. **`INSERT OR IGNORE`** — one instance in `session_history.rs` → `INSERT ... ON CONFLICT DO NOTHING`.
8. **`server/tests/common/mod.rs`** — replace `sqlite::memory:` with a per-test Postgres database created via `CREATE DATABASE` with a unique name, dropped in `TestApp::shutdown`. Requires `DATABASE_TEST_URL` env var pointing at a local/CI postgres superuser connection.

### No data migration

Production data is currently ephemeral (`/tmp`). There is nothing to migrate. The first deploy with Postgres simply starts with an empty database and runs migrations from scratch.

---

## File-by-file design

### `server/Cargo.toml`

```toml
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "macros", "migrate", "time"] }
```

Remove: `sqlite`.

### `server/src/db.rs`

```rust
use sqlx::{postgres::PgPoolOptions, PgPool};

pub async fn init_pool(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await
        .map_err(|e| AppError::Internal(format!("migrate: {e}").into()))?;
    Ok(pool)
}
```

### `server/src/config.rs`

New field: `pub database_url: String`.

In `parse_env()`:
```rust
let database_url = std::env::var("SB_DATABASE_URL")
    .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/singing_bridge_dev".into());
```

In `dev_default()`:
```rust
database_url: "postgres://postgres:postgres@localhost/singing_bridge_dev".into(),
```

Remove: `db_url`, `data_dir`, `dev_blob_dir` (blob store is Azure-only; dev uses `DevBlobStore` with `TempDir` — no data_dir needed for DB).

Actually keep `data_dir` for the dev blob store. Only remove the `db_url` derivation.

Prod validation: require `SB_DATABASE_URL` is set and starts with `postgres://` or `postgresql://`. Remove `SB_DATA_DIR` from prod checks.

### `server/migrations/` — Postgres rewrites

All 6 files rewritten. Key changes per file:

**0001_initial.sql**
```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE teachers (
  id         BIGSERIAL PRIMARY KEY,
  email      CITEXT    NOT NULL UNIQUE,
  slug       CITEXT    NOT NULL UNIQUE,
  created_at BIGINT    NOT NULL
);
CREATE TABLE magic_links (
  token_hash  BYTEA  PRIMARY KEY,
  teacher_id  BIGINT NOT NULL REFERENCES teachers(id),
  issued_at   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE TABLE sessions (
  cookie_hash BYTEA  PRIMARY KEY,
  teacher_id  BIGINT NOT NULL REFERENCES teachers(id),
  issued_at   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);
CREATE TABLE signup_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        CITEXT NOT NULL,
  peer_ip      TEXT   NOT NULL,
  attempted_at BIGINT NOT NULL
);
-- indexes unchanged
```

**0002_session_log.sql**
- `BLOB` → `BYTEA`, `INTEGER` → `BIGINT`
- `id BLOB PRIMARY KEY` → `id BYTEA PRIMARY KEY` (UUID stored as raw bytes)

**0003_recordings.sql**
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `BLOB` → `BYTEA`, `INTEGER` → `BIGINT`, `REAL` → `DOUBLE PRECISION`

**0004_password_auth.sql**
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `INTEGER` → `BIGINT` for timestamps; `INTEGER NOT NULL DEFAULT 0` booleans → `BOOLEAN NOT NULL DEFAULT FALSE`

**0005_session_history.sql**
- Same pattern: AUTOINCREMENT → BIGSERIAL, INTEGER → BIGINT, COLLATE NOCASE removed (use CITEXT for email column)

**0006_accompaniments.sql**
- Same pattern: AUTOINCREMENT → BIGSERIAL, REAL → DOUBLE PRECISION, INTEGER → BIGINT

### `server/src/**/*.rs` — bind placeholder change

All `sqlx::query("... WHERE foo = ?")` → `sqlx::query("... WHERE foo = $1")`.
Multi-bind: `... VALUES (?, ?, ?)` → `... VALUES ($1, $2, $3)`.

Files affected (10): `auth/mod.rs`, `auth/magic_link.rs`, `auth/password.rs`, `auth/rate_limit.rs`, `cleanup.rs`, `http/library.rs`, `ws/session_history.rs`, `ws/session_log.rs`, `ws/accompaniment.rs`, `ws/recording_gate.rs` (and any others that surface during compilation).

All `use sqlx::SqlitePool` → `use sqlx::PgPool`.

### `session_history.rs` — INSERT OR IGNORE

```sql
-- Before
INSERT OR IGNORE INTO students (teacher_id, email, first_seen_at) VALUES (?, lower(?), ?)
-- After
INSERT INTO students (teacher_id, email, first_seen_at) VALUES ($1, lower($2), $3)
ON CONFLICT DO NOTHING
```

### `server/tests/common/mod.rs` — test DB isolation

Replace `sqlite::memory:` with per-test Postgres DB:

```rust
static DB_COUNTER: AtomicU64 = AtomicU64::new(0);

async fn make_test_db() -> (String, String) {
    let base = std::env::var("DATABASE_TEST_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost".into());
    let n = DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let db_name = format!("sb_test_{}", n);
    // Connect to postgres (maintenance DB) and create the test DB
    let admin = sqlx::PgPool::connect(&format!("{}/postgres", base)).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {db_name}")).execute(&admin).await.unwrap();
    let url = format!("{}/{}", base, db_name);
    (url, format!("{}/postgres", base))  // (test url, admin url for cleanup)
}
```

`TestApp::shutdown()` drops the test DB via the admin connection.

### `infra/bicep/container-app.bicep`

- Add new `param sbDatabaseUrl string` (secureString)
- Add to secrets: `{ name: 'sb-db-url', value: sbDatabaseUrl }`
- Add to env vars: `{ name: 'SB_DATABASE_URL', secretRef: 'sb-db-url' }`
- Remove `SB_DATA_DIR` env var entry
- Add new `infra/bicep/postgres.bicep` for Flexible Server provisioning

### `infra/bicep/postgres.bicep` (new)

```bicep
param location string = resourceGroup().location
param serverName string = 'sb-postgres'
param adminUser string = 'sbadmin'
@secure()
param adminPassword string
param dbName string = 'singing_bridge'

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: serverName
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: adminUser
    administratorLoginPassword: adminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

// Firewall: Cloudflare IPv4 ranges (same set as Container App ingress)
// Azure "allow Azure services" rule covers Container Apps egress
resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  name: 'AllowAzureServices'
  parent: pgServer
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  name: dbName
  parent: pgServer
}

output connectionString string = 'postgres://${adminUser}:${adminPassword}@${pgServer.properties.fullyQualifiedDomainName}/${dbName}?sslmode=require'
```

---

## Test Strategy

### Property / invariant coverage

- `PgPool` connects and migrations run cleanly (test harness startup proves this)
- All existing integration tests pass unchanged (same behaviour, different backend)
- CITEXT enforces case-insensitive email/slug uniqueness: insert `FOO@BAR.COM` then insert `foo@bar.com` → unique violation
- `BYTEA` round-trip: `cookie_hash`, `token_hash`, `student_email_hash` values survive insert/select unchanged

### Failure-path coverage

- Missing `SB_DATABASE_URL` in prod config → `ConfigError::Missing` (existing prod validation pattern)
- Bad connection string → pool connect error surfaced at startup, not silently ignored
- Migration failure → `AppError::Internal` with message, process exits

### Regression guards

- All 14 existing Rust HTTP integration tests (http_dashboard.rs etc.) must pass with Postgres backend
- All existing auth, rate-limit, cleanup tests must pass
- No `SqlitePool` symbol remaining in non-test source (CI: `grep -r SqlitePool server/src` fails if any found)

### Fixture reuse plan

`spawn_app()` in `tests/common/mod.rs` creates a fresh Postgres DB per test (unique name via counter). `TestApp::shutdown()` drops it. No shared state between tests. The `DATABASE_TEST_URL` env var points at a local postgres or CI service container.

Local dev: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16` or existing local postgres.

CI: Add a `services: postgres:16` block to the GitHub Actions workflow (or equivalent).

### Test runtime budget

`cargo test` with Postgres: expected ≤ 60s (Postgres startup + per-test DDL is slower than in-memory SQLite; 14 integration tests × ~2s each = 28s, unit tests add ~5s). Flaky policy: any test that fails intermittently due to DB contention is a bug — the per-test DB isolation removes all shared state.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Bind placeholder count mismatch (`$N` off-by-one) | Medium | Compile error from sqlx if wrong; caught before deploy |
| CITEXT extension not available | Low | `CREATE EXTENSION IF NOT EXISTS citext` in migration; available on all Azure PG16 |
| Azure PG Flexible Server public access blocked by policy | Low | Check with `az policy` before provisioning; AllowAzureServices firewall rule covers ACA egress |
| Test harness needs local postgres | Medium | Docker one-liner in README; CI service container |
| `succeeded INTEGER NOT NULL DEFAULT 0` boolean columns | Low | Postgres accepts `BOOLEAN`; Rust code uses `i64` or `bool` bind — audit during placeholder pass |

---

## Files changing

| File | Change |
|------|--------|
| `server/Cargo.toml` | `sqlite` → `postgres` in sqlx features |
| `server/src/db.rs` | `SqlitePool` → `PgPool`, remove pragmas |
| `server/src/state.rs` | `SqlitePool` → `PgPool` |
| `server/src/config.rs` | add `database_url`; remove `db_url`; prod validation |
| `server/src/auth/mod.rs` | `SqlitePool` → `PgPool`, `?` → `$N` |
| `server/src/auth/magic_link.rs` | same |
| `server/src/auth/password.rs` | same |
| `server/src/auth/rate_limit.rs` | same |
| `server/src/cleanup.rs` | same |
| `server/src/http/library.rs` | same |
| `server/src/ws/session_history.rs` | same + `INSERT OR IGNORE` fix |
| `server/src/ws/session_log.rs` | same |
| `server/src/ws/accompaniment.rs` | same (if any queries) |
| `server/migrations/0001_initial.sql` | Postgres rewrite |
| `server/migrations/0002_session_log.sql` | Postgres rewrite |
| `server/migrations/0003_recordings.sql` | Postgres rewrite |
| `server/migrations/0004_password_auth.sql` | Postgres rewrite |
| `server/migrations/0005_session_history.sql` | Postgres rewrite |
| `server/migrations/0006_accompaniments.sql` | Postgres rewrite |
| `server/tests/common/mod.rs` | per-test Postgres DB instead of in-memory SQLite |
| `infra/bicep/postgres.bicep` | new: Flexible Server + firewall + database |
| `infra/bicep/container-app.bicep` | add `SB_DATABASE_URL` secret + env var; remove `SB_DATA_DIR` |

**Not changing:** all HTTP handlers, WS handlers, auth logic, blob store, sidecar client, session-panels.js, teacher.js — zero behaviour change, pure storage backend swap.
