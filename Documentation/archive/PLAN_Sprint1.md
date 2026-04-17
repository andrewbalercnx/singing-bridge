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
