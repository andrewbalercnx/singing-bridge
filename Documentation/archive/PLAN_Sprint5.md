# PLAN — Sprint 5: Azure + Cloudflare deployment + TURN + session log

**Sprint:** 5
**Title:** Azure + Cloudflare deployment + TURN + session log
**Status:** DRAFT (R2)
**Last updated:** 2026-04-18

## 1. Problem statement + spec refs

From `SPRINTS.md` §Sprint 5 (lines 121–143):

> **Goal:** Ship to production at `singing.rcnx.io`, on Azure behind
> Cloudflare, with TURN for NAT traversal and a minimal session log.

**Deliverables (verbatim):**
- IaC (Bicep preferred, Terraform acceptable) for:
  - Rust signalling server on Azure Container Apps
  - SQLite on attached persistent volume (defer Azure SQL)
  - coturn on Azure VM with static public IP
  - Cloudflare DNS, TLS edge, static-asset CDN in front of the server
- Magic-link email delivery via Cloudflare
- `singing.rcnx.io` DNS + TLS via Cloudflare, pointing at the Container App
- Session log: start time, duration, peak packet loss, browser / device
  class. No PII beyond hashed email + session id
- Abuse mitigation: per-room lobby cap (default 10 waiting), per-IP
  join rate limit, teacher-initiated block of a lobby entry
- Deployment runbook in `knowledge/runbook/`

**Exit criteria (verbatim):**
- Teacher on home broadband + student on a different ISP complete a
  10-minute A/V session via the production URL
- TURN relay is used when direct P2P fails; verified via a forced
  TURN-only test
- Rate limit and lobby cap enforced under synthetic load
- Session log entries reconcile with observed sessions; no raw PII on
  disk

### Spec references

- `SPRINTS.md` §Sprint 5 — authoritative deliverables.
- `knowledge/decisions/0001-mvp-architecture.md` §Infrastructure —
  browser-only clients, Container Apps, SQLite on attached volume,
  coturn on VM with static public IP (TURN cannot traverse CF), CF for
  DNS/TLS/CDN/email, domain `singing.rcnx.io`.
- `knowledge/decisions/0001-mvp-architecture.md` §What we will monitor
  — "proportion of sessions hitting the 96 kbps floor" names the
  session-log measurement the runbook-level dashboard must surface.
- `knowledge/architecture/signalling.md` — WS protocol, payload
  opacity, single-writer pump, `tokio::sync::RwLock` room state,
  atomic room cap. Sprint 5 adds no new `Signal` shape; two new
  `ClientMsg` variants (§4.3) and two new `ServerMsg` variants.

## 2. Current state (from codegraph + read-through)

### 2.1 Server — what exists at HEAD

- `server/src/config.rs`: `Config` hard-coded via `dev_default()`.
  `lobby_cap_per_room = 32` — SPRINTS spec is `10`; needs lowering and
  env-var binding. No `turn_shared_secret`, no `smtp_*`, no
  `trusted_proxy_header`, no `data_dir`.
- `server/src/main.rs`: `Config::dev_default()` is hard-coded.
  Switching to prod requires reading env. In-memory SQLite
  (`sqlite::memory:`) — production needs `sqlite://<path>?mode=rwc`.
- `server/src/auth/mailer.rs`: `Mailer` trait exists; only `DevMailer`
  implementation (file sink). A production `SmtpMailer` is missing —
  header note: "Real SMTP lives in Sprint 5". This sprint fulfils
  that.
- `server/src/http/mod.rs`: no `/turn-credentials` route; no
  `/healthz`.
- `server/src/ws/protocol.rs`: `ClientMsg` has no metrics/block
  variants. `ErrorCode` lacks `Blocked`, `RateLimited`.
- `server/src/ws/mod.rs`: `ws_upgrade` reads `ConnectInfo<SocketAddr>`
  but discards it (`_addr`). Per-IP limiting + peer-IP session-log
  capture need this value threaded through. No `X-Forwarded-For`
  handling — Cloudflare + Container Apps sit in front.
- `server/src/ws/lobby.rs`: `reject` is terminal (closes with 1000
  `teacher_rejected`). No "block" that prevents re-join for a TTL.
- `server/src/state.rs`: `RoomState` has no block list; no
  session-log row handle. `ActiveSession { student, started_at }` —
  peak loss/RTT are not tracked anywhere on the server.
- `server/migrations/0001_initial.sql` — teachers, magic_links,
  sessions, signup_attempts. No `session_log` table. No migration
  `0002_*`.
- `server/tests/common/mod.rs` has a `TestOpts.dev` field
  (Sprint 3). Prod-mode harness is already supported at the test
  level. No harness for "spawn with a stub SMTP mailer" yet.

### 2.2 Client — what exists at HEAD

- `web/assets/signalling.js::makePeerConnection` hard-codes
  `{ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }` with a
  comment tagging it as a Sprint-5-to-replace placeholder. The sprint
  replaces this with a call to `GET /turn-credentials`.
- `web/assets/session-core.js` runs the 2 s adapt/quality tick — the
  natural hook to emit periodic `session_metrics` up the WS. No code
  currently sends any metrics message.
- `web/student.html` / `web/teacher.html` — no "you were blocked"
  surface. Need a parallel to `#floor-violation` for blocked students.

### 2.3 Cross-cutting gaps

- No `Dockerfile`, no `infra/`, no `.dockerignore`. No CI workflow
  for image build/push (only `node --test` + `cargo test`).
- `Documentation/DEPLOYMENT.md` — absent. `knowledge/runbook/netem.md`
  exists; no `deploy.md` / `rollback.md` / `incident.md`.

## 3. Proposed solution (with alternatives)

### 3.1 Top-level shape

```
infra/                              [NEW]
  bicep/
    main.bicep                      // Azure: RG outputs, module composition
    container-app.bicep             // Container Apps environment + app + Azure Files volume
    coturn-vm.bicep                 // Linux VM + static public IP + NSG + cloud-init
    acr.bicep                       // Azure Container Registry (private, admin disabled)
    log-analytics.bicep             // Workspace for Container App + VM diagnostics
    params/
      prod.bicepparam               // shape only — real values from env at deploy time
  cloudflare/
    README.md                       // manual steps (DNS, proxy, worker email routing)
    workers/
      magic-link-relay.js           // email delivery via Cloudflare Email Workers (MailChannels)
Dockerfile                          [NEW — multi-stage: rust:1.82 -> distroless cc]
.dockerignore                       [NEW]
server/src/auth/mailer.rs           [EDIT — add SmtpMailer (feature-gated via config)]
server/src/auth/rate_limit.rs       [EDIT — add per-ip WS join limiter]
server/src/config.rs                [EDIT — env-driven Config::from_env(); prod lobby cap = 10]
server/src/main.rs                  [EDIT — env-gated mailer/DB path; --health]
server/src/http/mod.rs              [EDIT — +/turn-credentials, +/healthz]
server/src/http/turn.rs             [NEW]
server/src/http/health.rs           [NEW]
server/src/ws/mod.rs                [EDIT — thread peer IP; session_log hooks]
server/src/ws/lobby.rs              [EDIT — block-on-reject, session_log open]
server/src/ws/protocol.rs           [EDIT — SessionMetrics ClientMsg; Blocked ErrorCode]
server/src/ws/session_log.rs        [NEW — open/update/close row, no-PII invariant]
server/src/state.rs                 [EDIT — RoomState.blocked_ips, ActiveSession.log_id + peaks]
server/migrations/0002_session_log.sql  [NEW]
web/assets/ice.js                   [NEW — pure fetchIceServers() + cache + expiry]
web/assets/signalling.js            [EDIT — awaits fetchIceServers() before RTCPeerConnection]
web/assets/session-core.js          [EDIT — emits sessionMetrics via injected sink every 10 s]
web/{student,teacher}.html          [EDIT — #blocked-notice element]
knowledge/runbook/
  deploy.md                         [NEW]
  rollback.md                       [NEW]
  incident-turn-down.md             [NEW]
knowledge/architecture/signalling.md [EDIT — session_log paragraph; ICE config flow]
.github/workflows/deploy.yml        [NEW — build image, push to ACR, `az containerapp update`]
```

