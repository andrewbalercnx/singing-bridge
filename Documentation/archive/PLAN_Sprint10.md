# PLAN: Sprint 10 — Password auth (replace magic link)

## Problem statement

The current teacher auth flow depends on email delivery at login time. Replacing the magic link with a conventional email + password flow removes the email-delivery dependency from the login hot path entirely. The magic-link infrastructure is retained as a password-reset escape hatch behind a `config.password_reset_enabled` flag defaulting to `false`.

---

## Current state (from codegraph)

| Layer | File(s) | Summary |
|-------|---------|---------|
| DB | `migrations/0001_initial.sql` | `teachers(id, email, slug, created_at)` — no password column |
| Auth helpers | `auth/mod.rs` | `issue_session_cookie`, `resolve_teacher_from_cookie` |
| Auth helpers | `auth/magic_link.rs` | `issue`, `consume`, `invalidate_pending` |
| Auth helpers | `auth/rate_limit.rs` | `check_and_record` against `signup_attempts` |
| HTTP | `http/signup.rs` | `POST /` signup → magic link; `POST /auth/consume` → session |
| HTTP | `http/teach.rs` | `GET /teach/<slug>` — cookie resolves teacher vs student view |
| Config | `config.rs` | `magic_link_ttl_secs`, `session_ttl_secs`, `signup_rate_limit_*` |
| Cargo | `Cargo.toml` | No `argon2` dep; `sha2`, `rand`, `subtle`, `cookie` present |

The session-cookie machinery already works. Only the credential-validation path changes.

---

## Deployment precondition

Migration 0004 adds `password_hash TEXT` as a nullable column. **This sprint assumes no production teachers exist.** All existing test-fixture rows are created during `spawn_app()` and wiped between tests.

**NULL-password-hash login behavior** (defensive, for any future partial-deploy scenario):
- `password_reset_enabled = false`: 401 "invalid credentials" (same body as any other failure — no account state disclosed)
- `password_reset_enabled = true`: 401 "no password set — use the magic link sent to your email"

Both branches perform the same Argon2 work (see constant-time design below).

---

## Proposed solution

### Migration 0004 — `server/migrations/0004_password_auth.sql`

```sql
ALTER TABLE teachers ADD COLUMN password_hash TEXT;

-- teacher_id is nullable so unknown-email attempts can still be recorded
-- for IP-based throttling.
CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id   INTEGER REFERENCES teachers(id),   -- NULL for unknown-email attempts
  peer_ip      TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  succeeded    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_login_attempts_teacher_t ON login_attempts(teacher_id, attempted_at);
CREATE INDEX idx_login_attempts_ip_t      ON login_attempts(peer_ip, attempted_at);
```

**Retention**: `login_attempts` rows older than 24 h are pruned by `cleanup.rs` (same pattern as `recording_gate_attempts` cleanup — a single `DELETE WHERE attempted_at < now - 86400` in the periodic pass).

**Magic-link token behavior when `password_reset_enabled` toggled off**: existing unconsumed tokens in `magic_links` are not purged. The `post_consume` route returns 403 immediately, so they are inert but harmless. Operators who disable the flag after tokens have been issued should run `UPDATE magic_links SET consumed_at = unixepoch() WHERE consumed_at IS NULL` to expire them explicitly — documented in the runbook.

### New crate: `argon2 = "0.5"`

Argon2id, OWASP params (m=19456, t=2, p=1). PHC string stored in `teachers.password_hash`.

### New module: `auth/password.rs`

