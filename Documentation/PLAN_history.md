
---

# Sprint 1: signalling foundation + teacher identity + lobby

_Archived: 2026-04-17_

# PLAN — Sprint 1: Signalling foundation + teacher identity + lobby

**Sprint:** 1
**Title:** Signalling foundation + teacher identity + lobby
**Status:** DRAFT (revised R5 — addresses FINDINGS_Sprint1.md R1–R4)
**Last updated:** 2026-04-17

## 1. Problem statement

Build the first vertical slice of `singing-bridge`: a teacher can sign
up via magic link, claim a stable room URL at `/teach/<slug>`, and
manually admit one student from a live lobby into a peer-to-peer
WebRTC data channel that round-trips a `hello` message.

This sprint is deliberately **transport only** — no media (Sprint 2),
no video (Sprint 3), no bandwidth adaptation (Sprint 4), no production
deploy (Sprint 5). The bar is: signalling is real, auth is real,
lobby is real, and the browsers complete an ICE handshake over the
signalling channel we built.

### Spec references

- `SPRINTS.md` §Sprint 1 — deliverables and exit criteria
- `knowledge/decisions/0001-mvp-architecture.md` §Identity and
  addressing, §Lobby model, §Infrastructure — authoritative on
  teacher-chosen slug, magic-link auth, lobby admission model,
  browser-only clients, SQLite persistence

## 2. Current state (from codegraph)

The project is greenfield at the Rust layer. `python3
scripts/index-codebase.py --stats` reports 38 files, 704 symbols, 0
endpoints — all scaffolding (bootstrap scripts, template test
suites). No `Cargo.toml`, no `*.rs` files, no server code.

Existing infrastructure that shapes the plan:

- `.claude/codebase.db` — codegraph with a Rust indexer already
  registered (`scripts/indexers/rust.py`). Writing Rust will
  auto-populate symbols/endpoints/tests tables on save.
- `scripts/check-headers.py` — requires every source file to carry a
  header block. Rust comment style is `//`.
- `scripts/hooks/guardrails.py` — PreToolUse hook on Bash.
- `knowledge/decisions/0001-mvp-architecture.md` — binding on
  identity / lobby / infra decisions implemented here.

## 3. Proposed solution

A single-crate Rust binary (`singing-bridge-server`) built with
**axum 0.7** on **tokio**, serving:

- HTTP endpoints for signup / magic-link verification / teacher
  landing / student landing / static assets
- WebSocket endpoint `/ws` carrying a tagged-union JSON signalling
  protocol that multiplexes **lobby** and **session** messages on one
  connection
- SQLite persistence via **sqlx 0.8** with compile-time checked
  queries (migrations checked into `server/migrations/`)
- In-memory shared state (`Arc<AppState>`) with per-room
  `Arc<tokio::sync::RwLock<RoomState>>` (see §4.6 for the concrete
  lock type — this is load-bearing for the async-cleanup design)

The browser client is plain **HTML + vanilla JS** (no bundler, no
framework, no npm step).

Dev-mode magic-link delivery writes the link to stdout **and** to a
file sink at `dev-mail/<sha256(email)>.jsonl` (append-only, JSON
Lines, `0600` permissions). Real SMTP is Sprint 5.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Cargo workspace (server + proto + test-harness crates) | Premature. Single binary is enough until Sprint 5 deploy tooling. |
| `rusqlite` instead of `sqlx` | Synchronous; wrapping in `spawn_blocking` per query is worse than `sqlx`'s native async, and we lose compile-time query checking. |
| Separate WS endpoints for lobby vs session | Two connections per student doubles reconnect complexity and creates state-sync races. Tagged-union on one socket is simpler. |
| Bundler + TypeScript | Violates "no bundler yet" deliverable. |
| JWT session tokens | Unnecessary for a single process. Opaque cookie indexing `sessions` is simpler and revocable. |
| `tower-sessions` crate | Overkill for one cookie. A short custom extractor reads/validates the cookie against `sessions` directly. |
| **Async work inside `Drop` for WS cleanup** | **Rejected per R1 findings #1, #2.** `Drop` cannot `.await`. All teardown lives in an async `cleanup(&self, &AppState)` called from the `/ws` handler's exit path (see §4.8). |

## 4. Component-by-component design

### 4.1 Project layout

```
Cargo.toml                      # single-crate (server/)
server/
  Cargo.toml
  build.rs                      # sqlx offline prepare hook
  migrations/
    0001_initial.sql            # teachers, magic_links, sessions, signup_attempts
  src/
    main.rs                     # tokio::main, wiring, graceful shutdown
    config.rs                   # env + CLI config struct
    error.rs                    # AppError enum + IntoResponse impl (§4.11)
    db.rs                       # sqlx::SqlitePool setup + migration run
    state.rs                    # AppState, RoomState, LobbyEntry (§4.6)
    auth/
      mod.rs                    # session cookie extractor
      magic_link.rs             # issue + verify tokens
      slug.rs                   # slug validator + reserved list
      mailer.rs                 # dev-file sink; Mailer trait (§4.12)
      rate_limit.rs             # per-email + per-IP signup limits (§4.13)
    http/
      mod.rs                    # Router::new() composition + middleware
      signup.rs                 # POST /signup, GET + POST /auth/verify
      teach.rs                  # GET /teach/<slug> (teacher + student views)
      static_assets.rs          # /assets/* (embedded via rust-embed)
      tracing.rs                # URI-redaction layer (§4.3)
      security_headers.rs       # CSP + hardening headers (§4.14)
    ws/
      mod.rs                    # /ws upgrade handler, Origin check (§4.7)
      protocol.rs               # ServerMsg / ClientMsg tagged unions
      connection.rs             # outbound pump + tracked JoinHandle (§4.15)
      lobby.rs                  # lobby join/leave/admit/reject transitions
      session.rs                # session relay (offer/answer/ice/hello)
  tests/
    common/
      mod.rs                    # spawn_app() fixture + dev-mail reader
    slug_validator.rs
    magic_link.rs
    ws_lobby.rs
    ws_lobby_rejection.rs
    ws_lobby_cap.rs
    ws_session_handshake.rs
    ws_signal_relay.rs
    ws_teacher_reconnect.rs
    ws_shutdown.rs
    http_signup.rs
    http_origin.rs
    http_csp.rs
web/
  teacher.html
  student.html
  assets/
    signalling.js               # signalling client w/ connectTeacher + connectStudent
    styles.css
    verify.js                   # CSP-safe external script for /auth/verify (§4.3, R4 #48)
dev-mail/                       # .gitignored; created at runtime, 0700
```

### 4.2 Data model (SQLite)

```sql
-- migrations/0001_initial.sql

CREATE TABLE teachers (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at      INTEGER NOT NULL
);

CREATE TABLE magic_links (
  token_hash      BLOB PRIMARY KEY,
  teacher_id      INTEGER NOT NULL REFERENCES teachers(id),
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER
);

CREATE TABLE sessions (
  cookie_hash     BLOB PRIMARY KEY,
  teacher_id      INTEGER NOT NULL REFERENCES teachers(id),
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE TABLE signup_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL COLLATE NOCASE,
  peer_ip         TEXT NOT NULL,
  attempted_at    INTEGER NOT NULL
);

CREATE INDEX idx_sessions_teacher ON sessions(teacher_id);
CREATE INDEX idx_magic_links_teacher ON magic_links(teacher_id);
CREATE INDEX idx_signup_attempts_email_time ON signup_attempts(email, attempted_at);
CREATE INDEX idx_signup_attempts_ip_time ON signup_attempts(peer_ip, attempted_at);
```

**SQLite pool setup** (R4 recommendation, `server/src/db.rs`):

```rust
SqlitePoolOptions::new()
    .max_connections(8)
    .after_connect(|conn, _| Box::pin(async move {
        sqlx::query("PRAGMA journal_mode=WAL").execute(&mut *conn).await?;
        sqlx::query("PRAGMA synchronous=NORMAL").execute(&mut *conn).await?;
        sqlx::query("PRAGMA busy_timeout=5000").execute(&mut *conn).await?;
        sqlx::query("PRAGMA foreign_keys=ON").execute(&mut *conn).await?;
        Ok(())
    }))
    .connect(&config.db_url)
    .await?
```

WAL journaling is required for readers to not block during the
single-writer serialisation SQLite enforces; `busy_timeout=5000` ms
lets concurrent writes retry instead of returning `SQLITE_BUSY`
immediately. These pragmas are applied to both the in-memory test
DB and the production file DB so test + prod behaviour matches.

Token / cookie invariants:

- Magic-link and cookie tokens are random 32 bytes; the raw value
  flows only in transit. Storage holds `sha256(raw)`. DB theft →
  no replay.
- Single-use magic-link consume is a **single atomic UPDATE**:
  `UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND
  consumed_at IS NULL AND expires_at > ? RETURNING teacher_id`. Two
  concurrent consumes → exactly one `RETURNING` row (§5.1 property
  test enforces this).

### 4.3 Auth flow — magic-link + no-token-in-logs

1. **`POST /signup {email, slug}`** — validates slug (§4.4), runs
   per-email + per-IP rate limit (§4.13), issues magic-link token,
   stores `magic_links` row, delivers via `Mailer`. Returns an HTML
   "check your email" page. Also inserts a `signup_attempts` row.

2. **Magic-link URL format.** The emailed link is
   `{BASE_URL}/auth/verify#token=<raw>` — the token is in the URL
   **fragment**, which is never sent to the server and never appears
   in access logs, email gateway traces, or proxy logs.