### 3.2 Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Terraform instead of Bicep** | SPRINTS lists Bicep as preferred and it has first-class Azure provider fidelity (e.g. cleaner Container App + Azure Files binding). We still lean on `az` CLI for one-shot imperatives. Terraform is noted as acceptable in SPRINTS, not required. |
| **Azure App Service instead of Container Apps** | Container Apps gives us the sidecarless single-container deployment the ADR names. App Service would add platform abstraction we don't need and make custom TLS edge (via Cloudflare) fiddlier. |
| **Managed disk on a VM for SQLite (no Container Apps)** | SQLite on Azure Files has well-known fsync/locking quirks in WAL mode. A VM + managed disk avoids them but costs us the Container App ergonomics (image rollouts, revisions, env bindings). We keep Container Apps and pin to **a single replica** (min=max=1), pair it with Azure Files `nobrl` + `cache=none` mount, and document the single-instance constraint (§6 R2). Azure SQL is explicitly deferred by the ADR. |
| **STUN-only, no TURN** | Exit criterion 2 requires forced TURN-only to work. Direct P2P fails for symmetric NAT — not uncommon on mobile hotspots. |
| **Twilio Network Traversal / Xirsys hosted TURN** | Adds a third-party dependency + per-minute cost. ADR already commits to coturn on Azure. |
| **Email via Resend/SendGrid/SES** | ADR specifies "magic-link email delivery via Cloudflare, matching prior rcnx.io projects". We honour that pattern: **Cloudflare Email Workers + MailChannels** (the prior-project recipe: the Worker signs a request to MailChannels over Workers-hosted DKIM). Server calls the Worker via an authenticated POST; Worker delivers the mail. This keeps all MX / DKIM / SPF concerns inside CF. |
| **Authenticated smtp-submission from the Container App** | Outbound port 25/465/587 from Azure Container Apps is blocked by default. Going via a CF Worker sidesteps the outbound-mail hostile ACL entirely. |
| **Re-use `signup_attempts` table for WS rate limit** | That table is per-email-per-IP for the HTTP signup flow. WS lobby-join rate limit is per-IP, high-frequency, and shouldn't hit SQLite every socket open. In-memory sliding window (DashMap keyed by peer-IP with a single-tick sweep) is the right fit. |
| **Add a "block" column to `teachers` / a new `student_blocks` table** | Students are stateless (ADR §Identity). Blocks should be too: keyed on peer-IP, per-room, in-memory, TTL-bounded. A blocked student reconnecting from a new IP / phone can rejoin — which is the acceptable failure mode for a "soft kick", not a durable ban. |
| **Send peak loss/RTT in the final `hangup` message** | The student browser may crash / close the tab before a graceful hangup — we'd lose the peak. Periodic `session_metrics` (every 10 s) means the worst-case loss of data is 10 s. |
| **Server inspects media stats** | Server does not see media (ADR). Client-reported metrics are the only option. Capped + rate-limited to mitigate lying clients. |
| **OAuth2 / short-lived JWT for the Mailer Worker** | Overkill. A 32-byte shared secret in an env var, checked by constant-time compare in the Worker, matches prior-project pattern and is sufficient for a one-trust-boundary egress. Rotated by redeploy. |

### 3.3 Sequencing

1. **Server-side prerequisites (no infra):** `Config::from_env`,
   `SmtpMailer`, `/turn-credentials`, `/healthz`, migration 0002,
   `session_log.rs`, per-IP WS limiter, block-on-reject,
   `SessionMetrics` ClientMsg, lobby cap default 10. These land
   behind a feature-flag-free env switch (`SB_ENV={dev,prod}`) so
   `cargo test` continues to exercise the dev path.
2. **Client-side:** `ice.js`, signalling rewire, `#blocked-notice`,
   metrics sink.
3. **Dockerfile + CI image build** (Docker build runs in CI before
   infra touches anything).
4. **Infra (Bicep):** ACR → Container App + Azure Files → coturn VM
   → Cloudflare config (manual, documented). First deploy pushes the
   image; runbook captures the sequence.
5. **Runbooks** last, documenting the above.

## 4. Component-by-component design

### 4.1 Config (`server/src/config.rs`)

#### 4.1.1 Shape

Add `Config::from_env() -> Result<Config, ConfigError>` decomposed as:

```rust
impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let c = Self::parse_env()?;       // parse all values, no cross-field checks
        validate_prod_config(&c)?;        // prod-only invariants (called only when SB_ENV=prod)
        Ok(c)
    }
    fn parse_env() -> Result<Self, ConfigError> { ... }
}

fn validate_prod_config(c: &Config) -> Result<(), ConfigError> {
    // Checks that belong only in prod (HTTPS required, secrets present, etc.)
}
```

New fields:

```rust
pub struct Config {
    // existing fields...
    pub data_dir: std::path::PathBuf,              // NEW
    pub turn_host: Option<String>,                 // NEW — e.g. "turn.singing.rcnx.io"
    pub turn_shared_secret: Option<SecretString>,  // NEW — coturn HMAC secret
    pub turn_ttl_secs: i64,                        // NEW — default 600 (i64 for consistency with other duration fields)
    pub mailer_kind: MailerKind,                   // NEW — Dev | CloudflareWorker
    pub cf_worker_url: Option<String>,             // NEW
    pub cf_worker_secret: Option<SecretString>,    // NEW — Bearer token for Worker auth
    pub trust_forwarded_for: bool,                 // NEW — off in dev, on in prod
    pub ws_join_rate_limit_per_ip: usize,          // NEW — default 20 / window (follows _rate_limit_ convention)
    pub ws_join_rate_limit_window_secs: i64,       // NEW — default 60
    pub lobby_block_default_ttl_secs: i64,         // NEW — default 600
    pub session_log_pepper: Option<SecretString>,  // NEW — 32-byte pepper for email hashing
}

pub enum MailerKind { Dev, CloudflareWorker }
```

`lobby_cap_per_room` default lowers `32 -> 10` (SPRINTS spec). Dev
`dev_default()` keeps 10 for consistency. `max_active_rooms` stays at
`1024` — the single-replica constraint already caps the working set;
reducing the in-memory limit would cause unexplained 503s under test
load and confuse the runbook operator.

**`SecretString`:** a minimal wrapper with `Debug: "<redacted>"`.
Comparison uses `subtle::ConstantTimeEq` (audited timing-safe primitive
from the `subtle` crate, already common in the Rust security ecosystem)
to avoid leaking secret length or content via short-circuit comparison.
Keeps secrets out of logs, panic messages, and `#[derive(Debug)]` leaks.
Lives in `server/src/auth/secret.rs`.

#### 4.1.2 Env var contract

| Env | Required in | Default | Notes |
|---|---|---|---|
| `SB_ENV` | always | `dev` | `prod` selects `require_secure_cookie`, `trust_forwarded_for=true`, `MailerKind::CloudflareWorker`. |
| `SB_BIND` | always | `127.0.0.1:8080` | prod: `0.0.0.0:8080`. |
| `SB_BASE_URL` | prod | `http://localhost:8080` | `https://singing.rcnx.io` in prod. |
| `SB_DATA_DIR` | prod | `./data` | mounted Azure Files share in prod (`/data`). |
| `SB_TURN_HOST` | prod | — | `turn.singing.rcnx.io`. |
| `SB_TURN_SHARED_SECRET` | prod | — | 32+ bytes. Mirrors coturn's `static-auth-secret`. |
| `SB_TURN_TTL_SECS` | — | `600` | — |
| `SB_CF_WORKER_URL` | prod | — | `https://mail.singing.rcnx.io/send`. |
| `SB_CF_WORKER_SECRET` | prod | — | Shared secret in `Authorization: Bearer`. |
| `SB_SESSION_LOG_PEPPER` | **prod** | — | **32 bytes minimum** (fail-fast in `validate_prod_config`). Dev uses a compile-time constant for test round-trips. |

`Config::from_env` fails loudly (exit non-zero) when a prod-required
env is absent — fail-fast over fail-silently.

### 4.2 Database + session_log

#### 4.2.1 Migration `0002_session_log.sql`

```sql
CREATE TABLE session_log (
  id                 BLOB PRIMARY KEY,      -- uuid v4, 16 bytes
  teacher_id         INTEGER NOT NULL REFERENCES teachers(id),
  -- student_email_hash: sha256(lower(email)||app_pepper) — not reversible.
  student_email_hash BLOB NOT NULL,
  browser            TEXT NOT NULL,         -- capped MAX_BROWSER_LEN
  device_class       TEXT NOT NULL,         -- capped MAX_DEVICE_CLASS_LEN
  tier               TEXT NOT NULL,         -- 'supported'|'degraded'|'unworkable'
  started_at         INTEGER NOT NULL,      -- unix seconds
  ended_at           INTEGER,               -- null while live
  duration_secs      INTEGER,               -- filled on close
  peak_loss_bp       INTEGER NOT NULL DEFAULT 0, -- basis points (0.01% each)
  peak_rtt_ms        INTEGER NOT NULL DEFAULT 0,
  ended_reason       TEXT                   -- 'hangup'|'floor_violation'|'disconnect'|'blocked'|'server_shutdown'
);

CREATE INDEX idx_session_log_teacher ON session_log(teacher_id, started_at);
CREATE INDEX idx_session_log_started ON session_log(started_at);
```

**No raw PII:**
- `student_email_hash` is `sha256(lower(email) || app_pepper)`.
  `app_pepper` is a 32-byte value loaded from `SB_SESSION_LOG_PEPPER`
  and cached in `AppState`. In dev the pepper is a compile-time
  constant (documented) so tests can round-trip.
- No `peer_ip` persists — §9 #1 decision.
- No raw email, no raw tier_reason (the tier enum is coarse enough).

**Units:** `peak_loss_bp` is basis points (0–10000) so the schema is
integer-only; converting at ingest avoids SQLite REAL precision
issues and keeps comparisons cheap.

#### 4.2.2 `server/src/ws/session_log.rs`