```rust
/// Public sync helper used by tests to create cheap-params hashes.
/// Production callers must not use this directly — use hash_password() instead.
pub fn hash_password_with_params(raw: &str, params: argon2::Params) -> Result<String>

/// Async public API. Wraps hash_password_with_params in spawn_blocking with production params.
/// Callers cannot hash on the async runtime.
pub async fn hash_password(raw: &str) -> Result<String>

/// Constant-time verify. Returns false on any failure (not Err).
pub fn verify_password(raw: &str, phc: &str) -> bool

/// Runtime-derived dummy PHC using production Argon2 params.
/// Initialized once at startup (once_cell::Lazy<String>).
/// No hardcoded literal — always derived via hash_password_with_params.
pub(crate) static DUMMY_PHC: once_cell::sync::Lazy<String>;

/// Single transactional function covering both IP throttle and per-account lockout.
/// Records the attempt (teacher_id may be None for unknown-email) then evaluates limits.
pub async fn record_and_check_limits(
    pool: &SqlitePool,
    teacher_id: Option<TeacherId>,
    peer_ip: &str,
    cfg: &LimitConfig,
) -> Result<LimitResult>

pub struct LimitConfig {
    pub account_window_secs: i64,
    pub account_max_failures: u32,
    pub ip_window_secs: i64,
    pub ip_max_attempts: u32,
}

pub enum LimitResult { Allow, IpThrottled, AccountLocked }
```

**`hash_password_with_params` visibility**: `pub` — required so `server/tests/common/mod.rs` can call it with cheap params. This is the only safe way to expose test params without adding a runtime config flag.

**`DUMMY_PHC` contract**: `once_cell::sync::Lazy<String>` initialized at first use via `hash_password_with_params("", Params::DEFAULT)`. This is a single runtime-derived value; there is no compile-time literal. Tests that need a dummy PHC call `hash_password_with_params("", cheap_params)` themselves — they do not share the production `DUMMY_PHC`.

### Constant-time login design — fully equalized

The goal is identical observable behavior (Argon2 cost + DB write cost) for all login failure paths:

```
POST /auth/login:
  1. Look up teacher by email → Option<Teacher>.
  2. Select candidate_phc:
       Some(t) where t.password_hash IS NOT NULL → t.password_hash
       Some(t) where t.password_hash IS NULL     → &*DUMMY_PHC
       None                                       → &*DUMMY_PHC
  3. result = verify_password(supplied_password, candidate_phc)
  4. Call record_and_check_limits(pool, teacher_id_opt, peer_ip, cfg)
     — this INSERT happens regardless of whether the teacher exists.
       Unknown-email → teacher_id = NULL; attempt is still recorded for IP counting.
  5. If LimitResult::IpThrottled → 429 (same for known and unknown email)
  6. If LimitResult::AccountLocked → 429 (only fired if teacher_id was Some)
  7. If result == false OR teacher row absent OR password_hash IS NULL → 401 "invalid credentials"
       (NULL + password_reset_enabled: different message body only when explicitly configured)
  8. On success (result == true, row present, hash not NULL):
       INSERT succeeded=1 attempt; issue_session_cookie; 200 with redirect URL
```

Both the unknown-email and known-email-wrong-password branches now perform one Argon2 call (step 3) and one DB write (step 4). The DB cost is symmetric.

**`record_and_check_limits` transaction** (single `BEGIN IMMEDIATE` on the single-connection pool):
1. `INSERT INTO login_attempts (teacher_id, peer_ip, attempted_at, succeeded) VALUES (?, ?, ?, 0)` — always, unconditionally
2. IP check: `SELECT COUNT(*) FROM login_attempts WHERE peer_ip=? AND attempted_at > now-ip_window` → if ≥ ip_max → `IpThrottled`
3. Account check (only if teacher_id IS NOT NULL): `SELECT MAX(attempted_at) FROM login_attempts WHERE teacher_id=? AND succeeded=1` → last_success; `SELECT COUNT(*) FROM login_attempts WHERE teacher_id=? AND succeeded=0 AND attempted_at > max(last_success, now-account_window)` → if ≥ account_max → `AccountLocked`
4. Commit → return `Allow`, `IpThrottled`, or `AccountLocked`

### Password validation rules (server-side, `post_register`)

- Minimum length: 12 characters
- Maximum length: 128 characters
- Returns 400 `{ "code": "password_too_short" }` or `{ "code": "password_too_long" }`

### New HTTP handlers: `http/login.rs`