3. **`GET /auth/verify`** — serves a small HTML page that loads an
   **external, same-origin** script `/assets/verify.js` (no inline
   script, so the global `script-src 'self'` CSP in §4.14 is
   honoured without `'unsafe-inline'` — resolves R2 finding #29).
   `verify.js` reads `location.hash`, strips `#token=`, and
   `fetch()`s `POST /auth/consume` with `Content-Type:
   application/json` and the body `{"token": "<raw>"}`. After a
   successful response, it calls `history.replaceState(null, "",
   "/auth/verify")` to clear the hash, then sets `location.href` to
   the redirect URL returned by the server.

4. **`POST /auth/consume {token}`** — hashes the token, runs the
   atomic consume-UPDATE, issues a random session cookie (32 bytes,
   hex), stores `sha256(cookie)` in `sessions`, returns `{redirect:
   "/teach/<slug>"}` with `Set-Cookie: sb_session=<hex>; HttpOnly;
   SameSite=Lax; Path=/; Max-Age=2592000` (30 d) plus `Secure` in
   non-dev builds (config refuses to drop `Secure` unless `BASE_URL`
   starts with `http://localhost` or `--dev` is explicit).

5. **Defence in depth: URI redaction.** A `tower::Layer` wraps the
   `tracing` request span to redact any `token=` query param before
   emitting the span. Belt + braces — the fragment approach already
   prevents leakage; redaction covers operators who copy-paste URLs
   into tickets. Test `http_signup::test_verify_token_redacted_in_logs`
   asserts a known token never appears in the captured log output.

6. **Teacher landing (`GET /teach/<slug>`)**: if the caller has a
   valid session cookie whose `teacher_id` owns `<slug>`, serves
   `teacher.html`; otherwise `student.html`. A revoked / expired /
   mismatched cookie is treated identically to "no cookie" (no
   branching that confirms cookie validity).

7. **Re-signup idempotency (explicit behaviour).** `POST /signup`
   with an email that already has a `teachers` row:
   - No cookie-backed active session → **rebind**: update the
     existing teacher's `slug` (subject to §4.4 availability),
     invalidate any prior unconsumed magic links for that teacher,
     issue a new link. Response: 200 "check your email."
   - Active session exists (any row in `sessions` where
     `expires_at > now` references this teacher) → **409
     Conflict**, body: `{code: "session_in_progress", message:
     "Log out of the existing session before changing your slug."}`
     Tests in §5.2 assert both branches.

8. **Session cookie refresh is OUT OF SCOPE this sprint** (§8 Q4
   resolved): a cookie lives 30 days from issue and does not
   refresh. Teacher re-auths via magic link when it expires.
   Re-testing deferred to Sprint 5 when we address production
   session management. Plan no longer proposes the 7-day refresh.

### 4.4 Slug validation

Regex: `^[a-z][a-z0-9-]{1,30}[a-z0-9]$` (3–32 chars, lowercase
start, alnum end — the terminal `[a-z0-9]` rejects trailing hyphens
without a separate post-check).

`RESERVED_SLUGS: &[&str]`: `admin`, `api`, `assets`, `auth`, `dev`,
`health`, `login`, `logout`, `signup`, `static`, `teach`, `ws`.
(`well-known` removed per R1 finding #21 — the regex's `[a-z0-9-]`
character class rejects dots but does accept the literal string
`well-known`; however `.well-known` (the actual path we'd protect
against) is already regex-rejected by the leading `[a-z]`. Keeping
the list minimal.)

Collision against an existing teacher returns **409 Conflict** with
an auto-suggested alternative (`{slug}-2`, `-3`, … up to `-9`; if
all taken, no suggestion). This **deliberately discloses slug
occupancy** — an accepted product trade-off (R1 finding #23): a
user choosing a slug needs to know if their preferred name is
taken, and the space of guessable slugs is not itself secret
(teachers share their slug URL publicly).

### 4.5 Signalling protocol

One WebSocket per client, tagged-union JSON. Types declared in
`ws/protocol.rs`:

```rust
#[derive(Copy, Clone, Serialize, Deserialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Role { Teacher, Student }

/// `Peer` is the **role** of the other side of the active session.
/// It is NOT a client-supplied connection identifier — the server
/// resolves the physical target connection from the room's
/// `active_session` membership. This prevents a third party from
/// addressing `Signal` messages at arbitrary connections
/// (R2 finding #31).
pub type Peer = Role;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    LobbyJoin { slug: String, email: String, browser: String, device_class: String },
    LobbyWatch { slug: String },
    LobbyAdmit { slug: String, entry_id: EntryId },
    LobbyReject { slug: String, entry_id: EntryId },
    /// Client indicates which role the message is FOR. Server checks
    /// the sender is the opposite role and is part of the same
    /// `active_session`, and forwards to that session's other half.
    Signal { to: Peer, payload: serde_json::Value },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    LobbyState { entries: Vec<LobbyEntryView> },
    Admitted { entry_id: EntryId },
    Rejected { reason: String },
    PeerConnected { role: Role },
    /// `from` is always filled in by the server from the sender's
    /// resolved role; clients cannot spoof it.
    Signal { from: Peer, payload: serde_json::Value },
    PeerDisconnected,
    ServerShutdown,
    Error { code: ErrorCode, message: String },
}
```

**Connection-bound slug authority** (R3 #42): once a connection has
delivered its first `LobbyWatch` (teacher) or `LobbyJoin` (student),
the slug is pinned in `ConnContext.slug` and every subsequent
`LobbyAdmit`, `LobbyReject`, and relay check uses **`ctx.slug`**.
Message-level `slug` fields are accepted as a sanity marker for
the client's own bookkeeping; the server ignores them for authority
and, if present and not equal to `ctx.slug`, rejects the message
with `Error { code: InvalidRoute }`. Test
`ws_lobby::test_admit_with_mismatched_slug_rejected` asserts a
teacher cannot admit an entry in a different room by sending a
different `slug` value.

**Relay authorization rule** (§4.7 step 4 refinement): when the
server processes `ClientMsg::Signal { to, payload }`:

1. Resolve the sender's role from their `ClientHandle` (teacher
   via session cookie; student via `active_session.student_entry`).
2. Reject with `Error { code: NotInSession }` if the sender is not
   a party to the active session.
3. Reject with `Error { code: InvalidRoute }` if `to ==
   sender_role` (a peer cannot address itself).
4. Forward as `ServerMsg::Signal { from: sender_role, payload }`
   to the other party's `ClientHandle`.

Type names `ClientMsg` / `ServerMsg` replace the earlier
`Cl2ServerMsg` / `Ws2ClientMsg` per R1 finding #19 (idiomatic
directional naming).

**Payload size budget** (R1 finding #17): a `Signal.payload` is
capped at **16 KiB** of serialised JSON; beyond that, the relay
drops the message and emits `Error { code: PayloadTooLarge }` to
the sender. The outer WS frame cap is 64 KiB (tokio-tungstenite
config). The per-message cap bounds memory pressure in the relay
hot path independently of the frame cap.

### 4.6 Room state (in-memory) — **explicit async-safe locking**

```rust
pub struct AppState {
    pub db: SqlitePool,
    pub rooms: DashMap<SlugKey, Arc<tokio::sync::RwLock<RoomState>>>,
    pub config: Config,
    pub mailer: Arc<dyn Mailer>,
    pub shutdown: tokio_util::sync::CancellationToken,
}

/// Normalised slug key. Constructed *only* via `SlugKey::new`, which
/// lowercases + trims. `DashMap` lookups therefore cannot be case-
/// or whitespace-confused relative to the `COLLATE NOCASE` DB
/// invariant (R2 finding #37).
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct SlugKey(String);
impl SlugKey {
    pub fn new(raw: &str) -> Result<Self, AppError> { /* validate + lowercase */ }
}

pub struct RoomState {
    pub teacher_conn: Option<ClientHandle>,
    pub lobby: Vec<LobbyEntry>,
    pub active_session: Option<ActiveSession>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct EntryId(pub Uuid);           // Copy per R1 finding #27

pub struct LobbyEntry {
    pub id: EntryId,
    pub email: String,
    pub browser: String,
    pub device_class: String,
    pub joined_at: Instant,
    pub conn: ClientHandle,
}

pub struct ActiveSession {
    pub student_entry: LobbyEntry,      // moved out of lobby on admit
    pub started_at: Instant,
}

pub struct ClientHandle {
    pub id: ConnectionId,                // random u64, used for equality on cleanup
    /// Sender into the per-connection pump. All outbound bytes
    /// (protocol messages and close frames) go through this one
    /// channel; see §4.15. R4 #47 requires this exact type — the
    /// earlier `Sender<ServerMsg>` spelling was a carry-over and
    /// is fixed here.
    pub tx: mpsc::Sender<PumpDirective>,
}
```

**Locking rules** (load-bearing, R1 findings #1, #2; R2 finding #30):

- `RoomState` is `tokio::sync::RwLock` — named explicitly. The lock
  supports `.await`-free critical sections by design.
- **Room acquisition goes through one helper** that clones the
  `Arc` out of `DashMap` and drops the `Ref` before returning:

  ```rust
  impl AppState {
      pub fn room(&self, slug: &SlugKey) -> Option<Arc<RwLock<RoomState>>> {
          // get() returns a Ref guard; cloning the Arc and dropping the
          // guard inside this function means no DashMap::Ref ever
          // escapes into an async scope.
          self.rooms.get(slug).map(|r| Arc::clone(r.value()))
      }
      pub fn room_or_insert(&self, slug: SlugKey) -> Arc<RwLock<RoomState>> {
          self.rooms.entry(slug).or_default().clone()
      }
  }
  ```

  **Rule: call sites MUST use these helpers — no direct
  `self.rooms.get(...)` in any `async fn`.** A clippy
  `disallowed_methods` entry bars direct `DashMap::get` /
  `::entry` in the `ws::*` and `http::*` modules (configured in
  `clippy.toml`). A grep-based CI check (`rg 'rooms\.(get|entry)\b'
  server/src/ws server/src/http`) fails the build if a direct call
  is introduced (belt + braces; clippy lint is the primary guard).
- **No `.await` inside a `RoomState` guard.** Every handler
  acquires the `RwLock` write guard, computes the state delta,
  collects any `ServerMsg`s to send, drops the guard, then
  `.await`s the `mpsc::Sender::send` calls. Clippy lint
  `clippy::await_holding_lock` is denied and fails CI.
- `ClientHandle::Drop` does **nothing async**. Drop only signals
  channel closure (receiver already observes). All
  peer-notification + room-state mutation happens in the explicit
  async cleanup in §4.8.
- `closed: Arc<AtomicBool>` is removed (R1 finding #18);
  `mpsc::Sender::is_closed()` + handler-exit cleanup is single-truth.

**Cardinality invariants** (tested):

- ≤ 1 `teacher_conn` per room
- ≤ 1 `active_session` per room
- A `LobbyEntry` is either in `lobby` OR referenced by
  `active_session`, never both. A `debug_assert!` at each
  transition (§4.7 step 3) enforces this in debug + test builds
  (R1 finding #22).

**Bounded resources:**

- `LOBBY_CAP_PER_ROOM = 32`. Over-cap `lobby_join` →
  `Error { code: LobbyFull }`; connection stays open.
- `MAX_ACTIVE_ROOMS = 1024`. Signup beyond this → 503.
- Per-connection outbound `mpsc::channel(64)`; slow consumer
  forces the pump task to close the socket (§4.15).

### 4.7 Admission flow + Origin validation

**WS upgrade (`GET /ws`)** — before `WebSocketUpgrade::on_upgrade`:

1. **`Origin` header MUST equal `config.base_url.origin()`** (per
   R1 finding #3). Absent or mismatched origin → **403** and the
   upgrade is refused. Test `http_origin::test_ws_upgrade_cross_origin_rejected`
   asserts 403 for a synthetic `Origin: https://evil.example`.
2. **Role is not decided at upgrade time** (R4 #46). A valid
   `sb_session` cookie yields a **candidate** `teacher_id` stored
   in `ConnContext.candidate_teacher_id: Option<TeacherId>`. The
   final `Role` is resolved when the first lobby message arrives:
   - On `LobbyWatch { slug }`: the server looks up the teacher
     that owns `slug` and compares to `candidate_teacher_id`.
     Match → `Role::Teacher`, `ctx.slug = slug`, proceed. Mismatch
     (cookie belongs to a different slug's teacher) OR no cookie →
     **`Error { code: NotOwner }` + `PumpDirective::Close { code:
     1008, reason: "not_slug_owner" }`**. The connection never
     promotes to teacher on another teacher's room, and never
     silently falls back to student on a `LobbyWatch`.
   - On `LobbyJoin { slug, ... }`: the server sets
     `Role::Student`, `ctx.slug = slug`, regardless of whether
     `candidate_teacher_id` is present. A teacher who joins
     another teacher's room as a student is allowed (they are
     not abusing credentials; students are unauthenticated by
     design). But their own room's teacher-cookie does NOT
     elevate them in someone else's room — that is the
     cross-room bypass this rule prevents.
   - After the first lobby message, `ctx.slug` and `ctx.role` are
     immutable for the life of the connection. A second
     `LobbyWatch` / `LobbyJoin` attempt → `Error { code:
     AlreadyJoined }`, connection stays open.

   Tests in §5.2 cover the specific failure paths:
   `test_teacher_cookie_for_slug_a_watching_slug_b_rejected` and
   `test_teacher_cookie_for_slug_a_joining_slug_b_as_student_succeeds`.

**Admission:**

1. Student connects, sends `LobbyJoin`. Handler validates slug,
   acquires write lock on `RoomState`, checks `lobby.len() <
   LOBBY_CAP_PER_ROOM`, appends entry, collects the teacher's
   `LobbyState` update message, drops the lock, sends the update.
2. Teacher (auth'd) connects, sends `LobbyWatch {slug}`. Handler
   verifies the cookie's `teacher_id` owns the slug (else
   `Error { code: NotOwner }` + 1008 close).
3. Teacher sends `LobbyAdmit {entry_id}`:
   - Acquire write lock; if `active_session.is_some()`, drop lock,
     send `Error { code: SessionInProgress }`.
   - Else: find the entry in `lobby`, move it into
     `active_session`, `debug_assert!(entry_not_in_lobby &&
     entry_in_active_session)`, drop lock, send `Admitted` to the
     student and `PeerConnected { role: Student }` to the teacher.
4. `Signal` messages from either party in the active session are
   forwarded to the other. Messages from any other socket
   addressing the active session's peers are rejected
   (`Error { code: NotInSession }`).
5. Teacher sends `LobbyReject {entry_id}`:
   - Acquire write lock, remove from lobby (if present; no-op +
     `Error { code: EntryNotFound }` otherwise), collect the
     student's `ServerMsg::Rejected { reason: "teacher_rejected" }`
     and the lobby broadcast message. Drop lock. Send both. Close
     the student socket with code 1000.
   - Tests in `ws_lobby_rejection.rs` cover this (R1 finding #6).

### 4.8 Disconnect + cleanup — **explicit async, not `Drop`**

Each `/ws` handler runs:

```rust
async fn ws_handler(ws: WebSocketUpgrade, state: Arc<AppState>, ...) -> Response {
    ws.on_upgrade(|sock| async move {
        let (result, ctx) = run_connection(sock, state.clone()).await;
        cleanup(&state, ctx, result).await;
    })
}

async fn cleanup(state: &AppState, ctx: ConnContext, result: ConnResult) {
    // 1. Acquire RoomState write lock via state.room(&slug) helper
    //    (§4.6 — no DashMap::Ref escapes this scope).
    //    Inside `room.write().await`, synchronously:
    //      - If teacher: teacher_conn = None (lobby entries preserved).
    //      - If student-in-lobby: remove from lobby; collect new
    //        LobbyState message for the teacher.
    //      - If student-in-active-session: active_session = None;
    //        collect PeerDisconnected for the teacher.
    //    Collect all outbound messages into a local Vec<(tx, msg)>.
    // 2. Drop the write guard explicitly before any .await.
    // 3. For each (tx, msg) collected, `tx.send(PumpDirective::Send(msg)).await`
    //    best-effort (recipient may already be gone).
    // 4. Drop `ctx.tx`; the pump's channel now has no senders
    //    (except any remaining Close directive already enqueued).
    // 5. Await `ctx.pump` with a 2 s timeout; on timeout `abort()`.
}
```

Key points (R1 findings #1, #2):

- All mutation is in this async function, called from the handler's
  normal exit path, not `Drop`.
- Handler-exit is driven by a `select!` over: inbound frame stream
  ends, outbound pump errors, server `CancellationToken` fires.
- **Ungraceful TCP close** (no close frame) is the same exit path —
  `StreamExt::next()` returns `None` on RST, and the handler
  proceeds to `cleanup()` identically. Test
  `ws_session_handshake::test_tcp_rst_triggers_cleanup` forces an
  `abort` on the underlying socket and asserts the peer receives
  `PeerDisconnected` within 1 s (R1 finding #25).
- On teacher disconnect, `lobby` entries are preserved. The lobby
  Vec's connections remain live — they see `lobby_state` updates
  resume when the teacher reconnects. Test
  `ws_teacher_reconnect::test_lobby_persists_across_teacher_reconnect`
  (R1 finding #12).

### 4.9 Browser client (`web/assets/signalling.js`)

One ~200-line vanilla module exporting a symmetric surface
(R1 finding #20):

```js
export const signallingClient = {
  connectTeacher({slug, onLobbyUpdate, onPeerConnected, onPeerDisconnected}),
  connectStudent({slug, email, onAdmitted, onRejected, onPeerDisconnected}),
};
```

Each returns an object with `{admit(entryId), reject(entryId),
hangup(), sendSignal(payload), close()}` as appropriate to the
role. No `playoutDelayHint`, DSP flags, or codec munging — Sprint 2.

### 4.10 Graceful shutdown — **broadcast ordered before close**

1. `tokio::signal::ctrl_c` triggers `AppState.shutdown.cancel()`.
2. HTTP server stops accepting new connections.
3. For each open WS, the handler's `select!` wakes on the token,
   enqueues `ServerMsg::ServerShutdown` to the outbound channel,
   waits up to 2 s for the pump to drain (`tokio::time::timeout`),
   then sends WS close frame 1012 and runs `cleanup()`.
4. SQLite pool closed.
5. 10 s global hard deadline on the whole shutdown.

Test `ws_shutdown::test_server_shutdown_delivered_before_close`
captures a connected client's last message and close code, asserts
the message is `ServerShutdown` and the close code is **1012**
(R1 finding #11, #13).

### 4.11 Typed `AppError` (R1 finding #16)

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("bad request: {0}")] BadRequest(Cow<'static, str>),
    #[error("conflict: {0}")]    Conflict(Cow<'static, str>),
    #[error("not found")]        NotFound,
    #[error("forbidden")]        Forbidden,
    #[error("too many requests")] TooManyRequests,
    #[error("session in progress")] SessionInProgress,
    #[error(transparent)]        Sqlx(#[from] sqlx::Error),
    #[error(transparent)]        Io(#[from] std::io::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response { /* maps each variant to a status + JSON body */ }
}
```

Handlers return `Result<impl IntoResponse, AppError>` so `?` keeps
the semantic variant instead of collapsing to a generic `500`.

### 4.12 `Mailer` trait (R1 finding #15)

```rust
#[async_trait::async_trait]
pub trait Mailer: Send + Sync + 'static {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError>;
}
```

Explicit `Send + Sync + 'static` bounds make `Arc<dyn Mailer>`
well-formed for `axum::Extension` usage. The dev implementation
writes to stdout and to `dev-mail/<sha256(email)>.jsonl` with
`fs::OpenOptions::mode(0o600)` (R1 finding #24). A `SmtpMailer`
lands in Sprint 5.

### 4.13 Rate limiting (R1 finding #9) — **in scope this sprint**

`POST /signup` checks the `signup_attempts` table:

- Per email: ≤ 3 attempts in the last 10 minutes.
- Per peer IP: ≤ 10 attempts in the last 10 minutes.

Over-cap returns 429 with `Retry-After`. Peer IP comes from
`ConnectInfo<SocketAddr>` (no proxy-header trust this sprint; when
Cloudflare is added in Sprint 5 we switch to `CF-Connecting-IP`
under a configured trusted-proxy check).

Test `http_signup::test_signup_rate_limit_email` and
`test_signup_rate_limit_ip` (R1 findings #9, #26).

### 4.14 Security headers (R1 finding #10)

A `tower::Layer` adds to every HTML response:

- `Content-Security-Policy: default-src 'self'; script-src 'self';
  connect-src 'self'; img-src 'self' data:; style-src 'self';
  object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  — `connect-src 'self'` only (R3 #41). Browsers already allow
  same-origin `ws://` / `wss://` under `'self'`, so explicit scheme
  entries would only weaken the directive by allowing cross-host
  WebSocket exfiltration.
  — **no `'unsafe-inline'`** anywhere (R2 finding #29). All scripts
  and stylesheets are loaded as same-origin static assets from
  `/assets/*`. The verify-flow script is `/assets/verify.js`
  (§4.3). No nonce plumbing is needed because no inline script
  remains in the sprint.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`
- `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (release only)

`Cache-Control: no-store` is attached specifically to `/auth/verify`
and `/auth/consume` responses.

Regression tests in `http_csp.rs` (R3 #44 — replaces the
unspecified "headless parser" mechanism with pure Rust assertions):

- `test_csp_header_is_strict` — `GET /auth/verify`, assert the
  response `Content-Security-Policy` header **exactly equals** a
  constant `EXPECTED_CSP` defined alongside the layer. Any future
  edit to the header forces an intentional update of the constant.
- `test_verify_html_has_no_inline_script` — render the HTML body
  and assert, via regex on the response bytes, that every
  `<script` tag carries a `src=` attribute (no inline code). The
  test also checks `<style` / `on[a-z]+=` handler attribute
  absence, which would also violate the CSP.
- `test_all_html_responses_carry_csp` — iterate the known HTML
  routes (`/`, `/signup`, `/auth/verify`, `/teach/example`) and
  assert each response has the CSP header. This catches a missing
  middleware registration.

### 4.15 Outbound pump lifecycle + sole writer (R1 #8, R2 #32, R3 #39 #40)

There is exactly one owner of the WebSocket write half for the life
of the connection: the **pump task**. Every outbound byte — including
every close frame, whether triggered by `LobbyReject`, server
shutdown, or protocol error — flows through a single
`mpsc::Sender<PumpDirective>`. No code outside the pump ever holds
the write half, which eliminates the dual-owner confusion and
removes the need for the phantom `WsCloser` type from R3.

```rust
/// Sole control channel for the outbound pump.
pub enum PumpDirective {
    /// Serialise and send a protocol message.
    Send(ServerMsg),
    /// Send a close frame with the specified code + reason, then
    /// terminate the pump. Any further `Send`/`Close` queued after
    /// this is dropped (channel receiver exits).
    Close { code: u16, reason: Cow<'static, str> },
}

pub struct ConnContext {
    pub slug: SlugKey,
    pub role: Role,
    pub id: ConnectionId,
    /// Clone stored in `ClientHandle.tx` in `RoomState`. All
    /// outbound traffic — including close frames emitted by
    /// shutdown or reject — goes through this sender.
    pub tx: mpsc::Sender<PumpDirective>,
    /// Owned for the whole connection. `cleanup()` is the only
    /// place that joins or aborts it.
    pub pump: JoinHandle<()>,
}

async fn run_connection(sock: WebSocket, state: Arc<AppState>) -> (ConnResult, ConnContext) {
    let (mut ws_tx, mut ws_rx) = sock.split();
    let (tx, mut rx) = mpsc::channel::<PumpDirective>(64);

    let pump = tokio::spawn(async move {
        while let Some(directive) = rx.recv().await {
            match directive {
                PumpDirective::Send(msg) => {
                    if ws_tx.send(to_ws_text(msg)).await.is_err() { break; }
                }
                PumpDirective::Close { code, reason } => {
                    let _ = ws_tx.send(ws::Message::Close(Some(ws::CloseFrame {
                        code, reason: reason.into(),
                    }))).await;
                    break;  // terminal; drain stops.
                }
            }
        }
        // Channel closed OR socket dropped OR we sent Close. Pump exits.
    });

    let ctx = ConnContext { /* slug/role/id */ tx: tx.clone(), pump };
    let result = inbound_loop(&mut ws_rx, tx, state).await;
    (result, ctx)
}

// `cleanup()` is async; no blocking_write anywhere.
async fn cleanup(state: &AppState, mut ctx: ConnContext, _r: ConnResult) {
    // 1. Room-state mutation + peer notifications (§4.8). This also
    //    removes our ClientHandle from RoomState, which drops the
    //    room's clone of `ctx.tx`.
    mutate_room_and_notify_peer(state, &ctx).await;

    // 2. Drop our own tx. With the room's clone already dropped, the
    //    pump's rx.recv() now returns None and the task exits.
    drop(ctx.tx);

    // 3. Single owner joins-or-aborts the pump.
    match tokio::time::timeout(Duration::from_secs(2), &mut ctx.pump).await {
        Ok(_)          => {}                // drained cleanly or panicked (logged)
        Err(_timeout)  => { ctx.pump.abort(); let _ = ctx.pump.await; }
    }
}
```

**Close-frame flows (all through the pump):**

- `LobbyReject` → handler sends `PumpDirective::Send(Rejected{...})`
  to the student, then `PumpDirective::Close { code: 1000, reason:
  "teacher_rejected" }`. The pump writes both in order and exits.
- Server shutdown → handler sends `PumpDirective::Send(ServerShutdown)`,
  then `PumpDirective::Close { code: 1012, reason: "server_restart" }`.
  The 2 s `tokio::time::timeout` in §4.10 bounds pump drain.
- Malformed JSON → `PumpDirective::Close { code: 1008, reason:
  "malformed_message" }`.
- Oversized frame → `PumpDirective::Close { code: 1009, reason:
  "frame_too_large" }`.

**Contract (resolving R3 #40):**

- `ConnContext.pump: JoinHandle<()>` has exactly one owner for the
  whole connection lifetime.
- `cleanup()` takes `ctx` by value and is the only place that
  awaits or aborts the handle.
- The write half is owned exclusively by the pump task. Close
  frames are data the pump sends, not a side-channel write.
- No `blocking_write` anywhere (R3 #39 resolved — the earlier
  sketch is removed; the room-state mutation in step 1 runs under
  `room.write().await`, which is async-safe because the guard is
  released before step 2 and before the send `.await`s in §4.8).

### 4.16 Banning panics in the WS hot path (R1 finding #28)

`#![deny(clippy::unwrap_used, clippy::expect_used)]` is applied at
the `ws` module level (inner attribute on `ws/mod.rs`). Use of
`.unwrap()` / `.expect()` in any `ws::*` file fails CI. Tests and
other modules are unaffected.

## 5. Test Strategy

### 5.1 Property / invariant coverage

| Module | Invariant | Test approach |
|---|---|---|
| `auth::slug` | Any reserved word → `Err`; any regex-violation → `Err`; valid slug → `Ok`. | Parametrised table + `proptest` generating random strings; asserts `validate(s).is_ok() == (matches_regex(s) && !reserved(s))`. |
| `auth::magic_link` | Consumed token cannot be consumed twice (concurrent consume → one wins). | 8 concurrent `consume()` calls on the same token; assert exactly one `Ok`. |
| `state::RoomState` | `lobby.len() + active_session.iter().count() ≤ LOBBY_CAP + 1`; every `EntryId` appears exactly once; XOR placement holds. | `proptest` state-machine strategy. **Operations include:** `join`, `admit`, `reject`, `leave`, `teacher_connect`, `teacher_disconnect`, `teacher_reconnect` (R1 finding #12). Invariant checked after each step. |
| `ws::protocol` | Every `ServerMsg` / `ClientMsg` variant round-trips JSON. | `serde_json` round-trip property test. |
| `http::tracing` | `token=<any>` in a URI is redacted before logging. | Generate random tokens, feed through the layer, assert token substring absent from log capture. |

Budget: ~5 s of `cargo test` runtime for property tests,
`PROPTEST_CASES=256` default.

### 5.2 Failure-path coverage

Every failure path gets at least one test:

**HTTP:**
- Signup: invalid slug regex → 400.
- Signup: reserved slug → 400.
- Signup: taken slug → 409 + suggested alternative.
- Signup: **over per-email rate limit** → 429 (R1 finding #9).
- Signup: **over per-IP rate limit** → 429.
- Signup: **existing email, no active session → rebind + 200** (R1 finding #7).
- Signup: **rebind invalidates prior unconsumed magic links** — test
  `http_signup::test_resignup_invalidates_prior_links`: issue link
  A, re-signup (rebind), attempt to consume A → 400 (R2 recommendation / finding #36).
- Signup: **existing email, active session → 409 session_in_progress** (R1 finding #7).
- `/auth/verify` loads HTML without a token → form submits empty, server 400.
- `/auth/consume` with: no token, wrong token, expired token, consumed token → 400 each.
- `/auth/consume` response **omits the raw token from any tracing span** (R1 finding #4, verified via in-process log capture).
- `/teach/<slug>` with revoked / expired cookie → student view.

**WebSocket:**
- Upgrade with missing `Origin` → 403 (R1 finding #3).
- Upgrade with cross-origin `Origin` → 403.
- Upgrade without cookie → success (role decided on first message).
- **`LobbyWatch slug_b` from a socket whose cookie owns `slug_a`** →
  `Error { code: NotOwner }` + close 1008 (R4 #46). Test
  `test_teacher_cookie_for_slug_a_watching_slug_b_rejected`.
- **`LobbyJoin slug_b` from a socket whose cookie owns `slug_a`** →
  joins as student in slug_b's lobby (cookie does not elevate
  across rooms, and does not block acting as a student elsewhere).
  Test `test_teacher_cookie_for_slug_a_joining_slug_b_as_student_succeeds`.
- Second `LobbyJoin` / `LobbyWatch` on the same socket → `Error { code: AlreadyJoined }`.
- `LobbyAdmit` while `active_session` exists → `Error { code: SessionInProgress }`.
- `LobbyAdmit` for unknown `entry_id` → `Error { code: EntryNotFound }`.
- `LobbyReject` happy path + unknown `entry_id` (R1 finding #6).
  Happy-path test asserts the student receives `ServerMsg::Rejected
  { reason: "teacher_rejected" }` immediately followed by WS close
  frame **code 1000** (R2 finding #33). Unknown-entry test asserts
  the teacher receives `Error { code: EntryNotFound }` and both
  sockets remain open.
- `LobbyJoin` over `LOBBY_CAP_PER_ROOM` → `Error { code: LobbyFull }`; connection stays open (R1 finding #5).
- 1025th signup when `MAX_ACTIVE_ROOMS` already at 1024 → 503 (R1 finding #5).
- `Signal` from a non-session peer → `Error { code: NotInSession }`.
- `Signal` with `to == sender_role` (self-addressed) →
  `Error { code: InvalidRoute }`. Test
  `ws_signal_relay::test_self_addressed_signal_rejected` (R3 recommendation).
- `LobbyAdmit` / `LobbyReject` with a `slug` field that does not
  equal `ctx.slug` → `Error { code: InvalidRoute }`. Test
  `ws_lobby::test_admit_with_mismatched_slug_rejected` (R3 #42).
- `Signal.payload` > 16 KiB → `Error { code: PayloadTooLarge }`.
  **Exact-boundary test** (R2 recommendation): a payload of exactly
  16 KiB is accepted; a payload of 16 KiB + 1 byte is rejected.
  Both assertions share the same test (`ws_signal_relay::test_payload_cap_boundary`).
- WS frame > 64 KiB → close 1009 (too big).
- Student disconnects mid-SDP → teacher gets `PeerDisconnected`, `active_session = None`.
- Teacher disconnects mid-session → student gets `PeerDisconnected`; active_session clears.
- Teacher disconnects WHILE lobby has entries → entries persist; teacher reconnects and receives current `LobbyState` (R1 finding #12).
- **Ungraceful TCP close** (abort on socket) → same cleanup path; peer `PeerDisconnected` within 1 s (R1 finding #25).
- Ill-formed inbound JSON → close 1008.
- Server shutdown → last client message is `ServerShutdown`, close code **1012** (R1 finding #11, #13).

### 5.3 Regression guards

This is Sprint 1 — no prior-round findings exist **in the code**.
Guards for R1 plan findings are woven into §5.2 and §5.1 above and
summarised here for traceability:

| R1 finding | Guard test |
|---|---|
| #1, #2, #28 (async cleanup, lock type, panic ban) | `ws_session_handshake::test_tcp_rst_triggers_cleanup`; clippy lints in CI |
| #3 (Origin) | `http_origin::test_ws_upgrade_cross_origin_rejected` |
| #4 (token in logs) | `http_signup::test_verify_token_redacted_in_logs` |
| #5 (lobby / room caps) | `ws_lobby_cap::test_lobby_cap_rejects`, `http_signup::test_max_rooms_rejects_signup` |
| #6 (lobby_reject) | `ws_lobby_rejection.rs` entire file |
| #7 (re-signup idempotency) | `http_signup::test_resignup_rebinds`, `test_resignup_with_active_session_conflict` |
| #11, #13 (shutdown) | `ws_shutdown::test_server_shutdown_delivered_before_close` |
| #12 (teacher reconnect) | `ws_teacher_reconnect.rs` entire file |
| #25 (ungraceful TCP close) | `ws_session_handshake::test_tcp_rst_triggers_cleanup` |
| R2 #29 (CSP / no inline script) | `http_csp::test_verify_html_has_no_inline_script`, `http_csp::test_csp_header_is_strict`, `http_csp::test_all_html_responses_carry_csp` |
| R2 #30 (DashMap::Ref across await) | clippy `disallowed_methods` + CI grep `rg 'rooms\.(get\|entry)\b' server/src/ws server/src/http` fails build |
| R2 #31 (server-resolved Peer) | `ws_signal_relay::test_third_party_cannot_address_session`, `ws_signal_relay::test_signal_from_spoofed_role_rejected` |
| R2 #32 (pump ownership) | `ws_shutdown::test_server_shutdown_delivered_before_close` (leaked pump would block shutdown timeout) |
| R2 #33 (reject close code 1000) | `ws_lobby_rejection::test_reject_closes_student_with_1000` |
| R2 #34 (log-capture isolation) | `TestApp::capture_logs` is per-test; log-sensitive tests are `#[serial]` |
| R2 #35 (signal payload boundary) | `ws_signal_relay::test_payload_cap_boundary` |
| R2 #36 (stale link after rebind) | `http_signup::test_resignup_invalidates_prior_links` |
| R2 #37 (SlugKey normalization) | `state::test_slug_key_case_insensitive_equal`; construction API forces lowercase |
| R3 #41 (connect-src 'self') | `http_csp::test_csp_header_is_strict` asserts exact header string |
| R3 #42 (slug authority) | `ws_lobby::test_admit_with_mismatched_slug_rejected` |
| R3 recommendation (InvalidRoute self-address) | `ws_signal_relay::test_self_addressed_signal_rejected` |
| R4 #46 (slug-aware role promotion) | `test_teacher_cookie_for_slug_a_watching_slug_b_rejected`, `test_teacher_cookie_for_slug_a_joining_slug_b_as_student_succeeds` |
| R4 #47 (pump channel type consistency) | Compile-time — `ClientHandle.tx` and `ConnContext.tx` share `Sender<PumpDirective>`; rustc enforces |
| R4 recommendation (teacher UI safe insertion) | `signalling.js` uses `textContent`; `web/teacher.html` loaded via a DOM snapshot test (`ws_lobby::test_teacher_view_escapes_student_strings`) that injects `<img src=x onerror=alert(1)>` as an email and asserts the teacher's DOM has no `img` element created |
| R4 recommendation (SQLite WAL + busy_timeout) | `db::test_pragmas_applied` queries `PRAGMA journal_mode` / `PRAGMA busy_timeout` after pool init and asserts `wal` / `5000` |

### 5.4 Fixture reuse plan

A single shared fixture in `server/tests/common/mod.rs`:

- `spawn_app(opts: TestOpts) -> TestApp` — binds TCP on
  `127.0.0.1:0`, spawns the server with `sqlite::memory:` DB and
  configurable `MAX_ACTIVE_ROOMS` / `LOBBY_CAP_PER_ROOM` /
  rate-limit overrides for targeted tests.
- `TestApp::signup_teacher(email, slug) -> SessionCookie`.
- `TestApp::open_ws_as_teacher(slug, cookie) -> WsClient`.
- `TestApp::open_ws_as_student(slug, email) -> WsClient`.
- `TestApp::capture_logs() -> LogCapture` — wraps a per-test
  buffered `tracing_subscriber` layer whose buffer lives on the
  `TestApp`. **The reliable isolation guarantee comes from
  `#[serial]`**, not from task-local subscriber scoping (which is
  not safe across the multi-threaded tokio runtime for log-
  capture purposes — R3 recommendation corrects R2's overstated
  claim). Every log-asserting test (`token-redacted-in-logs`,
  `csp-header-present`, etc.) carries the `#[serial]` attribute
  from the `serial_test` crate. Non-log tests run in parallel as
  usual. The buffered layer is installed inside the serialised
  critical section via `tracing::subscriber::set_default` and
  dropped on `TestApp::drop`, so it cannot leak into a parallel
  test.
- `WsClient::send`, `recv_timeout::<T>(Duration)`,
  `expect_next::<T>()`, `close()`, `abort()` (for TCP-RST
  simulation), `close_code()` (last observed close code).

All integration tests use these — no direct `reqwest` /
`tokio_tungstenite` in test bodies outside `common/`.

### 5.5 Test runtime budget + flaky policy

- Unit tests (`cargo test --lib`): target < 2 s.
- Integration tests (`cargo test --test '*'`): target < 45 s total
  (budget raised from 30 s to absorb added cases).
- Every integration test runs under a 10 s
  `tokio::time::timeout` wrapper to fail fast.
- Property tests capped at 256 cases default.
- **Flaky policy**: any intermittent failure is fixed by tightening
  synchronisation (`Notify` / `oneshot`), never by sleeping. No
  retry-on-failure loops in test code. Quarantine via `#[ignore]`
  with a tracking `// FINDING-N` comment only with council sign-off.
- Browser E2E is **manual** for this sprint. The exit criterion
  "data channel opens end-to-end and round-trips hello" is verified
  in `ws_session_handshake.rs` at the signalling layer, plus manual
  two-browser verification on two machines captured in the PR
  description (including observed ICE candidate types).

## 6. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `sqlx` offline query cache drifts silently from schema. | Med | Low | `cargo sqlx prepare` in the test script; check `.sqlx/` into git. CI step (Sprint 5) fails on drift. |
| R2 | Axum WS handlers hold `RwLock<RoomState>` across `.await` → deadlock. | Med | High | Clippy `await_holding_lock` deny'd; all mutations are `.await`-free; §4.6 rule; domain reviewer audits. |
| R3 | Magic-link token leaks via browser history / Referer / access logs. | Med | Med | **Token in URL fragment** (§4.3) → not sent to server; `no-referrer` header; URI redaction in tracing layer; single-use; 15 min TTL; `Cache-Control: no-store` on verify + consume. |
| R4 | Dev-mail file sink accumulates, stale link confuses developer. | Low | Low | Append-only JSONL; tests read **last** entry by email. Startup in `--dev` rotates to `.prev` so the current file starts empty. |
| R5 | WS signalling unauthenticated for students → lobby flood. | High | Med | `LOBBY_CAP_PER_ROOM`, inbound frame cap, `Signal.payload` cap, teacher `LobbyReject`, per-IP signup limit. Production per-IP WS limit is Sprint 5. |
| R6 | Session cookie without `Secure` in dev can leak over plain HTTP. | Low | Med | `--dev` is the only flag to drop `Secure`; binary refuses to start without `--dev` unless `BASE_URL` starts with `https://`. Release build rejects `--dev`. |
| R7 | In-memory `RoomState` lost on server restart. | Med | Low | Client retries on WS close 1012 with exponential backoff; teacher re-authenticates via persistent cookie. Accepted MVP. |
| R8 | Real-browser WebRTC edge cases surface only outside tests. | High | Med | Sprint 1 covers the **signalling** layer (browser-agnostic). Manual two-browser exit-criterion check feeds Sprint 3 browser-compat gating. |
| R9 | Magic-link race → two cookies for one link. | Low | High | Atomic consume UPDATE with `RETURNING`; §5.1 property test. |
| R10 | `rust-embed` rebuilds on every CSS edit. | Low | Low | `--dev` serves assets via `tower-http::ServeDir`; `rust-embed` release-only. |
| R11 | Cross-origin WebSocket hijack against authenticated teacher. | Med | High | Strict `Origin` check on every `/ws` upgrade (§4.7); 403 on mismatch; `http_origin` test asserts. (R1 finding #3.) |
| R12 | Outbound pump `JoinHandle` dropped → task leak. | Med | Med | `JoinHandle` retained for whole handler lifetime; joined-or-aborted in `cleanup()` (§4.15). Asserted implicitly by shutdown test — any leaked pump would keep the tokio runtime alive past shutdown. |

## 7. Exit criteria → test mapping

| SPRINTS.md exit criterion | Verified by |
|---|---|
| Teacher completes magic-link signup, lands on `/teach/<slug>` | `magic_link::test_signup_roundtrip`, `magic_link::test_consume_redirects_to_teach_slug` |
| Student visits URL, enters email, appears in teacher's lobby | `ws_lobby::test_student_join_visible_to_teacher` |
| Teacher admits, data channel opens, `hello` round-trips | `ws_session_handshake::test_full_sdp_exchange_over_signalling` + manual two-browser check (physical RTCDataChannel) |
| Disconnect on either side cleans up | `ws_session_handshake::test_student_disconnect_clears_session`, `test_teacher_disconnect_clears_session`, `test_tcp_rst_triggers_cleanup`, `ws_lobby::test_student_disconnect_removes_from_lobby` |

## 8. Decisions (previously "open questions", now resolved)

1. **Rate limiting: in scope.** 3 per email / 10 min; 10 per IP / 10 min. (§4.13, R1 finding #26.)
2. **Cookie name:** `sb_session`.
3. **Magic-link TTL:** 15 minutes.
4. **Session cookie TTL:** 30 days, **no refresh this sprint** (R1 finding #14). Refresh deferred to Sprint 5.
5. **Slug occupancy disclosure** on signup is an accepted product trade-off (§4.4, R1 finding #23).

## 9. Out of scope (explicitly deferred)

- Media tracks, DSP flags, codec munging → Sprint 2
- Video, UI polish, browser-compat gating → Sprint 3
- Bandwidth adaptation, reconnect UX, quality indicators → Sprint 4
- Azure / Cloudflare deploy, coturn, real SMTP, session log,
  production per-IP WS rate limits, session cookie refresh → Sprint 5
- Recording → Sprint 6

## 10. Implementation checklist (for the Editor)

1. Cargo project scaffold + `server/migrations/0001_initial.sql`.
2. `error::AppError` (§4.11) — all handlers return `Result<_, AppError>`.
3. `auth::slug` + unit tests (TDD-friendly; no deps).
4. `db` + `auth::magic_link` + concurrent-consume property test.
5. `auth::mailer` (dev sink, 0600 files) + `auth::rate_limit` + tests.
6. HTTP layer: tracing-redaction layer, security-headers layer,
   `/signup`, `/auth/verify` (HTML shim that references
   `/assets/verify.js`), `/auth/consume`, `/teach/<slug>`.
   Ship `web/assets/verify.js` alongside (R4 #48).
7. `state::RoomState` + proptest state machine including teacher reconnect.
8. `ws::protocol` (`ClientMsg` / `ServerMsg`) round-trip tests.
9. `ws::connection` (outbound pump with JoinHandle lifecycle).
10. `/ws` upgrade with Origin check + `ws::lobby` (admit + reject) +
    `ws_lobby*.rs` tests.
11. `ws::session` relay + `ws_session_handshake.rs` tests incl. TCP-RST.
12. Graceful shutdown + `ws_shutdown.rs` test (1012 close + delivery-before-close).
13. Browser client (`teacher.html`, `student.html`, `signalling.js`
    with symmetric `connectTeacher` / `connectStudent`,
    `verify.js`). Teacher UI renders student-supplied `email`,
    `browser`, `device_class` via `element.textContent = value`
    only — **no `innerHTML`** (R4 recommendation: prevent XSS from
    student-crafted strings in teacher's DOM).
14. Manual two-browser verification; record observed ICE candidate
    types (host / srflx / relay) in the PR description.
15. `./scripts/check-headers.py --sprint 1`; fix warnings.
16. Commit; `./scripts/council-review.py code 1 "signalling foundation"`.


---

# Sprint 2: high-fidelity bidirectional audio

_Archived: 2026-04-17_

# PLAN — Sprint 2: High-fidelity bidirectional audio

**Sprint:** 2
**Title:** High-fidelity bidirectional audio
**Status:** DRAFT (R4 — addresses FINDINGS_Sprint2.md R1 #1–#10 + R2 #11–#18 + R3 #19–#23)
**Last updated:** 2026-04-17

## 1. Problem statement

Sprint 1 delivered signalling + lobby + a data-channel handshake. This
sprint turns that data-channel handshake into a **real bidirectional
audio call**: both sides capture microphone audio with browser DSP
disabled, both sides play the remote audio with minimum buffering,
and the negotiated codec is Opus in music mode at 128 kbps stereo
with FEC. A dev-only debug overlay reports what actually landed, and
a dev-only loopback harness measures the real mic→speaker round-trip
on whichever machine is running the browser.

This sprint is **audio only**. No video (Sprint 3), no adaptation
(Sprint 4), no production deploy (Sprint 5). The browsers on both
sides are still only under manual two-machine verification; what we
automate here is the server-side toggle surface, the JS module
boundaries, and every piece of the pipeline that can be checked
without spinning up a WebRTC stack in tests — including the pure
SDP munger, which is tested under `node --test` in CI.

### Spec references

- `SPRINTS.md` §Sprint 2 — deliverables and exit criteria
- `knowledge/decisions/0001-mvp-architecture.md` §Media pipeline,
  §Browser compatibility (iOS Safari is "degraded" because it
  ignores several of these constraints — still proceed, flagged)

## 2. Current state (from codegraph)

`python3 scripts/index-codebase.py --stats` reports 38 files, 704
symbols, 6 models, 309 tests. Relevant to this sprint:

- **Browser client** (Sprint 1): `web/assets/signalling.js` owns the
  entire browser surface: `openWs`, `browserLabel`, `deviceClass`,
  class `Signalling`, `makePeerConnection`, `connectTeacher`,
  `connectStudent`. Currently: `iceServers` is the only `RTCPeerConnection`
  config; no `getUserMedia`, no tracks, no SDP munging. Student
  creates a data channel called `hello`; teacher accepts via
  `ondatachannel`. All module exports go through a single
  `window.signallingClient` global (no ES modules yet).
- **Teacher + student HTML** — `web/teacher.html`, `web/student.html`
  (~30 lines each). Student already carries the "Please wear
  headphones." line (Sprint 1 ADR-0001 compliance). Teacher HTML has
  no equivalent note.
- **Server HTTP** — `server/src/http/teach.rs` reads `teacher.html`
  or `student.html` from disk and returns the raw bytes. No
  templating. CSP is a fixed-string `EXPECTED_CSP` in
  `server/src/http/security_headers.rs`; `Permissions-Policy:
  camera=(self), microphone=(self), geolocation=()` is already in
  place.
- **Server config** — `Config.dev: bool` already exists
  (`server/src/config.rs`); used today to decide whether to emit HSTS
  and whether to require `Secure` on the session cookie. Sprint 2
  adds a third use: gate the debug marker + `/loopback` route.
- **Existing test harness** — `server/tests/common/mod.rs` exposes
  `spawn_app()` + `spawn_app_with(TestOpts)`. `TestOpts` today has
  `lobby_cap_per_room`, `max_active_rooms`, and the two rate-limit
  knobs — **`dev` is NOT yet a field**; the fixture always spawns a
  dev-mode server (it constructs `Config::dev_default()`). Sprint 2
  adds a `dev: bool` field and a `TestApp::get_html` helper.
- **CI** — `.github/workflows/ci.yml` runs header checks + pytest +
  bootstrap smoke. It does **not** yet run `cargo test` (called out
  in Sprint 1 and deferred to Sprint 5). Sprint 2 adds one new step:
  `node --test web/assets/tests/`, which needs no toolchain setup
  (ubuntu-latest ships Node 18+ by default) and so is cheap to land
  without pulling forward Sprint 5's CI work.
- **Signalling protocol** — `server/src/ws/protocol.rs`. Sprint 2
  adds **no new wire messages**. Opus SDP + ICE candidates travel
  inside the existing `Signal.payload: serde_json::Value`. This is a
  deliberate non-change: keeping the signalling protocol stable
  through media bring-up reduces blast radius.

## 3. Proposed solution

Five JS files added under `web/assets/`, one HTML page for the
dev-only harness, one JS worklet file, narrow changes to two
server-side handlers. Load-order, debug-gating, and teardown are
specified in one place each.

**Module surface (single contract, used end-to-end):**

```js
// web/assets/sdp.js  (UMD; browser + Node)
//   Exports: { mungeSdpForOpusMusic(sdp) -> sdp, SDP_FIXTURES, OPUS_MUSIC_FMTP }

// web/assets/audio.js (browser only, plain <script>; attaches to window.sbAudio)
//   Exports: { startLocalAudio() -> {stream, track, settings},
//              attachRemoteAudio(trackEvent) -> void,
//              detachRemoteAudio() -> void,
//              hasTrack(stream, id) -> boolean }   // pure, Node-testable
//   Imports: window.sbSdp.mungeSdpForOpusMusic
//
//   Contract for attachRemoteAudio:
//     - Argument: an RTCTrackEvent (the event object passed to
//       RTCPeerConnection#ontrack). The function reads ev.track and
//       ev.receiver from it.
//     - DOM target: the <audio id="remote-audio"> element that both
//       teacher.html and student.html carry.
//     - Idempotent: calling twice with the same track is a no-op;
//       duplicate detection is delegated to the pure helper
//       `hasTrack(stream, id)` (extracted so Node can test it
//       without a DOM; see §4.5).
//     - If el.play() rejects (autoplay blocked), surfaces an
//       "Click to enable audio" button that invokes el.play() on
//       click. See §4.5.

// web/assets/debug-overlay.js (browser only; self-gated)
//   Exports: { startDebugOverlay(pc, {localTrack}) -> {stop()} }
//   Self-gates: if document.querySelector('meta[name="sb-debug"]')
//               is null, startDebugOverlay returns a no-op { stop(){} }.
//   No dependency on any window.SB_* mutable global.

// web/assets/loopback.js (dev-only harness; uses AudioWorkletNode)
// web/assets/loopback-worklet.js (AudioWorklet module, loaded via
//                                 audioContext.audioWorklet.addModule)
//
//   Data transport between worklet and main thread is ONLY
//   `MessagePort.postMessage(ArrayBuffer)` — no SharedArrayBuffer.
//   This avoids the COOP/COEP cross-origin-isolation requirement
//   (finding #11) so `/loopback` can keep the default
//   security-headers middleware unchanged.
```

Signalling wiring (§4.4) invokes these at well-defined points.
`debug-overlay.js` is loaded on both teach HTMLs unconditionally
(same static-asset byte budget in dev vs prod — no behavioural
difference); the **only** debug signal is the server-injected
`<meta name="sb-debug">`. `window.SB_DEBUG` does not exist.

Two **narrow server changes:**

1. `server/src/http/teach.rs` does a single string replace of the
   literal token `<!-- sb:debug -->` in the served HTML. When
   `config.dev == true`, the replacement is `<meta name="sb-debug"
   content="1">`; when `false`, the replacement is the empty string.
   The token is a static literal we control; the replacement is one
   of two compile-time constants. No user input participates.
2. A new `/loopback` route in `server/src/http/mod.rs` returns
   `loopback.html` when `config.dev`, and 404s otherwise. Covered by
   the existing security-headers layer. The handler uses `?` on
   `tokio::fs::read_to_string` to preserve the typed `io::Error`
   via the existing `From<std::io::Error>` impl on `AppError`
   (finding #7).

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep SDP munging out of the browser; proxy + rewrite on the Rust server | The server currently does not parse SDP — it forwards `Signal.payload` opaquely (ADR-0001 + `knowledge/architecture/signalling.md`). Introducing SDP parsing server-side adds a WebRTC code path we don't otherwise need and a new surface of protocol quirks. Munging is a pure client-side text transform. |
| Use `RTCRtpSender.setParameters` instead of SDP munging | `setParameters` doesn't cover `stereo`, `useinbandfec`, or `cbr` — those must land in the Opus `fmtp` line. Munging is the standard pattern for these exact parameters. |
| Emit the debug marker via a nonced inline `<script>window.SB_DEBUG=true</script>` | Would force `script-src 'nonce-...'` plumbing and relax CSP away from `'self'`. A static `<meta>` tag is CSP-clean. |
| Run SDP munger tests only as browser-page self-tests | Fails finding #1: self-tests don't execute in CI. Node's built-in test runner is zero-install on ubuntu-latest; adding one `node --test` step covers the highest-risk transform in the sprint. |
| Keep a `window.SB_DEBUG` mirror alongside the meta tag | Two signals mean two ways to be wrong (finding #3). One server-controlled source truth. |
| Ship a full browser E2E harness (Playwright) this sprint | Significant tooling addition. The features this sprint delivers are best verified against real audio hardware anyway. Revisit Sprint 3 for browser-compat gating. |
| Merge `debug-overlay.js` into `audio.js` | Mixing concerns makes the overlay harder to verify as "off in prod." Keeping them separate lets the CSP / no-`sb-debug`-meta test verify that the overlay cannot activate in release, independent of the audio code. |
| Use `ScriptProcessorNode` for the loopback harness | `ScriptProcessorNode` is deprecated and runs on the main thread. `AudioWorkletNode` runs on the audio render thread (lower, more consistent latency) and is what the measurement is for. Commit to it (finding #9). |
| Use `SharedArrayBuffer` to stream samples from the worklet | Requires cross-origin isolation (COOP: `same-origin` + COEP: `require-corp`) either globally or route-scoped. Global would break `<iframe>`, the dev-mail file sink, and future Cloudflare CDN-fronted assets; route-scoped only for `/loopback` is workable but leaks the isolation requirement into security middleware for a dev-only tool. `MessagePort.postMessage(ArrayBuffer)` with transfer covers our throughput (~5 s of 48 kHz mono ≈ 480 kB total, transferred in ≤ 1 kB chunks) with zero infrastructure cost (finding #11). |

## 4. Component-by-component design

### 4.1 File layout (delta)

```
web/
  teacher.html            [ modified: +headphones note + why-tooltip
                            +debug container + sb:debug placeholder
                            +<audio id="remote-audio" ...>
                            +<script src="/assets/sdp.js"></script>
                            +<script src="/assets/audio.js"></script>
                            +<script src="/assets/debug-overlay.js"></script> ]
  student.html            [ modified: +why-tooltip +debug container
                            +sb:debug placeholder +remote-audio
                            +the same three script tags ]
  loopback.html           [ NEW: dev-only latency harness page ]
  assets/
    sdp.js                [ NEW: pure SDP munger, UMD export ]
    audio.js              [ NEW: getUserMedia + remote attach ]
    debug-overlay.js      [ NEW: self-gated overlay + teardown ]
    loopback.js           [ NEW: dev-only harness ]
    loopback-worklet.js   [ NEW: AudioWorklet capture processor ]
    signalling.js         [ modified: addTrack + SDP munge + ontrack ]
    teacher.js            [ modified: wire up local audio + teardown ]
    student.js            [ modified: wire up local audio + teardown ]
    styles.css            [ modified: overlay, tooltip, unmute button ]
    tests/
      sdp.test.js         [ NEW: Node --test; runs in CI ]
      audio.test.js       [ NEW: Node --test for hasTrack predicate ]

server/src/http/
  teach.rs                [ modified: inject sb:debug replacement ]
  mod.rs                  [ modified: add /loopback route ]
  loopback.rs             [ NEW: get_loopback handler, dev-gated ]
server/tests/
  common/mod.rs           [ modified: TestOpts.dev field;
                            TestApp::get_html helper ]
  http_teach_debug_marker.rs [ NEW ]
  http_loopback.rs        [ NEW ]
  http_csp.rs             [ modified: parameterise all_html_responses_carry_csp
                            over dev/prod ]
.github/workflows/ci.yml  [ modified: +step `node --test web/assets/tests/` ]
package.json              [ NEW: `{"private": true, "type": "commonjs"}` — one
                            line, zero deps; tells Node to treat .js as CJS ]
```

No new Rust crate dependencies. No changes to `ws/protocol.rs`,
`state.rs`, or `migrations/`.

### 4.2 `getUserMedia` constraints (audio.js §startLocalAudio)

```js
const AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate: 48000,
  },
  video: false,
};

async function startLocalAudio() {
  const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
  const [track] = stream.getAudioTracks();
  return { stream, track, settings: track.getSettings() };
}
```

iOS Safari ignores `echoCancellation:false` and `sampleRate:48000`.
That is accepted and surfaced via the degraded flag in Sprint 3.
The debug overlay (§4.7) displays the delta between requested and
observed settings. No automatic fallback here — if the browser
rejects the full constraint set, the caller surfaces the error in
the session status line and does not retry with relaxed constraints
(that belongs with Sprint 3's compatibility gating).

### 4.3 Opus music-mode SDP munging (sdp.js — separate module, CI-tested)

```js
// web/assets/sdp.js  —  UMD (browser global + Node module)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.sbSdp = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPUS_MUSIC_FMTP =
    'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;' +
    'useinbandfec=1;cbr=0;usedtx=0;maxplaybackrate=48000';

  const SDP_FIXTURES = Object.freeze({
    chrome_121_offer:   /* real Chrome SDP capture, \r\n */,
    firefox_122_offer:  /* real Firefox SDP capture, \r\n */,
    safari_17_offer:    /* real Safari SDP capture, PT 109, \r\n */,
    no_opus:            /* synthetic PCMU-only SDP */,
    already_munged:     /* output of mungeSdpForOpusMusic on chrome_121 */,
    two_opus_pts:       /* two rtpmap: opus/48000/2 lines (109 and 111) */,
    empty_fmtp:         /* a=fmtp:111 with no params, must upsert */,
    trailing_rtpmap:    /* opus rtpmap on the final line, no following fmtp */,
    mixed_line_endings: /* half \r\n, half \n, must preserve each line's ending */,
  });

  function mungeSdpForOpusMusic(sdp) { /* see algorithm below */ }

  return { mungeSdpForOpusMusic, SDP_FIXTURES, OPUS_MUSIC_FMTP };
});
```

**Algorithm** (line-oriented; preserves per-line ending):

1. Split on `(\r?\n)` with a capture group so each line retains the
   exact newline sequence that followed it (`\r\n`, `\n`, or none for
   the final line if the SDP is unterminated — real SDPs always end
   with an EOL but we tolerate either).
2. Walk tokens. For every `a=rtpmap:<PT> opus/48000/2` line
   (case-insensitive on `opus`), record `<PT>`.
3. For each recorded `<PT>`:
   - If an `a=fmtp:<PT> ...` line exists anywhere in the SDP,
     **replace** its parameter list with `OPUS_MUSIC_FMTP`,
     preserving its original newline.
   - If no matching fmtp exists, **insert** a new line
     `a=fmtp:<PT> ${OPUS_MUSIC_FMTP}` immediately after the rtpmap
     line, using the same newline the rtpmap line had. If the
     rtpmap is the final line (no trailing EOL), synthesise a newline
     that matches the document's majority line-ending (tie-breaker:
     `\r\n`).
4. Reassemble and return.

**Invariants** (asserted by the Node test suite in §5.1):

- **Idempotent**: `munge(munge(sdp)) === munge(sdp)`.
- **Non-Opus m-lines untouched**: every byte outside Opus rtpmap /
  fmtp regions is preserved (property holds once Sprint 3 adds
  video).
- **No-Opus passthrough**: returned byte-identical when no
  `opus/48000/2` rtpmap exists.
- **Multiple Opus PTs**: params applied to every matching PT.
- **Upsert, not append**: existing `a=fmtp` replaced, not duplicated.
- **Empty fmtp replaced**: `a=fmtp:111` with no params is transformed
  to `a=fmtp:111 ${OPUS_MUSIC_FMTP}`.
- **Trailing-rtpmap insertion**: Opus rtpmap as the final line
  produces a correctly terminated new fmtp line.
- **Mixed line endings**: input with both `\r\n` and `\n` produces
  output where each line keeps its original ending; inserted lines
  match the ending of their anchor rtpmap.

### 4.4 Track wiring (signalling.js delta)

**Student (offerer):**

1. On lobby admit / peer_connected: `startLocalAudio()` →
   `{stream, track, settings}`.
2. `pc.addTrack(track, stream)`.
3. `createOffer()` → `offer.sdp = window.sbSdp.mungeSdpForOpusMusic(offer.sdp)`
   → `setLocalDescription(offer)` → send over WS.
4. On `ontrack` (the teacher's audio): the shared handler delegates
   to `window.sbAudio.attachRemoteAudio(ev)`.
5. The existing `hello` data channel is **kept** this sprint — a
   cheap liveness check during manual testing. Removed in Sprint 3.

**Teacher (answerer):**

1. On `peer_connected`: `startLocalAudio()` → add track.
2. On the student's offer: `setRemoteDescription(offer)` →
   `createAnswer()` → `answer.sdp =
   window.sbSdp.mungeSdpForOpusMusic(answer.sdp)` →
   `setLocalDescription(answer)` → send.
3. `ontrack` delegates identically.

**Shared helper (signalling.js):**

```js
async function wireBidirectionalAudio(pc, onStatus) {
  const local = await window.sbAudio.startLocalAudio();
  pc.addTrack(local.track, local.stream);
  pc.ontrack = (ev) => window.sbAudio.attachRemoteAudio(ev);
  const stateListener = () =>
    onStatus && onStatus({ state: pc.connectionState });
  pc.addEventListener('connectionstatechange', stateListener);
  return {
    local,
    teardown() {
      pc.removeEventListener('connectionstatechange', stateListener);
      window.sbAudio.detachRemoteAudio();
      local.stream.getTracks().forEach((t) => t.stop());
    },
  };
}
```

`teardown()` is invoked by the caller from `onPeerDisconnected` and
from `hangup()`. This closes the mic capture (stops the red LED),
detaches the remote audio, and clears the state listener.

### 4.5 Remote-audio playout (audio.js §attachRemoteAudio)

**Contract** (single form, used consistently in HTML, signalling,
and tests):

```js
// Pure predicate — extracted so Node can test it without a DOM
// (finding #13). Exported via window.sbAudio.hasTrack.
function hasTrack(stream, id) {
  if (!stream || typeof stream.getTracks !== 'function') return false;
  if (!id || typeof id !== 'string') return false;
  return stream.getTracks().some((t) => t && t.id === id);
}

// argument: an RTCTrackEvent (from RTCPeerConnection#ontrack)
// returns: void
function attachRemoteAudio(ev) {
  const el = document.getElementById('remote-audio');
  if (!el) return;                         // page without the element
  if (!el.srcObject) el.srcObject = new MediaStream();
  if (hasTrack(el.srcObject, ev.track.id)) return;   // idempotent (finding #5)
  el.srcObject.addTrack(ev.track);
  try { ev.receiver.playoutDelayHint = 0; } catch (_) {}
  const p = el.play();
  if (p && typeof p.then === 'function') {
    p.catch(() => showUnmuteAffordance(el));   // autoplay blocked
  }
}

function detachRemoteAudio() {
  const el = document.getElementById('remote-audio');
  if (el && el.srcObject) {
    for (const t of el.srcObject.getTracks()) el.srcObject.removeTrack(t);
    el.srcObject = null;
  }
  hideUnmuteAffordance();
}

function showUnmuteAffordance(el) {
  const btn = document.getElementById('unmute-audio');
  if (!btn) return;
  btn.hidden = false;
  btn.onclick = () => { btn.hidden = true; el.play().catch(() => {}); };
}
function hideUnmuteAffordance() {
  const btn = document.getElementById('unmute-audio');
  if (btn) btn.hidden = true;
}
```

`<button id="unmute-audio" hidden>Click to enable audio</button>`
lives inside both `teacher.html` and `student.html` status sections.
Same textContent-only discipline as the rest of the teacher UI.

`playoutDelayHint = 0` is a hint, not a guarantee. Browsers
interpret it as "minimise de-jitter buffer consistent with audio
quality." The value landed on is read from `getStats()` and shown
in the debug overlay.

### 4.6 Headphones setup note + "why" tooltip

**Student (`student.html`)** — the existing `<p>Please wear headphones.</p>`
is replaced with:

```html
<p class="setup-note">Please wear headphones.
  <details class="why">
    <summary>Why?</summary>
    We've turned off browser echo cancellation so your voice sounds
    natural. Headphones stop your teacher's voice bouncing back into
    your microphone.
  </details>
</p>
```

**Teacher (`teacher.html`)** — the same block is added inside the
Session section. Teacher also needs headphones (AEC is off both
ways).

`<details>` / `<summary>` is native HTML disclosure — no JS, no
inline style, passes CSP. Keyboard-accessible by default.

### 4.7 Debug overlay (debug-overlay.js, self-gated)

**Loaded unconditionally** on `teacher.html` / `student.html` via
plain `<script src="/assets/debug-overlay.js">`. The overlay activates
only if `document.querySelector('meta[name="sb-debug"]')` is
non-null — which it is only when the server injected the marker
(i.e. only when `config.dev`).

```js
// Exported surface (finding #17, #19 — track passed in explicitly via opts;
// the overlay never reaches into audio.js internals to find it):
//   startDebugOverlay(pc, opts) -> { stop() }
//   opts.localTrack — the RTCRtpSender's underlying MediaStreamTrack
//
// All rendering functions (renderSdp, renderStats, renderSettings)
// write exclusively via element.textContent — no innerHTML, no
// inline HTML interpolation anywhere in this module (finding #22).
function startDebugOverlay(pc, opts) {
  var enabled = !!document.querySelector('meta[name="sb-debug"]');
  if (!enabled) return { stop: function () {} };   // no-op in prod

  var container = document.getElementById('sb-debug');
  if (!container) return { stop: function () {} };
  var panel = buildPanel();                        // textContent only
  container.append(panel);
  var localTrack = opts && opts.localTrack ? opts.localTrack : null;

  var stopped = false;
  var tick = function () {
    if (stopped || !pc) return;
    Promise.resolve()
      .then(function () { return pc.getStats(); })
      .then(function (stats) {
        if (stopped) return;
        renderStats(panel.__body, stats);
        renderSdp(panel.__body, pc.localDescription, pc.remoteDescription);
        renderSettings(panel.__body, localTrack);
      })
      .catch(function () { /* swallow; overlay is non-critical */ });
  };
  var interval = setInterval(tick, 1000);
  tick();

  return {
    stop: function () {
      stopped = true;
      clearInterval(interval);
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    },
  };
}
```

The caller (signalling.js) passes the local track from
`wireBidirectionalAudio` explicitly:
`window.sbDebug.startDebugOverlay(pc, { localTrack: audio.local.track })`.
Both `connectTeacher` and `connectStudent` use this form consistently.

**textContent-only contract (finding #22):** `buildPanel`, `setRow`,
`renderSdp`, `renderStats`, and `renderSettings` may only write to the
DOM via `element.textContent`. Use of `innerHTML`, `insertAdjacentHTML`,
or `on*` attributes is prohibited. `setRow` is the single write path;
all renders delegate through it.

**Teardown contract (finding #6):** the caller (signalling.js)
invokes `.stop()` from `onPeerDisconnected` and from `hangup()`,
alongside `wireBidirectionalAudio`'s `teardown()`. `startDebugOverlay`
returns a handle in **every** path, so the caller always has a
`.stop()` to call — including the no-op branch in production.

No PII in the overlay. Email / slug are never rendered there. Shown
fields:

- Opus fmtp params from local + remote SDP (stereo, bitrate, FEC).
- `track.getSettings()` for local audio: `echoCancellation`,
  `noiseSuppression`, `autoGainControl`, `sampleRate`, `channelCount`.
  Each flag is colour-coded green when the requested value was
  honoured.
- From `getStats()` (`inbound-rtp`, `outbound-rtp`, `remote-inbound-rtp`,
  `candidate-pair` reports filtered to `kind === 'audio'`):
  `packetsLost`, `jitter`, `roundTripTime`, `audioLevel`.

### 4.8 Loopback latency harness (loopback.html + loopback.js +
loopback-worklet.js; dev only)

**Primitive: `AudioWorkletNode`** (committed per finding #9).
**Data transport: `MessagePort.postMessage(ArrayBuffer)` with
transfer**, not `SharedArrayBuffer` (finding #11) — avoids the
COOP/COEP route-scoped-isolation requirement and keeps the security
middleware unchanged.

**loopback-worklet.js** — an `AudioWorkletProcessor` that receives
input samples (one channel, Float32), slices each `process()` call's
buffer, and `this.port.postMessage(buf.buffer, [buf.buffer])` —
zero-copy transfer of a fresh ArrayBuffer per block. Lives on the
audio render thread; the measurement does not jank the main thread.

**loopback.js** — main-thread driver:

```js
const SAMPLE_RATE = 48000;
const PULSE_HZ = 1000;
const PULSE_MS = 5;
const PULSE_COUNT = 10;              // named constant (finding #10)
const PULSE_SPACING_MS = 500;
```

On "Start":
1. Request mic via `getUserMedia({audio: {...DSP off}, video: false})`.
2. Create `AudioContext({sampleRate: 48000, latencyHint: 'interactive'})`.
3. `audioContext.audioWorklet.addModule('/assets/loopback-worklet.js')`.
4. Connect `MediaStreamAudioSourceNode` → `AudioWorkletNode` (capture).
5. Schedule `PULSE_COUNT` `OscillatorNode` bursts via
   `oscillator.start(t)`; record each scheduled `t` as the "emit time."
6. Worklet streams input frames to the main thread via
   `port.onmessage`; main thread appends each `Float32Array(buf)` to
   a growing array. No `SharedArrayBuffer`, no COOP/COEP.
7. For each emit time: cross-correlate the mic buffer (windowed
   around `t + expected_delay_range`) against a reference pulse;
   the argmax gives observed arrival time; round-trip =
   `arrival - emit - audioContext.baseLatency - audioContext.outputLatency`.
8. After `PULSE_COUNT` emits, compute mean / median / p95 / stddev;
   render on the page AND log to `console.log` prefixed
   `sb.loopback:`.

**Accuracy posture:** measurement, not a test. We do not assert a
specific number (SPRINTS.md exit criterion: "recorded, not gated
against"). The harness is here so subjective audio quality
complaints later can be triaged against a concrete number from the
same device.

**Safety:** the page lives at `/loopback`, served only when
`config.dev`. In release it 404s (route not registered). The page
never speaks to `/ws`, never calls `getUserMedia` before the user
clicks Start.

**No COOP/COEP headers are added** — because the design does not
use `SharedArrayBuffer`, the route stays under the default
security-headers middleware. An assertion in `http_loopback.rs`
(§5.2) confirms `/loopback` does NOT carry
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
(regression guard: any future reintroduction of `SharedArrayBuffer`
would break that test and force an explicit design decision).

### 4.9 Server-side changes

**`server/src/http/teach.rs`** — extraction into a pure helper
`inject_debug_marker(html: String, dev: bool) -> String` that
short-circuits with `return html` when `dev == false` (finding #23 —
hot-path scan avoided in prod):

```rust
fn inject_debug_marker(html: String, dev: bool) -> String {
    if !dev {
        return html;                // prod: zero allocations, zero scan
    }
    html.replace("<!-- sb:debug -->", r#"<meta name="sb-debug" content="1">"#)
}
```

`get_teach` calls `inject_debug_marker(html, state.config.dev)` after
the file read. The production path returns the string unchanged without
scanning it for the placeholder. The loopback handler (new code,
finding #7) uses bare `?` for file reads:

**`server/src/http/loopback.rs`** (new):

```rust
pub async fn get_loopback(
    State(state): State<Arc<AppState>>,
) -> Result<Response> {
    if !state.config.dev {
        return Err(AppError::NotFound);
    }
    let html_path = state.config.static_dir.join("loopback.html");
    let html = tokio::fs::read_to_string(&html_path).await?;   // io::Error → AppError::Io
    Ok(Html(html).into_response())
}
```

**`server/src/http/mod.rs`** — add
`.route("/loopback", get(loopback::get_loopback))`. No middleware
changes: the security-headers layer already applies to every HTML
route.

**No CSP changes.** Overlay + loopback assets are served from
`/assets/*` (same-origin). `<audio>` elements playing a
`MediaStream` don't fetch anything. `<details>`/`<summary>` is plain
HTML. `AudioContext` / `getUserMedia` are governed by
`Permissions-Policy`, which already grants `microphone=(self)`.

### 4.10 Test harness deltas

**`server/tests/common/mod.rs`:**

```rust
pub struct TestOpts {
    pub lobby_cap_per_room: usize,
    pub max_active_rooms: usize,
    pub signup_rate_limit_per_email: usize,
    pub signup_rate_limit_per_ip: usize,
    pub dev: bool,
}

// Default is HAND-WRITTEN (not `derive(Default)`, which would set
// `dev = false`) so that existing Sprint 1 tests keep their
// dev-mode semantics. Finding #12.
impl Default for TestOpts {
    fn default() -> Self {
        Self {
            lobby_cap_per_room: 32,
            max_active_rooms: 1024,
            signup_rate_limit_per_email: 999_999,
            signup_rate_limit_per_ip: 999_999,
            dev: true,
        }
    }
}

impl TestApp {
    // NEW helper — used by http_teach_debug_marker + http_loopback + http_csp.
    pub async fn get_html(
        &self,
        path: &str,
        cookie: Option<&str>,
    ) -> (reqwest::StatusCode, reqwest::header::HeaderMap, String) {
        let mut req = self.client.get(self.url(path));
        if let Some(c) = cookie {
            req = req.header("cookie", format!("sb_session={c}"));
        }
        let r = req.send().await.unwrap();
        let status = r.status();
        let headers = r.headers().clone();
        let body = r.text().await.unwrap_or_default();
        (status, headers, body)
    }
}
```

`spawn_app_with` applies `opts.dev` to `Config.dev`. When
`opts.dev == false`, it also sets `base_url` to `https://localhost`
to satisfy the release-config invariant from Sprint 1 (which
refuses `dev=false` with `http://` base URLs).

## 5. Test Strategy

### 5.1 Property / invariant coverage

**JS side — `sdp.js §mungeSdpForOpusMusic`** runs in **CI** via
`node --test web/assets/tests/sdp.test.js` (finding #1). The test
file uses Node's built-in `node:test` module — zero deps, zero
install on ubuntu-latest. CI step:

```yaml
- name: JS tests (SDP munger)
  run: node --test web/assets/tests/
```

Property asserts, one `test(...)` block each:

| Property | Check |
|---|---|
| Idempotence | `munge(munge(f)) === munge(f)` for every fixture. |
| Upsert (no duplicate fmtp) | Post-munge, `grep 'a=fmtp:<PT>'` count equals pre-munge count (or pre+1 when pre was 0). |
| Multiple Opus PTs | `two_opus_pts` fixture → both PTs carry `OPUS_MUSIC_FMTP`. |
| No-Opus passthrough | `no_opus` fixture → returned byte-identical. |
| Line ordering preserved | For each fixture, rtpmap line index ≤ matching fmtp line index. |
| Line endings preserved | `mixed_line_endings` fixture → each output line keeps its original `\r\n` or `\n`; inserted lines match the ending of their anchor rtpmap. |
| Empty fmtp replacement (finding #4) | `empty_fmtp` → `a=fmtp:111 ${OPUS_MUSIC_FMTP}`, exactly once. |
| Trailing-rtpmap insertion (finding #4) | `trailing_rtpmap` → final output contains a well-terminated fmtp line following the rtpmap. |

Fixtures for real browsers (`chrome_121_offer`, `firefox_122_offer`,
`safari_17_offer`) are captured during the manual two-machine
verification phase of this sprint (finding #10: explicit deliverable)
and committed as string literals in `sdp.js` before merge. Any later
browser regression is caught by re-running `node --test`.

**Rust side** — `state::RoomState` and `ws::protocol` invariants
from Sprint 1 are untouched this sprint. Re-running their existing
property tests acts as an unchanged regression guard.

Property test budget: Node suite completes in < 1 s on CI. Rust
property tests keep their `PROPTEST_CASES=256` default.

### 5.2 Failure-path coverage

**Server — debug marker (`http_teach_debug_marker.rs`):**

- `test_dev_teach_html_carries_debug_marker`: `spawn_app_with(dev=true)`,
  GET `/teach/<slug>` via `TestApp::get_html` without a cookie
  (student view); assert body contains `<meta name="sb-debug" content="1">`
  and does NOT contain the literal placeholder `<!-- sb:debug -->`.
- `test_dev_teacher_html_carries_debug_marker`: same, with
  authenticated slug-owner cookie (teacher view).
- `test_prod_teach_html_has_no_debug_marker`:
  `spawn_app_with(dev=false)`, assert body does NOT contain
  `sb-debug` (neither marker nor placeholder) and still carries
  the CSP header.

**Server — `/loopback` route (`http_loopback.rs`):**

- `test_dev_loopback_serves_html`: `dev=true`, GET `/loopback` →
  200, `Content-Type: text/html`, body starts with `<!doctype html>`
  and contains the deterministic DOM identifier
  `id="loopback-start"` (the Start button, guaranteed present by
  the harness layout; finding #15). The test also asserts the
  response does NOT carry `cross-origin-opener-policy` or
  `cross-origin-embedder-policy` (finding #11 regression guard).
- `test_prod_loopback_returns_404`: `dev=false`, GET `/loopback` →
  404. Response carries the CSP header (proves the not-found path
  still runs the security-headers middleware).
- `test_loopback_missing_file_returns_internal_error` (finding #10):
  `dev=true`, with `Config.static_dir` pointed at an empty temp dir;
  GET `/loopback` → 500 with `ErrorBody.code == "internal"`. Asserts
  the `io::Error → AppError::Io` conversion path works (finding #7).

**Server — CSP parameterisation (`http_csp.rs`, finding #8):**

- Refactor existing `test_all_html_responses_carry_csp` into a
  helper that takes a list of paths + `dev: bool`, and call it
  twice:
  - `test_all_html_responses_carry_csp_dev`: `dev=true`, paths =
    `["/", "/signup", "/auth/verify", "/loopback"]`.
  - `test_all_html_responses_carry_csp_prod`: `dev=false`, paths =
    `["/", "/signup", "/auth/verify"]`. Also asserts GET
    `/loopback` → 404 **but still with CSP** in the error response.

**JS — SDP munger failure cases (sdp.test.js):**

- Real-browser fixture with Opus fmtp containing third-party params
  (`x-google-min-bitrate=...`): upsert replaces the full parameter
  list with `OPUS_MUSIC_FMTP` (intended — canonical set). Asserted.
- Safari fixture with Opus at PT 109 rather than 111: upsert
  finds the rtpmap by its `opus/48000/2` signature, not by a fixed
  PT. Asserted.
- Already-munged input (`already_munged`): `munge(x) === x`.
  Asserted (implied by idempotence property).

**JS — debug-overlay gating** (asserted via the server-side
prod-marker-absent test):

`test_prod_teach_html_has_no_debug_marker` indirectly guarantees
`startDebugOverlay` cannot activate in release, because its gate
is the DOM presence of the marker. No JS-side test framework is
added for this (unit-testing the overlay would need a DOM shim
like jsdom, not justified this sprint).

**JS — remote-audio idempotency and autoplay recovery
(finding #5, #20):**

- **Idempotency**: `attachRemoteAudio` uses `ev.track.id` to
  detect duplicate-attach. The pure predicate `hasTrack(stream, id)`
  is Node-tested in `web/assets/tests/audio.test.js` with six tests
  covering all four equivalence classes:
  1. `hasTrack(stream, id)` → `true` when id is present in the stream.
  2. `hasTrack(stream, id)` → `false` when id is absent.
  3. `hasTrack(emptyStream, id)` → `false` for an empty track list.
  4. `hasTrack(null/undefined/{}, id)` → `false` for null/invalid stream.
  5. `hasTrack(stream, '')` / `hasTrack(stream, null)` / `hasTrack(stream, 42)` → `false` for invalid id.
  6. `hasTrack(streamWithNullEntries, id)` → tolerates null entries in the tracks array.
  Full DOM integration (the `attachRemoteAudio` call itself) remains
  under manual verification.
- **Autoplay recovery**: asserted at the **manual** exit-criterion
  check. The PR description must document: on Safari
  desktop, trigger "Autoplay blocked" state (by using "Never
  Allow Auto-play" in Safari preferences for the dev host); confirm
  the "Click to enable audio" button appears and restores playback
  after one click. This is a documented manual step, not an
  automated test, but it is a deliverable.

**Manual (two-machine) failure paths** — the exit criterion that
cannot be automated without a browser E2E harness. The PR
description must include:

- Observed `a=fmtp` line for Opus on both teacher and student sides
  (copy-paste from `chrome://webrtc-internals` or from the debug
  overlay). Must show `stereo=1`, `maxaveragebitrate=128000`,
  `useinbandfec=1`, `cbr=0`.
- `track.getSettings()` for the local audio on both sides.
- A loopback-harness reading on at least one machine (mean /
  median / p95 over `PULSE_COUNT` pulses). Recorded, not gated.
- Subjective listening statement: both sides hear the other at
  high fidelity (no pumping, pitch-natural, sibilants + low
  fundamentals present).
- Autoplay-blocked recovery, one browser (per finding #5 above).
- The three real-browser SDP fixtures captured during this phase
  and committed to `sdp.js` before merge (finding #10).

### 5.3 Regression guards (R1 plan findings + carry-overs)

| Finding | Guard |
|---|---|
| R1 #1 (SDP munger CI coverage) | `node --test web/assets/tests/` runs in CI on every PR. Adding/modifying the munger without matching test updates fails the pipeline. |
| R1 #2 (`attachRemoteAudio` contract consistency) | §3 module surface, §4.5 implementation, and the HTML skeletons (§4.1, §4.6) all name `remote-audio` as the element id and `RTCTrackEvent` as the argument. Two Rust tests own the structural assertion: `test_dev_teach_html_carries_debug_marker_student_view` asserts `student.html` carries `id="remote-audio"` and `id="unmute-audio"`; `test_dev_teach_html_carries_debug_marker_teacher_view` does the same for `teacher.html` (both in `server/tests/http_teach_debug_marker.rs`, finding #21). |
| R1 #3 (single debug gate) | `window.SB_DEBUG` is not referenced in any committed JS (grep-able guard — add `rg 'SB_DEBUG' web/assets` to the sprint-exit checklist and fail if non-zero). Overlay's self-gate reads only the meta tag. |
| R1 #4 (boundary fixtures) | Fixtures `empty_fmtp`, `trailing_rtpmap`, `mixed_line_endings` present in `SDP_FIXTURES` and asserted in §5.1. |
| R1 #5 (remote audio duplicate + autoplay) | Pure predicate tested in Node; autoplay recovery under manual check as documented. |
| R1 #6 (overlay teardown) | `startDebugOverlay(pc)` always returns `{stop()}`; caller invokes `stop()` from `onPeerDisconnected` and `hangup()`. |
| R1 #7 (io::Error propagation) | `get_loopback` uses bare `?`; `test_loopback_missing_file_returns_internal_error` covers the path. |
| R1 #8 (CSP test parameterisation) | Two dedicated tests; `/loopback` present in dev list, absent in prod list, 404-with-CSP asserted for prod. |
| R1 #9 (loopback primitive) | §4.8 commits to `AudioWorkletNode`; `loopback-worklet.js` listed in §4.1 file layout. |
| R1 #10 (misc. tracking) | `TestApp::get_html` helper in §4.10; loopback missing-file test in §5.2; real-browser SDP fixture capture in §5.2 manual deliverables + §5.1 fixtures; `PULSE_COUNT` constant in §4.8. |
| R2 #11 (SharedArrayBuffer / COOP-COEP) | Design uses MessagePort only (§4.8); `http_loopback.rs` asserts absence of COOP/COEP headers (§5.2); grep guard `rg 'SharedArrayBuffer' web/assets` at sprint exit (§10 step 21). |
| R2 #12 (`TestOpts.dev` default) | Hand-written `impl Default for TestOpts` sets `dev: true` explicitly; no `derive(Default)` (§4.10). Existing `spawn_app()` keeps Sprint 1 semantics. |
| R2 #13 (`hasTrack` contract) | Extracted to pure function in `audio.js`; `attachRemoteAudio` delegates (§4.5); Node-tested in `web/assets/tests/audio.test.js` (§4.1, §10 step 6). |
| R2 #14 (`audio.test.js` in layout) | File listed in §4.1 and §10 step 6. |
| R2 #15 (loopback HTML named identifier) | `test_dev_loopback_serves_html` asserts `id="loopback-start"` specifically (§5.2). |
| R2 #16 (CSP inline-script check extension) | Explicit checklist step 19 extends `verify_html_has_no_inline_script` to `/teach/<slug>` post-replacement and `/loopback`. |
| R2 #17 (`startDebugOverlay` track input) | Signature is `startDebugOverlay(pc, {localTrack})`; caller passes `local.track` from `wireBidirectionalAudio` (§4.7, §10 step 8). |
| R2 #18 (test budget count) | §5.5 says "six new tests" matching the enumeration. |
| Sprint 1 R2 #29 (no `'unsafe-inline'`) | Sprint 2 adds zero inline scripts/styles. `http_csp::verify_html_has_no_inline_script` extended to include `teacher.html`, `student.html` (post-replacement), `loopback.html`. |
| Sprint 1 R3 #41 (CSP byte-exact) | `EXPECTED_CSP` unchanged. `/loopback` served in dev asserts the same constant. |
| Sprint 1 R4 (teacher UI safe insertion) | Debug overlay follows the same `textContent`-only discipline. `ws_lobby::teacher_view_escapes_student_strings` untouched by this sprint. |
| R3 #19 (`startDebugOverlay` signature) | Signature is `startDebugOverlay(pc, opts)` where `opts.localTrack` carries the track. Both `connectTeacher` and `connectStudent` call it identically. Plan §4.7 now shows the actual implementation form consistently. |
| R3 #20 (`hasTrack` test coverage) | Six `hasTrack` tests in `audio.test.js` covering all four equivalence classes: present track, absent track, empty stream, null/invalid stream, invalid id, null entries in tracks array (§5.2). |
| R3 #21 (structural assertion owner) | Explicitly named: `test_dev_teach_html_carries_debug_marker` in `http_teach_debug_marker.rs` asserts both HTMLs carry `id="remote-audio"` and `id="unmute-audio"`. |
| R3 #22 (textContent-only overlay rendering) | §4.7 now explicitly states all rendering functions write via `element.textContent` only — no `innerHTML`, no `insertAdjacentHTML`, no `on*` attributes. |
| R3 #23 (`get_teach` hot-path) | `inject_debug_marker` short-circuits with `return html` when `dev == false` — zero scan, zero allocation in prod (§4.9). |

### 5.4 Fixture reuse plan

- **Rust tests**: reuse `server/tests/common/mod.rs`. Add
  `TestOpts.dev` field + `TestApp::get_html` helper. Three new test
  files + the `http_csp.rs` split use only the helper — no direct
  `reqwest` usage in test bodies outside `common/` (Sprint 1 rule
  preserved).
- **SDP fixtures (JS)**: committed as `const SDP_FIXTURES` in
  `sdp.js` alongside the munger. Each fixture is a JS string
  literal. Three real captures (Chrome 121, Firefox 122, Safari
  17.3) frozen in the file with a dated comment; six synthetic
  cases (`no_opus`, `already_munged`, `two_opus_pts`, `empty_fmtp`,
  `trailing_rtpmap`, `mixed_line_endings`).
- **Debug-marker fixture**: placeholder `<!-- sb:debug -->` is the
  single literal; tests assert presence/absence of one string each.
- **HTML skeletons**: `teacher.html` and `student.html` share the
  same three script tags and the same `remote-audio`/`sb-debug`/
  `unmute-audio` DOM IDs — any renaming needs to be applied in
  lock-step, enforced by the structure test in §5.2.

### 5.5 Test runtime budget + flaky policy

- Rust integration suite: six new tests (three http_teach_debug,
  three http_loopback; the `http_csp` dev/prod split is a refactor
  from one existing test into two, so net new is zero there), each
  < 500 ms. Aggregate new cost ≤ 3 s. Sprint 1 budget (< 45 s)
  holds with margin.
- JS Node test suite: < 1 s total on CI.
- CI step for `node --test`: zero install time on ubuntu-latest
  (Node 18 ships in the runner image).
- Loopback harness runtime: ~`PULSE_COUNT * PULSE_SPACING_MS` ≈
  5 s per measurement. Manual, not on CI.
- **Flaky policy**: unchanged from Sprint 1. No retry loops. Any
  intermittent HTTP test failure is fixed by tightening
  synchronisation, never by sleeping.

## 6. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | SDP munger corrupts a real browser's SDP → call never connects. | Med | High | Node-run property suite with nine fixtures including three real browsers; idempotence + upsert + line-ending invariants; manual two-machine check is the final gate. |
| R2 | `playoutDelayHint = 0` increases glitch rate (underruns) → worse audio. | Med | Med | Debug overlay reports per-second jitter + packet-loss live; manual exit criterion ("no pumping, no modulation") backstops. If glitch rate is bad, drop the hint (accepted per ADR "fidelity over latency"). |
| R3 | Debug overlay leaks into prod. | Low | Med | `test_prod_teach_html_has_no_debug_marker`; overlay gate is ONLY the meta tag; `window.SB_DEBUG` banned (grep guard in §5.3); release config refuses `--dev` unless `BASE_URL` is `http://localhost`. |
| R4 | `/loopback` exposes something sensitive in prod. | Low | Low | Route returns 404 in `!config.dev`; no DB access, no PII; tested. |
| R5 | `getUserMedia` called before a user gesture → auto-deny. | Med | Med | Student triggers from form-submit (gesture); teacher triggers from `peer_connected`, itself a consequence of clicking Admit. Both preserve gesture chain. Manual check in PR. |
| R6 | iOS Safari ignores constraints → degraded audio, confusing UX. | High | Low | ADR-0001 declares iOS Safari "degraded." Sprint 3 adds teacher-visible flag. Overlay shows honoured-vs-requested deltas for diagnosis. |
| R7 | Autoplay blocked → no audio despite connected call. | Med | High | `attachRemoteAudio` catches `play()` rejection → shows `#unmute-audio` button; one click restores playback. Manual-verified per finding #5. |
| R8 | SDP line-ending mix breaks answer generation on a strict UA. | Low | High | `mixed_line_endings` fixture + preservation property. |
| R9 | Loopback harness janks dev UI. | Low | Low | `AudioWorkletNode` runs on the render thread (not main). Standalone page, not in a live call. |
| R10 | `addTrack` before offer changes SDP shape in a way that breaks Sprint 1 WS relay tests. | Low | Med | Those tests synthesise SDP-shaped JSON opaquely; relay is SDP-agnostic. Running Sprint 1 suite unchanged after implementation is the guard. |
| R11 | UMD shim for sdp.js misbehaves under Node's strict module mode. | Low | Low | `package.json` pins `"type": "commonjs"`; the UMD factory is a standard pattern verified by `node --test`. |
| R12 | Overlay polling outlives a failed pc (memory leak). | Low | Low | §4.7 teardown contract; §5.3 R1 #6 guard. |
| R13 | A future refactor reintroduces `SharedArrayBuffer` without adding COOP/COEP → loopback silently breaks. | Low | Med | `http_loopback.rs` asserts COOP/COEP headers are absent (pins the design); grep guard `rg 'SharedArrayBuffer' web/assets` at sprint exit (§10 step 21); design rationale recorded in §3 alternatives and §9 decision #8. |

## 7. Exit criteria → test mapping

| SPRINTS.md exit criterion | Verified by |
|---|---|
| High-fidelity subjective audio both ways | Manual two-machine check; recorded in PR |
| SDP inspection confirms Opus 128 kbps stereo music mode FEC on | `chrome://webrtc-internals` capture in PR + debug-overlay screenshot; `node --test web/assets/tests/` asserts the emitted parameter string via fixtures |
| LAN one-way latency recorded | Loopback harness reading in PR; debug-overlay `roundTripTime` reading |

## 8. Out of scope (explicitly deferred)

- Video and two-tile UI → Sprint 3
- Browser-compat gating + degraded-tier warning → Sprint 3
- Mute / video-off / end-call without renegotiation → Sprint 3
- Any bandwidth adaptation or floor surface → Sprint 4
- Production Opus bitrate tuning beyond music-mode defaults → Sprint 4
- Rust tests in CI → Sprint 5 (Sprint 2 adds only the `node --test` step)
- Browser-based automated E2E → deferred; revisit Sprint 3
- Session-cookie refresh, real SMTP, TURN → Sprint 5

## 9. Decisions

1. **Debug signal is the server-injected `<meta>` tag only.** No
   `window.SB_DEBUG`; no query-string override; no cookie.
2. **`attachRemoteAudio(ev)` takes an `RTCTrackEvent` and targets
   `#remote-audio`.** One contract, used in HTML, signalling, and
   the module itself.
3. **SDP munger lives in its own file (`sdp.js`) with a UMD shim**
   so `node --test` can import it without a DOM. `audio.js`
   consumes it via `window.sbSdp.mungeSdpForOpusMusic`.
4. **Loopback processing primitive is `AudioWorkletNode`.**
   `ScriptProcessorNode` rejected (deprecated, main-thread).
5. **`hello` data channel stays** this sprint; removed in Sprint 3.
6. **Overlay teardown is the caller's responsibility**, exposed via
   `startDebugOverlay(pc) → {stop()}`. No-op stub returned in prod.
7. **JS CI gate is `node --test`** added to the existing workflow.
   Rust CI is still Sprint 5.
8. **Loopback transport is `MessagePort.postMessage(ArrayBuffer)`,
   not `SharedArrayBuffer`.** No COOP/COEP headers are added.
   Regression guard: `http_loopback.rs` asserts the absence of
   those headers, and a grep guard on `SharedArrayBuffer` runs at
   sprint exit.

## 10. Implementation checklist (for the Editor)

1. `web/assets/sdp.js` — UMD shim, `mungeSdpForOpusMusic`,
   `SDP_FIXTURES` (synthetic cases first; real browser captures
   added during §5.2 manual verification and committed before
   merge), `OPUS_MUSIC_FMTP`.
2. `package.json` at repo root: `{"private": true, "type": "commonjs"}`.
3. `web/assets/tests/sdp.test.js` — Node `node:test` suite covering
   §5.1 properties and §5.2 failure cases.
4. `.github/workflows/ci.yml` — add `node --test web/assets/tests/`
   step.
5. `web/assets/audio.js` — `startLocalAudio`, `attachRemoteAudio`,
   `detachRemoteAudio`, `showUnmuteAffordance`, `hideUnmuteAffordance`.
   Pure predicate `hasTrack(stream, id)` extracted for Node test.
6. `web/assets/tests/audio.test.js` — Node tests of the
   `hasTrack` predicate (six tests covering: present id, absent id,
   empty stream, null/invalid stream, invalid id types, null entries
   in tracks array; see §5.2).
7. `web/assets/debug-overlay.js` — self-gated; returns
   `{stop()}` in every path.
8. `web/assets/signalling.js` — add `wireBidirectionalAudio`,
   thread local track into both `connectTeacher` / `connectStudent`,
   munge SDP before every `setLocalDescription`, surface `pc` on the
   returned handle, call `startDebugOverlay(pc, { localTrack: audio.local.track })`
   and retain `.stop()`, invoke teardown on `onPeerDisconnected` + `hangup()`.
9. `web/teacher.html`, `web/student.html` — add
   `<!-- sb:debug -->`, `<audio id="remote-audio" autoplay
   playsinline>`, `<button id="unmute-audio" hidden>`, headphones
   note with `<details>`, `<div id="sb-debug">`, three `<script>`
   tags in load order: `sdp.js`, `audio.js`, `debug-overlay.js`,
   then `signalling.js`, then `teacher.js`/`student.js`.
10. `web/loopback.html` + `web/assets/loopback.js` +
    `web/assets/loopback-worklet.js` — harness + UI +
    `AudioWorkletProcessor`. Uses `PULSE_COUNT`, `PULSE_HZ`,
    `PULSE_MS`, `PULSE_SPACING_MS` constants at the top of
    `loopback.js`.
11. `web/assets/styles.css` — overlay panel (fixed position),
    tooltip styling, `#unmute-audio` button styling.
12. `server/src/http/teach.rs` — single-replace injection.
13. `server/src/http/loopback.rs` + register route in
    `http/mod.rs`. Handler uses bare `?` on file read.
14. `server/tests/common/mod.rs` — add `TestOpts.dev` field
    (default `true`; `false` flips `Config.dev` + switches
    `base_url` to `https://localhost`) and `TestApp::get_html`.
15. `server/tests/http_teach_debug_marker.rs` — three tests.
    Includes structural assertions for `#remote-audio` and
    `#unmute-audio` presence (finding #2 regression guard).
16. `server/tests/http_loopback.rs` — three tests (dev, prod,
    missing-file).
17. `server/tests/http_csp.rs` — split into parameterised
    dev/prod tests.
18. `./scripts/check-headers.py --sprint 2` and fix warnings
    (every new `.js` / `.rs` / `.html` file carries a header block
    with `File`, `Purpose`, `Last updated`, + `Role` / `Exports` on
    non-trivial modules).
19. **Extend `http_csp::verify_html_has_no_inline_script`** to also
    scan `/teach/<slug>` (teacher + student views,
    post-replacement) and `/loopback` (dev mode) — prove no inline
    `<script>` / `<style>` / `on*=` handlers slipped into the new
    pages (§5.3 R2 #29 guard; finding #16).
20. Grep guard: `rg 'SB_DEBUG' web/assets` returns no matches.
21. Grep guard: `rg 'SharedArrayBuffer' web/assets` returns no
    matches — enforces the MessagePort-only transport (finding #11).
22. Manual two-machine verification; capture SDP snippets (commit
    to `sdp.js` `SDP_FIXTURES`), `track.getSettings()`, loopback
    reading, autoplay-blocked recovery, subjective listening notes
    in the PR description.
23. Commit; `./scripts/council-review.py code 2 "high-fidelity bidirectional audio"`.