```rust
pub struct SessionLogId(Uuid);  // private inner — callers use it opaquely

impl SessionLogId {
    pub fn new() -> Self { Self(Uuid::new_v4()) }
}

pub async fn open_row(
    pool: &SqlitePool,
    teacher_id: TeacherId,
    student_email_hash: &[u8; 32],
    browser: &str,
    device_class: &str,
    tier: Tier,
    started_at: i64,
) -> Result<SessionLogId>;

pub async fn record_peak(
    pool: &SqlitePool,
    id: &SessionLogId,
    loss_bp: u16,
    rtt_ms: u16,
) -> Result<()>;
// UPDATE session_log SET peak_loss_bp = MAX(peak_loss_bp, ?),
//                        peak_rtt_ms  = MAX(peak_rtt_ms,  ?)
// WHERE id = ?
// No-op if row is missing or already closed — WHERE clause naturally finds nothing.

pub async fn close_row(
    pool: &SqlitePool,
    id: &SessionLogId,
    ended_at: i64,
    ended_reason: EndedReason,
) -> Result<()>;
// First-writer-wins: UPDATE ... SET ended_at = ?, duration_secs = MAX(0, ended_at - started_at),
//                                   ended_reason = ?
//                   WHERE id = ? AND ended_at IS NULL
// A second concurrent call finds ended_at already set → zero-row update → silently OK.
// duration_secs = MAX(0, ended_at - started_at) prevents negative values from clock skew.
```

**`ActiveSession` lifecycle with `log_id: Option<SessionLogId>`:**

```rust
pub struct ActiveSession {
    pub student: LobbyEntry,
    pub started_at: Instant,
    pub log_id: Option<SessionLogId>,  // None until open_row completes; transiently unset
    pub peak_loss_bp: AtomicU16,       // updated by SessionMetrics; drives record_peak
    pub peak_rtt_ms: AtomicU16,
}
```

**Sequencing:**

1. `admit()` acquires the `RwLock` write guard, moves the student
   into `active_session` (with `log_id: None`), and releases the
   guard. *No await inside the guard.*
2. After the guard drops, `admit()` calls `open_row(...)`. On
   success, re-acquires write to set `log_id = Some(id)`. On failure,
   logs a warning and leaves `log_id = None` — the session proceeds
   without logging. The `record_peak` and `close_row` calls both
   handle `log_id = None` by short-circuiting (no DB write).
3. `SessionMetrics` frames arrive and bump `peak_loss_bp` /
   `peak_rtt_ms` atomics on `ActiveSession`. Every 5th frame
   (i.e. every 10 s at the 2 s adapt tick rate) also calls
   `record_peak` to persist the high-water mark. This moves the
   DB write off the hot path.
4. `cleanup()` (in `ws::mod`) calls `close_row` for the `log_id`
   if present, with `ended_reason` derived from how the loop exited.