**`peer_ip` extraction**: `post_login` and `post_register` extract the peer IP using Axum's `ConnectInfo<SocketAddr>` extractor — the same pattern as `http/signup.rs` which already uses `ConnectInfo(addr): ConnectInfo<SocketAddr>` and passes `addr.ip().to_string()` to rate-limit helpers. No alternative derivation path (e.g. `X-Forwarded-For`) is used; the TCP peer address is authoritative on this deployment.

Routes:
- `GET  /auth/login`   → HTML login form
- `POST /auth/login`   → constant-time verify + limits + session cookie; `peer_ip` via `ConnectInfo<SocketAddr>`
- `POST /auth/logout`  → require valid session cookie (401 otherwise); DELETE session row; clear cookie with `Max-Age=0`

Register flow:
- `GET  /signup`       → HTML register form (email + slug + password + confirm)
- `POST /auth/register`→ validate password policy → `hash_password()` in spawn_blocking → INSERT teacher → `issue_session_cookie` → redirect; `peer_ip` via `ConnectInfo<SocketAddr>`

Magic-link gate: `GET /auth/verify` / `POST /auth/consume` return `403 Forbidden` when `!config.password_reset_enabled`.

### Session cookie policy

**`SameSite=Lax`** — kept as-is. `SameSite=Strict` would prevent the browser sending the session cookie on top-level GET navigation to `/teach/<slug>` from external links (email, calendar). `Lax` allows top-level GET navigation while blocking cross-site POSTs. `Secure` remains set in production.

### Config additions

```toml
password_reset_enabled = false
login_account_window_secs = 900
login_account_max_failures = 10
login_ip_window_secs = 300
login_ip_max_attempts = 20
```

No `argon2_test_params` in config. Tests call `hash_password_with_params(raw, cheap_params)` directly.

### Route table (full, after sprint)

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| GET | `/` | `get_root` | public |
| GET | `/signup` | `get_signup` | public |
| POST | `/auth/register` | `post_register` | public |
| GET | `/auth/login` | `get_login` | public |
| POST | `/auth/login` | `post_login` | public |
| POST | `/auth/logout` | `post_logout` | session required → 401 if absent/expired |
| GET | `/auth/verify` | `get_verify` | public (403 if `!password_reset_enabled`) |
| POST | `/auth/consume` | `post_consume` | public (403 if `!password_reset_enabled`) |
| GET | `/teach/<slug>` | `get_teach` | cookie resolves owner (unchanged) |

### ADR update

`knowledge/decisions/0001-mvp-architecture.md` updated to note magic-link superseded by password auth as of Sprint 10.

### UI

| Page | JS file | Notes |
|------|---------|-------|
| `/signup` | `web/assets/signup.js` (modified) | Adds password + confirm fields; endpoint → `POST /auth/register` |
| `/auth/login` | `web/assets/login.js` (new) | Email + password; shows lockout message on 429 |

---

## Alternatives considered

**Nullable vs separate IP-only table for unknown-email tracking**: nullable `teacher_id` in a single table is simpler and correctly indexes both IP and account dimensions. Adopted.

**`DUMMY_PHC` as compile-time literal**: rejected — a PHC literal would embed a specific Argon2 parameter set and could drift from production params. Runtime `Lazy` with `Params::DEFAULT` guarantees parity.

**`argon2_test_params` in runtime config**: rejected — creates a production downgrade path. Cheap params passed at call-site via `hash_password_with_params` instead.

---

## Test strategy

### Property / invariant coverage

- `hash_password_with_params(raw, cheap_params)` → PHC begins with `$argon2id$`
- `verify_password(raw, hash_password_with_params(raw, cheap_params))` → `true`
- `verify_password("wrong", phc)` → `false`
- `password_hash` column in DB never equals the raw password (direct SELECT after register)

### Failure-path coverage