**No raw PII guard — test `session_log_no_plaintext_email_or_ip`
(§5.1 #7) scans every column of every row after a full synthetic
session to prove the email string and the peer IP string do not
appear.**

### 4.3 WS protocol additions

#### 4.3.1 `ClientMsg::SessionMetrics`

```rust
ClientMsg::SessionMetrics {
    loss_bp: u16,       // 0..=10_000
    rtt_ms: u16,        // cap 65_535
},
```

- Only valid while the client is the `active_session` student (or the
  teacher, which we *accept and ignore* — avoids branching by role
  on the client).
- Rate-limited to **one frame per 5 s per connection**, in memory on
  `ConnContext`.
- Fields are bounded by type width; no extra validation needed.

#### 4.3.2 `ErrorCode::Blocked`, `ErrorCode::RateLimited`

New variants. Payload is `message: "blocked_by_teacher"` /
`"rate_limited"` — WS close is 1008. Blocked-on-rejoin is close
1008 with a reason token so the browser can render
`#blocked-notice` once reconnected (see §4.7).

#### 4.3.3 Backwards compat

Adding message tags is a strict extension — old clients never emit
`session_metrics`. Existing tests continue to pass untouched.

### 4.4 `/turn-credentials` endpoint

#### 4.4.1 Route shape

```
GET /turn-credentials
  -> 200 application/json { "iceServers": [ ... ], "ttl": 600 }
```

No auth required. Called by every client before `new RTCPeerConnection`.

**Application-layer rate limit:** reuses the same `per_ip` in-memory
sliding window as the WS join limiter (§4.5), but with its own independent
limit: `turn_cred_rate_limit_per_ip = 10` per `turn_cred_rate_limit_window_secs
= 60`. Exceeding the limit returns `429 Too Many Requests` (not 1008 — this
is HTTP, not WS). This limit is independent of the CF WAF rate-rule.

In dev mode the handler short-circuits to `{ "iceServers": [], "ttl": 60 }`
and rate limiting is bypassed — tests remain offline.

#### 4.4.2 Credential format (coturn REST API, "use-auth-secret")

```
username  = "{expiry_unix_ts}:{turn_realm}"   (realm = "singing.rcnx.io")
password  = base64(HMAC-SHA1(shared_secret, username))
ttl       = 600 seconds
iceServers = [
  { "urls": ["stun:{turn_host}:3478"] },
  { "urls": [
      "turn:{turn_host}:3478?transport=udp",
      "turn:{turn_host}:3478?transport=tcp",
      "turns:{turn_host}:5349?transport=tcp"
    ],
    "username": "{username}",
    "credential": "{password}",
    "credentialType": "password"
  }
]
```

coturn must be started with `use-auth-secret` + `static-auth-secret=`
matching `SB_TURN_SHARED_SECRET`. The entire scheme pre-dates the
sprint (documented in `coturn(1) § Long-Term Credential Mechanism`).

#### 4.4.3 Response headers

- `Cache-Control: no-store` — creds are time-bounded.
- CSP unchanged (JSON, not HTML).

### 4.5 Per-IP WS join rate limit

#### 4.5.1 Design

In-memory sliding window keyed on `peer_ip: IpAddr`.

```rust
// AppState gains:
pub ws_join_rate_limits: DashMap<IpAddr, WsJoinBucket>,
pub ws_join_rate_sweeper: JoinHandle<()>,  // owned here; aborted in main.rs on shutdown
```

`WsJoinBucket` is a plain struct (no `Arc<Mutex<...>>`):

```rust
pub struct WsJoinBucket {
    pub count: u32,
    pub window_start_unix: i64,
}
```

DashMap's per-shard locking suffices — the shard mutex is acquired
by `entry(ip).or_insert(...)` and released before any `.await`.
No `Arc<Mutex>` needed because the `DashMap` shard lock is the only
guard protecting each bucket.

The sweeper is a `tokio::spawn` that loops every 60 s, acquiring
each shard briefly to remove entries older than `2 × window`. Its
`JoinHandle` is stored on `AppState` and `main.rs` calls
`state.ws_join_rate_sweeper.abort()` on SIGINT before the graceful
shutdown sequence. The sweeper's own `select!` includes
`state.shutdown.cancelled()` for clean exit on the shutdown signal.

**`SB_WS_JOIN_RATE_LIMIT_PER_IP = 0`** is treated as "disabled" (all
traffic passes). Validated in `parse_env` with an explicit comment so
no silent behaviour.

**Limit:** `ws_join_rate_limit_per_ip` = 20 per `ws_join_rate_limit_window_secs`
= 60 (default).

#### 4.5.2 Where it fires

In `ws::handle_lobby_join`, **before** `slug_exists`: we don't want
scanning attackers learning which slugs exist by timing the DB
query.

The check is:
```rust
// Acquire DashMap shard, mutate bucket, release guard — all before any .await.
// The guard is a DashMap RefMut<IpAddr, WsJoinBucket>; it is dropped at the
// end of this block, not held across the send() calls below.
let over_limit = {
    let mut entry = state.ws_join_rate_limits.entry(peer_ip).or_default();
    // ... update window, increment count, check limit ...
    entry.count > config.ws_join_rate_limit_per_ip as u32
};  // guard dropped here

if over_limit {
    // sends and close are .await'd AFTER the guard is gone
    send_error(ctx, ErrorCode::RateLimited, "rate limited").await;
    let _ = ctx.tx.send(PumpDirective::Close { code: 1008, reason: "rate_limited".into() }).await;
    return false;
}
```

#### 4.5.3 Peer IP resolution

`trust_forwarded_for = true` in prod → read `X-Forwarded-For`'s
**first** entry (client-reported). Cloudflare rewrites this and
provides `CF-Connecting-IP`; we prefer the latter when present. In
dev the `ConnectInfo<SocketAddr>` addr is used directly. A helper
`resolve_peer_ip(config, headers, addr) -> IpAddr` encapsulates this
and has its own unit tests (§5.2).

**Spoofing:** CF is the only caller that legitimately populates
`CF-Connecting-IP`. The Container App's ingress ACL (§4.10) accepts
traffic only from CF's published IP ranges, so a non-CF client cannot
set that header. Documented in the runbook.

### 4.6 Lobby block (teacher-initiated)

#### 4.6.1 Client → server

`LobbyReject` already exists. We extend the teacher UI with a second
button "Reject & block (10 min)". Wire: teacher sends the existing
`LobbyReject` with an optional new field `block_ttl_secs:
Option<u32>` (serde `#[serde(default)]`). Server clamps to
`[0, 86_400]` and enforces the room-level ceiling
`SB_LOBBY_BLOCK_DEFAULT_TTL_SECS`.

#### 4.6.2 Server-side state

`RoomState` gains:

```rust
pub const BLOCK_LIST_CAP: usize = 256;  // in server/src/state.rs

pub struct BlockEntry {
    pub ip: IpAddr,
    pub until: Instant,
}

pub struct RoomState {
    // existing...
    pub blocked: Vec<BlockEntry>,  // capped at BLOCK_LIST_CAP; FIFO eviction
}
```

Linear scan is fine — lobbies are small. Swept on every `join_lobby`
(expire + evict). Rejected by IP match in `handle_lobby_join`:

```
if rs.blocked.iter().any(|b| b.ip == peer_ip && b.until > now) {
    -> Error { Blocked, "blocked_by_teacher" }
    -> Close 1008 "blocked"   // 1008 (policy violation) not 1000 (normal closure)
}
```

**Close-code branching in `lobby.rs`:**

- **Plain `LobbyReject` (no `block_ttl_secs`):** sends `Rejected` + closes
  with **1000** `"teacher_rejected"` — existing behaviour unchanged.
- **`LobbyReject` with `block_ttl_secs > 0`:** also adds IP to `blocked`;
  sends `Rejected` + closes with **1008** `"blocked"` so the browser
  can distinguish the two cases and render `#blocked-notice` instead of
  the generic rejection message.

Both code paths run under the existing `role == Teacher` guard.

#### 4.6.3 Cross-room blocks are intentionally absent

Each teacher is a separate trust boundary. A student blocked by
teacher A must still be able to join teacher B's room. The per-
`RoomState` block list is the mechanism. §9 #3 locks this decision.

### 4.7 Client changes

#### 4.7.1 `web/assets/ice.js` [NEW — UMD, Node-testable pure core]

```js
// Pure: cached + expiry logic; returns { iceServers, expiresAt }.
function cacheValid(cache, nowMs) {
  return cache && cache.expiresAt > nowMs + 10_000; // 10 s early refresh
}

// Browser: thin wrapper around window.fetch.
async function fetchIceServers(opts) {
  if (cacheValid(_cache, opts.now())) return _cache.iceServers;
  const r = await opts.fetch('/turn-credentials', { cache: 'no-store' });
  if (!r.ok) throw new Error('turn credentials fetch failed');
  const body = await r.json();
  _cache = { iceServers: body.iceServers, expiresAt: opts.now() + body.ttl * 1000 };
  return body.iceServers;
}
```

The browser wrapper lazily populates a module-level `_cache`.
`signalling.js::makePeerConnection` becomes an `async` function that
awaits `fetchIceServers` before constructing the `RTCPeerConnection`.

#### 4.7.2 `web/assets/session-core.js` metrics sink

`startSessionSubsystems` gains a `metricsSink` callback. Every 5th
adapt tick (= 10 s) it pushes `{loss_bp, rtt_ms}` from the latest
`qualityTierFromSummary` output. `signalling.js::startSession`
supplies the sink: `sig.send({ type: 'session_metrics', loss_bp,
rtt_ms })`. Floor-violation already fires synchronously — no change
there.

#### 4.7.3 `#blocked-notice`

Minimal: a `hidden` `<div>` alongside `#floor-violation`. The signal
handler wires an `onBlocked(reason)` callback that reveals the
notice. Dark-mode CSS parity (one-liner alongside existing
`.floor-violation`).

### 4.8 Mailer (production)

#### 4.8.1 `CloudflareWorkerMailer`

The existing `Mailer` trait already has `Send + Sync + 'static` bounds
(required because `Arc<dyn Mailer>` lives in `AppState` which is shared
across async tasks). `CloudflareWorkerMailer` upholds this: all fields
are `Send + Sync`.

```rust
pub struct CloudflareWorkerMailer {
    worker_url: Url,        // SB_CF_WORKER_URL
    bearer_secret: SecretString, // SB_CF_WORKER_SECRET
    http: reqwest::Client,  // connect_timeout 3 s, total timeout 10 s
}

// `from`, `subject` are NOT fields — they are compile-time constants:
const MAIL_FROM: &str = "noreply@singing.rcnx.io";
const MAIL_SUBJECT: &str = "Your singing-bridge sign-in link";

#[async_trait]
impl Mailer for CloudflareWorkerMailer {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        let body = serde_json::json!({
            "to": to,
            "subject": MAIL_SUBJECT,
            "url": url.as_str(),
            // "from" is NOT included — the Worker reads MAIL_FROM from its own env config
        });
        let resp = self.http.post(self.url.clone())
            .bearer_auth(self.secret.expose())
            .json(&body)
            .send().await?;
        if !resp.status().is_success() {
            return Err(MailerError::Upstream(resp.status().as_u16()));
        }
        Ok(())
    }
}
```

`MailerError` gains `Upstream(u16)`. Internal errors are mapped
through `AppError::Internal` (redacted message) already.

#### 4.8.2 Cloudflare Worker (Email Workers + MailChannels)

`infra/cloudflare/workers/magic-link-relay.js` — vendor-standard
MailChannels POST. Bearer-auth is a constant-time compare against
the deploy-time secret. Full source in §4.10.3.

### 4.9 Dockerfile

```dockerfile
# stage 1: cargo build --release
FROM docker.io/library/rust:1.82-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY server/Cargo.toml server/Cargo.toml
# cache-warming trick: build empty lib to seed ~/.cargo
RUN mkdir -p server/src && echo 'fn main(){}' > server/src/main.rs \
 && cargo build --release -p singing-bridge-server || true
COPY server ./server
RUN cargo build --release -p singing-bridge-server

# stage 2: distroless (cc so we get glibc)
FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/target/release/singing-bridge-server /app/server
COPY web /app/web
COPY server/migrations /app/migrations
WORKDIR /app
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/server"]
```

The binary reads `SB_STATIC_DIR=/app/web` in prod. Migrations are
embedded via `sqlx::migrate!` against `/app/migrations` at boot.

### 4.10 Infrastructure (Bicep)

#### 4.10.1 Azure resource map

| Resource | Bicep module | Notes |
|---|---|---|
| Resource group `sb-prod-rg` (UK South) | out-of-band `az group create` | Bicep RG scope starts here. |
| ACR `sbprodacr` | `acr.bicep` | Basic SKU, admin disabled, image-pull via managed identity. |
| Log Analytics workspace | `log-analytics.bicep` | Container App diagnostics + VM boot logs. |
| Container Apps env `sb-env` | `container-app.bicep` | Consumption plan, internal networking default, CF → ingress via FQDN. |
| Azure Storage account + File share `sb-data` | `container-app.bicep` | `Premium_LRS` (better fsync latency). Mounted at `/data`. |
| Container App `sb-server` | `container-app.bicep` | Image from ACR; env from `secretRef`; **min=max=1**; health probe `/healthz`; `readinessProbe` 3 s interval. **Ingress IP allow-list: CF published IP ranges only** (codified in Bicep `ipSecurityRestrictions` so it is IaC-enforced, not a runbook step). The CF IP range list is parameterized as a Bicep array; a runbook refresh step is documented for range updates. |
| VM `sb-turn` (Ubuntu 22.04 LTS, Standard_B1s) | `coturn-vm.bicep` | Static public IP, NSG allow 3478/udp + 3478/tcp + 5349/tcp, SSH allow from maintainer IP only. |
| coturn config via cloud-init | `coturn-vm.bicep` | See §4.10.2. |

**Single replica rationale (R2 in §6):** Container Apps scaling +
SQLite-on-fileshare is incompatible (no inter-pod file locking).
Pinning `min=max=1` turns the platform's scaler off. Not a forever
decision — Sprint-post-MVP work is a real DB.

#### 4.10.2 coturn cloud-init (excerpt)

```yaml
#cloud-config
package_update: true
packages: [coturn, ufw]
write_files:
  - path: /etc/turnserver.conf
    owner: turnserver:turnserver
    permissions: '0600'
    content: |
      listening-port=3478
      tls-listening-port=5349
      external-ip=${STATIC_IP}
      realm=singing.rcnx.io
      use-auth-secret
      static-auth-secret=${TURN_SHARED_SECRET}
      total-quota=100
      user-quota=12
      stale-nonce=600
      no-multicast-peers
      no-loopback-peers
      no-tlsv1
      no-tlsv1_1
      # SSRF: deny relay to RFC-1918, link-local, IMDS, and private IPv6 ranges
      denied-peer-ip=10.0.0.0-10.255.255.255
      denied-peer-ip=172.16.0.0-172.31.255.255
      denied-peer-ip=192.168.0.0-192.168.255.255
      denied-peer-ip=169.254.0.0-169.254.255.255
      denied-peer-ip=127.0.0.0-127.255.255.255
      denied-peer-ip=100.64.0.0-100.127.255.255
      denied-peer-ip=::1
      denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      cert=/etc/letsencrypt/live/turn.singing.rcnx.io/fullchain.pem
      pkey=/etc/letsencrypt/live/turn.singing.rcnx.io/privkey.pem
      log-file=/var/log/turnserver.log
      simple-log
runcmd:
  - ufw allow 22/tcp
  - ufw allow 3478
  - ufw allow 3478/udp
  - ufw allow 5349/tcp
  - ufw --force enable
  - systemctl enable --now coturn
```

The TLS cert lives on the VM, renewed by a cron-scheduled
`certbot certonly --standalone -d turn.singing.rcnx.io` (requires
briefly stopping coturn). Runbook documents the 3-month cadence.

**TURN cannot be proxied through Cloudflare** (UDP + long-lived TCP
sessions), per ADR — its A record is a **grey-cloud** entry pointing
directly at the static IP.

#### 4.10.3 Cloudflare (documented, not Bicep)

```
Zone: rcnx.io
Records:
  singing.rcnx.io    A  <container-app-fqdn-ip>    proxied (orange)
  turn.singing.rcnx.io A  <static-public-ip>       DNS-only (grey)
  _acme-challenge.turn.singing.rcnx.io  TXT        for certbot DNS-01

Workers:
  mail.singing.rcnx.io (worker.magic-link-relay)
    Env:
      MAIL_SHARED_SECRET = <32 bytes>
      MAIL_FROM          = noreply@singing.rcnx.io
      DKIM_SELECTOR      = mailchannels
      DKIM_PRIVATE_KEY   = <secret>
      DKIM_DOMAIN        = singing.rcnx.io

TLS:
  Container App ingress is HTTPS; CF is "Full (strict)" —
  CF validates the origin cert, origin cert issued by CA.

Email DNS (required by MailChannels):
  TXT @                 "v=spf1 include:relay.mailchannels.net -all"
  TXT mailchannels._domainkey  <DKIM pubkey>
  TXT _mailchannels     "v=mc1 cfid=<account-id>"
  MX  @                 (none — we do not receive email)
```

The worker code (abbreviated):

```js
// Timing-safe comparison using the Web Crypto API (available in CF Workers).
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ka = await crypto.subtle.importKey('raw', enc.encode(a), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', ka, enc.encode(a)),
    crypto.subtle.sign('HMAC', ka, enc.encode(b)),
  ]);
  // Constant-time buffer compare (both HMACs keyed with same key → equal length)
  const va = new Uint8Array(sa), vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('', { status: 405 });
    const hdr = req.headers.get('authorization') || '';
    const expected = 'Bearer ' + env.MAIL_SHARED_SECRET;
    if (!await timingSafeEqual(hdr, expected)) return new Response('', { status: 401 });
    // `from` is never taken from the request body — it comes from the Worker env only.
    const { to, subject, url } = await req.json();
    const payload = {
      personalizations: [{ to: [{ email: to }], dkim_domain: env.DKIM_DOMAIN,
                           dkim_selector: env.DKIM_SELECTOR, dkim_private_key: env.DKIM_PRIVATE_KEY }],
      from: { email: env.MAIL_FROM },   // sender identity is config-only, not request-controlled
      subject: subject || 'Your singing-bridge sign-in link',
      content: [{ type: 'text/plain',
                  value: `Hello,\n\nSign in to singing-bridge by opening this link in the same browser:\n\n${url}\n\nThis link expires in 15 minutes.\n` }],
    };
    const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return new Response('', { status: r.ok ? 204 : 502 });
  },
};
```

### 4.11 Runbooks (`knowledge/runbook/`)

- `deploy.md` — one-time bootstrap (create RG, deploy `acr` +
  `log-analytics` + `container-app` + `coturn-vm` + CF records +
  Worker) then per-release (`az acr build`, `az containerapp update
  --image`). Include `az containerapp logs tail` and
  `az containerapp revision` commands.
- `rollback.md` — revision revert via `az containerapp revision
  deactivate` + reactivate previous. Mention data-compat when a
  migration ships.
- `incident-turn-down.md` — symptoms (clients fall back to P2P fail
  → floor violation spike), check `systemctl status coturn`, verify
  cert expiry, renewal path.

### 4.12 CI additions

`.github/workflows/deploy.yml` — manual-dispatch workflow:

```yaml
on: { workflow_dispatch: { inputs: { tag: { default: "main" } } } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with: { creds: ${{ secrets.AZURE_CREDENTIALS }} }
      - run: |
          TAG=$(git rev-parse --short HEAD)
          az acr build -r sbprodacr -t singing-bridge:$TAG .
          az containerapp update -n sb-server -g sb-prod-rg --image sbprodacr.azurecr.io/singing-bridge:$TAG
```

No automatic push to prod on `main` — deploys are deliberate.

## 5. Test Strategy (MANDATORY)

### 5.1 Property / invariant coverage

**`/healthz` (`health.rs`)** — Rust integration:

1. **Returns 200 and minimal body in all states:** `GET /healthz` →
   `200 application/json {"status":"ok"}`. No version, no internal
   state — body is a single fixed string to avoid information disclosure.
2. **Returns 503 after shutdown is signalled:** call `state.shutdown.cancel()`;
   subsequent `GET /healthz` → 503. Verifies the readiness probe fails
   correctly when the server is draining.

**Turn credentials (`turn.rs` + `turn_credentials.rs` integration)** — Rust:

3. **Dev mode returns empty servers:** `SB_ENV=dev` → response body
   `{iceServers: [], ttl: 60}`. No HMAC computed, no secret required.
4. **Prod HMAC format:** with a known `static-auth-secret`,
   `username` is exactly `"{expiry}:singing.rcnx.io"` where
   `expiry == now_unix + ttl`; `credential == base64(hmac_sha1(secret, username))`.
   Verified against a hand-computed fixture (see §5.4 TURN_FIXTURE_SECRET).
5. **`ttl` field echoes config:** `SB_TURN_TTL_SECS=600` → body
   `ttl: 600`. `900` → `ttl: 900`.
6. **`Cache-Control: no-store`:** response header present and exact.
7. **`urls` list:** contains all four prod URLs in order: stun:3478,
   turn:3478 (udp), turn:3478 (tcp), turns:5349. Host == `turn_host`.
8. **Rate limit on `/turn-credentials`:** 10 requests from one IP in 60 s
   succeed; 11th returns 429. No body on 429 (no info disclosure).

**Session log (`session_log.rs` + `ws_session_log.rs`)** — Rust:

9. **Row opens on admit (`log_id = Some`), closes on disconnect:** admit a student,
   teardown; exactly one row with `ended_at IS NOT NULL` and
   `ended_reason = 'disconnect'`.
10. **`log_id = None` when `open_row` fails:** inject a pool that
    immediately returns an error; session proceeds normally (`admit` completes,
    media flows), `close_row` is a no-op, no panic.
11. **No PII in any row:** run a synthetic session where
    `email = "alice@contoso.example"` and peer_ip = `203.0.113.7`.
    After cleanup, `SELECT * FROM session_log` stringified does NOT
    contain the email string or the IP string. `student_email_hash` is
    32 bytes and non-zero.
12. **`record_peak` is `MAX(old,new)`:** concurrent `record_peak` calls
    with loss_bp `[100, 500, 300, 700, 400]` → final `peak_loss_bp = 700`.
13. **`record_peak` is a no-op when new ≤ old:** 3 calls with
    `[500, 500, 400]` result in exactly 1 UPDATE (observable via a
    transparent wrapper counter on the test pool).
14. **`record_peak` on a missing or already-closed row is a no-op:**
    call `record_peak` with a `SessionLogId` that was never inserted,
    or after `close_row` has run; neither panics nor errors; `loss_bp`
    in the DB is unchanged.
15. **Concurrent `close_row` calls are idempotent (first-writer-wins):**
    spawn two tasks calling `close_row` with different `ended_reason`s
    simultaneously. After both complete, exactly one `ended_reason` is
    set and it is not overwritten. The `UPDATE … WHERE ended_at IS NULL`
    guard makes this deterministic.
16. **`duration_secs` arithmetic:** `started_at = 1000`, `ended_at = 1065`
    → `duration_secs = 65`. `ended_at < started_at` (clock skew) →
    `duration_secs = 0` (MIN 0 guard).
17. **Multi-session teacher row isolation:** teacher has two serial
    sessions; both produce distinct `id`s, distinct `student_email_hash`
    rows.
18. **`ended_reason` taxonomy round-trips:** hangup / floor_violation /
    disconnect / blocked / server_shutdown all serialize and read back
    correctly from the TEXT column.

**Rate limit (`rate_limit.rs` + `ws_rate_limit.rs`)** — Rust:

19. **Allow under limit:** 20 lobby_join attempts from one IP in 60 s
    all succeed; 21st is rejected with `ErrorCode::RateLimited` + close 1008.
20. **Window rolls:** after 61 s, the counter resets; one more attempt
    succeeds.
21. **Per-IP isolation:** 20 joins from IP A exhaust A's budget; one
    more join from IP B (same WS, same slug) still succeeds.
22. **IPv6 parity:** same behaviour for `IpAddr::V6`.
23. **Sweep reclaims memory:** after 2× the window with no activity,
    the DashMap entry for that IP is gone (via the test-only
    `AppState::rate_limit_size()` helper).
24. **`ws_join_rate_limit_per_ip = 0` disables limiting:** every join
    succeeds regardless of frequency. Documented as the disabled value.

**Block (`ws_lobby_block.rs`)** — Rust:

**Per-IP resolution (`ws::peer_ip`)** — Rust unit:

41. **Dev mode ignores headers:** even with `CF-Connecting-IP: 1.2.3.4`,
    `resolve_peer_ip` returns the socket addr.
42. **Prod prefers `CF-Connecting-IP`:** both `X-Forwarded-For:
    10.0.0.1, 10.0.0.2` and `CF-Connecting-IP: 1.2.3.4` present —
    resolved IP is `1.2.3.4`.
43. **Prod falls back to first `X-Forwarded-For`** when no CF header.
44. **Malformed `CF-Connecting-IP` falls back to `X-Forwarded-For`:**
    `CF-Connecting-IP: not-an-ip` (unparseable) → warning logged; falls
    through to the `X-Forwarded-For` first-token rule. This is the
    missing precedence case; it must not fall to the socket addr when a
    valid `X-Forwarded-For` is present.
45. **Both malformed → socket addr:** `CF-Connecting-IP: bad`,
    `X-Forwarded-For: also-bad` → resolved IP is the socket addr;
    no panic.

25. **Block from IP X prevents X rejoining for TTL:** teacher rejects
    entry with `block_ttl_secs = 60`; the student's WS closes 1008
    "blocked"; a new WS from IP X is closed 1008 "blocked" within the
    60 s window.
26. **Different IP bypasses the block:** the same student from a new
    IP can rejoin.
27. **Block expires:** at `mock_now + 61 s`, rejoin from IP X succeeds.
28. **Block is per-room:** IP X blocked in room A can join room B.
29. **Block list eviction at `BLOCK_LIST_CAP`:** `BLOCK_LIST_CAP + 1`
    blocks evict the oldest entry; the newest is still active.
30. **Reject without block (the default path) still works:** no IP is
    added to `blocked`; rejoin succeeds immediately; close code is 1000.
31. **`block_ttl_secs = 0` is plain reject (no block):** close code is
    1000; `blocked` list unchanged.
32. **`block_ttl_secs` clamped at upper bound (86400):** value
    `86401` is stored as `86400 s`; value `0` is treated as plain reject.
33. **`block_ttl_secs` absent (backward-compat):** a `LobbyReject`
    message without the field (e.g. from an older teacher client)
    deserialises cleanly via `#[serde(default)]`; behaviour is
    plain reject (close 1000, no block entry).
34. **Blocked close code is 1008, plain reject is 1000:** the WS close
    code is verified explicitly in integration tests for both paths;
    regression guard is added to §5.3.

**Turn-only verification path (client-side harness)** — manual, see
§5.5 netem-style note.

**Config env (`config.rs`)** — Rust:

35. **Prod missing `SB_TURN_SHARED_SECRET` errors:** `from_env` returns
    `ConfigError::Missing("SB_TURN_SHARED_SECRET")`.
36. **Prod `SB_TURN_SHARED_SECRET` shorter than 32 bytes errors:**
    `validate_prod_config` returns `ConfigError::TooShort("SB_TURN_SHARED_SECRET")`.
    A 31-byte value is rejected; a 32-byte value is accepted.
37. **Prod missing `SB_SESSION_LOG_PEPPER` errors:** `from_env` returns
    `ConfigError::Missing("SB_SESSION_LOG_PEPPER")`.
38. **Prod with `SB_BASE_URL=http://...` errors:** HTTPS required in
    prod (`validate_prod_config`).
39. **Dev default lobby cap is 10:** matches SPRINTS spec.
40. **`SecretString::debug` never prints secret:** `format!("{:?}", s)`
    returns `"<redacted>"` regardless of inner value. Constant-time `eq`
    (via `subtle::ConstantTimeEq`) returns true for equal bytes, false for
    any single-byte difference (table of 3 cases: equal, prefix, distinct).

**Cloudflare Worker (`magic-link-relay.js`)** — Node (`node:test`
or `miniflare` shim; the Worker is a plain ES module with injectable
`env` and `fetch`):

46. **Valid auth → 204:** correct `Authorization: Bearer <secret>`,
    valid JSON body → MailChannels fetch called, 204 returned.
47. **Invalid auth → 401:** wrong Bearer value → 401, no upstream fetch.
48. **Missing auth → 401:** no `Authorization` header → 401.
49. **Wrong method → 405:** `GET /` → 405, no upstream fetch.
50. **Upstream 502 surfaced:** MailChannels returns 500 → Worker returns 502.
51. **`from` is config, not request:** request body omitting `subject`
    uses the default subject; `from` in the MailChannels payload equals
    `env.MAIL_FROM` regardless of any `from` key in the request body.

**ICE client (`ice.test.js`)** — Node:

52. **Cache reuses within expiry:** two calls with `clockNow` 0 and
    500_000 share one `fetch` call (ttl 600 s).
53. **Cache refreshes 10 s before expiry:** `clockNow` 595_000 →
    second `fetch` call made.
54. **Fetch failure rejects, no bad cache write:** stub returns 500;
    a subsequent call also triggers a fresh fetch (cache unchanged).
55. **Dev empty list is honoured:** `{iceServers: [], ttl: 60}` cached
    and returned as-is.
56. **`ttl=0` boundary:** server returns `ttl: 0`; cache is immediately
    stale on the next call (i.e. both calls issue a `fetch`). No division-
    by-zero or negative expiry.

**Session-metrics emission (`session-core.test.js` extension)** — Node:

57. **Every 5th adapt tick emits exactly one metrics frame:** 20 ticks
    → 4 sink invocations; payload fields `loss_bp`, `rtt_ms` are
    clamped to `[0, 10_000]` / `[0, 65_535]`.
58. **Zero-loss tick emits `loss_bp=0`:** no NaN, no negative.
59. **RTT unavailable (null) emits `rtt_ms=0`:** not dropped.

**Mailer (`mailer.rs`)** — Rust:

60. **`CloudflareWorkerMailer` POSTs expected JSON:** wiremock fixture
    asserts `Authorization: Bearer <secret>` header; body keys are `to`,
    `subject`, `url` — the `from` key is NOT in the body (it is Worker-
    config-only); method POST; content-type application/json.
61. **Upstream 500 maps to `MailerError::Upstream(500)`:** raw status
    is not leaked to the HTTP response body.
62. **Total timeout fires:** wiremock delays 11 s on the response body;
    mailer errors within ~10.5 s (total_timeout = 10 s). *This tests
    the total-request timeout, not the connect timeout.*
63. **Connect timeout fires:** wiremock accepts the TCP connection but
    never sends an HTTP response for 4 s; mailer errors within ~3.5 s.
    *These are two distinct test cases with two distinct wiremock behaviours.*

### 5.2 Failure-path coverage

**Migration 0002 idempotency:** apply, re-apply — no error,
`session_log` rows unchanged.

**`close_row` idempotency / concurrency:** two concurrent calls with
different `ended_reason`s race; the `WHERE ended_at IS NULL` guard
ensures exactly one wins. Covered by §5.1 #15. An additional unit
test runs the scenario with a sleep-injected second caller to confirm
the "zero rows updated" path does not error.

**TURN creds with zero-length secret:** `SB_TURN_SHARED_SECRET=""` →
`from_env` errors. (Silent accept would generate empty HMACs that
coturn would reject on first use, producing a hard-to-diagnose TURN
failure at runtime.)

**`/turn-credentials` under shutdown:** requesting during
`shutdown.cancelled()` returns 503 via existing `AppError`
propagation; no hang.

**`SessionMetrics` from a non-session connection:** lobby-watching
teacher sends the frame → server responds with
`Error{InvalidRoute}`, connection stays up (non-fatal).

**`SessionMetrics` over the 5-s rate:** 10 frames in 1 s from the
student — we accept the first (with an updated in-memory peak) and
silently drop subsequent ones until the gate opens. No DB UPDATE for
dropped frames.

**Block with `block_ttl_secs = 0`:** treated as "no block" (plain
reject). Negative values rejected by the `u32` type.

**Block from a forged `X-Forwarded-For`** (spoofing the teacher's
IP): impossible because `trust_forwarded_for=true` only in prod, and
the ingress ACL (§4.10) accepts only CF IPs — the path that reads
the spoofed header never runs on traffic not from CF. This is a
documented assumption (runbook step "verify the CF IP ACL before
trusting `CF-Connecting-IP`").

**SQLite-on-fileshare under lock contention:** `pragma
journal_mode=WAL` is incompatible with Azure Files `nobrl`. Dev tests
use in-memory; integration tests use a temp dir on local disk. An
**explicit runbook check** asserts `journal_mode=WAL` on boot in prod
— if WAL cannot engage, boot aborts rather than silently using
`journal_mode=DELETE` (which SQLite will do by default on fs without
byte-range locks). Covered by a startup self-check (§4.2.3 below)
and a unit test that spawns the server against an fs that refuses
locks and asserts non-zero exit.

**CF Worker unreachable:** signup returns 500 (redacted); user-facing
copy in `signup.js` is unchanged (already says "something went wrong").
Log event is `mailer_worker_unreachable` with upstream URL host (not
full URL).

**TURN VM down:** `/turn-credentials` still answers (the HMAC is
computed offline); clients fail to connect to coturn, fall back to
P2P only. Floor violations spike — runbook incident.

**TLS cert expired on TURN VM:** `turns:` connections fail; UDP 3478
still works for most clients. Cert-expiry monitor (CF worker cron
daily — out of scope for this sprint; noted §8).

### 5.3 Regression guards (carry-overs from Sprints 1–4)

| Finding (origin) | Guard |
|---|---|
| Sprint 1 R4 — no raw PII in logs / non-`textContent` rendering. | `#blocked-notice` is `textContent` only (test §5.1 #26 by implication + grep guard at sprint exit); session_log table carries only `student_email_hash`, asserted by §5.1 #7. |
| Sprint 1 R1 — single-writer per-socket pump. | New ClientMsg variants dispatch through the existing `handle_client_msg`; no new `ws_tx.send` call anywhere. Grep guard at sprint exit: `rg 'ws_tx\.send' server/src/ws` returns only the pump task. |
| Sprint 1 — no `.await` inside a `RoomState` guard. | `block_ip_after_reject` collects the block entry inside the guard and releases before awaiting the student's close send. Clippy `await_holding_lock = deny` stays in the workspace root; new modules respect it. **Test §5.1 #21 compiles as proof of this — if we regressed, clippy fails CI.** |
| Sprint 1 — atomic room cap. | Not touched. |
| Sprint 2 R1 #3 — single debug gate. | `/turn-credentials` dev-mode is gated by `config.dev`, the same flag that gates the debug marker. `#blocked-notice` has no debug surface. |
| Sprint 2 R2 #16 — no inline script. | HTML additions (`#blocked-notice`) contain zero script tags; `http_csp::verify_html_has_no_inline_script` passes for both student.html and teacher.html unchanged assertion style. |
| Sprint 3 R1 — `track.enabled` is the sole mute primitive. | Session-core metrics sink never reads `.enabled`. The existing §5.1 #33 guard from Sprint 4's plan already pins this; §5.1 #33 in this sprint's plan becomes a grep guard at sprint exit. |
| Sprint 3 — `#[serde(default)] tier`. | `LobbyReject` gains `#[serde(default)] block_ttl_secs: Option<u32>`. Back-compat test §5.1 #33: a `LobbyReject` without `block_ttl_secs` deserialises cleanly via the default and produces plain reject (close 1000, no block). This is the correct reference — not the pre-existing `ws_lobby.rs` reject test. |
| Sprint 3 — slug-aware role. | Teacher-only actions (`LobbyReject`) unchanged; block authority is still guarded by `ctx.role == Teacher`. |
| Sprint 4 R3 — hysteresis, no flap. | Adapt loop untouched. Metrics sink piggy-backs on the same `summariseStats` output; no new stats polling. |
| Sprint 4 — `setParameters` swallowed rejections. | Unchanged. |
| Sprint 4 — signal payload opacity. | `session_metrics` is a top-level ClientMsg, not a signal variant; server-opaque property of `Signal` preserved. |
| Sprint 5 R2 — close code 1000 vs 1008. | Plain reject → 1000; blocked reject → 1008. Integration test §5.1 #34 pins both codes. Grep guard at sprint exit: `rg '1008.*blocked\|blocked.*1008' server/src/ws/lobby.rs`. |
| Sprint 5 R2 — replica guard `min=max=1`. | `scripts/check-bicep.sh` greps `container-app.bicep` for `min:` and `max:` and asserts both equal `1`. Runs in CI alongside `cargo test`. |

### 5.4 Fixture reuse plan

- **Re-use:** `spawn_app`, `signup_teacher`, `TestApp::get_html`,
  `TestOpts.dev` from Sprint 1–3. Add `TestOpts.mailer_stub:
  Option<Arc<StubMailer>>` for §5.1 #60 (wiremock-style capture).
- **Re-use:** `STATS_FIXTURES` from Sprint 4 for §5.1 #57–#59 —
  metrics emission is driven off the same `summariseStats` output.
- **Re-use:** existing `server/tests/common/mod.rs` — adds
  `spawn_prod_like_app()` which flips `dev=false`, sets a static
  turn secret and session log pepper, and binds a localhost `StubMailer`
  (not real HMAC — `SB_TURN_SHARED_SECRET` / `SB_SESSION_LOG_PEPPER`
  are set so Config accepts the env).
- **New fixtures:**
  - `TURN_FIXTURE_SECRET = "test-secret-000000000000000000000"` (32
    bytes) + `TURN_FIXTURE_EXPIRY = 1_800_000_000_u64` +
    expected base64 password — hand-computed once.
  - `SESSION_LOG_PEPPER_FIXTURE = [0xAB; 32]` for hash round-trips.
  - `STUB_CF_WORKER` — `wiremock::MockServer` that expects the
    `Authorization: Bearer <secret>` header, returns 204.
  - `NO_LOCK_FS_FIXTURE` — a `tmpfile` mount flag that simulates
    an fs refusing byte-range locks (Linux-only test, feature-
    gated). Runs with `#[cfg(all(target_os="linux", feature="fs-stress"))]`.

### 5.5 Test runtime budget + flaky policy

- **Rust suite:** ~55 new tests (§5.1 Rust tests + failure-paths in
  §5.2). Budget: <12 s added to `cargo test`; full suite stays under
  75 s (wiremock-based mailer tests account for most of the extra cost).
- **Node suite:** ~18 new tests (§5.1 #46–#59 — Worker + ICE + session-
  core). Budget: <2 s. Node runner unchanged.
- **Integration deploy test:** none in CI. Exit-criterion #1 (10-min
  cross-ISP A/V session) is a manual acceptance run; results
  recorded in `knowledge/runbook/deploy.md` "Acceptance" section
  with timestamps. Exit-criterion #2 (forced TURN-only) is a
  documented browser-devtools recipe in `deploy.md`
  (Chrome → `chrome://webrtc-internals` → force `relay` in the
  ICE-candidate-pair filter).
- **Flaky policy:** rate-limit tests use an injected clock
  (`impl TimeSource for MockTime`). No `sleep`-based timing. Mailer
  timeout test uses wiremock's `set_delay` and asserts the observed
  error happens within `[2.5 s, 3.5 s]` — explicit tolerance band,
  not a bare point assertion.

## 6. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | SQLite on Azure Files WAL mode misbehaves (dropped fsyncs, `database is locked` under load). | Med | High | Single-replica Container App (scaler off). Premium LRS fileshare. Boot-time self-check: after `PRAGMA journal_mode=WAL`, read the mode back; if it's not `wal`, exit non-zero. Runbook escalation path: fail over to a VM + managed disk (Bicep module ready). |
| R2 | Multiple replicas silently enabled (e.g. someone edits the Bicep parameter) corrupts the DB. | Low | Critical | `min=max=1` is pinned in `container-app.bicep` by literal, not parameter. A CI lint step greps for `min:` / `max:` lines and asserts both equal 1. (One-line `rg` rule in `scripts/check-bicep.sh`.) |
| R3 | Cloudflare Worker outage blocks teacher sign-ups. | Low | Med | Current MVP has no SLA; retries on `/signup` give the user a do-over. Secondary mitigation noted: swap `MailerKind` to a fallback (e.g. direct SMTP via an Azure Communication Services resource — deferred). Document the blast radius in runbook. |
| R4 | `X-Forwarded-For` / `CF-Connecting-IP` spoofing bypasses rate limit. | Med | Med | Prod ingress ACL accepts only CF IP ranges (documented runbook step). Inside that boundary, trust CF. If the ACL drifts, rate limit trivially defeated — runbook has a `dig` + `curl --resolve` verification. |
| R5 | coturn credential secret leaks via logs. | Low | High | `SecretString` wrapper + `Debug` impl returning `<redacted>`. Test §5.1 #30. Secret fed only via env + Bicep `secureString`. |
| R6 | LetsEncrypt rate-limit during certbot renewal on the TURN VM. | Low | Med | Cron runs once daily only if cert is ≤30 days to expiry. Manual `certbot renew --dry-run` step in the runbook bootstrap. |
| R7 | Session log fills disk on a busy day. | Low | Low | One row per session; even at 100 sessions/day for 10 years that's < 400 k rows. `VACUUM` documented quarterly. |
| R8 | A malicious student floods `session_metrics` frames. | Low | Low | 5-second per-connection rate cap (§4.3.1 + §5.2). Frame size is fixed-integer; no allocation beyond the serde parse already capped at 64 KiB. |
| R9 | `/turn-credentials` becomes a credential oracle if the shared secret is short or reused. | Low | High | 32-byte minimum asserted in `Config::from_env` (§5.1 #27-style guard added). Documented rotation procedure: set new secret on coturn, set same new secret on Container App, wait for cache TTL to drain (~10 min). |
| R10 | Blocked student rejoins from a burner cell connection every five minutes. | Med | Low | IP-based blocks are inherently soft. MVP accepts this — teacher can reject repeatedly; per-IP rate-limit throttles the loop. Durable blocks deferred to post-MVP. |
| R11 | Bicep `container-app.bicep` drifts from what `az containerapp update` produces (image tag) during iterative deploys. | Med | Low | `deploy.md` pins the split: Bicep owns resource shape; `az containerapp update --image` owns image tags. A `what-if` check before every Bicep apply is called out in the runbook. |
| R12 | iOS Safari forces voice-processing that negates our fidelity floor even with TURN healthy. | Med | Med | Pre-existing Sprint 3 degraded-tier UX still fires; session_log records `tier=degraded` for iOS Safari and surfaces in the dashboard as a known-cause bucket. Not a Sprint 5 regression. |

## 7. Exit criteria → test mapping

| Exit criterion | How this sprint verifies it |
|---|---|
| 1. 10-minute cross-ISP A/V session via prod URL | Manual acceptance per `deploy.md`; recorded with timestamp + both participants' browsers. Not CI-automated. Passing the criterion ships; failing it blocks sprint completion. |
| 2. TURN relay used when direct P2P fails (forced TURN-only) | `deploy.md` recipe: (a) teacher browser sets Chrome `chrome://webrtc-internals` + `--force-fieldtrials=WebRTC-IPv6Default/Disabled/` to force relay, or (b) host firewall blocks direct UDP between the two LANs. Inspect `webrtc-internals` — all ICE candidate pairs have `local type: relay`. Documented screenshot in the runbook "Acceptance" section. |
| 3. Rate limit + lobby cap enforced under synthetic load | Unit + integration: §5.1 #12–#16, plus a `scripts/stress-lobby.sh` manual (bash loop of 50 `websocat` connections) documented in runbook. CI covers the deterministic path. |
| 4. Session log entries reconcile with observed sessions; no raw PII on disk | `session_log_no_plaintext_email_or_ip` integration test (§5.1 #7); manual reconciliation recipe in runbook (count rows in session_log vs manually logged acceptance sessions). |

## 8. Out of scope (explicitly deferred)

- **Session recording** — Sprint 6 (DEFERRED in SPRINTS.md).
- **Per-teacher invite codes / domain-locked magic links** — ADR
  "What we will monitor" calls for this only if lobby-abuse becomes
  real. Not yet.
- **Real-DB migration (Azure SQL or Postgres)** — ADR defers;
  SQLite is sufficient at MVP scale. Runbook notes the trigger
  conditions.
- **Durable block lists (persisted across restarts, cross-room)** —
  §4.6.3 pins this; deferred.
- **Multi-replica Container App** — deferred until we have a real DB.
- **TURN TLS cert auto-renew monitor (alert on <14 days)** — noted
  §5.2 (cert-expiry monitor); deferred to post-MVP automation sprint.
- **Automatic rollout of migrations** — boot-time `sqlx::migrate!`
  is the mechanism; we don't add a separate "run migrations now"
  admin endpoint this sprint.
- **Observability stack (metrics / traces)** — Log Analytics gives us
  logs. Prom/Grafana deferred.
- **DDoS / brute-force lockout beyond rate limiting** — Cloudflare
  edge handles Layer-7 at the zone level; we add no bespoke layer.

## 9. Decisions (binding for this sprint)

1. **No peer IP persists in the DB.** Session-log rows omit IP. IP
   lives in memory (block list, rate limiter) only. Mitigates
   GDPR-adjacent concerns; ADR's "stateless students" extends to the
   log.
2. **`student_email_hash` uses a server-side pepper, not a salt.**
   Per-row salts would let us invalidate individual rows by pepper
   rotation but lose the "same student across sessions" grouping
   property we'll want later for anti-abuse. Server-side pepper gives
   us deterministic grouping without storing the plaintext. Pepper
   compromise is a risk — mitigation is key rotation + keep-old-
   pepper-for-lookup window, out of scope here.
3. **Blocks are per-`RoomState`, by peer IP, in memory.** Not cross-
   room, not persisted, no user-visible appeal. Explicitly soft. §4.6.3.
4. **`SessionMetrics` is fire-and-forget.** Server does not ack.
   Dropping one during a reconnect flicker is acceptable — peak
   metrics are "best effort" by definition.
5. **Mailer is pluggable via `MailerKind` enum, not a feature flag.**
   Env-driven switch keeps one binary across environments; a
   `cargo build --features smtp` matrix would fragment CI.
6. **Container App runs as a non-root user** (uid 65532). Container
   Apps does not require root and distroless makes it the default
   posture.
7. **HMAC algorithm for TURN creds is SHA-1** (not SHA-256). coturn's
   `use-auth-secret` REST API is defined against SHA-1; using SHA-256
   would be incompatible with unmodified coturn. Documented.
8. **Container App image tag strategy: short git SHA** (not `latest`).
   Revision history in Container Apps becomes usable; `latest` is
   ambiguous and makes rollback confusing.
9. **No sidecar coturn on the Container App.** coturn needs UDP + a
   known static IP; Container Apps does not give us UDP or a stable
   per-replica IP. VM is the right shape. ADR already commits.

## 10. Implementation checklist

**Server (order-dependent):**

1. Add `server/src/auth/secret.rs` (`SecretString` + `subtle::ConstantTimeEq`).
   Add `subtle` to `server/Cargo.toml`.
2. Add `server/migrations/0002_session_log.sql`.
3. Add `MailerKind` + `CloudflareWorkerMailer` in `mailer.rs` (`from` from const,
   not request body; `Send + Sync` confirmed by trait bounds).
4. Extend `Config` + `Config::from_env` → `parse_env` + `validate_prod_config`.
   Add `SB_SESSION_LOG_PEPPER` as prod-required. Rename rate-limit fields to
   `ws_join_rate_limit_*`. Change `turn_ttl_secs: i64`. Add sweeper config fields.
5. Thread `trust_forwarded_for` + `resolve_peer_ip` (with malformed-header fallback)
   through `ws_upgrade`.
6. Add `ws::rate_limit` (DashMap<IpAddr, WsJoinBucket>, no Arc<Mutex>) +
   sweeper `JoinHandle` stored on `AppState`; sweeper uses `shutdown.cancelled()`.
7. Add `session_log.rs` + `ActiveSession { log_id: Option<SessionLogId>, peak_loss_bp: AtomicU16, peak_rtt_ms: AtomicU16 }`.
   `close_row` is first-writer-wins (`WHERE ended_at IS NULL`). `duration_secs = MAX(0, ended_at - started_at)`.
8. Add `ws/protocol::ClientMsg::SessionMetrics` + `ErrorCode::{Blocked, RateLimited}`.
9. Extend `LobbyReject` with `#[serde(default)] block_ttl_secs: Option<u32>`.
10. Add `RoomState.blocked: Vec<BlockEntry>` (capped at `BLOCK_LIST_CAP = 256`) +
    block-on-reject path; close 1008 for blocked, 1000 for plain reject.
11. Add `GET /turn-credentials` (with per-IP rate limit) + `GET /healthz`
    (minimal body `{"status":"ok"}`; returns 503 during shutdown).
12. Update `main.rs` to use `Config::from_env`, abort sweeper on shutdown, and
    select `MailerKind`.
13. Add `.sqlx/` offline query cache update if any compile-checked queries change.
14. `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`.

**Client:**

15. Add `web/assets/ice.js` (UMD + pure).
16. Update `signalling.js::makePeerConnection` to `await fetchIceServers`.
17. Wire `#blocked-notice` and `onBlocked` callback through `connectStudent`.
18. Add `session-core.js::metricsSink` wiring and metrics emission.
19. Teacher "Reject & block" button in `teacher.js`.
20. Add Node tests (`ice.test.js` + session-core extension).

**Infra:**

21. Write `Dockerfile` + `.dockerignore`.
22. `infra/bicep/acr.bicep` + `log-analytics.bicep`.
23. `infra/bicep/container-app.bicep` + Azure Files binding.
24. `infra/bicep/coturn-vm.bicep` + cloud-init.
25. `infra/bicep/main.bicep` composing all of the above.
26. `infra/cloudflare/workers/magic-link-relay.js`.
27. `infra/cloudflare/README.md` — manual DNS + Worker bootstrap.
28. `scripts/check-bicep.sh` — `min:` / `max:` lint (R2).
29. `.github/workflows/deploy.yml` — manual-dispatch image build/push.

**Docs:**

30. `knowledge/runbook/deploy.md` (bootstrap + per-release).
31. `knowledge/runbook/rollback.md`.
32. `knowledge/runbook/incident-turn-down.md`.
33. `knowledge/architecture/signalling.md` — add `session_log` + ICE-
    credentials paragraph.
34. Bump `Last updated: Sprint 5 (2026-04-17) -- <what changed>` on
    every edited file; run `./scripts/check-headers.py --sprint 5`.

**Acceptance (manual, gated):**

35. Deploy to Azure (follow `deploy.md`).
36. Run the 10-minute acceptance session (Exit #1) — record.
37. Run the forced TURN-only check (Exit #2) — capture
    `webrtc-internals` screenshot.
38. Commit (`.sprint-base-commit-5` is created by the archiver;
    commit before running the code review).
39. `./scripts/council-review.py code 5 "Azure + Cloudflare deployment + TURN + session log"`.
40. `./scripts/archive-plan.sh 5 "Azure + Cloudflare deployment + TURN + session log"`.