- `POST /auth/login` unknown email → 401
- `POST /auth/login` correct email, wrong password → 401
- `POST /auth/login` correct email, `password_hash IS NULL`, `password_reset_enabled = false` → 401 "invalid credentials"
- `POST /auth/login` correct email, `password_hash IS NULL`, `password_reset_enabled = true` → 401 "no password set"
- `POST /auth/login` 10 consecutive failures on known account → 429 on the 11th (synthetic timestamps)
- `POST /auth/login` exactly at window boundary (`attempted_at = now - window_secs`) → does NOT count (boundary predicate is strict `>`, so the boundary second is excluded; attempt at `now - window_secs + 1` counts but `now - window_secs` does not)
- `POST /auth/login` correct password after lockout window expires → 200
- `POST /auth/login` 20+ attempts from same IP against nonexistent emails → 429 (IP throttle fires on unknown-email path)
- `POST /auth/logout` no cookie → 401
- `POST /auth/logout` expired cookie → 401
- `POST /auth/logout` second call with same (now-deleted) cookie → 401 (idempotent from caller perspective)
- `POST /auth/register` password exactly 11 chars → 400 `password_too_short`
- `POST /auth/register` password exactly 12 chars → 200 (boundary success)
- `POST /auth/register` password exactly 128 chars → 200 (boundary success)
- `POST /auth/register` password exactly 129 chars → 400 `password_too_long`
- `POST /auth/register` duplicate email → 409
- `POST /auth/register` duplicate slug → 409 with suggestions
- `GET /auth/verify` when `password_reset_enabled = false` → 403
- `POST /auth/consume` when `password_reset_enabled = false` → 403

### Regression guards (one per prior-round finding)

- `resolve_teacher_from_cookie` resolves correctly after migration (schema unchanged for `sessions`)
- `GET /teach/<slug>` returns teacher view with valid cookie; student view without
- Magic-link `consume` works when `password_reset_enabled = true` (used directly in tests)
- `signup_attempts` rate-limit fires on excessive `POST /auth/register`

### Fixture reuse plan

`common::register_teacher(email, slug, password) -> String` calls `auth::password::hash_password_with_params(password, CHEAP_PARAMS)` directly (bypassing the async path) and `INSERT`s the resulting hash directly into the DB, then calls `issue_session_cookie`. `CHEAP_PARAMS` is a module-level constant in the test fixture (`Params::new(8, 1, 1, None).unwrap()`). This keeps all Argon2 in tests at O(1 ms) with no runtime config flag.

**NULL-hash teacher rows** (for `password_hash IS NULL` tests): created via a dedicated helper `common::insert_teacher_no_password(email, slug) -> i64` that runs `INSERT INTO teachers (email, slug, created_at) VALUES (?, ?, unixepoch())` directly against the pool, returning the teacher `id`. No `register_teacher` call is needed; the row has no password hash by construction.

All existing tests calling `signup_teacher(email, slug)` are updated to call `register_teacher(email, slug, "test-passphrase-12")`. The old `signup_teacher` is removed; compilation forces exhaustive update.

### Test runtime budget + flaky policy

Cheap Argon2 params (`m=8, t=1, p=1`): < 1 ms per hash.

Argon2 cost per test path:
- `register_teacher` fixture: cheap params → < 1 ms
- `POST /auth/login` success/failure tests (correct or wrong password against a registered teacher): one cheap-params verify call via `verify_password` against the cheap PHC stored by `register_teacher` → < 1 ms
- `POST /auth/login` unknown-email and NULL-hash tests: one `DUMMY_PHC` verify call (production params, ~50–100 ms) per request. These tests issue 1–2 HTTP requests each; total cost ≈ 200–400 ms.
- IP throttle and account lockout boundary tests: **direct SQL INSERT** into `login_attempts` to seed attempt history; no HTTP requests issued for seeding. The test then issues a single HTTP request to observe the 429. Total Argon2 cost for the boundary assertion: one production-params verify. ≈ 100 ms per test.

All new auth tests combined: < 10 s total (dominated by the handful of single unknown-email requests that hit `DUMMY_PHC`). No real-time sleeps; synthetic `attempted_at` values used for window boundary tests.
