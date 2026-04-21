
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


---

# Sprint 3: video track + two-tile UI + browser gating

_Archived: 2026-04-17_

# PLAN — Sprint 3: Video track + two-tile UI + browser compatibility gating

## 1. Problem statement + spec refs

From `SPRINTS.md` (lines 69–91):

> **Goal:** Add bidirectional video, deliver a clean two-tile interface,
> and handle browser compatibility at the landing page.

**Deliverables:**
- Video track (VP8 default; H.264 fallback where hardware encoding
  matters, notably mobile)
- Student UI: large teacher tile, small self-preview, mute / video-off / end-call
- Teacher UI: large student tile, small self-preview, live lobby panel
- Landing-page browser-compat gate (Supported / Degraded / Unworkable)
- Teacher lobby entry shows: email, browser name + version, device
  class, degradation flag
- Mute / video-off / end-call work **without renegotiating** the peer
  connection

**Exit criteria:**
- Full bidirectional A/V works on all supported browser pairs
- iOS Safari student joins with a visible warning; teacher sees the
  "iOS Safari" degraded flag
- In-app WebView (Facebook, Instagram, TikTok) joins are blocked with
  actionable guidance
- End-call cleans up all tracks and returns teacher to an empty room
  with lobby still live

**ADR alignment** (`knowledge/decisions/0001-mvp-architecture.md`):
- Browser-only clients, magic-link teacher auth — unchanged
- Fidelity-over-latency for audio — unchanged; video adds no pressure
- iOS Safari explicitly "degraded" tier — this sprint wires the flag
- Bandwidth degradation order: video drops first — this sprint keeps
  video OFF by default no; deferred to Sprint 4

**Foundational architecture ref** (`knowledge/architecture/signalling.md`):
- Signal-relay is payload-opaque; adding a video m-section is
  transparent to the server.

## 2. Current state (from exploration; codegraph does not index JS/Rust)

### 2.1 Client

- `web/student.html` — join form, then hidden session section with
  `<audio id="remote-audio" autoplay>` + `<button id="unmute-audio">` +
  `<div id="sb-debug">`. No video element, no local-preview element,
  no mute/video-off/end-call buttons.
- `web/teacher.html` — lobby list + session section with `<audio
  id="remote-audio" autoplay>` + `<button id="unmute-audio">` + hidden
  `<button id="hangup">`. No video, no preview.
- `web/assets/audio.js` — `window.sbAudio = { startLocalAudio,
  attachRemoteAudio, detachRemoteAudio, hasTrack }`. `startLocalAudio`
  returns `{ stream, track, settings }`. Audio-only constraints; no
  video request.
- `web/assets/signalling.js` — `connectTeacher` and `connectStudent`
  both call `wireBidirectionalAudio(pc)` which adds a single audio
  track and wires `pc.ontrack = (ev) => attachRemoteAudio(ev)`.
  Teardown: `refs.audio.teardown()`.
- `web/assets/teacher.js` / `student.js` — page controllers call
  `signallingClient.connectTeacher` / `connectStudent`. No buttons
  for mute/video-off. Teacher has a hidden `#hangup`; student has none.
- `web/assets/browser.js` — **does not exist**. UA sniffing lives
  inline in `signalling.js` as `browserLabel()` and `deviceClass()`.
- `web/assets/styles.css` — no tile/grid layout.

### 2.2 Server

- `server/src/ws/protocol.rs` — `ClientMsg::LobbyJoin { slug, email,
  browser, device_class }`; `ServerMsg::LobbyState { entries:
  Vec<LobbyEntryView> }`; `LobbyEntryView { id, email, browser,
  device_class, joined_at_unix }`. **No `tier` / `degraded` field.**
- `server/src/state.rs` — `LobbyEntry { id, email, browser,
  device_class, joined_at, joined_at_unix, conn }`. **No tier field.**
- `server/src/ws/lobby.rs` — stores the four client-supplied strings;
  emits views via `lobby_view()`.

### 2.3 Tests

- `server/tests/ws_lobby.rs::student_join_visible_to_teacher` —
  asserts email/browser/device_class round-trip. Adding a new field
  is backward-compatible for JSON deserialisation as long as it has
  `#[serde(default)]` on the server side.
- `server/tests/ws_session_handshake.rs::full_sdp_exchange_over_signalling`
  — payload-opaque; adding a video m-section to SDP does not touch
  this test.

## 3. Proposed solution (with alternatives)

### 3.1 Module surface (new or extended)

```
web/assets/browser.js         [NEW]
  Exports (UMD): {
    detectBrowser(ua, features) -> {
      name:    'Chrome'|'Firefox'|'Safari'|'Edge'|'unknown',
      version: number | null,
      tier:    'supported' | 'degraded' | 'unworkable',
      reasons: string[],        // human-readable, empty on supported
      device:  'desktop' | 'tablet' | 'phone',
      isIOS:   boolean,
      isInAppWebView: boolean,
    },
    BROWSER_FLOORS: { chrome: number, firefox: number, safariDesktop: number },
    BROWSER_UA_FIXTURES: Record<string, string>,  // frozen UA strings for tests
  }
  No DOM, no network — pure function of (ua, features).
  Features object has: {hasRTCPeerConnection, hasGetUserMedia}
  for feature-based blocking independent of UA.

web/assets/video.js           [NEW, UMD]
  Exports (browser + Node CommonJS): {
    startLocalVideo() -> { stream, track, settings }  // async, browser-only
    attachRemoteVideo(ev)                             // browser-only, idempotent
    detachRemoteVideo()                               // browser-only
    hasVideoTrack(stream, id)                         // pure, Node-testable
    orderCodecs(codecs, prefer)                       // pure, Node-testable
    applyCodecPreferences(transceiver, prefer)        // browser-only wrapper
  }
  `orderCodecs` is the pure ordering helper under the wrapper; tested
  in isolation. `applyCodecPreferences` delegates to it.
  Uses RTCRtpTransceiver.setCodecPreferences() — NOT SDP munging.
  UMD factory pattern matches `sdp.js`: `window.sbVideo` in the
  browser, `module.exports` under Node.

web/assets/controls.js        [NEW, UMD]
  Exports (browser + Node CommonJS): {
    wireControls({ audioTrack, videoTrack, onHangup })
      -> { teardown() }                               // browser-only
    deriveToggleView(enabled, onLabel, offLabel)      // pure, Node-testable
      -> { label, ariaPressed }
  }
  Canonical parameter contract: `audioTrack`, `videoTrack`, `onHangup`.
  Binds #mute, #video-off, #hangup buttons to track.enabled and
  hangup callback. Uses `track.enabled` (no renegotiation). Pure
  `deriveToggleView` drives button label + aria state; Node-tested.

web/assets/signalling.js      [EXTENDED]
  - `wireBidirectionalAudio` becomes `wireBidirectionalMedia` —
    adds audio track AND video track, returns { audio, video,
    audioTransceiver, videoTransceiver, teardown }. Partial-failure
    cleanup: if video acquisition fails AFTER audio succeeded, the
    audio stream is stopped before the error propagates.
  - Pure helper `dispatchRemoteTrack(ev, { onAudio, onVideo })`
    extracted so the audio/video branch is Node-testable.
  - `ontrack` delegates to dispatchRemoteTrack.
  - Codec preferences applied to each transceiver immediately after
    `addTransceiver` and before `createOffer`/`createAnswer`.
  - `browserLabel()` + `deviceClass()` DELETED; replaced with
    `window.sbBrowser.detectBrowser(navigator.userAgent, features)`.
  - `lobby_join` message gains `tier` and `tier_reason` fields
    derived from detectBrowser().
  - `refs` shape becomes `{ pc, media, overlay, dataChannel }` —
    `refs.audio` (Sprint 2) is renamed to `refs.media`. `makeTeardown`
    reads `refs.media.teardown()` (not `refs.audio.teardown()`).

web/assets/audio.js           [UNCHANGED contracts, internal tweaks]
  - `wireBidirectionalAudio` caller migrates; audio module stays put.
  - No video concerns leak here.

server/src/ws/protocol.rs     [EXTENDED]
  - `ClientMsg::LobbyJoin` gains `tier: Tier`, `tier_reason: Option<String>`
  - `LobbyEntryView` gains `tier: Tier`, `tier_reason: Option<String>`
  - New enum `Tier { Supported, Degraded, Unworkable }`
    serde-renamed to lowercase strings. Unknown strings deserialise
    to a hard error (serde's default behaviour on `Deserialize` for
    an enum without `#[serde(other)]`) — the connection's WS pump
    treats this as a protocol error and closes with code 1003
    (unsupported-data), matching Sprint 1's signal-error handling.
  - `pub const MAX_TIER_REASON_LEN: usize = 200;` — shared constant
    referenced by both the truncation helper in `lobby.rs` and the
    test that asserts the cap.
  - `#[serde(default)]` on `tier` and `tier_reason` fields of
    `ClientMsg::LobbyJoin`. **Default `Tier::Degraded`** (not
    Supported) — a client that fails to send a tier cannot be
    assumed healthy; Degraded warns the teacher without blocking
    the join. See §4.11 and §9 decision #6 for the trust-model
    rationale. Commented at the `impl Default for Tier` site.

server/src/state.rs           [EXTENDED]
  - `LobbyEntry` gains `tier`, `tier_reason`.
```

### 3.2 Alternatives considered

**A. SDP munging for video codec preference** vs. `RTCRtpTransceiver.setCodecPreferences()`.
- Reject munging — brittle, requires parsing m=video sections and
  reordering payload types. The transceiver API is universal (Chrome,
  Firefox, Safari 13+) and reverts gracefully if a preferred codec
  isn't offered by the UA.

**B. Renegotiation on mute (replaceTrack or remove/addTrack)** vs.
  `track.enabled = false`.
- Reject renegotiation — the spec mandates "without renegotiating."
  `track.enabled = false` on the sender silences/blacks the track
  without touching SDP. This is the WebRTC canonical approach.

**C. Server-side browser sniffing** vs. client-side detection.
- Reject server-side — UA strings are fundamentally unreliable;
  client-side can also run feature tests (RTCPeerConnection,
  getUserMedia existence). Server only ingests the client's verdict
  and echoes it to the teacher.

**D. Block unworkable browsers via 403 from `/teach/<slug>`** vs.
  client-side block page on the same HTML.
- Reject server-side blocking — the student.html is already served;
  the block UI is JS that hides the form and shows an explainer. Same
  URL continues to work if the user opens in a real browser later.

**E. Third tile for self-preview** vs. picture-in-picture in remote tile.
- Reject PiP-in-remote — complex CSS and z-index games. Two grid cells
  is cleaner on desktop; on mobile the self-preview stacks beneath
  the remote tile.

**F. Separate `video.js` module** vs. extending `audio.js`.
- Keep separate — audio.js is already audited for the music-mode
  Opus path. Mixing video concerns risks regressions in Sprint 2
  guarantees. Parallel modules with identical surface shape.

## 4. Component-by-component design

### 4.1 File layout delta

```
web/
  assets/
    browser.js              [NEW]  UMD, Node-testable
    video.js                [NEW]  browser-only
    controls.js             [NEW]  browser-only
    audio.js                [KEEP] no change to exports
    signalling.js           [EDIT] wireBidirectionalMedia; UA → sbBrowser
    teacher.js              [EDIT] render tier; wire controls
    student.js              [EDIT] landing gate; wire controls
    styles.css              [EDIT] tile grid + controls styling
    tests/
      browser.test.js       [NEW]  Node tier/feature tests
      video.test.js         [NEW]  Node hasVideoTrack tests
      sdp.test.js           [KEEP]
      audio.test.js         [KEEP]
  student.html              [EDIT] add video + preview + controls + block stub
  teacher.html              [EDIT] add video + preview + controls

server/
  src/
    ws/protocol.rs          [EDIT] Tier enum; LobbyJoin + LobbyEntryView
    state.rs                [EDIT] LobbyEntry carries tier
    ws/lobby.rs             [EDIT] persist tier into entries
  tests/
    ws_lobby.rs             [EDIT] assert tier round-trips
    ws_lobby_tier.rs        [NEW]  default + unknown-string handling
```

### 4.2 `web/assets/browser.js` (pure, Node-testable)

Signature:
```js
function detectBrowser(userAgent, features) {
  // features = { hasRTCPeerConnection, hasGetUserMedia }
  // returns { name, version, tier, reasons, device, isIOS, isInAppWebView }
}
```

**Tier decision tree** (first match wins):

```
1. isInAppWebView(ua)?                         → unworkable
   (FBAN|FBAV|Instagram|TikTok|Line|WebView markers)
2. !features.hasRTCPeerConnection
   || !features.hasGetUserMedia                → unworkable
3. isIOS?                                      → degraded
   reason: 'iOS Safari forces voice processing we cannot disable'
4. name === 'Firefox' && device === 'phone'    → degraded
   reason: 'Android Firefox audio processing differs from desktop'
5. name === 'Chrome' && version < chromeFloor  → degraded
6. name === 'Firefox' && version < firefoxFloor → degraded
7. name === 'Safari' && device === 'desktop'
   && version < 16                             → degraded
8. name === 'unknown'                          → degraded (best-effort)
9. otherwise                                   → supported
```

Version floors: `chromeFloor = 112, firefoxFloor = 115, safariDesktopFloor = 16`.
These are "last 2 majors" anchored to a conservative 2026-Q1 baseline; the
numbers are constants at the top of the module and also surfaced in
`BROWSER_FLOORS` export so tests can fixture against them.

**No DOM access**; `features` is injected by the caller. In production
caller passes `{ hasRTCPeerConnection: !!window.RTCPeerConnection,
hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) }`.

### 4.3 `web/assets/video.js`

UMD-wrapped; `hasVideoTrack` and `orderCodecs` are pure Node-exports.

```js
// --- Pure helpers (Node-testable) ---------------------------------

// Guard semantics intentionally mirror audio.js::hasTrack exactly
// (Sprint 2 finding pattern; parallel helpers must agree).
function hasVideoTrack(stream, id) {
  if (!stream || typeof stream.getVideoTracks !== 'function') return false;
  if (!id || typeof id !== 'string') return false;
  return stream.getVideoTracks().some((t) => t && t.id === id);
}

// Stable reordering: preferred codec family first, all others keep
// their relative order. `prefer` ∈ {'h264', 'vp8'}. Unknown prefer
// returns the input unchanged.
function orderCodecs(codecs, prefer) {
  if (!Array.isArray(codecs)) return [];
  if (prefer !== 'h264' && prefer !== 'vp8') return codecs.slice();
  const rx = prefer === 'h264' ? /h264/i : /vp8/i;
  const isPref = (c) => c && typeof c.mimeType === 'string' && rx.test(c.mimeType);
  // Use stable partition (NOT .sort, which is only spec-stable from
  // ES2019 forward but safer here to keep behaviour explicit).
  const preferred = [];
  const rest = [];
  for (const c of codecs) {
    if (isPref(c)) preferred.push(c);
    else rest.push(c);
  }
  return preferred.concat(rest);
}

// --- Browser-only wrappers ----------------------------------------

async function startLocalVideo() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      facingMode: 'user',
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  return { stream, track, settings: track.getSettings() };
}

function attachRemoteVideo(ev) {
  const el = document.getElementById('remote-video');
  if (!el) return;
  if (!el.srcObject) el.srcObject = new MediaStream();
  if (hasVideoTrack(el.srcObject, ev.track.id)) return;  // idempotent
  el.srcObject.addTrack(ev.track);
  try { ev.receiver.playoutDelayHint = 0; } catch (_) {}
}

function detachRemoteVideo() {
  const el = document.getElementById('remote-video');
  if (el && el.srcObject) {
    el.srcObject.getTracks().forEach((t) => el.srcObject.removeTrack(t));
    el.srcObject = null;
  }
}

function applyCodecPreferences(transceiver, prefer) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  if (typeof RTCRtpSender === 'undefined' ||
      typeof RTCRtpSender.getCapabilities !== 'function') return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const ordered = orderCodecs(caps.codecs, prefer);
  try { transceiver.setCodecPreferences(ordered); } catch (_) {}
}
```

UMD factory exports `{ hasVideoTrack, orderCodecs }` to Node and
additionally `{ startLocalVideo, attachRemoteVideo, detachRemoteVideo,
applyCodecPreferences }` when `window` is present.

### 4.4 `web/assets/signalling.js` — wireBidirectionalMedia

The file is wrapped in the same UMD factory as `sdp.js` so the three
extracted helpers — `dispatchRemoteTrack`, `acquireMedia`,
`teardownMedia` — can be `require()`d from Node tests.
`wireBidirectionalMedia` itself remains browser-only (it calls
`pc.addTransceiver` / `pc.ontrack`) but is written as a thin wrapper
over those helpers so the tested paths ARE the production paths.

```js
// --- Pure helpers (Node-testable) ---------------------------------

// Track-event dispatcher.
function dispatchRemoteTrack(ev, handlers) {
  if (!ev || !ev.track || !handlers) return;
  if (ev.track.kind === 'audio' && typeof handlers.onAudio === 'function') {
    handlers.onAudio(ev);
  } else if (ev.track.kind === 'video' && typeof handlers.onVideo === 'function') {
    handlers.onVideo(ev);
  }
}

// Partial-failure-safe media acquisition. Injected impls in tests.
async function acquireMedia(audioImpl, videoImpl) {
  const audio = await audioImpl.startLocalAudio();
  try {
    const video = await videoImpl.startLocalVideo();
    return { audio, video };
  } catch (err) {
    // Stop audio tracks before propagating so the mic LED turns off
    // even if the video permission was denied.
    try { audio.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    throw err;
  }
}

// Symmetric teardown.
function teardownMedia(media, audioImpl, videoImpl) {
  if (!media) return;
  try { audioImpl.detachRemoteAudio(); } catch (_) {}
  try { videoImpl.detachRemoteVideo(); } catch (_) {}
  if (media.audio && media.audio.stream) {
    try { media.audio.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  }
  if (media.video && media.video.stream) {
    try { media.video.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  }
}

// --- Browser-only assembly ----------------------------------------

async function wireBidirectionalMedia(pc, tier) {
  const { audio, video } = await acquireMedia(window.sbAudio, window.sbVideo);

  const audioTransceiver = pc.addTransceiver(audio.track, {
    streams: [audio.stream], direction: 'sendrecv',
  });
  const videoTransceiver = pc.addTransceiver(video.track, {
    streams: [video.stream], direction: 'sendrecv',
  });
  const preferH264 = tier && tier.device !== 'desktop';
  window.sbVideo.applyCodecPreferences(
    videoTransceiver, preferH264 ? 'h264' : 'vp8'
  );

  pc.ontrack = (ev) => dispatchRemoteTrack(ev, {
    onAudio: window.sbAudio.attachRemoteAudio,
    onVideo: window.sbVideo.attachRemoteVideo,
  });

  return {
    audio,
    video,
    audioTransceiver,
    videoTransceiver,
    teardown() {
      teardownMedia({ audio, video }, window.sbAudio, window.sbVideo);
    },
  };
}
```

**Rationale for `addTransceiver` vs `addTrack`**: `addTransceiver`
returns the transceiver synchronously so we can call
`setCodecPreferences` before the offer is created.

`refs` shape changes: Sprint 2 `{ pc, audio, overlay, dataChannel }`
→ Sprint 3 `{ pc, media, overlay, dataChannel }`. `media` holds the
return value of `wireBidirectionalMedia`. `makeTeardown` now invokes
`refs.media.teardown()` — **this rename touches every call site in
both `connectTeacher` and `connectStudent`** (R1 Medium: silent-
regression risk). Checklist step 6 calls this out explicitly.

### 4.5 `web/assets/controls.js`

Canonical parameter contract: `{ audioTrack, videoTrack, onHangup }`.
Pure toggle-view logic extracted for Node testing.

```js
// --- Pure helper (Node-testable) ---------------------------------

// Given the current `enabled` state of a track, return the view-
// model for the button that toggles it. `enabled === true` means the
// track is flowing (NOT muted / video on); `aria-pressed` reports
// the muted/off state of the button (pressed == track disabled).
function deriveToggleView(enabled, onLabel, offLabel) {
  return {
    label: enabled ? onLabel : offLabel,
    ariaPressed: enabled ? 'false' : 'true',
  };
}

// --- Browser-only wrapper -----------------------------------------

function wireControls({ audioTrack, videoTrack, onHangup }) {
  const muteBtn  = document.getElementById('mute');
  const videoBtn = document.getElementById('video-off');
  const hangBtn  = document.getElementById('hangup');

  function paint(btn, track, onLabel, offLabel) {
    if (!btn) return;
    const enabled = track ? track.enabled : true;
    const v = deriveToggleView(enabled, onLabel, offLabel);
    btn.textContent = v.label;
    btn.setAttribute('aria-pressed', v.ariaPressed);
  }

  function onMute() {
    if (audioTrack) audioTrack.enabled = !audioTrack.enabled;
    paint(muteBtn, audioTrack, 'Mute', 'Unmute');
  }
  function onVideo() {
    if (videoTrack) videoTrack.enabled = !videoTrack.enabled;
    paint(videoBtn, videoTrack, 'Video off', 'Video on');
  }
  function onHang() { onHangup && onHangup(); }

  // Paint initial state (tracks typically start enabled).
  paint(muteBtn,  audioTrack, 'Mute', 'Unmute');
  paint(videoBtn, videoTrack, 'Video off', 'Video on');

  if (muteBtn)  muteBtn.addEventListener('click', onMute);
  if (videoBtn) videoBtn.addEventListener('click', onVideo);
  if (hangBtn)  hangBtn.addEventListener('click', onHang);

  return {
    teardown() {
      if (muteBtn)  muteBtn.removeEventListener('click', onMute);
      if (videoBtn) videoBtn.removeEventListener('click', onVideo);
      if (hangBtn)  hangBtn.removeEventListener('click', onHang);
    },
  };
}
```

Invariant: `track.enabled` is the sole mute primitive. No
`replaceTrack`, no removeTrack, no renegotiation.

**Testability**: `deriveToggleView` is pure and Node-tested (see §5.1
controls coverage). The DOM wrapper is browser-only; manual test
covers the click cycle end-to-end.

### 4.6 HTML updates — `web/student.html`

New structure (relevant excerpts):

```html
<section id="join" ... >
  <div id="block-notice" hidden>
    <h2>This browser can't run the lesson tool</h2>
    <p id="block-reason"></p>
    <p>Open the link in Chrome, Firefox, Safari, or Edge.</p>
  </div>
  <div id="degraded-notice" hidden>
    <p id="degraded-reason"></p>
  </div>
  <form id="join-form">... existing ...</form>
</section>

<section id="session" hidden>
  <div class="tiles">
    <div class="tile remote">
      <video id="remote-video" autoplay playsinline></video>
      <audio id="remote-audio" autoplay></audio>
      <button id="unmute-audio" hidden>Click to enable audio</button>
    </div>
    <div class="tile self">
      <video id="local-video" autoplay playsinline muted></video>
    </div>
  </div>
  <div class="controls">
    <button id="mute" aria-pressed="false">Mute</button>
    <button id="video-off" aria-pressed="false">Video off</button>
    <button id="hangup">End call</button>
  </div>
</section>

<!-- sb:debug -->
<div id="sb-debug"></div>

<script src="/assets/browser.js"></script>
<script src="/assets/sdp.js"></script>
<script src="/assets/audio.js"></script>
<script src="/assets/video.js"></script>
<script src="/assets/debug-overlay.js"></script>
<script src="/assets/controls.js"></script>
<script src="/assets/signalling.js"></script>
<script src="/assets/student.js"></script>
```

`#local-video` is **muted** (self-preview — avoids feedback) and
**playsinline** (iOS needs this or it full-screens).

### 4.7 HTML updates — `web/teacher.html`

Same tile/controls shape as student. Keeps the existing lobby panel;
lobby list entries render email + browser + device + tier badge.

### 4.8 Controls CSS (`web/assets/styles.css` additions)

```css
.tiles {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr auto;
  gap: 0.5rem;
}
@media (min-width: 48rem) {
  .tiles {
    grid-template-columns: 1fr 12rem;
    grid-template-rows: 1fr;
  }
}
.tile { position: relative; background: #000; min-height: 12rem; }
.tile video { width: 100%; height: 100%; object-fit: cover; }
.tile.self  { min-height: 8rem; }
.controls { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.controls button { padding: 0.5rem 1rem; }
.tier-badge { font-size: 0.8em; padding: 0.1em 0.4em; border-radius: 0.25em; }
.tier-badge.supported { background: #d4edda; color: #155724; }
.tier-badge.degraded  { background: #fff3cd; color: #856404; }
.tier-badge.unworkable { background: #f8d7da; color: #721c24; }
```

Dark-mode overrides in the existing `@media (prefers-color-scheme: dark)` block.

### 4.9 Landing-page gate (`web/assets/student.js`)

Flow on page load:
```
const detect = window.sbBrowser.detectBrowser(navigator.userAgent, {
  hasRTCPeerConnection: !!window.RTCPeerConnection,
  hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
});
if (detect.tier === 'unworkable') {
  document.getElementById('join-form').hidden = true;
  document.getElementById('block-notice').hidden = false;
  document.getElementById('block-reason').textContent = detect.reasons[0] || '';
  return;  // no event wiring
}
if (detect.tier === 'degraded') {
  const n = document.getElementById('degraded-notice');
  n.hidden = false;
  document.getElementById('degraded-reason').textContent = detect.reasons[0] || '';
}
// form remains enabled for supported + degraded
```

On form submit: `connectStudent({ slug, email, tier: detect, ... })`.

### 4.10 `signalling.js` lobby_join extension

```js
sig.send({
  type: 'lobby_join',
  slug,
  email,
  browser: `${detect.name}/${detect.version || ''}`.replace(/\/$/, ''),
  device_class: detect.device,
  tier: detect.tier,
  tier_reason: detect.reasons[0] || null,
});
```

### 4.11 Server protocol (`protocol.rs`)

```rust
// Maximum stored length (in *characters*, not bytes) for a client-
// supplied tier reason. Used by both the truncation helper in
// lobby.rs and the test asserting the cap.
pub const MAX_TIER_REASON_LEN: usize = 200;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Supported,
    Degraded,
    Unworkable,
}

impl Default for Tier {
    // CONSERVATIVE DEFAULT: a lobby_join without an explicit tier is
    // assumed Degraded, not Supported. Legitimate clients always send
    // a tier (set by detectBrowser); a tier-absent join is therefore
    // an older build, a hand-crafted client, or a tampered payload.
    // Flagging it as Degraded warns the teacher without blocking the
    // join. The admission gate is UX advisory, not a security boundary;
    // see §9 decision #6 for the trust model.
    fn default() -> Self { Tier::Degraded }
}

// ClientMsg::LobbyJoin gains:
//   #[serde(default)] tier: Tier,
//   #[serde(default)] tier_reason: Option<String>,

// LobbyEntryView gains the same two fields (always present in the
// server-emitted JSON — no #[serde(default)] on the emit side).
```

**Unknown tier strings** (e.g. `"tier":"bogus"`) fail serde
deserialisation. `ws::connection` already converts deserialisation
failures into a WS close with code 1003 (unsupported-data) via the
existing protocol-error pipeline (Sprint 1). The new
`test_lobby_join_with_unknown_tier_closes_with_1003` pins that exact
outcome.

**Trust model note**: the browser-compat gate is advisory UX — it
surfaces the client's self-reported capability to the teacher so the
teacher can choose whether to admit. It is NOT a security boundary.
A user who tampers with `tier` only succeeds in running a session
their browser can't support well; there is no privileged surface
behind the gate. This is why server-side UA enforcement is
intentionally not added in Sprint 3 (§9 decision #6).

### 4.12 Server lobby (`state.rs` + `lobby.rs`)

```rust
pub struct LobbyEntry {
    pub id: EntryId,
    pub email: String,
    pub browser: String,
    pub device_class: String,
    pub tier: Tier,
    pub tier_reason: Option<String>,
    pub joined_at: Instant,
    pub joined_at_unix: i64,
    pub conn: ClientHandle,
}

// In lobby.rs — char-safe truncation. `String::truncate(n)` is
// byte-based and panics on a non-char-boundary byte. We instead
// count characters with `.chars().count()` for the guard and
// rebuild the String with `.chars().take(max_chars).collect()` so
// every codepoint boundary is respected.
fn truncate_to_chars(s: String, max_chars: usize) -> String {
    if s.chars().count() <= max_chars { return s; }
    s.chars().take(max_chars).collect()
}

// handle_lobby_join body excerpt:
let tier_reason = tier_reason.map(|r| truncate_to_chars(r, MAX_TIER_REASON_LEN));
```

**Why char-safe truncation?** `String::truncate(200)` on a string
whose 200th byte falls inside a multi-byte UTF-8 codepoint panics
(R1 High: domain reviewer). `truncate_to_chars` is O(n) in the input
length and safe on all UTF-8; test fixture (§5.2) uses a multi-byte
codepoint straddling the boundary to prevent regression.

`state.rs::LobbyEntry::view()` projects `tier` and `tier_reason` into
`LobbyEntryView`. `tier` is enum-bounded by serde; no validation
needed beyond deserialisation.

### 4.13 Teacher rendering (`teacher.js`)

Per-entry render (via textContent):

```js
function renderEntry(entry) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.textContent = `${entry.email} · ${entry.browser} · ${entry.device_class}`;
  const badge = document.createElement('span');
  badge.className = `tier-badge ${entry.tier}`;
  badge.textContent = entry.tier;
  li.append(label, document.createTextNode(' '), badge);
  if (entry.tier_reason) {
    const r = document.createElement('span');
    r.className = 'tier-reason';
    r.textContent = ` (${entry.tier_reason})`;
    li.append(r);
  }
  // admit / reject buttons ... unchanged
  return li;
}
```

All student-supplied strings rendered via `textContent` only — XSS
invariant from Sprint 1 R4 carried forward.

## 5. Test Strategy

### 5.1 Property / invariant coverage

**Browser detection (`browser.test.js`)** — Node `node:test`:
1. **Tier is always one of {supported, degraded, unworkable}** for
   any UA string in the fixture set (12 UAs).
2. **isInAppWebView UAs map to unworkable** (FBAN, FBAV, Instagram,
   TikTok, Line, generic WebView).
3. **iOS UAs (iPhone/iPad) always map to degraded** regardless of
   Safari version.
4. **Feature-absent env is unworkable** — `{hasRTCPeerConnection:
   false}` overrides any UA.
5. **BROWSER_FLOORS exports are stable** — the version-floor constants
   are a named export and match the decision-tree numbers in §4.2.
6. **detectBrowser is pure** — same input always produces same output
   (asserted by running each fixture twice and comparing deep equal).
7. **Version-floor boundaries (R1 High: test_quality)** — for each
   of Chrome, Firefox, and Safari-desktop, three assertions covering
   `floor - 1` → degraded, `floor` → supported, `floor + 1` →
   supported. Nine assertions total, one per (browser × boundary)
   pair. Named constants from `BROWSER_FLOORS` drive the fixtures so
   the tests track any future floor bump.

**Video helper (`video.test.js`)** — Node:
8. `hasVideoTrack` — 6 tests paralleling the Sprint 2 `hasTrack`
   suite (present id, absent id, empty stream, null/invalid stream,
   invalid id types, null entries in tracks array). Guard semantics
   must match `audio.js::hasTrack` byte-for-byte in shape.
9. `orderCodecs` — 6 tests: (a) prefer 'h264' puts all H264 codecs
   first, rest keep relative order; (b) prefer 'vp8' puts VP8 first;
   (c) empty codec list returns empty; (d) unknown prefer value
   returns input unchanged; (e) stable ordering (two VP8 codecs
   retain input order after H264 preference); (f) null/undefined
   entries in the input are treated as non-matching (via the `c &&`
   guard in the implementation) and preserved into the `rest`
   partition — pins the null-preservation contract.

**Controls (`controls.test.js`)** — Node:
10. `deriveToggleView` — 6 tests: (a) enabled=true → `{label:
    onLabel, ariaPressed:'false'}`; (b) enabled=false → `{label:
    offLabel, ariaPressed:'true'}`; (c) repeated-toggle determinism
    (alternating true/false produces alternating views); (d)
    null/undefined `enabled` defaults to `false` semantics; (e)
    absent onLabel/offLabel surfaces `undefined` in label (documents
    the contract, catches regressions); (f) return shape is exactly
    `{label, ariaPressed}` — no extra keys.

**Signalling dispatch (`signalling.test.js` — NEW)** — Node:
11. `dispatchRemoteTrack` — 5 tests: (a) audio track → onAudio
    called with event, onVideo not called; (b) video track → onVideo
    only; (c) unknown kind → neither called (silent); (d)
    null/undefined event → neither called (no throw); (e) handlers
    missing → no throw.

### 5.2 Failure-path coverage

**Client-side (`browser.test.js`)**:
- UA for Chrome 1 (version far under floor) → degraded with reason
  mentioning "old Chrome".
- UA for Firefox Android → degraded with phone-specific reason.
- Generic unknown UA → degraded with "best-effort" reason.
- Truncated UA (`"Mozilla"`) → degraded (best-effort fallthrough).
- Empty UA string → degraded.

**Client-side (`controls.test.js`)**:
- `deriveToggleView(false, 'Mute', 'Unmute')` → label 'Unmute',
  ariaPressed 'true' (already in §5.1 but pinned here for the
  failure-path contract).

**Client-side (`signalling.test.js`)**:
- `dispatchRemoteTrack` with a malformed event (`{track: {}}`) does
  not call handlers and does not throw.

**Server-side (`ws_lobby_tier.rs` — NEW, four tests)**:
- `test_lobby_join_without_tier_defaults_to_degraded`: student sends
  legacy `lobby_join` with no tier fields; teacher sees
  `tier: "degraded"`, `tier_reason: null` (matches the conservative
  default in §4.11).
- `test_lobby_join_with_unknown_tier_closes_with_1003`: student sends
  `"tier":"bogus"`; the WS closes with code 1003 (unsupported-data),
  matching the existing Sprint 1 protocol-error behaviour. Asserts
  both the close code and that `lobby_state` was not emitted.
- `test_lobby_join_with_oversized_tier_reason_is_truncated`: reason
  is 201 chars including at least one 3-byte codepoint ('中') placed
  so that byte-based truncation would split inside the codepoint.
  Stored string is exactly 200 chars long (`.chars().count() == 200`),
  the codepoint survives intact, and the server did not panic.
  This fixture specifically would fail on `String::truncate(200)`.
- `test_lobby_join_accepts_tier_reason_at_exact_cap`: reason is
  exactly 200 chars → stored unchanged.

**Server-side (extend `ws_lobby.rs::student_join_visible_to_teacher`)**:
- Student sends `tier: "degraded"`, `tier_reason: "iOS Safari forces
  voice processing"`.
- Teacher sees both fields in `lobby_state`.

### 5.3 Regression guards (carry-overs — Sprint 3 is round 1 so no
round-specific findings yet; all items come from prior sprint approvals)

| Carry-over | Guard |
|---|---|
| Sprint 1 R4 — teacher UI renders student strings via textContent only | `teacher.js::renderEntry` touched; manual read + `ws_lobby::teacher_view_escapes_student_strings` still passes unchanged. |
| Sprint 2 R1 #2 — `attachRemoteAudio` contract | `ontrack` split by `ev.track.kind` via `dispatchRemoteTrack`; audio path unchanged. `test_dev_teach_html_carries_debug_marker_*_view` continue to assert `#remote-audio` + `#unmute-audio` and are **extended to assert `#remote-video`, `#local-video`, and that both video elements carry the `playsinline` attribute** (R1 Low: playsinline location; R1 R2 Risk: iOS full-screen). |
| Sprint 2 R1 #3 — single debug gate | `browser.js` / `video.js` / `controls.js` must not reference `SB_DEBUG`. Grep guard `rg 'SB_DEBUG' web/assets` stays on sprint-exit checklist (§10 step 20). |
| Sprint 2 R1 #6 — overlay teardown + media teardown coverage (R1 Medium: teardown coverage incomplete) | `refs.media.teardown()` replaces `refs.audio.teardown()`; overlay teardown path still invoked from `onPeerDisconnected` + `hangup()`. **New Node test** `signalling.test.js::teardown invokes detach + stop for both audio and video`: builds a fake `refs` with spy tracks + spy detach fns (fake `window.sbAudio`/`sbVideo`), calls the teardown fn returned by `wireBidirectionalMedia`, and asserts: `detachRemoteAudio` called once, `detachRemoteVideo` called once, every track on the audio stream had `.stop()` called, every track on the video stream had `.stop()` called. |
| Sprint 2 R1 #6 — partial-failure cleanup (R1 High: wireBidirectionalMedia no cleanup) | Two new Node tests in `signalling.test.js`: (a) `acquireMedia success path returns {audio, video}` — success path with both impls returning healthy handles; asserts the return shape is exactly `{audio, video}`, no extra keys, and no `.stop()` was called on any track (success path does not tear down). (b) `acquireMedia partial failure stops audio stream when video acquisition throws` — stubs `videoImpl.startLocalVideo` to throw; asserts every track on the audio stream had `.stop()` called and the error propagates to the caller. Both tests inject `audioImpl` + `videoImpl` dependencies. |
| Sprint 2 R2 #11 — no SharedArrayBuffer | Video path uses no SAB; grep guard `rg 'SharedArrayBuffer' web/assets` still clean at sprint exit. |
| Sprint 2 R2 #16 — no inline script | `http_csp::verify_html_has_no_inline_script` extended HTMLs still pass after the HTML rewrite. No new inline scripts. |
| Sprint 2 R2 #28 — prod strips `<!-- sb:debug -->` | `inject_debug_marker` untouched; `test_prod_teach_html_has_no_debug_marker` still passes. |
| Sprint 2 R2 (cache-control on /teach) | `get_teach` response headers untouched; no regression test change needed. |

### 5.4 Fixture reuse plan

- **Re-use**: `SDP_FIXTURES` from Sprint 2 — signalling round-trip
  tests remain SDP-opaque; no new fixture needed for the video
  m-section (transceiver API handles it and `full_sdp_exchange_over_signalling`
  already uses a minimal synthetic SDP).
- **Re-use**: `spawn_app`, `TestApp::get_html`, `signup_teacher`,
  `TestOpts` from Sprint 1/2 — all new Rust tests lift these helpers
  without modification.
- **New browser UA fixtures** (`BROWSER_UA_FIXTURES` in `browser.js`):
  13 UAs covering: Chrome desktop current, Chrome Android current,
  Chrome-on-iOS (`CriOS` — must resolve to degraded via the iOS
  branch, not via its Chrome label), Firefox desktop current,
  Firefox Android, Safari desktop 17, Safari iOS 17, Edge desktop
  current, Facebook in-app (FBAN), Instagram in-app, TikTok in-app,
  Chrome desktop 110 (degraded), empty/garbage UA. Frozen in the
  module for reuse by `browser.test.js`.

### 5.5 Test runtime budget + flaky policy

- **Rust integration suite**: five new tests (four `ws_lobby_tier.rs`
  + one extension in `ws_lobby.rs`), each <500 ms. `http_teach_debug_marker`
  existing three tests gain two new asserts (playsinline, video element
  ids) — no new test cases. Aggregate new cost ≤2.5 s; Sprint 2 budget
  (<45 s full suite) holds with margin.
- **Node suite**: ~45 new tests —
  `browser.test.js` (~18: 6 properties + 5 failure paths + 9
  boundaries), `video.test.js` (11: 6 hasVideoTrack + 5 orderCodecs),
  `controls.test.js` (6 deriveToggleView), `signalling.test.js` (8:
  5 dispatch + 1 teardown + 2 acquire paths). Total <2 s. CI runner:
  `node --test web/assets/tests/*.test.js` already on the workflow.
- **Flaky policy**: unchanged — no retries, no sleeps, no
  synchronisation-by-timeout. Any intermittent failure is fixed by
  tightening the WebSocket handshake ordering, never by padding.

## 6. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `setCodecPreferences` silently ignored on a UA → wrong codec negotiated → CPU/quality regression | Low | Med | Wrapped in try/catch; UA is still capable of VP8 fallback. Manual two-browser matrix (Chrome/Firefox/Safari × desktop/mobile) logs negotiated codec via debug overlay (adds `fmtp.video` row). |
| R2 | iOS Safari `playsinline` missing → full-screen takeover → UX regression | Med | High | `playsinline` attribute on every `<video>` element; regression guard in `test_dev_teach_html_carries_debug_marker_*` asserting `playsinline` on `#remote-video` + `#local-video`. |
| R3 | Self-preview feedback loop (local video audio plays back on local speakers) | Low | Med | `#local-video` has `muted` attribute. Audio path doesn't attach to local preview; only remote-audio element plays inbound audio. |
| R4 | `track.enabled = false` does not actually mute on some UAs (old Firefox bugs) | Low | Med | Per-UA baseline Chrome 112+/Firefox 115+/Safari 16+ is safe. Degraded tiers are warned; debug overlay surfaces the per-track `muted` state for diagnosis. |
| R5 | `addTransceiver` changes SDP shape in a way that breaks the Sprint 2 signalling tests | Low | Med | Sprint 2 tests are payload-opaque. Running full Rust suite unchanged after implementation is the guard. |
| R6 | Backward-compat: legacy `lobby_join` without tier field crashes server | Low | High | `#[serde(default)]` on the new fields; `test_lobby_join_without_tier_defaults_to_degraded` guards (conservative default per §4.11 / §9 #6). |
| R7 | In-app WebView detection false positive blocks a legit user | Med | Med | Block page is advisory: copy tells them to open in a real browser. A false positive is mildly annoying, not dangerous. Fixture coverage of 4 known in-app markers, all others fall through to feature tests (not name matching). |
| R8 | Video bandwidth blows past a weak uplink → audio stutters | Med | High | Sprint 4 handles adaptive bitrate. Sprint 3 sets `height: { ideal: 720 }` — UA downgrades automatically under pressure. Manual two-machine check confirms audio doesn't stutter under normal LAN. |
| R9 | Controls click-through to signalling while `peer_connected` hasn't fired yet → null-track error | Low | Low | Controls wired AFTER `wireBidirectionalMedia` resolves; buttons hidden in HTML until `#session` section becomes visible. |
| R10 | CSP breakage: new `<video>` tags unexpected by CSP | Low | High | CSP unchanged (`media-src` not specified; defaults to `default-src 'self'` which permits same-origin MediaStream). `all_html_responses_carry_csp_*` tests still pass. |
| R11 | Teacher's own tier leaks into the lobby display (teacher joins its own room for testing) | Low | Low | Teacher never sends `lobby_join`; they send `lobby_watch`. No tier field on the teacher side. |
| R12 | Codec-preferences reordering surfaces a codec the remote UA rejected → ICE connects but media doesn't flow | Low | High | `setCodecPreferences` filters, doesn't inject — it only reorders the UA's own advertised codecs. The intersection with the remote offer still applies. Manual matrix is the guard. |

## 7. Exit criteria → test mapping

| SPRINTS.md exit criterion | Verified by |
|---|---|
| Full bidirectional A/V session works on all supported browser pairs | Manual two-machine matrix (Chrome↔Chrome, Chrome↔Firefox, Firefox↔Safari, Chrome↔iOS-Safari); screenshots + debug-overlay capture in PR. |
| iOS Safari student joins with visible warning; teacher sees "iOS Safari" flag | `browser.test.js` asserts iOS UA → degraded + reason; `ws_lobby.rs` extension asserts degraded tier round-trips; manual test captures teacher-side badge render. |
| In-app WebView blocked with guidance | `browser.test.js` asserts FBAN/Instagram/TikTok UAs → unworkable; manual test opens `/teach/<slug>` in Facebook in-app and confirms block UI. |
| End-call cleans up all tracks, teacher returns to empty room with live lobby | `hangup()` path calls `refs.media.teardown()` (both audio + video track stops); `ws_session_handshake::student_disconnect_clears_session` continues to pass; manual confirm. |

## 8. Out of scope (explicitly deferred)

- Bandwidth adaptation / quality floors → Sprint 4
- Connection-quality indicator UI → Sprint 4
- Reconnect on transient drop → Sprint 4
- Azure deployment + TURN + session log → Sprint 5
- Session recording → Sprint 6 (post-MVP)

## 9. Decisions (binding for this sprint)

1. `addTransceiver` over `addTrack` for both audio and video — needed
   to set codec preferences before the offer is created.
2. `RTCRtpTransceiver.setCodecPreferences()` over SDP munging for the
   video codec — universal support, no parser risk. Pure ordering
   extracted to `orderCodecs()` for Node tests.
3. `track.enabled = false` for mute — mandated by spec; no
   renegotiation. Pure `deriveToggleView()` under the DOM binding.
4. Client-side tier detection, server echoes. The gate is **UX
   advisory**, not a security boundary — a user who fakes `tier` only
   succeeds in running a session their browser cannot support well;
   there is no privileged surface behind the gate. Server-side UA
   enforcement is intentionally NOT added this sprint (see #6 for
   the conservative default that pairs with this decision).
5. Separate `browser.js`, `video.js`, `controls.js` modules — keeps
   audit surfaces isolated; each is independently Node-testable where
   the logic is pure. All three files use the same UMD factory as
   `sdp.js` for Node-export parity.
6. `#[serde(default)]` on new `LobbyJoin` fields, with default
   `Tier::Degraded` (NOT Supported). Rationale: a legitimate client
   always sends `tier`; a missing field is an older build, a
   hand-crafted client, or a tampered payload. Degraded-by-default
   warns the teacher without blocking the join. This is the
   conservative pairing for decision #4's advisory-gate model.
7. Char-safe truncation for `tier_reason` (`truncate_to_chars`) —
   byte-based `String::truncate` panics on non-ASCII at the boundary.
   Multi-byte fixture in the regression test prevents reintroduction.
8. `wireBidirectionalMedia` built on three extracted helpers
   (`dispatchRemoteTrack`, `acquireMedia`, `teardownMedia`) so every
   non-DOM branch is Node-testable. The wrapper is a 15-line thin
   assembly over the helpers.

## 10. Implementation checklist

1. `web/assets/browser.js` — `detectBrowser` + `BROWSER_UA_FIXTURES`
   + `BROWSER_FLOORS`; UMD factory pattern copied from `sdp.js`.
2. `web/assets/tests/browser.test.js` — 6 property tests + **9
   boundary tests** (Chrome/Firefox/Safari × {floor-1, floor,
   floor+1}) + 5 failure paths (§5.1–5.2).
3. `web/assets/video.js` — UMD; pure `hasVideoTrack` + `orderCodecs`
   exported for Node; browser wrappers under `window.sbVideo`.
4. `web/assets/tests/video.test.js` — 6 `hasVideoTrack` tests +
   5 `orderCodecs` tests (§5.1). `hasVideoTrack` guard mirrors
   `audio.js::hasTrack` exactly.
5. `web/assets/controls.js` — UMD; pure `deriveToggleView` exported;
   `wireControls` under browser only with canonical signature
   `{ audioTrack, videoTrack, onHangup }`.
6. `web/assets/tests/controls.test.js` — 6 `deriveToggleView` tests.
7. `web/assets/signalling.js` — UMD so `dispatchRemoteTrack`,
   `acquireMedia`, `teardownMedia` are Node-exportable. Delete
   `browserLabel`/`deviceClass`; call `detectBrowser` at connect
   time; replace `wireBidirectionalAudio` with
   `wireBidirectionalMedia`; **rename `refs.audio` → `refs.media` in
   both `connectTeacher` and `connectStudent`, and in `makeTeardown`**
   (R1 Medium: silent-regression risk). Route `ontrack` via
   `dispatchRemoteTrack`. Pass `tier` + `tier_reason` into `lobby_join`.
8. `web/assets/tests/signalling.test.js` — 5 dispatch + 1 teardown
   coverage + 1 partial-failure cleanup tests (§5.3).
9. `web/student.html` — add block/degraded notices, tiles section,
   controls, `#local-video` (+ `playsinline` + `muted`),
   `#remote-video` (+ `playsinline`); add `<script>` tags in correct
   order (browser → sdp → audio → video → overlay → controls →
   signalling → student).
10. `web/teacher.html` — same tile/controls structure + `#local-video`
    (+ `playsinline` + `muted`) + `#remote-video` (+ `playsinline`).
    No block notice.
11. `web/assets/teacher.js` — render `tier` badge + `tier_reason` in
    each lobby entry; wire controls after `onPeerConnected`.
12. `web/assets/student.js` — landing gate on page load; pass `tier`
    to `connectStudent`; wire controls after `onPeerConnected`.
13. `web/assets/styles.css` — `.tiles`, `.tile`, `.controls`,
    `.tier-badge`, `.tier-reason`; dark-mode parity.
14. `server/src/ws/protocol.rs` — `Tier` enum with explicit
    "conservative default" comment on `impl Default`; `pub const
    MAX_TIER_REASON_LEN: usize = 200`; `#[serde(default)]` fields on
    `ClientMsg::LobbyJoin` + `LobbyEntryView`.
15. `server/src/state.rs` — `LobbyEntry` gains `tier`, `tier_reason`;
    `view()` projects both.
16. `server/src/ws/lobby.rs` — `handle_lobby_join` persists via
    char-safe `truncate_to_chars(reason, MAX_TIER_REASON_LEN)`.
17. `server/tests/ws_lobby.rs` — extend
    `student_join_visible_to_teacher` to assert `tier` + `tier_reason`
    round-trip.
18. `server/tests/ws_lobby_tier.rs` — NEW: four tests (default
    Degraded, unknown-string closes 1003, multi-byte truncation at
    exact 200 chars, exact-cap accepted unchanged).
19. Extend `test_dev_teach_html_carries_debug_marker_student_view`
    and `..._teacher_view` in
    `server/tests/http_teach_debug_marker.rs` to assert `#remote-video`,
    `#local-video`, and the presence of `playsinline` on both.
20. `./scripts/check-headers.py --sprint 3` — fix any stale lines.
21. `rg 'SB_DEBUG' web/assets` → zero matches (grep guard).
22. `rg 'SharedArrayBuffer' web/assets` → only comment references
    (grep guard, same as Sprint 2).
23. Run full Rust + Node test suites: all green.
24. Manual two-machine matrix + mute/video-off cycle + unworkable-gate:
    Chrome↔Chrome, Chrome↔Firefox, Firefox↔Safari, Chrome↔iOS-Safari
    (degraded), Facebook-in-app (block UI appears — screenshot, since
    WebView is not browser-automatable this sprint). Click mute,
    confirm teacher hears silence; click video-off, confirm teacher
    sees last-frame still. Captures + brief description in PR.


---

# Sprint 4: bandwidth adaptation + quality hardening

_Archived: 2026-04-17_

# PLAN — Sprint 4: Bandwidth adaptation + quality hardening

## 1. Problem statement + spec refs

From `SPRINTS.md` (lines 95–117):

> **Goal:** Degrade gracefully under constrained bandwidth in a defined
> priority order, protecting audio-to-teacher as the last thing dropped.

**Deliverables:**
- RTCP-feedback-driven adaptive bitrate following the four-rung order
  (student→teacher video, teacher→student video, teacher→student audio
  floor 48 kbps, student→teacher audio floor 96 kbps).
- Opus FEC tuning; video NACK / RED verification.
- Connection-quality indicator in both UIs (packet loss %, estimated
  latency, bandwidth headroom).
- "Your connection can't support this lesson" surface when
  student→teacher audio cannot hold the 96 kbps floor.
- Network-impairment test harness (`tc netem` recipe); behaviour
  verified at 2 % loss / 20 ms jitter.
- Automatic reconnect on transient network drop (target: session
  restored within 5 s without user action).

**Exit criteria:**
- Subjective audio quality rated "good" at 2 % simulated loss.
- Degradation order empirically matches spec when bandwidth is
  squeezed in the harness.
- Audio-to-teacher 96 kbps floor is respected; floor-violation surface
  fires correctly.
- Transient 2–3 s network drop is auto-recovered.

**ADR alignment** (`knowledge/decisions/0001-mvp-architecture.md`
§Bandwidth degradation order + §What we will monitor):

> When bandwidth is constrained, drop in this order (highest dropped
> first, lowest last): (1) student→teacher video, (2) teacher→student
> video, (3) teacher→student audio (floor: 48 kbps), (4) student→teacher
> audio (floor: 96 kbps — never drop below).
>
> If student→teacher audio cannot hold 96 kbps, the session surfaces a
> "your connection can't support this lesson" message rather than
> silently degrading below the fidelity floor.

This sprint realises that order mechanically. Proportion of sessions
hitting the 96 kbps floor is also called out as a production monitoring
target — the server-side session log lands in Sprint 5, but this sprint
must at minimum emit a structured client-side event when the floor is
breached so Sprint 5 has something to wire up.

**Foundational architecture ref** (`knowledge/architecture/signalling.md`):

> The server … only forwards opaque JSON payloads it defines the frame
> shape for.

Adaptive bitrate and ICE restart both reuse the existing `Signal`
envelope — the server remains payload-opaque. No wire-protocol change is
required. `ClientMsg` / `ServerMsg` are not extended this sprint.

## 2. Current state (from codebase exploration; codegraph does not index JS)

### 2.1 Client — what exists at HEAD

- `web/assets/signalling.js` — `wireBidirectionalMedia(pc, detect)` at
  lines 95–129: adds audio + video transceivers (`sendrecv`), applies
  codec preferences (H.264 on mobile, VP8 elsewhere), routes remote
  tracks by kind. **No `sender.setParameters` call, no `priority`
  or `networkPriority` hint, no stats loop, no ICE-restart hook.**
- `pc.oniceconnectionstatechange` — never bound. ICE failure produces a
  silent dead session; the existing teardown is only driven by
  `peer_disconnected` from the server.
- `setMungedLocalDescription` (l. 83) runs `mungeSdpForOpusMusic` on
  every `setLocalDescription`. Video m-section is untouched by the
  munger (Opus-only; see §2.3 below).
- `debug-overlay.js` — 1 Hz polling of `pc.getStats()` already
  extracts `inbound-rtp audio`, `remote-inbound-rtp audio`, selected
  `candidate-pair`. Reads `packetsLost`, `jitter`, `audioLevel`,
  `remote.roundTripTime`, `currentRoundTripTime`. **Useful precedent
  for the stats pipeline shape.** No video counters, no outbound
  counters.
- `controls.js` — mute/video-off toggle `track.enabled`. Invariant
  from Sprint 3: adapt loop must NOT touch `track.enabled`; the user
  owns that primitive.
- No quality UI. No floor surface. No reconnect logic.

### 2.2 Server — what exists at HEAD

- Signal relay (`server/src/ws/session.rs`) is payload-opaque — the
  adapt-driven ICE restart just sends new SDP offers/answers through
  the existing `Signal` type.
- Lobby admit/reject (`server/src/ws/lobby.rs`) closes the
  `active_session` on `peer_disconnected`. A re-admit is required if
  a peer drops hard. **Sprint 4 does not change this** — ICE restart
  keeps the same WS and same `active_session` membership, so the
  server is untouched for reconnect.
- No server-side session-resume token. Scope decision in §9 #1.

### 2.3 SDP munger reach

`sdp.js` only walks Opus payload-types (`OPUS_RTPMAP_RE`). Video
m-sections and their `a=rtcp-fb` / `a=fmtp` lines are pass-through.
Modern Chrome/Firefox/Safari advertise video NACK by default:
`a=rtcp-fb:<VP8-PT> nack` and `nack pli`. RED / ULPFEC is
Chrome-only. The plan (§4.5) verifies rather than injects, because
munging video SDP introduces much more interop risk than Opus fmtp
munging did.

### 2.4 Test infrastructure precedent

- Node suite (`web/assets/tests/*.test.js`) runs under `node --test`
  with no DOM. UMD factories expose pure logic for Node; browser
  wrappers live behind `typeof window`. Adapt loop's pure decision
  function must fit that mould.
- Rust integration suite (`server/tests/*.rs`) lifts `spawn_app`,
  `signup_teacher`, `TestApp::get_html` from `server/tests/common`.
  The payload-opaque nature of `Signal` means the suite stays green
  for ICE-restart flows (existing `ws_signal_relay.rs` already proves
  arbitrary SDP round-trips).

## 3. Proposed solution (with alternatives)

### 3.1 Module surface (new or extended)

```
web/assets/adapt.js           [NEW — pure + DOM-free]
  Exports (UMD): {
    LADDER,                          // frozen rung catalogue
    DEGRADE_LOSS,                 // 0.05  — threshold to increment rung
    DEGRADE_RTT_MS,               // 500
    IMPROVE_LOSS,                 // 0.02  — threshold to decrement rung
    IMPROVE_RTT_MS,               // 300
    DEGRADE_SAMPLES,              // 4
    IMPROVE_SAMPLES,              // 8
    FLOOR_SAMPLES,                // 6     — ticks at floor before violation
    initLadderState(role),
      // -> { role, videoRung, audioRung,
      //      consecutiveBad: {video,audio},
      //      consecutiveGood: {video,audio},
      //      floorBreachStreak }
    decideNextRung(prev, outboundSamples, role),
      // outboundSamples: Array<Sample> (outbound only)
      // -> { next: LadderState, actions: Action[] }
      // Action = { type: 'setVideoEncoding', params: EncodingParams }
      //        | { type: 'setAudioEncoding', params: EncodingParams }
      //        | { type: 'floor_violation' }
      // EncodingParams = { maxBitrate: number, scaleResolutionDownBy?: number, active?: bool }
    encodingParamsForRung(ladderKey, rungIndex),
      // ladderKey in {studentVideo,teacherVideo,teacherAudio,studentAudio}
      // rungIndex OOB -> throws RangeError
      // student audio rung 1 -> { maxBitrate: 96_000 }
      // teacher audio rung 3 -> { maxBitrate: 48_000 }
      // video terminal rung  -> { maxBitrate: 0, scaleResolutionDownBy: 4.0, active: false }
      // video non-terminal   -> { maxBitrate: N, scaleResolutionDownBy: M, active: true }
    floorViolated(state),
      // predicate: state.role==='student' && state.floorBreachStreak >= FLOOR_SAMPLES
  }
  Node-testable: every export is pure. No DOM, no RTC.

web/assets/quality.js         [NEW — pure core + DOM binding]
  Exports (UMD): {
    STATS_FIXTURES,               // frozen Map-shaped stand-ins for Node tests
    summariseStats(stats, prevStats),
      // pure: (RTCStatsReport|Map, RTCStatsReport|Map|null) -> Array<Sample>
      // Sample = { kind, dir, lossFraction, rttMs, outBitrate, inBitrate }
      // prevStats=null -> bitrate fields = 0 (first tick)
      // multiple SSRCs same kind: take SSRC with highest packetsSent
    qualityTierFromSummary(samples),
      // pure: Array<Sample> -> { tier: 'good'|'fair'|'poor', loss, rttMs, outBitrate }
      // empty input -> { tier: 'good', loss: 0, rttMs: 0, outBitrate: 0 }
    renderQualityBadge(el, summary),
      // browser-only: sets el.textContent + el.className; no innerHTML
  }

web/assets/reconnect.js       [NEW — pure state machine + DOM trigger]
  Exports (UMD): {
    ICE_WATCH_MS,                 // 3000
    ICE_RESTART_MS,               // 5000
    STANDARD_FLICKER,             // test fixture: canonical happy-path event sequence,
                                  //                starting from phase 'healthy'
    STRAIGHT_TO_FAILED,           // test fixture: healthy -> failed direct arc
                                  //                (proves healthy->giveup transition)
    CLOSED_FROM_HEALTHY,          // test fixture: healthy -> closed direct arc
                                  //                (proves the 'closed' row of the table)
    initReconnectState(),
      // -> { phase: 'healthy', retryCount: 0, timerId: null }
    onIceStateEvent(prev, iceState, nowMs),
      // iceState in { 'new','checking','connected','completed',
      //               'disconnected','failed','closed' }
      // -> { next: ReconnectState,
      //      effect: 'none'|'schedule_watch'|'cancel_timer'|
      //              'call_restart_ice'|'give_up' }
    startReconnectWatcher(pc, onEffect, clock),
      // browser-only; clock = { now, setTimeout, clearTimeout }
  }

web/assets/session-core.js    [NEW — UMD; pure core + browser wrapper]
  Exports (UMD):
    module.exports (Node-testable, pure): {
      applyActions(actions, senders),
        // executes setVideoEncoding / setAudioEncoding actions via
        // senders.audio.setParameters / senders.video.setParameters;
        // swallows + logs rejections; never touches track.enabled;
        // no DOM, no window, no document access — Node-testable with stubs
    }
    window.sbSessionCore (browser-only): {
      applyActions,                              // re-exported for browser callers
      startSessionSubsystems(pc, senders, role, callbacks) -> { stopAll() },
        // wires the 2 s adapt interval, quality monitor, and reconnect watcher;
        // senders = { audio: RTCRtpSender, video: RTCRtpSender }
        // callbacks = { onQuality(summary), onFloorViolation(),
        //               onReconnectEffect(effect) }
    }

web/assets/signalling.js      [EXTENDED — stays as wire-protocol layer only]
  - Sets sender priority + networkPriority at transceiver creation.
  - After data channel open: calls session-core.startSessionSubsystems.
  - ICE-restart path (student side): calls pc.restartIce() on
    'call_restart_ice' effect; re-offers via existing createOffer flow.
  - makeTeardown calls stopAll() from session-core.

web/assets/teacher.js         [EXTENDED]
web/assets/student.js         [EXTENDED]
  - Render the quality badge from signalling's onQuality callback.
  - Student: on floor_violation, reveal a modal banner;
    Teacher: mirrors it into session-status so the teacher sees
    "student's connection can't support this lesson".

web/teacher.html              [EXTENDED]
web/student.html              [EXTENDED]
  - #quality-badge, #reconnect-banner, #floor-violation elements.

web/assets/styles.css         [EXTENDED]
  - .quality-badge {good,fair,poor}, .reconnect-banner,
    .floor-violation

tests/netem/                  [NEW]
  impair.sh                   # apply 2% loss / 20ms jitter on loopback
  clear.sh
  README.md                   # how to run the manual harness

knowledge/runbook/netem.md    [NEW]
  Step-by-step for the manual impairment run.

web/assets/tests/
  adapt.test.js               [NEW]
  quality.test.js             [NEW]
  reconnect.test.js           [NEW]
  session-core.test.js        [NEW — applyActions stub tests]
```

No new `server/` files. No protocol messages. No new crates.

### 3.2 Why an in-JS adapt loop instead of relying on browser congestion control

The browser's own BWE already reacts to REMB / TWCC. Three reasons the
adapt loop is still worth writing:

1. **Priority alone doesn't express the 96 kbps audio floor.** Priority
   hints the browser, but there is no browser-visible primitive for
   "never let the Opus encoder drop below 96 kbps specifically on
   student→teacher." We have to enforce that with
   `sender.setParameters.encodings[0].minBitrate` (Chrome only) + an
   explicit floor violation surface.
2. **Cross-peer order.** Rungs 1 and 2 are different peers' uplinks.
   Each peer owns its own ladder but both must obey the shared order.
   An explicit per-peer state machine makes that auditable.
3. **Observability.** Sprint 5 wants a session-log entry when the 96
   kbps floor is breached. Computing floor-violation in JS produces a
   structured event we can ship to the server later; deferring to
   browser BWE does not.

Alternatives considered and rejected:

- **Do nothing; trust browser BWE.** Rejected: cannot express the
  hard 96 kbps floor, and the floor message is a spec deliverable.
- **Server-side bitrate control via REMB proxy.** Rejected: needs an
  SFU or media-aware proxy and contradicts the ADR decision to stay
  P2P. Sprint 6 recording may one day force this; Sprint 4 does not.
- **simulcast.** Rejected: a two-peer session gains nothing from
  simulcast layers at the sender; we never select between them.

### 3.3 Why `priority` / `networkPriority` are set unconditionally

Even on Sprint 3 clients, these hints are cheap, well-specified, and
make browser BWE drop video before audio on its own. They are a safety
net if the adapt loop fails to run (e.g. UA ignores
`setParameters.encodings`). They are set once at transceiver creation;
no ongoing cost.

## 4. Component-by-component design

### 4.1 `web/assets/adapt.js`

#### 4.1.1 Rung catalogue

```js
// Rung indices: 0 = healthy, increasing = more degraded.
// Separate ladders per (role, kind): role ∈ {student, teacher},
// kind ∈ {video, audio}. Each rung names the maxBitrate the sender
// will target and, for video only, the resolution scale factor.
var LADDER = Object.freeze({
  // Rung 1 (student→teacher video): first to drop under pressure.
  studentVideo: [
    { maxBitrate: 1_500_000, scaleDownBy: 1.0 },  // 720p
    { maxBitrate:   500_000, scaleDownBy: 2.0 },  // 360p
    { maxBitrate:   200_000, scaleDownBy: 4.0 },  // 180p
    { maxBitrate:         0, scaleDownBy: 4.0 },  // off (see §4.1.5)
  ],
  // Rung 2 (teacher→student video): drops next.
  teacherVideo: [
    { maxBitrate: 1_500_000, scaleDownBy: 1.0 },
    { maxBitrate:   500_000, scaleDownBy: 2.0 },
    { maxBitrate:   200_000, scaleDownBy: 4.0 },
    { maxBitrate:         0, scaleDownBy: 4.0 },
  ],
  // Rung 3 (teacher→student audio): drops after both video rungs.
  teacherAudio: [
    { maxBitrate: 128_000 },
    { maxBitrate:  96_000 },
    { maxBitrate:  64_000 },
    { maxBitrate:  48_000 },  // floor
  ],
  // Rung 4 (student→teacher audio): NEVER below 96 kbps.
  studentAudio: [
    { maxBitrate: 128_000 },
    { maxBitrate:  96_000 },  // floor — last valid rung
  ],
});
```

**Design decision (§9 #2):** video rung 3 (`maxBitrate: 0`) does NOT
set `track.enabled = false` or flip the transceiver to `'inactive'`.
It calls `sender.setParameters({ encodings: [{ active: false }] })`
so the sender stops transmitting but keeps the transceiver alive —
re-enabling is a one-call toggle, no renegotiation, and `track.enabled`
remains the user's primitive (Sprint 3 invariant carried forward).

#### 4.1.2 `initLadderState(role)`

```js
function initLadderState(role) {
  return {
    role: role,                  // 'student' | 'teacher'
    videoRung: 0,
    audioRung: 0,
    consecutiveBad: { video: 0, audio: 0 },
    consecutiveGood: { video: 0, audio: 0 },
    floorBreachStreak: 0,        // student role only
  };
}
```

#### 4.1.3 `decideNextRung(prev, outboundSamples, role)`

Pure. `samples` is an array of `Sample` objects (output of
`summariseStats(stats, prevStats)`, filtered to outbound only).
Each sample represents one outbound media stream: `{ kind, dir, lossFraction, rttMs, outBitrate, inBitrate }`.
No mutation of `prev`; returns a new state plus an `actions` array.

Thresholds (§9 #3):

```js
var DEGRADE_LOSS = 0.05;     // 5%
var DEGRADE_RTT_MS = 500;    // upstream stall
var IMPROVE_LOSS = 0.02;
var IMPROVE_RTT_MS = 300;
var DEGRADE_SAMPLES = 4;     // 4 × 2 s = 8 s sustained
var IMPROVE_SAMPLES = 8;     // 8 × 2 s = 16 s sustained (slow upgrade; avoid flap)
var FLOOR_SAMPLES = 6;       // 12 s sustained at floor rung before surfacing
```

Transition rules:

- Video: under DEGRADE for DEGRADE_SAMPLES → `videoRung++` (clamped
  at last rung); under IMPROVE for IMPROVE_SAMPLES → `videoRung--`
  (clamped at 0).
- Audio: only starts degrading when `videoRung` is at the bottom of
  its ladder. Same SAMPLES thresholds. This is where cross-rung
  ordering is enforced (§9 #4).
- Student audio: `audioRung` clamped at 1 (96 kbps floor). Any
  DEGRADE_SAMPLES sustained at rung 1 increments
  `floorBreachStreak`. `floorBreachStreak >= FLOOR_SAMPLES` →
  `actions` contains `{type: 'floor_violation'}`. Does NOT further
  mutate `audioRung`.
- Teacher audio: `audioRung` clamped at 3 (48 kbps floor). No
  violation surface on this side — teacher side can tolerate
  degradation of their own outbound audio because the spec's
  diagnostic-signal protection is specifically student→teacher.

Returned shape:

```js
{
  next: {
    role,                           // carried through unchanged from prev.role
    videoRung, audioRung,
    consecutiveBad, consecutiveGood,
    floorBreachStreak
  },
  actions: [
    { type: 'setVideoEncoding', params: { maxBitrate, scaleResolutionDownBy, active } },
    { type: 'setAudioEncoding', params: { maxBitrate, minBitrate? } },
    { type: 'floor_violation' }       // student only
  ]
}
```

**State-shape invariant:** `next.role === prev.role` on every call. `role`
is set once by `initLadderState(role)` and is never mutated. `floorViolated(state)`
can be called with any state returned by `initLadderState` or `decideNextRung`.

#### 4.1.4 `encodingParamsForRung(ladderKey, rungIndex)`

Pure. Translates ladder key + rung index into the
`RTCRtpEncodingParameters` shape (`EncodingParams`).

**Call path:** `decideNextRung` is the only caller. When `decideNextRung`
decides to transition a rung, it calls `encodingParamsForRung` to build
the `EncodingParams` and embeds the result inside the outgoing
`{ type: 'setVideoEncoding'|'setAudioEncoding', params }` action. The
downstream `applyActions` helper in `session-core.js` does NOT call
`encodingParamsForRung`; it simply forwards the prebuilt `params` to
`sender.setParameters({ encodings: [params] })`. This keeps the
translation layer (`adapt.js`) fully pure and decoupled from the
side-effectful sender calls in `session-core.js`.

For `'studentAudio'` rung 1 (the 96 kbps floor): writes both
`maxBitrate: 96_000` AND `minBitrate: 96_000`. The `minBitrate`
is a Chrome-only UA hint (Chromium honours `encodings[0].minBitrate`;
Firefox and Safari ignore it as of 2026-04). Cross-browser enforcement
of the student audio floor is done by the `audioRung` clamp at rung 1
inside the state machine — `minBitrate` is belt-and-braces, not
authoritative (see §9 #9).

For `'studentAudio'` rung 0 (128 kbps, healthy): returns
`{ maxBitrate: 128_000 }` WITHOUT `minBitrate`. The `minBitrate`
field is written ONLY at the student-audio floor (rung 1) so that
the UA hint kicks in exactly when the state machine has also clamped.
Pinned by test #10a (negative test across all other rungs and ladders).

Throws `RangeError` on out-of-bounds `rungIndex` (no silent corruption).

#### 4.1.5 `floorViolated(state)`

Convenience predicate: returns `true` iff `state.role === 'student'`
AND `state.floorBreachStreak >= FLOOR_SAMPLES`. The streak counter
lives in state (updated by `decideNextRung`) for hysteresis.
This matches the definition in §3.1 and the test cases in §5.2.

### 4.2 `web/assets/quality.js`

#### 4.2.1 `summariseStats(stats, prevStats)`

Pure. Inputs: current `RTCStatsReport` (or Map-shaped stand-in in Node tests) and the previous snapshot (or `null` on the first tick). Output is an array of per-direction `Sample` objects. Bitrate fields are 0 when `prevStats` is null. When multiple SSRCs of the same kind exist, the SSRC with the highest `packetsSent` is used (deterministic tiebreak).

```js
[
  { kind: 'audio', dir: 'outbound', role: 'student_uplink', lossFraction, rttMs, outBitrate, inBitrate: null },
  { kind: 'audio', dir: 'inbound',  role: 'teacher_downlink', lossFraction, rttMs: null, outBitrate: null, inBitrate },
  { kind: 'video', dir: 'outbound', ... },
  { kind: 'video', dir: 'inbound',  ... },
]
```

Derivation rules:

- `remote-inbound-rtp` reports give `packetsLost`, `jitter`,
  `roundTripTime`, `fractionLost` (or derived via delta of
  `packetsLost` over the last window). Preferred source for
  outbound loss.
- `inbound-rtp` reports give inbound byte counts for `inBitrate`
  (delta of `bytesReceived` over 2 s).
- Outbound byte counts via `outbound-rtp.bytesSent` delta.
- Selected `candidate-pair.currentRoundTripTime` is the
  transport-level RTT fallback when remote-inbound is absent.

Caller retains the previous stats map across ticks and passes it as `prevStats`.

#### 4.2.2 `qualityTierFromSummary(samples)`

Pure. Reduces the sample array to one summary object:

```
{ tier: 'good'|'fair'|'poor', loss: number, rttMs: number, outBitrate: number }
```

Tier rules:
- `poor` if any outbound `lossFraction > 0.05` OR `rttMs > 400`.
- `fair` if any outbound `lossFraction > 0.02` OR `rttMs > 200`.
- `good` otherwise.
- Empty sample array → `{ tier: 'good', loss: 0, rttMs: 0, outBitrate: 0 }`.

`loss`, `rttMs`, `outBitrate` are the worst (highest) values seen across all outbound samples; used by the badge tooltip.

#### 4.2.3 `renderQualityBadge(el, summary)`

Browser-only. Writes `textContent` only (Sprint 1 R4 invariant).
Sets `className = 'quality-badge ' + summary.tier`. Tooltip via
`title` attribute (`'loss: 3.2 % / rtt: 85 ms / out: 1.4 Mbps'`).

### 4.3 `web/assets/reconnect.js`

Pure state machine + thin DOM wrapper.

Inputs: a stream of `'iceconnectionstatechange'` events (`'new'`,
`'checking'`, `'connected'`, `'completed'`, `'disconnected'`,
`'failed'`, `'closed'`) plus a monotonic clock.

States: `healthy → watching → restarting → giveup`.

Transitions (complete table — every `(phase, iceState)` pair is defined):

| From phase | Event | Next phase | Effect | Notes |
|---|---|---|---|---|
| `healthy` | `new` | `healthy` | `none` | pre-connection noise |
| `healthy` | `checking` | `healthy` | `none` | initial negotiation |
| `healthy` | `connected` | `healthy` | `none` | steady state |
| `healthy` | `completed` | `healthy` | `none` | steady state |
| `healthy` | `disconnected` | `watching` | `schedule_watch` | start 3 s timer |
| `healthy` | `failed` | `giveup` | `give_up` | direct catastrophic failure |
| `healthy` | `closed` | `giveup` | `give_up` | peer explicitly closed |
| `watching` | `new` | `watching` | `none` | unexpected, ignore |
| `watching` | `checking` | `watching` | `none` | UA re-probing, continue to wait |
| `watching` | `connected` | `healthy` | `cancel_timer` | recovered before timer |
| `watching` | `completed` | `healthy` | `cancel_timer` | recovered before timer |
| `watching` | `disconnected` | `watching` | `none` | idempotent (redundant event) |
| `watching` | `failed` | `giveup` | `give_up` | cancels pending watch timer |
| `watching` | `closed` | `giveup` | `give_up` | cancels pending watch timer |
| `watching` | `<watch-timer-fire>` | `restarting` | `call_restart_ice` | schedule 5 s timer |
| `restarting` | `new` | `restarting` | `none` | restart in progress |
| `restarting` | `checking` | `restarting` | `none` | restart in progress |
| `restarting` | `connected` | `healthy` | `cancel_timer` | restart succeeded |
| `restarting` | `completed` | `healthy` | `cancel_timer` | restart succeeded |
| `restarting` | `disconnected` | `restarting` | `none` | still mid-restart |
| `restarting` | `failed` | `giveup` | `give_up` | restart failed |
| `restarting` | `closed` | `giveup` | `give_up` | peer closed mid-restart |
| `restarting` | `<restart-timer-fire>` | `giveup` | `give_up` | restart deadline missed |
| `giveup` | * | `giveup` | `none` | terminal state; all events ignored |

Every `(phase, iceState)` and every timer-fire is listed above. The pure
`onIceStateEvent(prev, iceState, nowMs)` function implements exactly this
table; tests in §5.1 #25–#29 plus the §5.2 failure-path cases each exercise
one row. A new test fixture `CLOSED_FROM_HEALTHY` (added alongside
`STANDARD_FLICKER` and `STRAIGHT_TO_FAILED`) exercises the row
`healthy + closed → giveup`.

Only the student side calls `pc.restartIce()` — the student is the
offerer (see `signalling.js::connectStudent`). Teacher stays a
passive answerer, re-negotiates on arrival of the new offer.

#### 4.3.1 `initReconnectState()` / `onIceStateEvent(prev, state, nowMs)`

```js
function onIceStateEvent(prev, state, nowMs) {
  // returns { next, effect }
  // effect ∈ { 'none', 'schedule_watch', 'cancel_timer', 'call_restart_ice', 'give_up' }
}
```

The caller (`startReconnectWatcher`) owns the timer and owns the
`pc.restartIce()` call. The pure function only decides what to do.

#### 4.3.2 `startReconnectWatcher(pc, onEffect, clock)`

Browser-only. Binds `pc.oniceconnectionstatechange`. `clock` defaults
to `Date.now`/`setTimeout`; tests inject a fake. `onEffect` is a
callback so the signalling layer can show/hide the reconnect banner
without this module reaching into the DOM.

### 4.4 `web/assets/session-core.js` + `signalling.js` integration

The session-core module owns the adapt loop, quality monitor, reconnect
watcher, and the `applyActions` mutation helper. The signalling module
only wires priority hints at transceiver creation and invokes session-core
once the data channel is open. This section covers both modules together
to keep the wiring between them auditable in one place.

#### 4.4.1 `session-core.js` — testability and module boundary

`session-core.js` ships a UMD factory (matching `controls.js` / `video.js`):

- **Pure core (Node-testable, exported via `module.exports`):**
  `applyActions(actions, senders)`. Its only dependency is a `senders`
  object with `audio` and `video` fields; each field must support
  `setParameters(params)` returning a Promise. Node tests supply stub
  senders with `setParameters` spies. No DOM, no `window`, no `document`.
- **Browser-only (attached to `window.sbSessionCore`):**
  `startSessionSubsystems(pc, senders, role, callbacks)` which wires the
  2 s `setInterval` adapt loop, the quality monitor, and the reconnect
  watcher. Returns `{ stopAll() }`.

This split resolves the earlier review finding: `applyActions` is
Node-testable because it is the pure helper in the UMD factory; only the
`setInterval`-based orchestrator is browser-only. The Node test suite
(`session-core.test.js`) imports `applyActions` via CommonJS and exercises
it against stub senders.

#### 4.4.2 Priority hints (signalling.js responsibility)

Immediately after `pc.addTransceiver(...)` returns (inside
`wireBidirectionalMedia` in `signalling.js`), call:

```js
var aParams = audioTransceiver.sender.getParameters();
aParams.encodings = aParams.encodings && aParams.encodings.length
  ? aParams.encodings : [{}];
aParams.encodings[0].priority = 'high';
aParams.encodings[0].networkPriority = 'high';
// minBitrate is NOT set here — per §4.1.4 it is written only at
// the student-audio floor rung (rung 1) by encodingParamsForRung.
// Setting it at creation would pin the encoder at 96 kbps before
// adaptation runs; we want rung 0 (128 kbps) at session start.
await audioTransceiver.sender.setParameters(aParams);

var vParams = videoTransceiver.sender.getParameters();
vParams.encodings = vParams.encodings && vParams.encodings.length
  ? vParams.encodings : [{}];
vParams.encodings[0].priority = 'low';
vParams.encodings[0].networkPriority = 'low';
await videoTransceiver.sender.setParameters(vParams);
```

The `role` argument is passed into `wireBidirectionalMedia` from the
caller (`connectTeacher` vs `connectStudent`). Failures in
`setParameters` are logged but not fatal — older UAs without
`encodings` on transceivers still progress to negotiation.

#### 4.4.3 Adapt loop (session-core.js responsibility)

After the data channel opens, `signalling.js` calls
`window.sbSessionCore.startSessionSubsystems(pc, senders, role, callbacks)`.
Inside `startSessionSubsystems`, a `setInterval(tick, 2000)` loop runs:

```js
function tick() {
  pc.getStats().then(function (stats) {
    var samples = window.sbQuality.summariseStats(stats, prevStats);
    prevStats = stats;
    var summary = window.sbQuality.qualityTierFromSummary(samples);
    if (callbacks.onQuality) callbacks.onQuality(summary);

    var outbound = samples.filter(function (s) { return s.dir === 'outbound'; });
    var res = window.sbAdapt.decideNextRung(ladderState, outbound, role);
    ladderState = res.next;
    applyActions(res.actions, senders);   // applyActions is local to this module
    for (var i = 0; i < res.actions.length; i++) {
      if (res.actions[i].type === 'floor_violation' && callbacks.onFloorViolation) {
        callbacks.onFloorViolation();
      }
    }
  }).catch(function () { /* non-critical */ });
}
```

`applyActions(actions, senders)` is the single `setParameters` call site:

```js
function applyActions(actions, senders) {
  for (var i = 0; i < actions.length; i++) {
    var a = actions[i];
    if (a.type === 'setVideoEncoding') {
      try {
        senders.video.setParameters({ encodings: [a.params] })
          .catch(function (err) { console.warn('sb.applyActions: video setParameters rejected', err); });
      } catch (err) { console.warn('sb.applyActions: video setParameters threw', err); }
    } else if (a.type === 'setAudioEncoding') {
      try {
        senders.audio.setParameters({ encodings: [a.params] })
          .catch(function (err) { console.warn('sb.applyActions: audio setParameters rejected', err); });
      } catch (err) { console.warn('sb.applyActions: audio setParameters threw', err); }
    }
    // 'floor_violation' actions are handled by the caller, not here.
  }
}
```

`track.enabled` is never touched (Sprint 3 invariant carried forward).
The interval is cleared by `stopAll()`.

#### 4.4.4 ICE-restart integration (signalling.js responsibility)

The reconnect watcher is started by `startSessionSubsystems` and emits
effects via a callback. The signalling-side integration handles the
effect mapping:

```js
// Passed to startSessionSubsystems as callbacks.onReconnectEffect.
function (effect) {
  // effect values from onIceStateEvent: 'none'|'schedule_watch'|'cancel_timer'|
  // 'call_restart_ice'|'give_up'
  if (effect === 'schedule_watch') onReconnectBanner(true);
  else if (effect === 'cancel_timer') onReconnectBanner(false);
  else if (effect === 'call_restart_ice') {
    onReconnectBanner(true);
    if (role === 'student') {
      pc.restartIce();
      // Explicit re-offer: createOffer + setMungedLocalDescription + sig.send.
      // Teacher side: this branch is NOT taken; the teacher responds to the
      // student's new offer via the existing sig.on('signal') handler.
    }
  }
  else if (effect === 'give_up') { onReconnectBanner(false); teardownSession(); }
}
```

`stopAll()` from `startSessionSubsystems` is added to the teardown path
in `makeTeardown` so the adapt interval, quality monitor, and reconnect
watcher all stop together.

### 4.5 SDP and codec-parameter adjustments

#### 4.5.1 Opus FEC confirmation

`useinbandfec=1` is already set in `OPUS_MUSIC_FMTP` (Sprint 2).
Sprint 4 adds no new Opus fmtp parameters — `cbr=0` plus inband FEC
is the recommended pairing under loss. The debug overlay already
surfaces `fmtp.useinbandfec`; Sprint 4 adds a regression assertion
in `sdp.test.js` that the value survives the munger (it does today,
but we pin it — see §5.1).

#### 4.5.2 Video NACK / RED verification

Video negotiation is left to the browser defaults. Sprint 4 adds a
verification helper in `video.js` — `verifyVideoFeedback(sdp)` — that
returns `{nack, nackPli, transportCc, red, ulpfec}` booleans by
scanning the video m-section's `a=rtcp-fb:<PT>` and
`a=rtpmap:<PT> red/...` / `ulpfec/...` lines. Wired into the debug
overlay so we can see what the negotiated SDP actually contains.

Rationale: the test matrix in §7 can then assert empirically that
Chrome/Firefox/Safari default offers carry NACK. We only escalate to
munging if a real UA fails the check; this sprint does not add
video-SDP munging because of interop risk (§9 #5).

#### 4.5.3 `packetLossPercentage` (non-standard)

Some Chrome builds accept `a=fmtp:<PT> packetLossPercentage=5` as an
Opus FEC hint. Not standardised, not portable. **Rejected** — §9 #5.

### 4.6 UI additions

#### 4.6.1 Student HTML

```html
<section id="session" hidden>
  <div id="reconnect-banner" class="reconnect-banner" hidden>
    Reconnecting…
  </div>
  <div id="floor-violation" class="floor-violation" hidden>
    <h2>Your connection can't support this lesson.</h2>
    <p>Audio to your teacher dropped below the minimum we
       need to hear you clearly. Try a different network or check
       with your teacher.</p>
  </div>
  <span id="quality-badge" class="quality-badge good">good</span>
  <div class="tiles"> ... unchanged ... </div>
  <div class="controls"> ... unchanged ... </div>
</section>
```

#### 4.6.2 Teacher HTML

Same three elements (`#reconnect-banner`, `#quality-badge`, and —
mirrored — `#floor-violation` reading "This student's connection
can't support the lesson"). Teacher is never the floor-breacher, so
the teacher-side text is about the student's side.

#### 4.6.3 CSS (additions to `styles.css`)

```css
.quality-badge { padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.8rem; }
.quality-badge.good { background: #dff3dd; color: #1a3d1a; }
.quality-badge.fair { background: #fff2cc; color: #6b5100; }
.quality-badge.poor { background: #fbe1e1; color: #7a1f1f; }

.reconnect-banner { background: #fff2cc; padding: 0.5rem; text-align: center; }
.floor-violation  { background: #fbe1e1; padding: 1rem; border-radius: 6px; }

@media (prefers-color-scheme: dark) {
  .quality-badge.good { background: #1f3f1f; color: #bfe6bf; }
  .quality-badge.fair { background: #3f3a1f; color: #ebd28a; }
  .quality-badge.poor { background: #3f1f1f; color: #f1b6b6; }
}
```

### 4.7 `web/assets/teacher.js` / `student.js` wiring

Thin wiring: new callbacks `onQuality(tier)`,
`onFloorViolation()`, `onReconnectBanner(visible)` are passed into
`connectTeacher` / `connectStudent`. The page modules set
`textContent` on `#quality-badge`, toggle `hidden` on the banners.
`controls.js` untouched (mute/video-off still owns `track.enabled`).

Student-side floor-violation handler hides `#session`, shows
`#floor-violation`, and calls `handle.hangup()` to release media.

### 4.8 `tests/netem/impair.sh`

Linux-only; documented and guarded.

```sh
#!/usr/bin/env bash
set -euo pipefail
# Apply 2% loss / 20ms jitter to loopback. Symmetric (both directions).
IFACE=lo
LOSS=${LOSS:-2%}
JITTER=${JITTER:-20ms}

# Input validation: reject anything that isn't a simple percentage or duration.
# Prevents shell injection / stray tc flags when $LOSS / $JITTER come from env.
if [[ ! "$LOSS" =~ ^[0-9]+(\.[0-9]+)?%$ ]]; then
  echo "impair.sh: LOSS must be a percentage like '2%' or '0.5%' (got: $LOSS)" >&2
  exit 2
fi
if [[ ! "$JITTER" =~ ^[0-9]+(\.[0-9]+)?(ms|us|s)$ ]]; then
  echo "impair.sh: JITTER must be a duration like '20ms' (got: $JITTER)" >&2
  exit 2
fi

sudo tc qdisc replace dev "$IFACE" root netem loss "$LOSS" delay 10ms "$JITTER" distribution normal
echo "netem: $LOSS loss, $JITTER jitter on $IFACE"
```

`clear.sh` runs `sudo tc qdisc del dev lo root` (idempotent; exit
code tolerated). `README.md` explains:

- This is a local-loopback harness — both peers must be on the same
  machine (one Chrome, one Chrome Incognito, both pointed at
  `localhost:3000`).
- Not a CI gate. CI has no tc, no sudo, no netem kernel module.
- Expected observations at 2 % loss / 20 ms jitter:
  - Rung 0 video at start.
  - Ladder steps to rung 1 within ~8 s (DEGRADE_SAMPLES × tick).
  - Subjective audio quality stays "good" on headphones.
  - Floor surface does NOT fire.
- Expected observations at 10 % loss:
  - Ladder descends to rung 3 video, then rung 1–3 audio.
  - On student-side, floor surface fires within ~25 s.

### 4.9 `knowledge/runbook/netem.md`

Step-by-step for a maintainer: prerequisites (Linux + `sudo tc`),
how to open two Chrome profiles on the same host, what to measure in
the debug overlay, how to clear netem after the session. Points to
ADR-0001 §Bandwidth degradation order so the reader knows what to
expect before running it.

### 4.10 File-header discipline

All new files carry an inline structured header block. Canonical template
(used verbatim — no external convention doc is referenced):

```
// File: <relative path>
// Purpose: <one-line purpose; what this file exists to do>
// Role: <where it fits in the module graph; what it is the ONE
//        place for>
// Exports: <public symbols; note pure vs browser-only>
// Depends: <direct runtime dependencies>
// Invariants: <constraints that callers / future edits must preserve>
// Last updated: Sprint 4 (YYYY-MM-DD) -- <short note>
```

Run `./scripts/check-headers.py --sprint 4` before commit. PostToolUse
hook auto-bumps `Last updated`; the sprint-exit checklist re-reads
touched files and replaces any `-- edited` placeholder.

## 5. Test Strategy (MANDATORY)

### 5.1 Property / invariant coverage

**Adapt state machine (`adapt.test.js`)** — Node `node:test`:

1. **Ladder monotonicity:** for each of `studentVideo`, `teacherVideo`, `teacherAudio`,
   `studentAudio`, `LADDER[k]` is a non-empty frozen array and `maxBitrate` is
   non-increasing across indices.
2. **Student audio floor constant:** `LADDER.studentAudio[last].maxBitrate === 96_000`.
3. **Teacher audio floor constant:** `LADDER.teacherAudio[last].maxBitrate === 48_000`.
4. **`decideNextRung` is pure:** same `(prev, outboundSamples, role)` input twice →
   deep-equal output. Asserted for all four ladder roles × {healthy, bad, borderline}.
5. **Video-before-audio ordering — student role:** given a student-role state at
   `videoRung === 0`, drive `DEGRADE_SAMPLES × (LADDER.studentVideo.length)` bad-sample
   ticks. Assert `audioRung` stays 0 while `videoRung` advances to its terminal index.
6. **Audio advances after video exhaustion — student role:** continuing from test #5
   state, drive `DEGRADE_SAMPLES` additional bad ticks. Assert `audioRung === 1`
   (audio begins to degrade) and `videoRung` stays clamped at its terminal index.
6a. **Video-before-audio ordering — teacher role:** given a teacher-role state at
    `videoRung === 0`, drive `DEGRADE_SAMPLES × (LADDER.teacherVideo.length)` bad-sample
    ticks. Assert `audioRung` stays 0 while `videoRung` advances to its terminal index.
6b. **Teacher audio advances after video exhaustion:** continuing from test #6a,
    drive `DEGRADE_SAMPLES` additional bad ticks. Assert `audioRung === 1` (teacher
    audio begins to degrade) and `videoRung` stays at terminal. Further bad ticks
    eventually advance `audioRung` to 3 (teacher floor). No `floor_violation` action
    is emitted on teacher role (per §9 #4 — floor surface is student-only).
7. **Hysteresis:** alternating `[bad, good, bad, good, ...]` for 20 ticks never
   increments either rung.
8. **Upgrade is slower than degrade:** starting at video rung 2, 4 consecutive GOOD
   ticks do not upgrade; 8 consecutive GOOD ticks do.
9. **Floor-breach streak:** starting at student `audioRung = 1`, drive bad samples
   until `floorBreachStreak >= FLOOR_SAMPLES`. Assert `actions` carries exactly one
   `{type: 'floor_violation'}`. Further bad samples do NOT emit additional events.

**`encodingParamsForRung(ladderKey, rungIndex)` (`adapt.test.js`)**:

10. **Student audio floor — both fields:** `encodingParamsForRung('studentAudio', 1)`
    returns an object with `maxBitrate === 96_000` AND `minBitrate === 96_000`
    (both fields required; spec-critical for UA-level floor enforcement).
10a. **`minBitrate` is studentAudio rung-1-only (negative test):** for each of
    `'teacherAudio'`, `'studentVideo'`, `'teacherVideo'` across every valid rung,
    AND for `'studentAudio'` rung 0, assert `!('minBitrate' in result)`.
    Pins the branch: only `studentAudio` rung 1 (the floor) writes `minBitrate`;
    even the healthy `studentAudio` rung 0 does not.
11. **Teacher audio floor:** `encodingParamsForRung('teacherAudio', 3)` returns
    `{ maxBitrate: 48_000 }` with no `minBitrate` property.
12. **Video terminal rung (`active: false`):** for both `studentVideo` and `teacherVideo`,
    terminal-rung call returns `{ active: false, maxBitrate: 0, scaleResolutionDownBy: 4.0 }`.
13. **Video non-terminal rung (`active: true`):** `encodingParamsForRung('studentVideo', 0)`
    returns `active === true`, `maxBitrate > 0`, `scaleResolutionDownBy === 1.0`.
14. **Invalid rung:** `encodingParamsForRung('studentVideo', 99)` throws `RangeError`.
15. **Audio has no `scaleResolutionDownBy`:** `encodingParamsForRung('studentAudio', 0)`
    returns an object without that property.

**`floorViolated(state)` (`adapt.test.js`)**:

16. **True for student at FLOOR_SAMPLES:** `floorViolated({role:'student', floorBreachStreak: FLOOR_SAMPLES})` → `true`.
17. **False one-shy:** `floorViolated({role:'student', floorBreachStreak: FLOOR_SAMPLES - 1})` → `false`.
18. **False for teacher at FLOOR_SAMPLES:** `floorViolated({role:'teacher', floorBreachStreak: FLOOR_SAMPLES})` → `false`.

**Quality summary (`quality.test.js`)** — Node:

19. **`summariseStats(stats, prevStats)` deltas:** given two snapshot fixtures 2 s apart,
    `inBitrate` and `outBitrate` match `(bytes1 - bytes0) * 8 / 2`.
20. **First tick (prevStats null):** `summariseStats(STATS_FIXTURES.healthy_20s, null)`
    returns samples with bitrate fields = 0; does not crash.
21. **Multi-SSRC tiebreak:** use a two-snapshot fixture pair
    `STATS_MULTI_SSRC_AUDIO_T0` / `STATS_MULTI_SSRC_AUDIO_T1` where:
    - at t0: SSRC A `bytesSent = 100_000, packetsSent = 500`;
             SSRC B `bytesSent =  50_000, packetsSent = 1200`.
    - at t1 (+2 s): SSRC A `bytesSent = 110_000` (Δ = 10_000 bytes → 40 kbps);
                    SSRC B `bytesSent = 150_000` (Δ = 100_000 bytes → 400 kbps).
    Call `summariseStats(T1, T0)` and assert exactly one outbound audio sample
    with `outBitrate === 400_000` (SSRC B's delta, the higher `packetsSent` wins).
    The test fails if the implementation picks SSRC A (which would give
    `outBitrate === 40_000`). Bitrates are distinct by an order of magnitude
    so the assertion is unambiguous.
22. **`qualityTierFromSummary` thresholds:** `loss = 0.01` → `{tier:'good'}`; `loss = 0.03`
    → `{tier:'fair'}`; `loss = 0.06` → `{tier:'poor'}`. Table-driven with named constants.
22a. **Boundary equality points:** inclusive/exclusive behaviour at the exact thresholds:
    `loss === 0.02` (boundary: good→fair, rule says `> 0.02` so 0.02 still `good`);
    `loss === 0.0200001` → `fair`;
    `loss === 0.05` → `fair` (rule `> 0.05`, so 0.05 stays `fair`);
    `loss === 0.0500001` → `poor`;
    `rttMs === 200` → `good`; `rttMs === 200.001` → `fair`;
    `rttMs === 400` → `fair`; `rttMs === 400.001` → `poor`.
    Pins the `>` (strictly-greater) semantics in one place.
23. **Empty sample array:** `qualityTierFromSummary([])` → `{tier:'good', loss:0, rttMs:0, outBitrate:0}`.
24. **`renderQualityBadge` textContent-only:** after `renderQualityBadge(el, summary)`,
    `el.innerHTML` contains no angle brackets injected by the function.

**Reconnect state machine (`reconnect.test.js`)** — Node:

25. **Happy path `healthy → watching → restarting → healthy`:** canonical sequence via
    stubbed clock; each effect emitted exactly once at the right step.
26. **Recovery before timer:** `'connected'` arrives before watch timer fires; effect is
    `'cancel_timer'`, no `'call_restart_ice'` emitted.
27. **Give-up on restart timer:** restart timer fires; `'give_up'` emitted.
28. **Idempotent on repeated `'disconnected'`:** second event from `watching` returns
    `effect: 'none'`, no double-timer scheduled.
29. **Role is not encoded in the pure function:** `onIceStateEvent` emits
    `'call_restart_ice'` regardless of role; the caller (session-core.js) decides
    whether to actually call `pc.restartIce()`.

**`applyActions` (`session-core.test.js`)** — Node-level stub tests:

30. **Action-to-sender routing:** `setVideoEncoding` action calls `videoSender.setParameters`;
    zero `audioSender.setParameters` calls.
31. **Exact parameter forwarding:** `setAudioEncoding` with `{maxBitrate:96_000}` → 
    `audioSender.setParameters` receives encoding with `maxBitrate === 96_000`.
32. **Recovery after rejection:** first `setParameters` call rejects; no unhandled
    rejection; second call in the next tick succeeds normally.
33. **`track.enabled` never accessed:** spy on `.enabled`; assert zero property reads.

**SDP munger (`sdp.test.js` extension)**:

34. **Opus `useinbandfec=1` survives the munger** for every fixture in `SDP_FIXTURES`.
35. **Video m-section byte-identical** before/after the munger (against `SDP_WITH_VIDEO`
    fixture with both audio + video m-sections).

**Video feedback verification (`video.test.js` extension)**:

36. **Chrome-like offer:** `verifyVideoFeedback(SDP_WITH_VIDEO)` returns
    `{nack: true, nackPli: true, transportCc: true}`.
37. **Absent video m-section:** `verifyVideoFeedback(SDP_NO_VIDEO)` returns all-false
    without throwing.
38. **Safari 16-like offer:** `verifyVideoFeedback(SDP_WITH_VIDEO_SAFARI)` returns
    `{nack: true, nackPli: true, transportCc: false, red: false, ulpfec: false}`.

### 5.2 Failure-path coverage

**Adapt (`adapt.test.js`):**

- `decideNextRung` called with `sample.lossFraction === null`
  (stats were unavailable this tick): no rung change; no crash.
- `decideNextRung` called with an oversized rung index (simulating a
  state corrupted by hot reload): clamped, no throw.
- Teacher-role with bad samples stays in its own ladder
  (`studentAudio` is never advanced from a teacher state).

**Quality (`quality.test.js`):**

- `summariseStats` called with `prevStats = null` (first tick):
  deltas are 0, no NaN.
- `summariseStats` on a stats Map containing a `candidate-pair` with
  no `currentRoundTripTime` field: `rttMs = null` in the sample.

**Reconnect (`reconnect.test.js`):**

- Direct `'failed'` from `'checking'` (never saw `'connected'`):
  emits `give_up` immediately.
- `'closed'` from `'restarting'` (cable yanked mid-restart):
  `give_up` emitted, no timer left pending.
- Timer fires AFTER `'connected'` was observed: `watching → healthy`
  transition cleared the timer (effect is `'cancel_timer'` on the
  `connected` event).

**`floorViolated` predicate (`adapt.test.js`):**

- Returns `false` for a teacher-role state at `floorBreachStreak >= FLOOR_SAMPLES`
  (role guard: only student role can be in violation).
- Returns `true` only when `role === 'student'` AND `floorBreachStreak >= FLOOR_SAMPLES`.
- Returns `false` at `floorBreachStreak === FLOOR_SAMPLES - 1` (one-shy boundary).

**Video feedback Safari fixture (`video.test.js`):**

- `verifyVideoFeedback` on a Safari 16-style offer (no `transport-cc` line) returns
  `{nack: true, nackPli: true, transportCc: false, red: false, ulpfec: false}`.
  A `SDP_WITH_VIDEO_SAFARI` fixture is added alongside `SDP_WITH_VIDEO` for this case.

**Signalling (browser-only, manual test + one Node check):**

- `setParameters` rejection (stub `sender.setParameters` to throw):
  the adapt loop continues on next tick, no unhandled promise
  rejection. Node test asserts the caller swallows + logs.

**Server-side (`ws_signal_relay.rs` extension):**

- The signal-relay test lobs a synthetic "ICE restart" offer (SDP
  string containing `ice-ufrag` with a new value) through the relay
  and asserts it is delivered unchanged. Pins the opacity invariant
  for ICE restart — the sprint's server-side change surface is
  zero, and this test makes that concrete.

### 5.3 Regression guards (carry-overs from Sprints 1–3)

| Carry-over | Guard |
|---|---|
| Sprint 1 R4 — student-supplied strings rendered via `textContent` only (XSS). | `teacher.js::renderEntry` unchanged; `#quality-badge`, `#reconnect-banner`, `#floor-violation` all set via `textContent`; new test (§5.1 #24) pins badge rendering; grep guard `rg 'innerHTML' web/assets` stays clean at sprint exit (§10 step 14). |
| Sprint 2 R1 #2 — `attachRemoteAudio` contract. | Untouched by this sprint. `signalling.js` routes audio via `dispatchRemoteTrack`, which is already covered. |
| Sprint 2 R1 #3 — single debug gate (`<meta name="sb-debug">`). | New debug-overlay rows (video feedback verification) render only when the gate is present. `debug-overlay.js::startDebugOverlay` keeps its early-return on missing meta. |
| Sprint 2 R1 #6 — partial-failure cleanup + symmetric teardown. | Adapt loop's `setInterval` and reconnect watcher's timer MUST both be cleared in `makeTeardown`. New Node test `signalling.test.js::teardown clears adapt interval and reconnect watcher` injects spy timers and asserts both are cleared. |
| Sprint 2 R2 #11 — no SharedArrayBuffer. | Grep guard re-run at sprint exit (§10 step 14). |
| Sprint 2 R2 #16 — no inline script. | `http_csp::verify_html_has_no_inline_script` still passes after the HTML additions (three new elements, zero script tags). |
| Sprint 2 R2 #28 — prod strips `<!-- sb:debug -->`. | Untouched. |
| Sprint 3 R1 — `track.enabled` is the SOLE mute primitive. | Adapt loop only calls `sender.setParameters`; grep guard `rg 'track.enabled' web/assets/adapt.js web/assets/signalling.js` at sprint exit confirms the adapt path does not touch `.enabled`. **Test:** `adapt.test.js::actions never target track.enabled` — assert no returned action's `type` starts with `setTrackEnabled`. |
| Sprint 3 R1 — video `playsinline` on iOS. | HTML additions do not remove the existing attribute; `http_teach_debug_marker` assertions unchanged. |
| Sprint 3 R1 — `setCodecPreferences` tolerates absent caps. | Untouched by this sprint. |
| Sprint 3 R1 Low #17 — `hasVideoTrack` / `hasTrack` parallelism. | Untouched. |
| Sprint 3 R1 — `#[serde(default)] tier` backward-compat. | No new `ClientMsg` field this sprint; regression-safe by construction. |
| Sprint 3 R1 — `tier_reason` char-safe truncation. | Untouched. |

### 5.4 Fixture reuse plan

- **Re-use:** `SDP_FIXTURES` from Sprint 2. All §5.1 #34 assertions
  iterate over the existing fixture set — no new SDP strings
  required for the FEC-survival property.
- **Re-use:** `spawn_app`, `TestApp::get_html`, `signup_teacher` from
  Sprint 1/2 for the `ws_signal_relay.rs` ICE-restart extension.
- **New fixtures:**
  - `STATS_FIXTURES` in `quality.js` — a set of Map-shaped
    `RTCStatsReport` stand-ins: `healthy_20s`,
    `two_percent_loss_20ms_jitter`, `ten_percent_loss`,
    `stats_without_remote_inbound`, `empty_stats`,
    `STATS_MULTI_SSRC_AUDIO` (two audio outbound SSRCs with different `packetsSent`).
    Frozen in the module for `quality.test.js` + `adapt.test.js` reuse.
  - `SDP_WITH_VIDEO` — synthetic offer with both audio and video m-sections,
    VP8 + H.264 PTs, `a=rtcp-fb nack / nack pli / transport-cc`.
  - `SDP_WITH_VIDEO_SAFARI` — same as above without `transport-cc` line.
  - `SDP_NO_VIDEO` — audio-only SDP (no video m-section) for absent-video test.
  - Two reconnect-event sequences (`STANDARD_FLICKER`,
    `STRAIGHT_TO_FAILED`) exported from `reconnect.js` for test reuse.

### 5.5 Test runtime budget + flaky policy

- **Rust suite:** one new test (`ws_signal_relay.rs::ice_restart_offer
  relays_opaquely`), <500 ms. Aggregate new cost ≤0.5 s; Sprint 2
  budget (<45 s full suite) holds.
- **Node suite:** new-test accounting (auditable from §5.1):
    - `adapt.test.js`: 21 tests from §5.1 (#1, #2, #3, #4, #5, #6, #6a, #6b, #7, #8, #9,
      #10, #10a, #11, #12, #13, #14, #15, #16, #17, #18) + ~6 from §5.2 adapt failure paths ≈ 27.
    - `quality.test.js`: 7 tests from §5.1 (#19, #20, #21, #22, #22a, #23, #24)
      + ~3 from §5.2 ≈ 10.
    - `reconnect.test.js`: 5 tests from §5.1 (#25–#29) + ~4 from §5.2 (inc. closed-from-restarting) ≈ 9.
    - `session-core.test.js`: 4 tests from §5.1 (#30–#33).
    - `sdp.test.js` extension: 2 tests (§5.1 #34–#35).
    - `video.test.js` extension: 3 tests (§5.1 #36–#38).
    - `signalling.test.js` extension: 1 test (§5.3 teardown carry-over).
  Aggregate ≈ 56 new tests. All run in <3 s. Node runner unchanged.
- **Netem harness:** manual only, NOT run in CI. README documents
  the exact commands; runbook points to the expected observable
  rung transitions.
- **Flaky policy:** the adapt loop's timing-sensitive tests use a
  fake clock (`{ now, setTimeout, clearTimeout }` injected). No
  `setTimeout(0)`-based delays, no `await new Promise(r =>
  setTimeout(r, 100))`. Reconnect watcher accepts the same injected
  clock. Any intermittent failure is fixed by tightening the
  injection, never by padding.

## 6. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `sender.setParameters` unsupported or silently no-op on a UA (Safari has had bugs). | Med | Med | `priority` / `networkPriority` hints are the backstop (browser BWE still protects audio). Adapt loop's wrapper logs but does not throw; the state machine still tracks what it *wanted*, so the debug overlay shows the divergence. |
| R2 | `pc.restartIce()` is absent on some older Firefox builds. | Low | High | Version floor (FF 115+, Sprint 3) is above the `restartIce()` landing version. UAs without it fall through to the giveup → teardown path and the page reloads (future sprint). Documented in §8. |
| R3 | Adapt loop flaps the rung under bursty loss. | Med | Med | Hysteresis: DEGRADE_SAMPLES=4, IMPROVE_SAMPLES=8 (double). Property test #6 pins no-flap under alternating-sample input. |
| R4 | 96 kbps floor hides a real fidelity regression because `minBitrate` is Chrome-only. | Med | Med | Adapt-side streak counter + explicit `floor_violation` surface are the portable mechanism. `minBitrate` in encodings is belt-and-braces; the actual floor is enforced by refusing to advance `audioRung` past 1 on the student. |
| R5 | Stats cadence (2 s) is too slow to catch a sudden cliff. | Low | Med | 2 s matches the existing debug overlay cadence; faster polling burns CPU on mobile UAs. Floor surface fires within 12 s of sustained bad samples, which is within the "good subjective audio at 2 % loss" acceptance target (no surface fires there). |
| R6 | `restartIce()` produces a new SDP that the existing Opus fmtp munger does not recognise (e.g. renumbered PTs). | Low | High | The munger is PT-aware (walks `a=rtpmap` to find Opus PTs); renumbering is transparent. Node test #18 iterates every fixture including the re-munged Sprint-3 output. |
| R7 | Video `encodings[0].scaleResolutionDownBy` is not honoured on Firefox. | Med | Low | Video still loses bitrate via `maxBitrate`; resolution downgrade is a best-effort resolution hint. Documented in netem runbook as "on Firefox, resolution will not change but bitrate will." |
| R8 | Floor surface triggers on brief burst loss and reloads the student out of a recoverable session. | Low | High | FLOOR_SAMPLES=6 (12 s sustained) before surfacing. One-shot: once emitted, the state machine does not re-emit without a reset (tested in §5.1 #9). |
| R9 | CSP blocks the quality badge / banner styling. | Low | High | All styling is via classes on elements; CSS is already allowed by `style-src 'self'`. No inline `style=` attributes. `http_csp::*` asserts this for HTML rewrites. |
| R10 | Priority hint `networkPriority: 'high'` triggers a DSCP marking that the network strips, leading to worse-than-default behaviour. | Low | Med | Priority is advisory and only affects local queueing. Field observations via the debug overlay are the guard; documented in §8 as a future-observability item. |
| R11 | Reconnect banner flickers for 2 s then disappears on a stable network (student ICE briefly renegotiates). | Med | Low | `ICE_WATCH_MS = 3000` — banner does not appear for sub-3-s glitches. Test #14 pins this. |
| R12 | Teacher-side ICE restart race: teacher sees a new offer arrive before `restartIce()` fully completes locally. | Low | Med | Perfect-negotiation pattern is not needed because only student is the offerer. Teacher's `setRemoteDescription` on the new offer is the single synchronisation point. |
| R13 | A browser tab throttles `setInterval` in the background, starving the adapt loop. | Med | Low | Deliberately ignored — if the tab is backgrounded the user is not in a lesson. Pinned in §8. |
| R14 | `audio.track.enabled = false` (user muted) is misread as bad quality and drops rung. | Low | Low | `summariseStats` reads byte counters; a muted track still emits RTP frames (silence packets). If it ever stops emitting, `lossFraction === null` branch (failure-path test) holds the rung. |
| R15 | Netem script run without sudo silently half-applies, giving misleading observations. | Med | Low | `impair.sh` uses `set -euo pipefail`; sudo failure aborts with exit code. README explicitly lists sudo as a prerequisite. |

## 7. Exit criteria → test mapping

| SPRINTS.md exit criterion | Verified by |
|---|---|
| Subjective audio quality rated "good" at 2 % simulated loss. | Manual netem run (§4.8–4.9); observations logged in the PR. Supporting logic: `quality.test.js` §5.1 #22 and #22a (tier thresholds + boundary). |
| Degradation order empirically matches spec when bandwidth is squeezed. | `adapt.test.js` §5.1 #5 and #6 (student ordering) + #6a and #6b (teacher ordering) + netem manual run observing rung 1 → 2 → 3 → 4 transitions. |
| Audio-to-teacher 96 kbps floor respected; floor-violation surface fires correctly. | `adapt.test.js` §5.1 #2 (floor-constant) + #9 (floor-breach streak + one-shot emit) + #10 (minBitrate branch); manual netem at 10 % loss triggers the student-side surface. |
| Transient 2–3 s network drop auto-recovered. | `reconnect.test.js` §5.1 #25–#29; manual test using Chrome DevTools → Network → Offline for 2 s confirms the session recovers without user action. |
| `ws_signal_relay.rs` remains green under ICE-restart SDPs. | §5.2 server-side extension. |
| Sprint 3 regressions stay green. | §5.3 full regression matrix; `cargo test` + `node --test` both in CI. |

## 8. Out of scope (explicitly deferred)

- Server-side session-resume token / grace window for WS reconnect
  (Sprint 4 handles only ICE-level reconnect through a still-open
  WebSocket — 2–3 s drops over TCP stay connected on the WS path).
  If the WS itself drops, the student must rejoin and be
  re-admitted. Addressed in Sprint 5 alongside the session log.
- Simulcast / SVC. Not useful for two-peer P2P.
- Chrome-only `packetLossPercentage` Opus extension (§4.5.3).
- Background-tab throttling of the adapt loop (R13).
- DSCP / TOS marking verification (R10).
- Migration to `RTCRtpTransport.getStats` / standards-track
  high-resolution stats — the current `pc.getStats()` per-ssrc
  approach is portable.
- Azure deployment + TURN + session log — Sprint 5.
- Session recording — Sprint 6 (post-MVP).

## 9. Decisions (binding for this sprint)

1. **No server-side protocol change.** Adaptive bitrate, priority
   hints, and ICE restart all reuse the existing `Signal` envelope;
   the server stays payload-opaque. This keeps Sprint 5's
   session-log design unconstrained — we'd rather add one
   `QualityReport` message there, with a full session-token
   handshake, than add it piecemeal here.
2. **Video rung 3 is `encoding.active = false`, not
   `track.enabled = false` and not `transceiver.direction =
   'inactive'`.** Preserves the Sprint 3 invariant that
   `track.enabled` is the USER's primitive, and avoids the SDP
   renegotiation that an inactive transceiver would require.
3. **Thresholds:** DEGRADE_LOSS=0.05, DEGRADE_RTT_MS=500,
   IMPROVE_LOSS=0.02, IMPROVE_RTT_MS=300, DEGRADE_SAMPLES=4,
   IMPROVE_SAMPLES=8, FLOOR_SAMPLES=6. Chosen to align with
   "subjective audio good at 2 % loss" (below DEGRADE_LOSS on
   average) while reacting within ~8 s of sustained real loss.
4. **Cross-rung ordering is enforced in the ADAPT state machine,
   not in each peer's thresholds.** A peer in the student role
   advances `audioRung` only when `videoRung` is at the bottom of
   its own ladder. Tested directly (§5.1 #5 and #6).
5. **Video SDP is not munged.** NACK / RED / ULPFEC negotiation is
   left to the browser defaults; the debug overlay surfaces what
   was actually negotiated. The interop risk of rewriting video
   m-sections exceeds the benefit given our codec-preference-based
   policy already orders VP8/H.264 per UA.
6. **Only the student calls `pc.restartIce()`.** The student is the
   offerer in the existing code path (`connectStudent` owns the
   initial `createOffer`). Keeping a single offerer sidesteps the
   perfect-negotiation coordination problem.
7. **Reconnect timer budget: 3 s watch + 5 s restart = 8 s
   observable upper bound.** This is within the "within 5 s without
   user action" target for the common case (ICE recovers during
   `watching`, never enters `restarting`). The full 8 s is reserved
   for the restart path.
8. **Quality badge is advisory, not gating.** A "poor" badge does
   not disable the call; only the floor-violation surface ends it.
9. **`minBitrate: 96_000` on student audio is belt-and-braces,
   not authoritative.** The adapt state machine owns the floor;
   `minBitrate` is a polite hint for compliant UAs.
10. **Netem harness is manual.** CI does not run it. The harness
    and its runbook are deliverables; automating netem in CI is out
    of scope (needs a privileged container).

## 10. Implementation checklist

1. `web/assets/adapt.js` — UMD factory; `LADDER`, `initLadderState`,
   `decideNextRung`, `encodingParamsForRung`, `floorViolated`, constants.
   File header.
2. `web/assets/tests/adapt.test.js` — §5.1 #1–#18 (state machine, `encodingParamsForRung`,
   `floorViolated`) + §5.2 adapt failure paths.
3. `web/assets/quality.js` — UMD; `summariseStats`, `qualityTierFromSummary`,
   `renderQualityBadge`, `STATS_FIXTURES`. File header.
4. `web/assets/tests/quality.test.js` — §5.1 quality tests + §5.2 failure paths.
5. `web/assets/reconnect.js` — UMD; state machine + exported sequence fixtures;
   browser wrapper binds `iceconnectionstatechange`. File header.
6. `web/assets/tests/reconnect.test.js` — §5.1 reconnect tests + §5.2 edge cases
   (injected fake clock; `'closed'` from `'restarting'`).
7. `web/assets/video.js` — add `verifyVideoFeedback(sdp)` pure helper; export via
   UMD. File header's `Last updated` bumped.
8. `web/assets/tests/video.test.js` — extend with Chrome, Safari, and absent-video
   fixtures (§5.1 + §5.2 Safari SDP fixture).
9. `web/assets/tests/sdp.test.js` — extend with FEC-survival + video-section
   byte-identical assertions.
10. `web/assets/session-core.js` — browser-only orchestration: `startSessionSubsystems`
    (starts adapt loop + quality monitor + reconnect watcher, returns `{ stopAll() }`);
    `applyActions` (sole WebRTC mutation call site; swallows rejections). File header.
11. `web/assets/tests/session-core.test.js` — stub-based Node tests for `applyActions`
    (§5.1 applyActions tests).
12. `web/assets/signalling.js` — wire priority hints at transceiver creation; after data
    channel open call `session-core.startSessionSubsystems`; ICE-restart re-offer path
    on student side; `makeTeardown` calls `stopAll()`. File header bumped.
13. `web/assets/tests/signalling.test.js` — extend with `teardown calls stopAll` (§5.3).
14. `web/student.html`, `web/teacher.html` — add `#reconnect-banner`, `#quality-badge`,
    `#floor-violation` elements; add `<script>` tags for new modules in load order:
    adapt → quality → reconnect → session-core → (signalling already last).
15. `web/assets/student.js`, `web/assets/teacher.js` — thread `onQuality`,
    `onFloorViolation`, `onReconnectBanner` callbacks; render badge; handle floor
    violation (student: hide session, show notice, hangup).
16. `web/assets/styles.css` — quality-badge, reconnect-banner, floor-violation
    (both colour schemes). Grep guards at sprint exit:
    `rg 'innerHTML' web/assets` (clean),
    `rg 'SharedArrayBuffer' web/assets` (clean),
    `rg 'track\.enabled' web/assets/adapt.js web/assets/session-core.js web/assets/signalling.js`
    (matches only in existing controls-related paths, not adapt).
17. `tests/netem/impair.sh`, `clear.sh`, `README.md` — executable, sudo-safe, documented.
18. `knowledge/runbook/netem.md` — step-by-step runbook, expected observables, link to ADR-0001.
19. `server/tests/ws_signal_relay.rs` — add `ice_restart_offer` relay case (§5.2 server-side).
20. `server/tests/http_teach_debug_marker.rs` — extend dev-view asserts to include
    `#quality-badge`, `#reconnect-banner`, `#floor-violation`.
21. Re-run `python3 scripts/index-codebase.py --incremental`.
22. Re-run `./scripts/check-headers.py --sprint 4` and fix any warnings.
23. Commit before `code` review — reviewers diff against `.sprint-base-commit-4`.
24. `./scripts/council-review.py plan 4 "bandwidth adaptation + quality hardening"`.
25. On plan APPROVED, implement, re-run full suite, then
    `./scripts/council-review.py code 4 "bandwidth adaptation + quality hardening"`.
26. On code APPROVED, `./scripts/archive-plan.sh 4 "bandwidth adaptation + quality hardening"`,
    update `SPRINTS.md` status, append to `CHANGES.md`.


---

# Sprint 5: Azure + Cloudflare deployment + TURN + session log

_Archived: 2026-04-18_

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


---

# Sprint 6: Session Recording

_Archived: 2026-04-18_

# PLAN_Sprint6.md — Session Recording

**Sprint:** 6  
**Status:** R1 REVISED  
**Date:** 2026-04-18

---

## Problem Statement

Teachers have no way to persist a lesson. A student who wants to review their singing or a teacher who wants to document a lesson's arc has nothing after the call ends. Sprint 6 adds session recording with a frictionless post-session send flow, a teacher recording library, and a lightweight email-gate for student access.

**Spec references:** `SPRINTS.md § Sprint 6`  
**Architecture constraint:** `knowledge/decisions/0001-mvp-architecture.md` — no SFU; browser-only clients; stateless students; Azure Blob for storage.  
**Signalling constraint:** `knowledge/architecture/signalling.md` — `ClientMsg`/`ServerMsg` tagged unions; single-writer pump; no `.await` while holding `RwLock`.

---

## Current State (from codegraph)

| Layer | What exists | What is missing |
|---|---|---|
| Server routes | `/signup`, `/auth/*`, `/teach/:slug`, `/loopback`, `/ws` | Recording upload, recording library, email-gate playback |
| DB schema | `teachers`, `magic_links`, `sessions`, `signup_attempts` | `recordings` table |
| WS protocol | `ClientMsg` (join/watch/admit/reject/signal), `ServerMsg` (lobby/session/error) | Consent handshake, recording-active indicator |
| Mailer | `Mailer` trait + `DevMailer` + `CloudflareWorkerMailer`; only `send_magic_link` | `send_recording_link` method on all impls |
| Client JS | teacher.js, session-core.js, signalling.js, student.js | recorder.js, recordings.js, recording-gate.js |
| HTML | teacher.html, student.html | recordings.html (library), recording.html (gate) |
| Storage | None | `BlobStore` trait + `DevBlobStore` + Azure impl |

---

## Proposed Solution

### Approach chosen: client-side `MediaRecorder` + `BlobStore` trait

The teacher's browser composes a stream (Web Audio API mixes teacher mic + student remote audio; teacher video track added), feeds it to `MediaRecorder`, and accumulates `ondataavailable` chunks in memory. On session end the accumulated blob is uploaded via `POST /api/recordings/upload`. The server stores it via a `BlobStore` abstraction (dev: local file; prod: Azure Blob Storage), persists metadata to SQLite, and issues a random access token.

**Why not SFU-assisted server-side recording?**  
ADR-0001 explicitly deferred the SFU to multi-party or recording needs. Client-side recording avoids adding a forwarding hop that would increase latency for the live session. The quality trade-off is small: the teacher's browser already receives both streams.

**Why teacher's browser, not student's?**  
The teacher is the session owner, initiates recording, and is the distribution actor.

**Alternative considered: server-side mixing via RTMP/ffmpeg**  
Rejected — requires a transcoding service not in the current infra.

---

## Component Design

### 1. Database — `server/migrations/0003_recordings.sql`

**Migration numbered `0003`** — `0001_initial.sql` and `0002_*` already exist (or are reserved); using `0003` avoids ordering ambiguity.

```sql
CREATE TABLE recordings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id           INTEGER NOT NULL REFERENCES teachers(id),
  student_email        TEXT    NOT NULL,          -- stored plaintext; consent was given
  student_email_hash   BLOB    NOT NULL,          -- SHA-256(lowercase), gate comparison
  created_at           INTEGER NOT NULL,          -- unix seconds
  duration_s           INTEGER,                   -- NULL until upload confirmed
  blob_key             TEXT    UNIQUE,            -- opaque UUID-based key; NULL = blob purged
  token_hash           BLOB    NOT NULL UNIQUE,   -- SHA-256(256-bit random token)
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  accessed_at          INTEGER,                   -- NULL until first successful gate access
  deleted_at           INTEGER                    -- soft-delete; NULL = live
);

CREATE INDEX idx_recordings_teacher    ON recordings(teacher_id, created_at DESC);
CREATE INDEX idx_recordings_token_hash ON recordings(token_hash);

-- Gate-attempt rate limiting (per-IP, per 5 min window).
CREATE TABLE recording_gate_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_ip      TEXT    NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX idx_gate_attempts_ip_t ON recording_gate_attempts(peer_ip, attempted_at);
```

**Schema decisions explained:**
- `blob_key` is `NULLABLE` (no `NOT NULL`): the cleanup task sets it to `NULL` after the blob is purged. `UNIQUE` still holds (SQLite allows multiple `NULL` values in a UNIQUE column — this is the standard SQL behaviour). A `NULL` `blob_key` means the blob has been purged; the row is retained for audit. This replaces the earlier conflicting `NOT NULL` design.
- `accessed_at` column added to record first successful gate access (timestamp, no IP stored permanently).
- `recording_gate_attempts` is a dedicated table (not reusing `signup_attempts`) — different semantics, different cleanup cadence, easier to index and query independently.

`student_email` stored plaintext because: (a) student explicitly consented to recording, (b) teacher needs legible display in library, (c) Sprint 6 is pre-prod. Encryption-at-rest can be added post-launch.

### 2. BlobStore trait — `server/src/blob.rs`

**Trait uses `#[async_trait]` to be object-safe for `Arc<dyn BlobStore>`** — matching the existing `Mailer` pattern.

```rust
#[async_trait]
pub trait BlobStore: Send + Sync + 'static {
    async fn put(&self, key: &str, data: Pin<Box<dyn AsyncRead + Send>>) -> Result<u64>;
    // Returns bytes written. Pin<Box<dyn AsyncRead + Send>> is dyn-safe; Arc<dyn BlobStore> compiles.

    async fn get_url(&self, key: &str, ttl_secs: u64) -> Result<Url>;
    // Returns a time-limited URL (Azure SAS or /api/dev-blob/<uuid>.webm).

    async fn delete(&self, key: &str) -> Result<()>;
}
```

**Streaming `put` (not `Bytes`)**: The upload body is a `Pin<Box<dyn AsyncRead + Send>>` (not `impl AsyncRead`, which is not dyn-safe). This is the same pattern used by `tokio::io` combinators. `DevBlobStore` writes chunks incrementally to disk; `AzureBlobStore` uses block upload. Avoids materialising a 100–500 MB recording in server memory.

**`impl AsyncRead` vs `Pin<Box<dyn AsyncRead>>`**: `impl Trait` in trait method position is generic, breaking object safety. `Pin<Box<dyn AsyncRead + Send>>` is a concrete type — the trait is object-safe and `Arc<dyn BlobStore>` compiles.

**`DevBlobStore`** — writes to `Config.dev_blob_dir/{uuid}.webm` on disk (flat directory, no subdirectories). `get_url` returns `/api/dev-blob/{uuid}.webm`. All implementations annotated with `#[async_trait]`.

**`AzureBlobStore`** (prod) — uses `azure_storage_blobs` crate + SAS tokens. Uses a full path key internally (`recordings/{teacher_id}/{uuid}.webm`) but this is the Azure-side path only, never exposed in URLs or passed to the dev route. Stubbed in this sprint; wired in Sprint 5 when infra lands.

**Blob key format — two-tier design** (resolves dev/prod consistency):
- **DB `blob_key`**: for DevBlobStore, `{uuid}.webm`; for AzureBlobStore, `recordings/{teacher_id}/{uuid}.webm`. The key format is opaque to callers — the BlobStore impl maps it to its storage path.
- **Dev serving route segment**: `{uuid}.webm` — no slashes, traversal defense works as specified.
- **UUID generation**: `uuid::Uuid::new_v4().to_string()` on the server. No user-supplied strings in the key.

`AppState` gains `pub blob: Arc<dyn BlobStore>`.

### 3. Mailer extension — `server/src/auth/mailer.rs`

Add to the `Mailer` trait:

```rust
async fn send_recording_link(&self, to: &str, url: &Url) -> Result<(), MailerError>;
```

**All three impls updated**:
- `DevMailer` — appends a JSON line to the same per-email `.jsonl` file (same pattern as `send_magic_link`)
- `CloudflareWorkerMailer` — sends via the existing Cloudflare worker endpoint with a recording-link template
- Any future impl gets a compile error if it misses the method — no `default` impl to hide the gap

### 4. WebSocket protocol extensions — `server/src/ws/protocol.rs`

New `ClientMsg` variants:
```
RecordStart { slug: String }              // teacher initiates
RecordConsent { slug: String, granted: bool }  // MUST come from active student connection
RecordStop { slug: String }               // teacher stops early
```

New `ServerMsg` variants:
```
RecordConsentRequest                      // server → student only
RecordConsentResult { granted: bool }     // server → teacher only
RecordingActive                           // server → both sides
RecordingStopped                          // server → both sides
```

`ErrorCode` additions: `RecordNotInSession`, `RecordNoConsent`, `RecordAlreadyActive`.

**Consent sender enforcement** in `ws/session.rs`:

```
RecordStart handler:
  - Require sender connection is the teacher (by matching room.teacher_conn.id)
  - Require room.active_session is Some
  - Require room.recording_active == false, else send Error { RecordAlreadyActive }
  - Relay RecordConsentRequest to student conn only

RecordConsent handler:
  - EXPLICIT CHECK: Require sender connection is room.active_session.student.conn.id
  - If sender is NOT the student → send Error { code: NotInSession } to sender, no state change
  - If granted: set room.recording_active = true; relay RecordConsentResult { true } to teacher,
                RecordingActive to both
  - If denied: relay RecordConsentResult { false } to teacher only; no state change
```

This ensures a teacher client cannot self-grant consent by sending `RecordConsent`.

**Session-end cleanup — both disconnect paths**:

_Student disconnect_ (existing `remove_by_connection` path): if `room.recording_active == true`, reset to `false`; relay `RecordingStopped` to the teacher connection after releasing the write guard.

_Teacher disconnect_: the teacher's WebSocket closes → the teacher pump drops → the connection is removed from `room.teacher_conn`. If `room.recording_active == true`, reset to `false`; relay `RecordingStopped` to `room.active_session.student.conn` (if present) after releasing the write guard. The student sees the indicator go off before the `PeerDisconnected` message arrives.

No `.await` while holding the `RwLock` guard in either path — same rule as existing session handlers.

`RoomState` gains `recording_active: bool` (default `false`).

`ErrorCode` additions (revised): **`RecordAlreadyActive`** (new) + **`NotInSession`** reused for "no active session when `RecordStart` sent" and "non-student sender of `RecordConsent`". `RecordNotInSession` is removed (redundant with existing `NotInSession`). `RecordNoConsent` is removed (the 30 s timeout path has the client send `RecordConsent { granted: false }`, making a server-side no-consent code unnecessary).

### 5. Server HTTP routes — `server/src/http/`

**New module: `recordings.rs`** — all routes require teacher session cookie:

| Method | Path | Auth | Handler |
|---|---|---|---|
| `POST` | `/api/recordings/upload` | Teacher cookie | Stream multipart body → BlobStore; INSERT recordings row (transactional — see §orphan handling) |
| `GET` | `/api/recordings` | Teacher cookie | Auth by `teacher_id` (NOT by slug). Returns `Vec<RecordingView>` filtered by `teacher_id` and `deleted_at IS NULL`. Query param: `sort=date\|student` |
| `POST` | `/api/recordings/:id/send` | Teacher cookie | Verify `teacher_id` owns the recording. Send email; if `failed_attempts >= 3`, issue a new token + reset counter |
| `DELETE` | `/api/recordings/:id` | Teacher cookie | Verify `teacher_id` owns recording. Set `deleted_at = now()` |

**Authorization contract for all recording routes**: extract `teacher_id` from session cookie first; then `WHERE id = ? AND teacher_id = ?` on every query. Never rely on slug as the authorization gate. Return 403 (not 404) when a teacher tries to act on another teacher's recording.

**`RecordingView`** — explicitly defined struct serialized by the `GET /api/recordings` handler. Excludes all internal fields:
```rust
pub struct RecordingView {
    pub id:            i64,
    pub student_email: String,
    pub created_at:    i64,      // unix seconds
    pub duration_s:    Option<i64>,
    pub status:        RecordingStatus, // "live" | "link_disabled" | "uploading"
}
// Never serialized: token_hash, student_email_hash, blob_key, teacher_id, deleted_at
```
`status` is derived server-side: `uploading` if `duration_s IS NULL`; `link_disabled` if `failed_attempts >= 3`; `live` otherwise.

**Blob-orphan handling (upload transaction)**:
1. Insert `recordings` row inside a SQLite transaction with `blob_key` pre-generated (but `duration_s` NULL).
2. Stream body to `BlobStore::put(key, body_stream)`.
3. If `put` fails → rollback transaction; return 500.
4. If `put` succeeds but commit fails → call `BlobStore::delete(key)` as compensation before returning 500. Log if that delete also fails (blob is then orphaned; the cleanup task will not find it since the DB row was never committed — document this as a known edge case for the production runbook).
5. On success → return `{ id, token }`.

**Upload body size limit**: `RequestBodyLimit` at 512 MB on the upload route only; all other routes keep Axum's 2 MB default.

**MIME type / magic-byte validation on upload (stream reconstruction)**:
- Accept only `Content-Type: video/webm` or `audio/webm` (from request header, checked first).
- Extract the body as a `Stream<Item = Result<Bytes>>` via `axum::body::BodyDataStream`.
- Read the first 4 bytes: buffer chunks from the stream into a `BytesMut` until 4 bytes are accumulated.
- Reject with 415 if the bytes do not match the WebM magic signature `\x1A\x45\xDF\xA3`.
- **Stream reconstruction** (fully async, compiles with `Pin<Box<dyn AsyncRead + Send>>`):
  ```rust
  // Dependencies: tokio-util, futures, bytes (already in ecosystem)
  use bytes::Bytes;
  use futures::{stream, StreamExt};
  use tokio_util::io::StreamReader;

  let header_bytes: Bytes = Bytes::copy_from_slice(&header); // 4 validated bytes
  let body_stream = remaining_body_stream   // BodyDataStream, Item = Result<Bytes, BodyError>
      .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
  let prepended = stream::once(async { Ok::<Bytes, std::io::Error>(header_bytes) })
      .chain(body_stream);
  let reader: Pin<Box<dyn AsyncRead + Send>> = Box::pin(StreamReader::new(prepended));
  blob.put(&key, reader).await?;
  ```
  `StreamReader` (from `tokio-util`) wraps a `Stream<Item = Result<Bytes, std::io::Error>>` into an `AsyncRead`. The stored blob is byte-for-byte identical to the original upload body (the 4 header bytes are prepended back before storage).
- The blob key suffix `.webm` is fixed (not derived from the MIME header).

**New module: `recording_gate.rs`** (no auth):

| Method | Path | Handler |
|---|---|---|
| `GET` | `/recording/:token` | Serve `recording.html`; token format validated (must be 64 hex chars) |
| `POST` | `/recording/:token/verify` | Two-control rate limiting (see below); email hash check against `student_email_hash WHERE deleted_at IS NULL`; on match return time-limited blob URL |

**Two-control rate limiting on `/recording/:token/verify`**:
1. **Per-IP limit** (checked first): INSERT into `recording_gate_attempts(peer_ip, attempted_at = strftime('%s','now'))`; then `SELECT COUNT(*) WHERE peer_ip = ? AND attempted_at > strftime('%s','now') - 300`. If count > 10, reject with 429 before any DB token lookup. Cleanup task prunes rows where `attempted_at < strftime('%s','now') - 300`.

   **Client IP extraction** — `Config` gains `trust_cf_connecting_ip: bool` (default `false`; set `true` in prod):
   - If `trust_cf_connecting_ip`: read `CF-Connecting-IP` header (set by Cloudflare for all proxied requests); use its value as `peer_ip`.
   - Fallback / dev: use `ConnectInfo<SocketAddr>` from Axum (TCP peer address). In dev this is `127.0.0.1`; in prod behind Cloudflare the TCP peer is Cloudflare's edge IP — only the header gives the real client IP.
   - If `trust_cf_connecting_ip` is true but the header is absent, reject with 400 (malformed request in a Cloudflare-fronted deployment).
2. **Per-token lockout** (second): after 3 failed email checks for a given token, `failed_attempts >= 3` — all subsequent verifies return 403 `token_disabled` without incrementing further. Teacher notified by email on reaching 3 (once).

Response body for `POST /recording/:token/verify`:
- `200 { url: "<time-limited Azure SAS or /api/dev-blob/<key>>" }` — on success; logs `accessed_at` (timestamp, no IP stored permanently)
- `403 { error: "wrong_email" }` — wrong email, attempts remaining
- `403 { error: "token_disabled" }` — locked out
- `404` — token not found or `deleted_at IS NOT NULL`
- `429` — per-IP rate limit hit

**Token format validation**: `/recording/:token` and `/recording/:token/verify` both reject (404 or 400) immediately if the token path segment is not exactly 64 lowercase hex characters. No DB lookup for malformed tokens.

**Dev blob serving** — `GET /api/dev-blob/:key` (dev builds only, gated at compile time via `#[cfg(debug_assertions)]` + runtime `Config.dev` check):

Path traversal defense:
```rust
let safe_key = key.trim_matches('/');
if safe_key.contains("..") || safe_key.contains('/') {
    return Err(AppError::NotFound);
}
let resolved = config.dev_blob_dir.join(safe_key);
let canonical = resolved.canonicalize()?;
let root = config.dev_blob_dir.canonicalize()?;
if !canonical.starts_with(&root) {
    return Err(AppError::NotFound);
}
// stream file
```

The route handler is only registered when `config.dev == true`; in release builds the route does not exist even if someone crafts a request to it.

**New HTML route for library**: `GET /teach/:slug/recordings` — served from `recordings.html`; requires teacher session cookie (add to `recordings.rs`, same auth as other recording routes).

**Cleanup task** — extracted into a testable function:

```rust
// server/src/cleanup.rs
pub async fn run_one_cleanup_cycle(db: &SqlitePool, blob: &Arc<dyn BlobStore>) -> Result<usize> {
    // SELECT id, blob_key FROM recordings
    //   WHERE deleted_at IS NOT NULL
    //     AND deleted_at < strftime('%s','now') - 86400
    //     AND blob_key IS NOT NULL
    // for each: BlobStore::delete(key); if delete succeeds → UPDATE recordings SET blob_key = NULL
    //           if delete fails → log warning, leave blob_key intact (retry next cycle)
    // Also: DELETE FROM recording_gate_attempts WHERE attempted_at < strftime('%s','now') - 300
    // returns count of blobs successfully purged
    //
    // Note: strftime('%s','now') returns integer unix seconds — compatible with the schema.
    //       Do not use now() (not valid SQLite) or CURRENT_TIMESTAMP (returns text, not integer).
}

pub async fn cleanup_loop(db: SqlitePool, blob: Arc<dyn BlobStore>, shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            _ = interval.tick() => { let _ = run_one_cleanup_cycle(&db, &blob).await; }
            _ = shutdown.cancelled() => break,
        }
    }
}
```

`cleanup_loop` is spawned in `main.rs` with the existing `AppState.shutdown` token, so it exits cleanly on graceful shutdown. Integration tests call `run_one_cleanup_cycle` directly without sleeping.

### 6. Token security

- Token: `rand::thread_rng().fill_bytes(&mut buf)` where `buf` is `[u8; 32]` declared in scope — NOT a discarded temporary
  ```rust
  let mut buf = [0u8; 32];
  rand::thread_rng().fill_bytes(&mut buf);
  let token_hex = hex::encode(&buf);
  let token_hash = Sha256::digest(&buf);
  ```
- Stored: `token_hash` (32 bytes) in `recordings.token_hash`
- URL: `/recording/<token_hex>` (64 hex chars)
- Gate: `Sha256::digest(email.to_lowercase().as_bytes())` compared with `subtle::ConstantTimeEq` to `student_email_hash`
- New token on resend: same generation, resets `failed_attempts = 0`, overwrites `token_hash`

### 7. Client-side recorder — `web/assets/recorder.js`

```
window.sbRecorder = {
  start(localStream, remoteStream) → handle,
  // handle: { stop() → Promise<Blob>, mimeType: string }
}
```

Implementation:
1. Create `AudioContext`.
2. `createMediaStreamSource(localStream)` + `createMediaStreamSource(remoteStream)` → both to `createMediaStreamDestination()`.
3. Add teacher's video track from `localStream` to the destination `MediaStream`.
4. Detect supported MIME: try `video/webm;codecs=vp8,opus` → `video/webm` → `audio/webm;codecs=opus` (audio-only, noted in upload body).
5. `new MediaRecorder(compositeStream, { mimeType })`.
6. `ondataavailable` pushes `Uint8Array` chunks to an array (no single large allocation).
7. `stop()` returns `Promise<Blob>` resolving on `onstop`.

Upload helper `uploadRecording(blob, mimeType, slug)`:
- `fetch('/api/recordings/upload', { method: 'POST', body: blob, headers: { 'Content-Type': mimeType } })`
- Returns `{ id, token }` from server
- Progress tracked via `XMLHttpRequest` `upload.onprogress` (or ReadableStream if browser supports)

### 8. Teacher UI changes — `web/teacher.html` + `web/assets/teacher.js`

**Record button** (shown only during active session):
- States: `idle` → `waiting-consent` → `recording` → `stopped`
- Button label + border change per state; uses `textContent` only (no `innerHTML`)

**Consent relay** in teacher.js:
- `RecordStart` sent when teacher presses Record
- `RecordConsentResult { granted: false }` → reset button, show "Student declined recording" via `textContent`
- `RecordConsentResult { granted: true }` → call `sbRecorder.start(localStream, remoteStream)`
- `RecordingActive` → show REC indicator on both sides
- `RecordAlreadyActive` error → show "Recording already in progress"

**Post-session modal**: shown if a recording blob is available on session end. Upload runs in background; Send button disabled until upload resolves. Email field pre-filled from the admitted student's email (already available in teacher.js scope from the admitted `LobbyEntryView`).

**Student email exposure**: `signalling.js` exposes the current session's student email on the returned handle (e.g., `handle.studentEmail`) so `teacher.js` can pre-fill the modal without accessing globals.

**Recordings library link**: `<a href="/teach/<slug>/recordings">My recordings</a>` in teacher.html header, rendered with `textContent` for the slug.

### 9. Student UI changes — `web/student.html` + `web/assets/student.js`

**Consent banner** — shown on `RecordConsentRequest`:
- 30-second timeout: auto-sends `RecordConsent { granted: false }` and hides banner (tested explicitly in JS test matrix)
- `consent-accept`/`consent-decline` buttons render text via `textContent` only

**REC indicator**: `<span id="rec-indicator" hidden>REC</span>` shown on `RecordingActive`, hidden on `RecordingStopped`.

### 10. Teacher recording library — `web/recordings.html` + `web/assets/recordings.js`

- `GET /api/recordings` filtered by `teacher_id` (from session cookie); response excludes `deleted_at IS NOT NULL` rows
- Sort: `sort=date` (default) or `sort=student` query param; server returns pre-sorted; client can re-sort without refetch
- All string values rendered via `textContent` / `createElement` — no `innerHTML`
- Send link inline: reveals `<input type="email">` pre-filled with `student_email`; submit calls `POST /api/recordings/:id/send`; on success shows "Sent" confirmation
- Delete: `confirm()` then `DELETE /api/recordings/:id`; row removed from DOM on 200

### 11. Student recording access — `web/recording.html` + `web/assets/recording-gate.js`

1. Browser loads `/recording/<token>` → server validates token format (64 hex, else 404); serves `recording.html`
2. JS shows email gate form; submit calls `POST /recording/:token/verify`
3. On `200`: set `<video>` `src` attribute to the returned URL; show player
4. On `403 wrong_email`: show error via `textContent` ("Email didn't match. Please try again.")
5. On `403 token_disabled`: show "This link has been disabled. Ask your teacher to resend."
6. On `404`: show "This recording link is invalid."
7. On `429`: show "Too many attempts. Please try again later."

**Gate query contract**: `SELECT … FROM recordings WHERE token_hash = ? AND deleted_at IS NULL` — the `deleted_at IS NULL` predicate is explicit in the handler, not only in tests.

---

## File Change Summary

| File | Change |
|---|---|
| `server/migrations/0003_recordings.sql` | NEW — recordings table + indexes (numbered 0003) |
| `server/src/blob.rs` | NEW — `#[async_trait]` BlobStore trait (streaming put) + DevBlobStore |
| `server/src/cleanup.rs` | NEW — `run_one_cleanup_cycle` + `cleanup_loop` (testable entry point) |
| `server/src/http/recordings.rs` | NEW — teacher recording API + library page (auth by teacher_id) |
| `server/src/http/recording_gate.rs` | NEW — two-control rate-limit + email gate + playback |
| `server/src/http/mod.rs` | MODIFY — add new routes; dev-blob route gated on cfg+runtime |
| `server/src/state.rs` | MODIFY — `RoomState` adds `recording_active: bool` |
| `server/src/ws/protocol.rs` | MODIFY — new ClientMsg/ServerMsg variants + ErrorCode entries |
| `server/src/ws/session.rs` | MODIFY — RecordStart/RecordConsent/RecordStop handlers; sender-role check |
| `server/src/auth/mailer.rs` | MODIFY — `send_recording_link` on Mailer trait + ALL impls (Dev + Cloudflare) |
| `server/src/config.rs` | MODIFY — add `dev_blob_dir`, `recording_max_bytes`, `recording_link_ttl_secs` |
| `server/src/lib.rs` / `main.rs` | MODIFY — construct BlobStore; spawn `cleanup_loop` with shutdown token |
| `server/tests/common/mod.rs` | MODIFY — `TestOpts` gains `blob: Option<Arc<dyn BlobStore>>`; defaults to temp-dir DevBlobStore |
| `web/teacher.html` | MODIFY — Record button, REC indicator, post-session modal, library link |
| `web/assets/teacher.js` | MODIFY — recorder wiring, consent relay, modal logic, student email on handle |
| `web/student.html` | MODIFY — consent banner, REC indicator |
| `web/assets/student.js` | MODIFY — consent banner (+ 30 s timeout), REC indicator |
| `web/assets/recorder.js` | NEW — MediaRecorder + stream composition + upload |
| `web/recordings.html` | NEW — teacher library page |
| `web/assets/recordings.js` | NEW — library fetch, sort, send, delete (all textContent) |
| `web/recording.html` | NEW — student email-gate page |
| `web/assets/recording-gate.js` | NEW — gate form, player reveal, all error states |

---

## Test Strategy

### Property / invariant coverage

- `token_hash` is never the raw token: unit test inserts recording, verifies raw 32-byte buf != stored hash, and that `hex::encode(Sha256::digest(buf)) == hex::encode(token_hash)`.
- `accessed_at` invariants: (a) `NULL` before any successful gate verify; (b) populated with a timestamp on first successful verify; (c) does NOT change on a second successful verify (immutable after first access). All three asserted as separate test cases against the DB row.
- Upload byte-fidelity: integration test uploads a known 8-byte WebM-magic-prefixed payload; downloads via the dev-blob route; asserts the retrieved bytes are identical to the uploaded bytes. Catches truncation or off-by-one in stream reconstruction.
- Email-gate constant-time comparison: unit test verifies `subtle::ConstantTimeEq` is the comparison used; a correct email returns match; a wrong-by-one-character email returns no-match.
- `failed_attempts` monotonically increases to lockout: property test drives N (1–10) wrong emails; asserts `failed_attempts == min(N, 3)` and that `failed_attempts >= 3` disables the gate.
- `recording_active` state machine: unit test drives RecordStart → ConsentGranted → active; then session end → inactive. Verify no intermediate state is skipped.
- Soft-delete gate: integration test sets `deleted_at`, verifies `POST /recording/:token/verify` returns 404 even with a correct email.
- `deleted_at IS NOT NULL` excludes rows from `GET /api/recordings`: integration test creates a recording, deletes it, verifies it is absent from the listing.

### Failure-path coverage

- Upload: BlobStore `put` fails → DB row rolled back; handler returns 500; teacher modal shows error.
- Upload: DB commit fails after successful `put` → `BlobStore::delete` called as compensation; 500 returned.
- Upload: body > 512 MB → 413 before reaching handler; modal shows "Recording too large".
- Upload: wrong/missing WebM magic bytes → 415; no blob stored.
- Gate: wrong email ×3 → `failed_attempts = 3`; subsequent correct email returns 403 `token_disabled`.
- Gate: per-IP rate limit (>10 attempts/5min) → 429 before token lookup.
- Gate: malformed token (not 64 hex chars) → 404, no DB query.
- Gate: token not found → 404.
- Gate: resend creates a new token; old token returns 404 on subsequent verify.
- WS `RecordConsent` from teacher connection → `Error { NotInSession }`; `recording_active` remains false.
- WS `RecordStart` when `recording_active == true` → `Error { RecordAlreadyActive }`.
- WS `RecordStart` when no active session → `Error { RecordNotInSession }`.
- WS `RecordStart` sent by a student connection → `Error { NotOwner }` (student can't call teacher-only messages).
- WS teacher disconnect during active recording: `recording_active` is reset to false; `RecordingStopped` sent to student.
- Cross-teacher authorization: teacher A's cookie cannot `GET /api/recordings` for teacher B's recordings (empty list returned, not 403, to avoid enumeration); cannot `DELETE` or send-link for teacher B's recording (403).
- Cleanup: `run_one_cleanup_cycle` when `BlobStore::delete` fails — row's `blob_key` remains non-NULL; row survives for retry next cycle; function returns 0 purged.
- Cleanup: stale `recording_gate_attempts` rows (older than 300 s) are pruned by `run_one_cleanup_cycle`; test inserts old and fresh rows, runs one cycle, asserts old row gone and fresh row retained.

### Regression guards

- **Sprint 3 R4 — no innerHTML**: Grep for `innerHTML` in all new JS files; CI fails if found.
- **Sprint 1 — no `.await` under RwLock**: All new recording WS handlers follow acquire→modify→drop→await; code review checkpoint explicitly checks `session.rs` recording block.
- **Sprint 2 — Mailer trait decoupling**: `recordings.rs` receives `Arc<dyn Mailer>`; grep for `DevMailer` / `CloudflareWorkerMailer` in `recordings.rs` fails if found.
- **Sprint 4 — stable lobby removal order**: No recording-state code touches `lobby` ordering; `remove_by_connection` change is additive only.
- **Existing CSP tests**: `server/tests/http_csp.rs` extended to cover `/recording/:token` and `/teach/:slug/recordings` — both must carry the strict CSP header.

### Fixture reuse plan

- `tests/common/mod.rs` `TestApp` / `TestOpts` — `TestOpts` gains `blob: Option<Arc<dyn BlobStore>>`, defaulting to a temp-dir `DevBlobStore` (via `tempfile::tempdir()`). Existing tests gain the field implicitly via `..Default::default()`.
- **Two-teacher fixture**: add `make_two_teachers(app)` helper returning `(TeacherFixture, TeacherFixture)` — used for cross-teacher authorization tests. Each `TeacherFixture` bundles `teacher_id`, `slug`, and a session cookie.
- `recording_fixtures.rs` in `server/tests/` — `insert_test_recording(app, teacher_id, student_email)` → `(id, token_hex)`; `make_valid_token()` → `(buf, hex, hash)`.
- `DevMailer` test helpers — existing `assert_mail_count(dir, email, n)` extended to check `send_recording_link` entries in the `.jsonl` file.

### Test runtime budget

- All Rust integration tests: < 200 ms each (in-process SQLite + temp-dir DevBlobStore).
- `run_one_cleanup_cycle` integration test: creates soft-deleted row, calls function directly, asserts row purged + blob file gone; < 50 ms.
- JS unit tests (Node): `recorder.js` (mock AudioContext + MediaRecorder), `recording-gate.js` (mock fetch), `recordings.js` (mock fetch + sort); consent timeout uses `fake-timers`; ~20 tests total, < 2 s.
- `student.js` consent timeout: explicitly in JS test matrix — drive `RecordConsentRequest`, advance fake timer 30 s, assert `RecordConsent { granted: false }` sent.
- Flaky policy: any test with real `setTimeout` is gated on `fake-timers`; real-timer tests are blocked from CI merge.
- New Rust test count target: ~50 tests across recording API, gate, WS protocol, cleanup.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `MediaRecorder` MIME type varies (Safari has no VP8) | Medium | Detect at start; fall back to `audio/webm;codecs=opus`; magic-byte check on server validates actual content |
| Large recordings (100–400 MB) OOM teacher browser | Medium | Stream chunks via `ondataavailable`; never coerce to single string; show upload progress |
| Student network drop during consent handshake | Low | `remove_by_connection` resets `recording_active`, sends `RecordingStopped` to teacher |
| Blob orphan on DB commit failure | Low | Compensating `BlobStore::delete` in upload handler; documented known-gap in runbook |
| Azure SAS URL valid for 15 min after student accesses | Low | MVP acceptable; Sprint 5 hardening can add WAF rate limiting on blob subdomain |
| `subtle` crate not in `Cargo.toml` | Known | Add `subtle = "2"` to `[dependencies]` |
| Cleanup task loops after shutdown signal | Known | `shutdown.cancelled()` arm in `cleanup_loop` ensures clean exit |


---

# Sprint 7: In-session chat + lobby messaging

_Archived: 2026-04-18_

# PLAN Sprint 7: In-session chat + lobby messaging

## Problem statement

Teachers and students currently have no text channel during a lesson. A student who joins the lobby early has no way to receive a message ("be right with you") from the teacher before being admitted. Once in session there is no fallback if audio breaks down. Sprint 7 adds:

1. **Bidirectional in-session chat** between teacher and admitted student.
2. **One-way teacher → lobby chat** so the teacher can send a short message to a waiting student without admitting them.

The design deliberately excludes student → teacher lobby messaging (Option 1 per SPRINTS.md). Students cannot reply until admitted; this keeps the lobby state model simple.

## Spec references

- SPRINTS.md §Sprint 7
- `knowledge/architecture/signalling.md` — tagged-union protocol, single-writer pump, no `.await` under guard
- `knowledge/decisions/0001-mvp-architecture.md` — ephemeral in-memory session model

## Current state (from codegraph)

| File | Relevant exports |
|------|-----------------|
| `server/src/ws/protocol.rs` | `ClientMsg`, `ServerMsg`, `ErrorCode`, `EntryId`, `PumpDirective` |
| `server/src/ws/mod.rs` | `handle_*` dispatch, `RoomState`, `ActiveSession` |
| `server/src/state.rs` | `LobbyEntry { id: EntryId, conn: ClientHandle }`, `RoomState { lobby: Vec<LobbyEntry>, active_session: Option<ActiveSession> }`, `ClientHandle { id: ConnectionId, tx }` |
| `web/assets/teacher.js` | `renderEntry`, session callbacks |
| `web/assets/student.js` | `showConsentBanner`, session callbacks |
| `web/assets/signalling.js` | `sendRecordConsent` and similar send helpers |
| `web/assets/tests/signalling.test.js` | JS unit test pattern (`node:test`) |

`EntryId` is already defined in `protocol.rs` (line 49) and is included in `LobbyEntryView` which the teacher receives in every `LobbyState` message — so the teacher client already has the `entry_id` it needs to address a lobby message. No new state fields are required on `RoomState`.

`LobbyEntry.conn.tx` (`mpsc::Sender<PumpDirective>`) gives direct access to any waiting student's outbound pump. The teacher's own `ConnectionId` is available in the handler context as `sender.conn.id`.

## Proposed solution

All chat flows through the existing `/ws` connection (Alternative A). No new HTTP endpoints, no persistence. Fits the ephemeral session model.

## Component design

### 1. Protocol (`server/src/ws/protocol.rs`)

**New constants:**
```rust
pub const MAX_CHAT_CHARS: usize = 500;
pub const MAX_CHAT_BYTES: usize = 2000; // 500 chars × 4 bytes/char (worst case UTF-8)
```

Both limits are checked: byte count first (fast path, no UTF-8 decode), then char count. This matches the project's established dual-limit pattern (cf. `MAX_TIER_REASON_BYTES` / `MAX_TIER_REASON_CHARS`).

**New `ClientMsg` variants:**
```rust
Chat {
    text: String,
},
LobbyMessage {
    entry_id: EntryId,
    text: String,
},
```

**New `ServerMsg` variants:**
```rust
Chat {
    from: Role,  // Role::Teacher or Role::Student
    text: String,
},
LobbyMessage {
    text: String,
},
```

`from: Role` is sufficient for a two-party session. The UI maps it to display names: teacher sees "You" for `Role::Teacher`, "Student" for `Role::Student`; student sees "Teacher" for `Role::Teacher`, "You" for `Role::Student`. This mapping is fixed in JS and never derived from user input.

**No new `ErrorCode` variant.** `ErrorCode::NotInSession` covers the "chat sent with no active session" case. `ErrorCode::PayloadTooLarge` covers oversized text. Both are already defined.

Empty messages (zero chars after receiving, i.e. `text.is_empty()`) are rejected with `Error { PayloadTooLarge, "chat text must not be empty" }`.

### 2. Server handlers (`server/src/ws/mod.rs`)

**`handle_chat(sender, teacher_tx, rs, text)`**

The `teacher_tx` parameter matches the existing handler signature pattern (already threaded through as `Arc<mpsc::Sender<PumpDirective>>` for record handlers).

Sequence (all under write guard, no `.await`):
1. Validate byte length: `text.len() > MAX_CHAT_BYTES` → `Error { PayloadTooLarge }`.
2. Validate char length: `text.chars().count() > MAX_CHAT_CHARS` → `Error { PayloadTooLarge }`.
3. Validate not empty: `text.is_empty()` → `Error { PayloadTooLarge }`.
4. Verify active session: `rs.active_session.is_none()` → `Error { NotInSession }`.
5. **Authorise sender identity:**
   - If `sender.role == Role::Teacher`: assert `sender.conn.id` matches the room's teacher connection id (passed in from the WS handler context). A rogue teacher-role connection on a different room cannot chat.
   - If `sender.role == Role::Student`: assert `sender.conn.id == rs.active_session.as_ref().unwrap().student.conn.id`. A stale or spoofed student connection cannot chat.
6. Clone both txs (target + self) under the guard. Drop the guard.
7. Send `ServerMsg::Chat { from: sender.role, text: text.clone() }` to **both** parties (sender receives their own echo so both UIs share one append path and stay in sync on delivery failures).

**`handle_lobby_message(sender, teacher_conn_id, rs, entry_id, text)`**

`teacher_conn_id: ConnectionId` is the `ConnectionId` of the WS connection that opened the teacher watch, threaded in from the handler context.

Sequence:
1. Validate byte + char length (same as above).
2. Validate not empty.
3. Authorise: `sender.conn.id != teacher_conn_id` → `Error { NotOwner }`. Role alone is not sufficient; the sender must be the specific teacher connection for this room.
4. Look up entry: `rs.lobby.iter().find(|e| e.id == entry_id)` — None → `Error { EntryNotFound }`. If the student was admitted or rejected between the teacher typing and sending, this returns `EntryNotFound`; the teacher UI handles this as a transient "student no longer in lobby" notice.
5. Clone the entry's `tx` under the guard. Drop the guard.
6. Send `ServerMsg::LobbyMessage { text }` to the entry's tx.
7. Nothing sent back to the teacher (one-way). The teacher UI shows an optimistic "Sent" state immediately on form submit, clearing on `EntryNotFound` error response.

Dispatch additions in the main message match:
```rust
ClientMsg::Chat { text } => handle_chat(&sender, &teacher_tx, &mut rs, text),
ClientMsg::LobbyMessage { entry_id, text } => handle_lobby_message(&sender, teacher_conn_id, &mut rs, entry_id, text),
```

### 3. Teacher UI (`web/teacher.html`, `web/assets/teacher.js`)

**Chat panel** (in-session, `teacher.html`):
```html
<div id="chat-panel" hidden aria-label="Chat">
  <ul id="chat-log" aria-live="polite"></ul>
  <form id="chat-form">
    <input id="chat-input" type="text" maxlength="500" placeholder="Message…" autocomplete="off">
    <button type="submit">Send</button>
  </form>
</div>
```
Shown on `PeerConnected`, hidden on `PeerDisconnected`.

`onChat({ from, text })` in `teacher.js`:
```js
function appendChat(from, text) {
  var li = document.createElement('li');
  li.className = 'chat-msg from-' + from; // fixed class, no user input in className
  var label = document.createElement('span');
  label.className = 'chat-label';
  label.textContent = from === 'teacher' ? 'You' : 'Student'; // textContent only
  var body = document.createElement('span');
  body.className = 'chat-body';
  body.textContent = text; // textContent only — no innerHTML anywhere
  li.appendChild(label);
  li.appendChild(body);
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}
```

**Lobby message inline action** (added to `renderEntry` in `teacher.js`):
```html
<form class="lobby-msg-form">
  <input type="text" maxlength="500" placeholder="Send a message…" autocomplete="off">
  <button type="submit">Send</button>
  <span class="lobby-msg-status" hidden></span>
</form>
```
On submit: `sessionHandle.sendLobbyMessage(entry_id, text)`. On success: clear input, show "Sent ✓" for 2 s. On `EntryNotFound` response: show "Student left the lobby".

**`sendChat(text)` and `sendLobbyMessage(entry_id, text)`** added to `signalling.js` alongside the existing `sendRecordConsent` pattern:
```js
sendChat: function (text) {
  ws.send(JSON.stringify({ type: 'chat', text: text }));
},
sendLobbyMessage: function (entry_id, text) {
  ws.send(JSON.stringify({ type: 'lobby_message', entry_id: entry_id, text: text }));
},
```

### 4. Student UI (`web/student.html`, `web/assets/student.js`)

**Lobby banner** (in lobby waiting state):
```html
<div id="lobby-message-banner" hidden role="status" aria-live="polite">
  <span id="lobby-message-text"></span>
</div>
```
`onLobbyMessage({ text })`:
```js
lobbyMessageText.textContent = text; // textContent only
lobbyMessageBanner.hidden = false;
if (lobbyMsgTimer) clearTimeout(lobbyMsgTimer);
lobbyMsgTimer = setTimeout(function () { lobbyMessageBanner.hidden = true; }, 8000);
```

**Chat panel** (in-session, identical structure to teacher). Shown on `PeerConnected`, hidden on `PeerDisconnected`. Same `appendChat` logic with swapped label: `from === 'teacher' ? 'Teacher' : 'You'`.

### 5. No database changes

All chat is ephemeral. No new tables, no migrations.

## XSS safety invariant

All user-supplied text is rendered exclusively via `.textContent`. No `innerHTML`, no `insertAdjacentHTML`, no dynamic class names derived from message content anywhere in chat or lobby message rendering.

## Test strategy

### Property / invariant coverage
- `handle_chat`: teacher sends → both teacher and student receive `Chat { from: teacher, text }`.
- `handle_chat`: student sends → both receive `Chat { from: student, text }`.
- `handle_chat`: 500-char message accepted; 501-char rejected with `PayloadTooLarge`.
- `handle_chat`: 500 × "🎵" (4 bytes each = 2000 bytes) accepted; 501 × "🎵" rejected.
- `handle_chat`: empty string rejected with `PayloadTooLarge`.
- `handle_lobby_message`: delivers `LobbyMessage { text }` to the correct lobby entry's connection.
- `handle_lobby_message`: unknown `entry_id` → `EntryNotFound`.
- `handle_lobby_message`: does not send anything back to the teacher connection.

### Failure-path coverage
- `Chat` with no active session → `NotInSession`.
- `Chat` from a connection whose `conn.id` does not match the session's teacher or student → `NotInSession` (treated as unauthorised; no session membership).
- Student sends `LobbyMessage` (role = student) → `NotOwner`.
- Rogue teacher-role connection (different `conn_id`) sends `LobbyMessage` → `NotOwner`.
- `Chat` or `LobbyMessage` text > 500 chars → `PayloadTooLarge`.
- `Chat` or `LobbyMessage` text > 2000 bytes → `PayloadTooLarge`.
- `LobbyMessage` to student who was admitted between send and delivery → `EntryNotFound`.

### Regression guards (verified test names)
- `ws_session_handshake::full_sdp_exchange_over_signalling` — chat is additive, existing handshake must be unaffected.
- `ws_session_handshake::student_disconnect_clears_session` — disconnect behaviour unchanged.
- `protocol::client_msg_roundtrips` — extended to include `Chat` and `LobbyMessage` variants.
- `protocol::server_msg_roundtrips` — extended to include `Chat` and `LobbyMessage` variants.

### JS unit tests (`web/assets/tests/chat.test.js`)
Following the `node:test` pattern in `signalling.test.js`:
- `sendChat` serialises to `{ type: "chat", text }`.
- `sendLobbyMessage` serialises to `{ type: "lobby_message", entry_id, text }`.
- `appendChat` with `from="teacher"` renders label `"Teacher"` / `"You"` correctly for student/teacher POV.
- `appendChat` with `from="student"` renders label correctly.
- `appendChat` uses `textContent` not `innerHTML` (verified by checking `innerHTML` is never called in the helper under test).
- `onLobbyMessage` sets `textContent` and shows the banner.

### Fixture reuse plan
- Rust integration tests reuse `TestOpts` / app-builder from `ws_session_handshake.rs`.
- A `make_teacher_and_student_in_session` helper (new, extracted from the handshake test) is the base fixture for all chat tests.
- Lobby-message tests reuse the existing `LobbyJoin` / `LobbyWatch` message pattern.

### Test runtime budget
All new Rust tests are in-process (no real network). All JS tests run under `node --test`. Target < 150 ms total. No async sleeps — assertions are direct channel reads.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Lobby entry removed (admitted/rejected) between lookup and send | Lock is held across lookup and `tx.clone()`; `EntryNotFound` returned atomically if missing |
| Teacher identity spoofing via `role: Teacher` WS header | `handle_lobby_message` checks `sender.conn.id == teacher_conn_id`, not just role |
| XSS via chat text | All rendering via `.textContent`; no `innerHTML` anywhere in chat path |
| Chat log growing without bound in a long session | Client-side DOM only; no server memory impact; acceptable for MVP |


---

# Sprint 8: Variation A Warm Room session UI

_Archived: 2026-04-19_

# Plan: Sprint 8 — Variation A "The Warm Room" Session UI

## Problem Statement

The current session UI is a plain functional scaffold. Claude Design has delivered a complete high-fidelity brief (Variation A — "The Warm Room") for the live session screen. Sprint 8 implements that design in the actual codebase, wiring it to real WebRTC audio/video.

**Scope (confirmed):**
- Transport: keep existing WebRTC P2P (no SFU)
- Student: responsive — desktop + mobile (≤600px breakpoint per brief)
- Teacher: desktop only

Audio constraints (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`) are already in `web/assets/audio.js`. Opus music-mode SDP munging is already in `signalling.js`. `playoutDelayHint = 0` is already set in `audio.js:77` (`attachRemoteAudio`). No audio pipeline changes needed.

## Design Reference

`design_handoff_singing_bridge_session/mocks/session-ui/variation-a.jsx` — canonical pixel reference. Prototype uses fake oscillators and SVG portraits; both must be replaced with real Web Audio `AnalyserNode` and `<video>` elements.

## Current State

| File | Current role |
|---|---|
| `web/teacher.html` | Functional scaffold — lobby list, session controls, chat, recording |
| `web/student.html` | Functional scaffold — join form, lobby wait, session view, chat |
| `web/assets/teacher.js` | UI wiring — session handle, chat, recording, lobby forms |
| `web/assets/student.js` | UI wiring — join, lobby, session handle, chat |
| `web/assets/signalling.js` | WebRTC + WS glue |
| `web/assets/controls.js` | `wireControls` — mic/video/hangup DOM wiring (currently owns `#mute`, `#video-off`, `#hangup`) |
| `web/assets/audio.js` | `getUserMedia` with music-mode constraints; `attachRemoteAudio` sets `playoutDelayHint=0` |
| `server/tests/http_teach_debug_marker.rs` | Structural HTML regression test — asserts specific static DOM IDs that will change |

## Proposed Solution

### Control ownership (resolves High finding #5)

`controls.js` currently owns `#mute`, `#video-off`, `#hangup` — static DOM IDs that move into the dynamically generated session UI. Post-sprint:

- **`session-ui.js` owns all 5 in-session buttons** (mic, video, note, say, end) as part of its generated DOM
- **`controls.js` is deleted.** `wireControls` is replaced by session-ui.js callbacks; no `wireControls` call remains in `onPeerConnected` after this sprint.
- **`deriveToggleView` is relocated** to `web/assets/session-ui.js` (exported as a named function alongside `mount`). It is a pure UI-state derivation function with no DOM dependency, making it a natural fit as a session-ui utility. `web/assets/tests/controls.test.js` is updated to import `deriveToggleView` from `session-ui.js` instead of `controls.js`; all existing toggle-view test cases are preserved with no semantic change.
- **Control callback flow:**
  - Mic toggle → `opts.onMicToggle()` → caller (`teacher.js` / `student.js`) calls `localStream.getAudioTracks()[0].enabled = !enabled`
  - Video toggle → `opts.onVideoToggle()` → caller calls `localStream.getVideoTracks()[0].enabled = !enabled`
  - End → `session-ui.js` opens confirm dialog → on confirm calls `opts.onEnd()` → caller calls `handle.hangup()`
  - Teacher record: `teacher.js` retains `startRecording`/`stopRecording` as separate buttons mounted OUTSIDE `#session-root` in teacher.html — no change to recording flow

### Breath ring semantics (resolves High finding #1)

**Invariant:** The breath ring always represents the **remote** party's vocal activity — i.e., the person the local user is listening to. This is the relevant signal regardless of role.

| Role | Ring source stream |
|---|---|
| Teacher view | remote = student stream → `AnalyserNode` on student's incoming audio |
| Student view | remote = teacher stream → `AnalyserNode` on teacher's incoming audio |

The `AnalyserNode` is created on the `MediaStreamAudioSourceNode` of the remote `<audio>` element's `srcObject`. Concretely: after `attachRemoteAudio` sets `remoteAudio.srcObject`, session-ui creates `audioCtx.createMediaStreamSource(remoteAudio.srcObject)` → `analyser`.

Self-preview breath ring: NOT added. The self-preview card has no ring — only the remote video panel has one. This matches the design intent (ring signals "they are speaking").

### `setRemoteStream` lifecycle (resolves Medium finding #2)

`setRemoteStream(stream)` is the only public method that attaches a new remote stream after mount. Lifecycle rules:

1. Disconnect and close existing `AnalyserNode` source node (call `.disconnect()` on `MediaStreamAudioSourceNode`)
2. Cancel the running RAF loop via the saved ID
3. Detach the old stream from the remote `<video>` and `<audio>` elements
4. Attach the new stream; create a new `AnalyserNode`; restart RAF loop
5. Teardown (`teardown()`) always: cancel RAF, disconnect analyser nodes (`.disconnect()`), close `AudioContext` (`audioCtx.close()`), stop timer, remove DOM. A test asserts `audioCtx.close` was called exactly once during teardown.

`updatePeerName` is **not** exported. Remote name and role label are set at mount time and do not change within a session. If the caller needs to update them (no current use case), they remount.

### XSS safety for peer identity (resolves Medium finding #3)

All peer-supplied strings — `remoteName`, `remoteRoleLabel`, self-label "You" — are written via `.textContent` only. No `innerHTML` anywhere in `session-ui.js`. XSS tests for both initial render and any future dynamic update are included in the test plan.

### Font and CSP (resolves Medium finding #4)

Fonts are self-hosted. WOFF2 files for Fraunces (400/500/600) and Poppins (300/400/500/600) are sourced from `@fontsource` packages and committed to `web/assets/fonts/`. `@font-face` declarations go in `web/assets/theme.css`. **No preconnect**, no Google Fonts reference, no external font URL anywhere in the HTML.

The existing CSP in `server/src/http/middleware.rs` (or wherever headers are set) must allow `font-src 'self'` — this is already the minimal default and requires no change.

`server/tests/http_csp.rs` will add an assertion that neither `teacher.html` nor `student.html` contains `fonts.googleapis.com` or `fonts.gstatic.com`.

### Muted banner semantics + local audio track ownership (resolves High finding #1, Medium finding #5)

**No track cloning required.** Web Audio API's `createMediaStreamSource(stream)` reads the raw captured audio data at the source node level, before the `track.enabled` property takes effect. When `track.enabled = false` the browser stops forwarding audio to WebRTC (silence is sent), but the `AnalyserNode` downstream of `createMediaStreamSource` still receives live microphone data. This is standard browser behaviour — it is how "talking while muted" indicators are implemented across all major video call products.

**Null-stream rule:** When `opts.localStream` is `null`, no `createMediaStreamSource` call is made, no `localAnalyser` is created, and the muted-banner subsystem is completely disabled for the mount's lifetime. `checkAndUpdate` becomes a no-op. A test covers `mount(container, { localStream: null })` — verifies it mounts without error and never displays the muted banner regardless of audio state.

**Analyser placement (non-null path):** `audioCtx.createMediaStreamSource(opts.localStream)` → `localAnalyser`. `opts.localStream` is the `MediaStream` returned by `audio.js:startLocalAudio()`.

**Mute toggle path:** `opts.onMicToggle()` → caller does `opts.localStream.getAudioTracks()[0].enabled = !enabled`. This mutes the WebRTC sender (silence sent to remote) while the `localAnalyser` continues to receive raw mic data. No track clone is needed; no change to `signalling.js`.

**Banner trigger rules:**
- Show banner when: `micEnabled === false` AND `localRMS > MUTE_DETECT_THRESHOLD` (0.05) for ≥ `MUTE_DETECT_FRAMES` (4 consecutive RAF frames ≈ 67ms)
- Banner auto-hides after `MUTE_BANNER_MS` (3000 ms)
- Repeated trigger while visible: hide timer resets (no duplicate banner)
- On `micEnabled → true`: banner immediately hides

### HTML changes

**`web/teacher.html`:**
- Replace inner session controls/video block with `<div id="session-root"></div>`
- Keep recording buttons and send-recording modal OUTSIDE `#session-root`
- Remove static `#mute`, `#video-off`, `#hangup` IDs — `session-ui.js` generates these
- Add `<script src="/assets/session-ui.js">` and `<link rel="stylesheet" href="/assets/theme.css">`

**`web/student.html`:**
- Same session section replacement
- Ensure `<meta name="viewport" content="width=device-width, initial-scale=1">` is present (add if missing)
- Add viewport and theme assets

### New files

#### `web/assets/session-ui.js`
```
// File: web/assets/session-ui.js
// Purpose: Variation A "The Warm Room" session UI — breath ring, audio meters,
//          control cluster, self-preview, muted banner, end-call dialog.
// Role: Mounts the full live-session UI into a container element; wires to real
//       Web Audio AnalyserNodes for RMS-driven breath ring and level meters.
// Exports: window.sbSessionUI.mount(container, opts) → { teardown, setRemoteStream }
// Depends: Web Audio API (AudioContext, AnalyserNode), DOM (video, dialog elements)
// Invariants: all peer-supplied strings rendered via .textContent only (no innerHTML);
//             exactly one RAF loop per mount; teardown is idempotent.
// Last updated: Sprint 8 (2026-04-19) -- initial implementation
```
Exports `window.sbSessionUI.mount(container, opts)` → `{ teardown, setRemoteStream }`.

**`mount` size bound:** `mount` is an orchestrator only — it calls the six named builders, wires their return handles together, starts `runAudioLoop`, and returns the public handle. It contains **no rendering logic**, no CSS string construction, and no direct DOM manipulation beyond appending the builders' root nodes. Target ≤40 lines; a lint comment enforces this at review time.

`opts`:
```js
{
  role,              // 'teacher' | 'student'
  remoteName,        // string — written via .textContent
  remoteRoleLabel,   // string — written via .textContent
  localStream,       // MediaStream (local audio + video) — null safe
  remoteStream,      // MediaStream (remote) — may arrive later via setRemoteStream
  headphonesConfirmed, // boolean — display-only in Sprint 8; chip is informational, not interactive
  micEnabled,        // boolean — initial mic state
  videoEnabled,      // boolean — initial video state
  onMicToggle,       // () => void
  onVideoToggle,     // () => void
  onEnd,             // () => void — called only after confirmation dialog
  onNote,        // () => void — logs intent only in Sprint 8 (note panel is Sprint 9)
  onSay,         // () => void — opens the existing chat panel (already wired in teacher.js/student.js)
}
```

Internal decomposition (≤60 lines each, narrow parameter sets):
- `buildRemotePanel({ remoteName, remoteRoleLabel, headphonesConfirmed })` → DOM node + `{ setStream(MediaStream|null), teardown() }`
- `buildBaselineStrip()` → DOM node + `{ setLevels(selfRms, remoteRms), setElapsed(seconds) }`  — no AudioContext parameter; receives pre-computed levels
- `buildControls({ micEnabled, videoEnabled, onMicToggle, onVideoToggle, onEnd, onNote, onSay })` → DOM node + `{ setMicActive(bool), setVideoActive(bool) }`  
  — `onNote` logs intent (stable callback name; panel implementation deferred to Sprint 9); `onSay` opens the existing chat panel (push-to-talk semantics explicitly excluded — any push-to-talk implementation requires a new ADR)
- `buildSelfPreview(stream)` → DOM node (stream may be null; shows black)
- `buildMutedBanner()` → DOM node + `{ checkAndUpdate(micEnabled, rms) }`
- `runAudioLoop(analyserSelf, analyserRemote, onFrame)` → `{ stop() }`  
  — **Null contract:** either argument may be `null`; a null analyser produces zero RMS for that channel. This covers both `localStream: null` (no `analyserSelf`) and `setRemoteStream(null)` (no `analyserRemote`). Callers never pass stubs.
- `fmtTime(seconds)` → string; clamps negative/non-finite to `0`

#### `web/assets/theme.css`
```
/* File: web/assets/theme.css
   Purpose: Design tokens (colours, typography, radii, shadows) + session layout CSS.
   Role: Shared stylesheet; loaded by teacher.html and student.html.
   Invariants: all fonts self-hosted (no external font URLs); no Google Fonts reference.
   Last updated: Sprint 8 (2026-04-19) -- initial implementation */
```
- `@font-face` declarations for Fraunces + Poppins from `web/assets/fonts/`
- CSS custom properties (design tokens from brief)
- `.sb-session` layout rules
- `@media (max-width: 600px)` overrides for student mobile
- Self-preview mirror: `.sb-self-preview video { transform: scaleX(-1); }` (CSS class, not inline)

#### `web/assets/fonts/`
WOFF2 subsets for Fraunces and Poppins (committed as binary assets). Acquisition process: `npm ci` from a `package.json` that pins `@fontsource/fraunces` and `@fontsource/poppins` to exact versions; WOFF2 files are copied from `node_modules/@fontsource/*/files/` and their SHA-256 checksums recorded in `web/assets/fonts/CHECKSUMS.txt`. This file is committed alongside the WOFF2 assets so future reviewers can verify provenance.

### HTML regression test update (resolves High finding #3)

`server/tests/http_teach_debug_marker.rs` must be updated post-sprint. Assertions that check for static DOM IDs that no longer exist (`#mute`, `#video-off`, `#hangup`, etc.) are replaced with:

- Teacher page: contains `id="session-root"`, `session-ui.js` appears in script load order, `theme.css` linked, no Google Fonts URL
- Student page: same + `<meta name="viewport"` present

### `playoutDelayHint` after DOM refactor (resolves High finding)

`attachRemoteAudio` in `audio.js` currently sets `playoutDelayHint = 0` via a `#remote-audio` element lookup. Once `#remote-audio` is removed, that path becomes unreachable. To preserve the ADR-required low-latency playout:

`signalling.js`'s `ontrack` handler is updated to set `ev.receiver.playoutDelayHint = 0` **directly on the RTCRtpReceiver**, before any DOM attachment. This is the correct place — it is independent of which audio element the stream ends up in, and fires as early as possible. The `attachRemoteAudio` call then attaches the stream to the `<audio>` element created by `buildRemotePanel`.

Test: `ontrack` fires with a stub receiver; assert `receiver.playoutDelayHint === 0`.

## JS Wiring

**`web/assets/teacher.js` — `onPeerConnected`:**
```js
const ui = window.sbSessionUI.mount(document.getElementById('session-root'), {
  role: 'teacher',
  remoteName: lastStudentEmail,  // best available; no lesson name yet
  remoteRoleLabel: 'Student',
  localStream: /* audio.stream combined with video.stream */,
  remoteStream: null,  // attached via setRemoteStream in ontrack
  micEnabled: true,
  videoEnabled: true,
  onMicToggle() { /* toggle localAudioTrack.enabled */ },
  onVideoToggle() { /* toggle localVideoTrack.enabled */ },
  onEnd() { if (sessionHandle) sessionHandle.hangup(); },
  onNote() { console.log('[sprint9] note panel'); },
  onSay() { /* open existing chat panel — same toggle already wired in teacher.js */ document.getElementById('chat-panel').classList.remove('hidden'); },
});
```
No `wireControls` call. `localAudioTrack` still captured for MediaRecorder.

**`web/assets/student.js` — `onPeerConnected`:** Same pattern, `role: 'student'`.

**`onPeerDisconnected`:** calls `ui.teardown()` then resets `ui = null`.

## Test Strategy

### Property / invariant coverage
- `fmtTime`: `0`→`"0:00"`, `65`→`"1:05"`, `3661`→`"1:01:01"`, `-5`→`"0:00"`, `NaN`→`"0:00"` (clamp to 0)
- Breath ring via `buildRemotePanel`: after `setStream(stream)`, inject RMS value 0.0 → assert ring `box-shadow` has `4px` inner spread and min opacity; inject RMS 1.0 → assert `14px` spread and max opacity. (Ring style logic is internal to `buildRemotePanel`; not tested via a separate exported function.)
- `MeterBar`: 14 pips; at level 0.0 all off; at 0.6 → first 8 pips cream; at 0.85 → 11 pips, 9th–11th amber; at 1.0 → all 14, last 2 rose
- Self-preview has class `sb-self-preview`; CSS enforces mirror — no inline transform on the element
- All peer-identity strings written via `.textContent` — tested by asserting `.innerHTML` is not used and `<script>` injection does not execute
- `headphonesConfirmed: true` → chip has moss (`#6F9A7A`) background, text "Headphones on"; `false` → clay (`#C8684F`), text "No headphones"
- Mic button click → `onMicToggle` called once; `setMicActive(false)` → button inactive class applied, mic-slash icon shown
- Video button click → `onVideoToggle` called once; `setVideoActive(false)` → button inactive class applied
- Note button click → `onNote` called once (no panel opened)
- Say button click → `onSay` called once; chat panel becomes visible
- `runAudioLoop` contract: stub `analyserSelf` returns fixed byte array A, `analyserRemote` returns fixed byte array B; inject one synthetic RAF frame; assert `onFrame` called with `(rmsOf(A), rmsOf(B))` in that order. This test fails if RMS computation or argument ordering is wrong.
- `buildBaselineStrip.setElapsed(65)` → elapsed text node contains `"1:05"` (integration test through `fmtTime`)

### Failure-path coverage
- `mount(container, { localStream: null })` → mounts without error; self-preview shows black; muted banner is never shown regardless of audio state (`checkAndUpdate` is a no-op)
- `setRemoteStream(null)` → detaches gracefully; RAF continues with zero RMS
- `setRemoteStream(s2)` after `setRemoteStream(s1)` → only one RAF loop running
- `teardown()` twice → no error (idempotent guard); first call verifies `audioCtx.close()` called exactly once
- `teardown()` → `audioCtx.close()` called (stub AudioContext records calls; assertion in test)
- Muted banner: `checkAndUpdate(false, 0.01)` × 3 frames → no show (below threshold); × 4 frames → shows; called again while visible → timer resets; `checkAndUpdate(true, 0.9)` → hides immediately
- End button click → dialog opens; "Cancel" → dialog closes, `onEnd` NOT called; "End" → `onEnd` called

### Regression guards (one per prior finding)
- **[F15/F22 — HTML DOM regression]**: `http_teach_debug_marker.rs` updated assertions pass post-sprint
- **[F8 — XSS]**: `session-ui.test.js` confirms `.textContent` used, no `innerHTML`; `<img src=x onerror=alert(1)>` as peer name renders as literal text
- **[F17 — lobby message empty]**: unchanged; deferred to Sprint 8 follow-up (was Sprint 7 finding)
- **CSP font]**: `http_csp.rs` asserts no Google Fonts URL in teacher/student HTML

### Fixture reuse plan
- Extend `web/assets/tests/session-ui.test.js` (new file) using existing `node:test` + DOM stub pattern from `chat.test.js`
- DOM stubs extended to support `<video>` element (add `srcObject`, `play()` stub)
- `AudioContext` / `AnalyserNode` stubbed with configurable RMS return

### Test runtime budget
- `session-ui.test.js`: ≤3s
- Updated `http_teach_debug_marker.rs`: included in existing `cargo test` (no new integration test binary)
- Flaky policy: no real timers in tests; `setTimeout`/`setInterval` mocked; RAF via synchronous frame injection

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Fraunces/Poppins WOFF2 files add binary weight to repo | Subset to Latin + Latin-Extended only; each face file ≤50KB |
| `AudioContext` suspended on mobile Safari until user gesture | `audioCtx.resume()` called inside the `onPeerConnected` handler which fires after the submit gesture |
| Mobile Safari: `autoplay` blocked on `<video>` | Local preview: `muted` attribute present; remote video: attached after user gesture (submit / admit) |
| `controls.js` removal breaks test imports | `deriveToggleView` relocated to `session-ui.js`; `controls.test.js` import updated to match; `wireControls` has no test coverage and is simply deleted |
| Self-preview mirror causes confusion if teacher films whiteboard | Mirror only applied to `.sb-self-preview` — remote video unchanged |


---

# Sprint 9: Lobby completion + Warm Room chat

_Archived: 2026-04-19_

# Plan: Sprint 9 — Lobby completion + Warm Room chat

## Problem Statement

Two experience gaps remain after Sprint 8:

1. **Lobby** — Students land in a waiting state with no self-check. `headphonesConfirmed` is hardcoded `false` in both `teacher.js` and `student.js`, so the session UI chip always shows "No headphones" regardless of what the user actually did. The design brief requires both parties confirm headphones before the lesson begins.

2. **Chat** — The Say button opens the plain Sprint 7 `#chat-panel` HTML element. It works but is entirely outside the Warm Room design system. Separately, the lobby-message banner (teacher → waiting student) also uses unstyled HTML.

This sprint completes both, adding a pre-session self-check flow and replacing all chat surfaces with Warm Room–styled components.

## Scope

- **Lobby self-check**: student and teacher both confirm headphones (and optionally test mic/camera) before the session starts. Headphones state flows through to the session UI chip.
- **In-session chat drawer**: Warm Room–styled slide-up drawer driven by the Say button. Wires to existing `sessionHandle.sendChat()` / `onChat` callbacks.
- **Lobby message toast**: Warm Room–styled toast replacing the plain `#lobby-message-banner`.
- **No new backend tables**: `headphones_confirmed` is session-ephemeral; a single `#[serde(default)]` field on `LobbyEntryView` is all that's needed.

## Current State

| File | Current role |
|---|---|
| `server/src/ws/protocol.rs` | `LobbyEntryView` lacks `headphones_confirmed`; `ClientMsg` has no `HeadphonesConfirmed` variant |
| `server/src/ws/lobby.rs` | `join_lobby` / `watch_lobby`; no headphones state tracking |
| `server/src/ws/mod.rs` | `handle_client_msg` dispatch; no headphones handler |
| `server/src/state.rs` | `LobbyEntry` struct; no headphones field |
| `web/assets/signalling.js` | `connectStudent` delivers `onLobbyUpdate`, `onChat`; no headphones callback |
| `web/assets/teacher.js` | Renders lobby entries; `headphonesConfirmed: false` hardcoded in `sbSessionUI.mount` |
| `web/assets/student.js` | `headphonesConfirmed: false` hardcoded in `sbSessionUI.mount`; shows plain lobby-wait section |
| `web/assets/session-ui.js` | `buildControls` has Say button calling `opts.onSay`; chat is caller-owned |
| `web/student.html` | `#lobby-status` section is plain HTML |
| `web/teacher.html` | Lobby entry rendering is plain HTML in `teacher.js` |

## Proposed Solution

### 1. Server: headphones state

**`server/src/state.rs`** — add `headphones_confirmed: bool` to `LobbyEntry` (default `false`).

**`server/src/ws/connection.rs`** — add `entry_id: Option<EntryId>` to `ConnContext`. Initialised to `None` on connection setup. This is the authoritative lookup key for the `HeadphonesConfirmed` handler; no lobby scan is needed.

**`server/src/ws/protocol.rs`** — two changes:
- `LobbyEntryView` gains `headphones_confirmed: bool` (serialised; `#[serde(default)]` for backwards compat)
- `ClientMsg` gains `HeadphonesConfirmed` (no payload) — the server resolves the entry from `ctx.entry_id`

**`server/src/ws/lobby.rs`** — `join_lobby` writes the newly generated `EntryId` back to `ctx.entry_id` immediately after inserting the `LobbyEntry`. This is the only place `entry_id` is set. A new `confirm_headphones(ctx, state)` function handles the mutation: it checks `ctx.role == Some(Role::Student)` and `ctx.entry_id.is_some()` before acquiring any lock; returns `EntryNotFound` if the entry is no longer in the lobby (already admitted or rejected); sets `headphones_confirmed = true` and re-broadcasts `LobbyState` to the teacher. This follows the existing pattern where lobby mutations live in `lobby.rs`, not `mod.rs`.

**`server/src/ws/mod.rs`** — adds a `HeadphonesConfirmed` branch in `handle_client_msg` that is thin dispatch only:
1. **Student-only guard** — if `ctx.role != Some(Role::Student)`, return an error (`NotInSession` or a new `RoleViolation` code) before acquiring any lock. This is checked before the call to `lobby::confirm_headphones`.
2. Delegates to `lobby::confirm_headphones(ctx, &state)`.

**No migration needed** — `headphones_confirmed` is in-memory only (lost on server restart, acceptable for a session-ephemeral signal).

### 2. Student pre-session self-check screen

After the student submits their join form and before the "waiting" state is shown, display a self-check overlay:

- Full-page or modal overlay, dark navy background
- Camera self-preview: `<video muted autoplay playsinline>` attached to `getUserMedia` stream (already acquired by `audio.js` + `video.js` in the join flow)
- Mic level indicator: small MeterBar (reuse `buildBaselineStrip` level rendering) driven by a local `AnalyserNode` on the audio track — same pattern as session-ui
- Headphones confirmation: toggle button "I'm wearing headphones" — must be activated before "I'm ready" is enabled
- On "I'm ready": hide overlay, show lobby-wait section, send `HeadphonesConfirmed` over the WS once the connection opens

**Implementation file**: `web/assets/self-check.js` — new module, exports `window.sbSelfCheck.show(stream, opts)` → `{ teardown }`. `opts`: `{ onConfirmed() }`.

**`web/student.html`**: add `<div id="self-check-root"></div>` before `#lobby-status`; add `<script src="/assets/self-check.js">`.

**`web/assets/student.js`**: after `getUserMedia` succeeds and WS opens, call `sbSelfCheck.show(stream, { onConfirmed })`. On `onConfirmed`: send `HeadphonesConfirmed`, hide self-check, show `#lobby-status`.

### 3. Teacher self-check overlay

Teacher's self-check is lighter — they don't need to be in a lobby, they just need headphones before the session. It appears once per browser session (gated by `sessionStorage`).

- Shown on page load of `/teach/<slug>` if `sessionStorage.getItem('sb-teacher-checked')` is falsy
- Same overlay as student: self-preview + mic level + headphones toggle
- On confirm: `sessionStorage.setItem('sb-teacher-checked', '1')`; overlay tears down
- Teacher does **not** send `HeadphonesConfirmed` to the server — teacher headphones state is display-only (shown to teacher themselves, not broadcast to students)
- `headphonesConfirmed` for the teacher's own session-ui mount remains `false` (teacher's chip shows their own state, not needed in MVP)

**Same `self-check.js`** module handles both teacher and student. Teacher call site skips the WS send.

### 3a. Teacher self-check sessionStorage semantics

The `sessionStorage.getItem('sb-teacher-checked')` gate is a **UX-only convenience**, not a trust boundary. Its intent is simply to avoid re-showing the overlay every time the teacher reloads — it carries no security weight. Persistence scope is intentional: the flag survives within one browser session (tab reloads, navigations) but is cleared when the browser closes or the tab is explicitly closed. If the teacher opens a new tab they will see the check again; this is acceptable and expected behaviour.

### 4. Warm Room chat drawer (in-session)

The chat drawer is extracted into its own module `web/assets/chat-drawer.js` to keep `session-ui.js` within the project module size limit. `session-ui.js` imports it and wires the Say button; callers interact only through the session-ui handle.

**New module**: `web/assets/chat-drawer.js` — standard file header block required. Exports `window.sbChatDrawer` (or consumed as a local dependency by `session-ui.js`). Exports `buildChatDrawer({ onSendChat })` → DOM node + `{ open(), close(), toggle(), appendMsg(from, text), hasUnread() }`.

**Script load order in HTML**: `chat-drawer.js` must load before `session-ui.js`.

**`session-ui.js` opts change:**
```js
// removed: onSay (stub)
// added:
onSendChat,   // (text: string) => void — called when user submits a message
onChatMsg,    // not in opts — caller registers via handle.appendChatMsg(from, text)
```

**Public handle gains**: `handle.appendChatMsg(from, text)` — caller invokes this when `onChat` fires from the signalling layer.

Drawer spec (from design brief):
- Slides up from the bottom: `position: absolute; bottom: 0; left: 0; right: 0; height: 140px` when open
- Background: `rgba(15,23,32,0.92); backdrop-filter: blur(8px); border-top: 1px solid rgba(251,246,239,0.12)`
- Header "Say": Fraunces italic 15px, `rgba(251,246,239,0.85)`
- Message list: scrollable, cream text; sent messages right-aligned, received left-aligned
- Input + send button styled with `theme.css` tokens
- CSS transition: `transform: translateY(0)` open, `translateY(100%)` closed; `transition: transform 0.2s ease-out`
- Unread dot: 6px rose (`#E17F8B`) circle on Say button badge when drawer is closed and a new message arrives; clears on open
- Empty-send prevention: send button and Enter key are no-ops when the input is blank or whitespace-only

**Say button in `buildControls`**: becomes a toggle that calls `opts.onSayToggle()`. `session-ui.js` wires this to `chatDrawer.toggle()`.

**`teacher.js` / `student.js`**: remove `onSay` and `#chat-panel` show/hide. Add `onSendChat` to mount opts; call `handle.appendChatMsg(from, text)` in `onChat` callback. The static `#chat-panel` element is removed from both HTML files.

### 5. Warm Room lobby message toast (student waiting)

Replace `#lobby-message-banner` with a Warm Room–styled toast rendered by a new small module.

**`web/assets/lobby-toast.js`** — new module, standard file header block required. Exports `window.sbLobbyToast.show(text, durationMs)`. Appends a toast element into the page body:
- Dark navy pill: `background: rgba(15,23,32,0.88); backdrop-filter: blur(6px); border-radius: 999px; padding: 10px 20px`
- Text in Fraunces italic 14px, cream colour
- Positioned fixed, bottom-centre of viewport
- Auto-dismisses after `durationMs` (default 8000) with a CSS opacity fade-out
- Multiple calls stack (each toast has its own timer); **maximum 3 simultaneous visible toasts** — if a 4th `show()` call arrives while 3 are visible, the oldest is immediately removed before the new one is appended

**`web/student.js`**: remove `#lobby-message-banner` manipulation; call `sbLobbyToast.show(text)` from `onLobbyMessage`.

**`web/student.html`**: remove `#lobby-message-banner` and `#lobby-message-text` elements; add `<script src="/assets/lobby-toast.js">`.

### HTML changes summary

**`web/teacher.html`**:
- Remove `#chat-panel` (chat now inside session-ui)
- Add `<script src="/assets/self-check.js">`
- Add `<script src="/assets/chat-drawer.js">` before `session-ui.js`

**`web/student.html`**:
- Add `<div id="self-check-root"></div>`
- Remove `#lobby-message-banner` + `#lobby-message-text`
- Remove `#chat-panel`
- Add `<script src="/assets/self-check.js">`, `<script src="/assets/lobby-toast.js">`, and `<script src="/assets/chat-drawer.js">` before `session-ui.js`

### CSS additions (`theme.css`)

- `.sb-self-check` overlay layout
- `.sb-chat-drawer` (slide-up animation, backdrop, message bubbles)
- `.sb-lobby-toast` (fixed pill, fade-out animation)
- `.sb-btn-badge` (unread dot on Say button)

### New file headers

All three new JS modules must carry the project's standard structured file header block (`File`, `Purpose`, `Role`, `Exports`, `Depends`, `Invariants`, `Last updated`):
- `web/assets/self-check.js`
- `web/assets/lobby-toast.js`
- `web/assets/chat-drawer.js`

## Test Strategy

### Property / invariant coverage
- `sbSelfCheck`: renders self-preview, mic level indicator, and disabled "I'm ready" button before headphones toggled; button enables after toggle
- `sbSelfCheck`: `onConfirmed` called exactly once when "I'm ready" clicked; not called before headphones toggled
- `sbSelfCheck` (teacher path): overlay skips display when `sessionStorage.getItem('sb-teacher-checked')` is set; confirm writes the flag exactly once; teacher call site does not invoke any WS send
- `sbSelfCheck`: teardown stops all media tracks on the stream and removes the overlay element from the DOM
- `buildChatDrawer`: initial state is closed (closed CSS class present, no open class)
- `buildChatDrawer`: `toggle()` alternates open/closed class; `appendMsg('teacher', 'hello')` adds a bubble with correct sender class; unread dot appears after `appendMsg` while drawer is closed; clears after `open()`
- `buildChatDrawer`: `appendMsg` text written via `.textContent` (XSS guard — same invariant as session-ui)
- `buildChatDrawer`: send is suppressed when input is empty or whitespace-only; `onSendChat` not called
- `sbLobbyToast.show(text)`: creates an element with text set via `.textContent`; element is appended to container; second call before first dismisses creates second element (stacked)
- `sbLobbyToast`: auto-dismisses after `durationMs` ms (fake clock); element is removed from DOM on dismiss
- `sbLobbyToast`: when 3 toasts are already visible, a 4th `show()` removes the oldest before appending the new one (cap enforcement)
- `HeadphonesConfirmed` protocol: server sets `headphones_confirmed = true` on the correct `LobbyEntry`; next `LobbyState` broadcast includes `headphones_confirmed: true` for that entry; exactly one broadcast emitted per confirmation
- `LobbyEntryView` serialisation: `headphones_confirmed` defaults to `false` when absent (backwards compat)
- HTML regression: `student.html` contains `<script src="/assets/self-check.js">`, `<script src="/assets/lobby-toast.js">`, `<script src="/assets/chat-drawer.js">`, and `<div id="self-check-root">`; `teacher.html` contains `<script src="/assets/self-check.js">` and `<script src="/assets/chat-drawer.js">`; both files load `chat-drawer.js` before `session-ui.js`

### Ordering and protocol invariants
- `LobbyJoin` is sent on WS open (inside `connectStudent`) before the self-check can emit `HeadphonesConfirmed`. The student self-check `onConfirmed` callback is only invoked after the WS connection is open; the `HeadphonesConfirmed` send is therefore always preceded by `LobbyJoin` in the same connection.

### Failure-path coverage
- `sbSelfCheck.show(null, ...)`: renders without error when stream is null (camera/mic permission denied); mic level indicator disabled
- `buildChatDrawer.appendMsg` with XSS payload: `<script>xssCheck()</script>` renders as literal text, does not execute
- `handle.appendChatMsg` called after `teardown()`: no-op, no error
- Teacher connection sends `HeadphonesConfirmed`: server rejects with role-violation error before acquiring any lock; student entry unchanged
- Student sends `HeadphonesConfirmed` before `LobbyJoin` (no `entry_id` on context): server returns `EntryNotFound`; client ignores gracefully
- `HeadphonesConfirmed` sent with no active lobby entry (e.g. already admitted): server returns `EntryNotFound`; client ignores gracefully
- `HeadphonesConfirmed` sent twice: idempotent; second broadcast omitted if state unchanged

### Regression guards (one per prior-round finding)
- **[Sprint 8 — session-ui XSS]**: chat drawer inherits the `.textContent`-only invariant; test asserts no `innerHTML` on user-supplied message text
- **[Sprint 7 — lobby banner]**: `#lobby-message-banner` is removed; regression test asserts the old element ID is no longer present in `student.html`
- **[Sprint 8 — headphonesConfirmed hardcoded]**: integration test asserts `headphonesConfirmed` in the session-ui mount opts reflects the actual confirmed state, not `false`
- **[Sprint 7 — chat panel in HTML]**: `#chat-panel` is removed from both HTML files; `http_teach_debug_marker.rs` updated accordingly; test asserts `#chat-panel` ID absent from both HTML files

### Fixture reuse plan
- `self-check.test.js`: new file; reuses DOM stubs from `session-ui.test.js`; `sessionStorage` stubbed as plain object
- `chat-drawer.test.js`: new file (was `session-ui.test.js` extension); reuses DOM stubs; `buildChatDrawer` exported directly
- `ws_headphones.rs`: new Rust integration test; reuses `spawn_app` + `TestOpts` from `common`
- `lobby-toast.test.js`: new file; minimal DOM stubs (just `document.createElement` + `body.appendChild`); fake clock for dismiss timing

### Test runtime budget
- New JS tests: ≤2s total
- `ws_headphones.rs`: ≤200ms (single WS round-trip, in-process)
- Flaky policy: no real timers; `setTimeout` mocked in toast tests via fake clock; RAF stubbed as before

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `getUserMedia` unavailable before `LobbyJoin` is sent | Self-check acquires media independently; on failure shows "camera/mic unavailable" with degraded state; headphones-only confirmation still possible |
| Teacher reloads page mid-session; `sessionStorage` cleared | Self-check re-appears; teacher re-confirms; no functional regression |
| Chat drawer clips on small viewports | Drawer height capped at 50% viewport height on mobile; `overflow-y: scroll` inside message list |
| `HeadphonesConfirmed` arrives after student is already admitted | Server checks entry is still in lobby before updating; returns `EntryNotFound` (not an error from client's perspective — already admitted means `headphonesConfirmed` is irrelevant) |
| Removing `#chat-panel` from HTML breaks old `onChat` wiring | All `onChat` wiring migrated to `handle.appendChatMsg` in `teacher.js`/`student.js` before HTML element removal; regression test asserts old element ID absent |


---

# Sprint 10: Password auth

_Archived: 2026-04-21_

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


---

# Sprint 11: Persistent student records + session history

_Archived: 2026-04-21_

# PLAN: Sprint 11 — Persistent student records + session history

## Problem statement

The teacher currently has no way to review past sessions. `session_log` stores privacy-preserving hashed email; it is not suitable as a teacher-visible history because the hash is irreversible. Sprint 11 adds a parallel persistence path using plain email (visible only to the owning teacher) and a `/teach/<slug>/history` page showing the teacher who they taught, when, and for how long.

---

## Current state (from codegraph)

| Layer | File(s) | Summary |
|-------|---------|---------|
| DB | `migrations/0001_initial.sql` | `teachers`, `sessions`, `magic_links`, `signup_attempts` |
| DB | `migrations/0002_session_log.sql` | `session_log` — hashed email, metrics, ended_reason |
| DB | `migrations/0003_recordings.sql` | `recordings`, `recording_gate_attempts` |
| DB | `migrations/0004_password_auth.sql` | `login_attempts`, `password_hash` on teachers |
| WS | `ws/lobby.rs` | `admit()` — creates ActiveSession, opens session_log row |
| WS | `ws/mod.rs` | `close_row()` called at all session-end paths (~line 759) |
| WS | `ws/session_log.rs` | `open_row`, `close_row`, `record_peak` |
| HTTP | `http/recordings.rs` | `post_upload` — creates recordings row after blob upload |
| HTTP | `http/teach.rs` | `get_teach` — teacher/student view |
| Cleanup | `cleanup.rs` | `run_one_cleanup_cycle` — prunes gate_attempts, login_attempts |
| State | `state.rs` | `ActiveSession` — holds `log_id: Option<SessionLogId>` |

`session_log` uses `student_email_hash` (irreversible). `recordings` has `student_email`. The new `session_events` table mirrors `session_log` but stores plain email (via `students` table), supports recording linkage, and soft-deletes.

---

## Deployment precondition

No existing session events or students. Migration 0005 creates new tables and alters existing ones; no existing data rows are changed.

---

## Proposed solution

### Migration 0005 — `server/migrations/0005_session_history.sql`

```sql
-- Typed ids for session history
CREATE TABLE students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES teachers(id),
  email         TEXT    NOT NULL COLLATE NOCASE,  -- stored normalized (lowercase)
  first_seen_at INTEGER NOT NULL,
  UNIQUE(teacher_id, email)
);
CREATE INDEX idx_students_teacher ON students(teacher_id);

CREATE TABLE session_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES teachers(id),
  student_id    INTEGER NOT NULL REFERENCES students(id),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,           -- NULL while live
  duration_secs INTEGER,           -- MAX(0, ended_at - started_at); set on close
  recording_id  INTEGER REFERENCES recordings(id),
  ended_reason  TEXT,              -- 'hangup'|'disconnect'|'server_shutdown'|'floor_violation'|'blocked'
  archived_at   INTEGER            -- soft-delete: set by cleanup when completion time < now - 90d
);
CREATE INDEX idx_session_events_teacher ON session_events(teacher_id, started_at DESC);
CREATE INDEX idx_session_events_student ON session_events(student_id);

-- One-shot recording linkage slot: written at consent time, consumed at upload.
-- Ensures upload can link to the right session even if the session has already ended.
CREATE TABLE recording_sessions (
  teacher_id       INTEGER PRIMARY KEY REFERENCES teachers(id),
  session_event_id INTEGER NOT NULL REFERENCES session_events(id),
  created_at       INTEGER NOT NULL
);
```

**`students.email` normalization**: stored as `lower(email)`. UNIQUE(teacher_id, email) with COLLATE NOCASE handles existing rows; new inserts always lowercase first.

**Known limitation**: plain student emails persist in `students` until a future erasure path is added. Documented as a known gap; no GDPR-mandated deletion path in MVP scope.

### Named constants

```rust
const SESSION_ARCHIVE_DAYS: i64 = 90;
const HISTORY_PAGE_LIMIT: i64 = 100;
const RECORDING_SLOT_TTL_SECS: i64 = 86400; // max gap between consent and upload
```

### New module: `ws/session_history.rs`

All public functions own an `EndedReason` parameter (not `&str`) where applicable, matching the existing `session_log` contract. All mutating operations include `teacher_id` in both the Rust signature and the SQL predicate.

```rust
pub type StudentId = i64;
pub type SessionEventId = i64;

/// Upsert student. Two-step: INSERT OR IGNORE then SELECT.
/// Email normalized to lowercase before insertion.
pub async fn upsert_student(pool: &SqlitePool, teacher_id: TeacherId, email: &str) -> Result<StudentId>

/// Open a session_event row (ended_at, duration_secs, ended_reason all NULL).
pub async fn open_event(pool: &SqlitePool, teacher_id: TeacherId, student_id: StudentId, started_at: i64) -> Result<SessionEventId>

/// Close event: first-writer-wins (WHERE ended_at IS NULL). Sets duration_secs = MAX(0, ended_at - started_at).
/// teacher_id enforced in SQL: WHERE id = ? AND teacher_id = ?
pub async fn close_event(pool: &SqlitePool, event_id: SessionEventId, teacher_id: TeacherId, ended_at: i64, reason: EndedReason) -> Result<()>

/// Store the recording-linkage slot (upsert: one slot per teacher).
pub async fn set_recording_slot(pool: &SqlitePool, teacher_id: TeacherId, event_id: SessionEventId) -> Result<()>

/// Consume and clear the slot; returns None if expired or absent.
/// Only returns the event_id if created_at > now - RECORDING_SLOT_TTL_SECS.
pub async fn consume_recording_slot(pool: &SqlitePool, teacher_id: TeacherId) -> Result<Option<SessionEventId>>

/// Link a recording to its session event. teacher_id enforced in SQL.
pub async fn link_recording(pool: &SqlitePool, event_id: SessionEventId, teacher_id: TeacherId, recording_id: i64) -> Result<()>
```

**`upsert_student` — conflict-safe id return**:
```sql
INSERT OR IGNORE INTO students (teacher_id, email, first_seen_at) VALUES (?, lower(?), ?);
SELECT id FROM students WHERE teacher_id = ? AND email = lower(?);
```
Always returns the correct `id` regardless of whether the INSERT fired.

**`close_event` — first-writer-wins + ownership**:
```sql
UPDATE session_events
SET ended_at = ?, duration_secs = MAX(0, ? - started_at), ended_reason = ?
WHERE id = ? AND teacher_id = ? AND ended_at IS NULL
```

### State changes (`state.rs`)

`ActiveSession` gains:
```rust
pub session_event_id: Option<SessionEventId>,
pub student_id: Option<StudentId>,
```
Both start as `None`, filled after async DB calls outside the room lock — same lifecycle as `log_id`.

### Admission flow changes (`ws/lobby.rs` → `admit`)

After `session_log::open_row` succeeds, on the same `Ok` branch:
1. `upsert_student(pool, teacher_id, &email)` → `student_id`
2. `open_event(pool, teacher_id, student_id, started_at)` → `event_id`
3. Re-acquire room write lock (same pattern as `log_id`):
   - If `active_session` still exists: set `session_event_id` and `student_id`
   - If not (orphan race): call `close_event(pool, event_id, teacher_id, now, EndedReason::Disconnect)` immediately (mirrors orphan `close_row` pattern)

If either DB call fails: log warning and continue — history is best-effort; the session proceeds regardless.

### Session close flow changes (`ws/mod.rs`)

At the point where `close_row` is called (~line 759):
```rust
if let Some((event_id, teacher_id)) = session.session_event_id.zip(session.teacher_id) {
    if let Err(e) = session_history::close_event(&state.db, event_id, teacher_id, ended_at, ended_reason).await {
        tracing::warn!(error = %e, "session_history close_event failed");
    }
}
```

### Recording linkage — durable slot pattern

**Problem with naive "most recent open event" lookup**: if the session ends before the upload finishes, or a new session starts before upload arrives, the lookup returns the wrong event.

**Solution**: at `handle_record_consent(granted=true)`, write a durable slot:
```rust
session_history::set_recording_slot(&state.db, teacher_id, event_id).await?
```

In `post_upload`:
```rust
if let Some(event_id) = session_history::consume_recording_slot(&state.db, teacher_id).await? {
    let _ = session_history::link_recording(&state.db, event_id, teacher_id, recording_id).await;
}
```

The slot is keyed by teacher_id (one per teacher). Consuming clears it atomically. Expiry is 24 h (RECORDING_SLOT_TTL_SECS). Recordings uploaded more than 24 h after consent remain unlinked — acceptable for MVP.

### Email validation at WS join

`handle_lobby_join` (currently validates only length) gains a format check:
```rust
if !email.contains('@') || email.len() < 3 {
    close_malformed(ctx, "invalid email").await;
    return false;
}
```
The email is also normalized to lowercase before storage in LobbyEntry. This is consistent with existing teacher email handling.

### History page HTML escaping

`http/history.rs` builds HTML server-side. All user-derived values (email, ended_reason) are HTML-escaped using a `html_escape(s: &str) -> String` helper (replaces `&`, `<`, `>`, `"`, `'` with entities). No templating library required.

### Archive semantics (`cleanup.rs`)

Cutoff is based on session **completion** time, not start time:
```sql
UPDATE session_events
SET archived_at = ?
WHERE COALESCE(ended_at, started_at) < ?
  AND archived_at IS NULL
```
Where the cutoff is `now - SESSION_ARCHIVE_DAYS * 86400`.

### New HTTP handler: `http/history.rs`

Route: `GET /teach/<slug>/history`

Auth: same as `get_recordings_page` — valid session cookie for the owning teacher (401 otherwise).

Query:
```sql
SELECT se.id, se.started_at, se.ended_at, se.duration_secs, se.ended_reason,
       s.email, r.id AS recording_id
FROM session_events se
JOIN students s ON s.id = se.student_id
LEFT JOIN recordings r ON r.id = se.recording_id
WHERE se.teacher_id = ?
  AND se.archived_at IS NULL
ORDER BY se.started_at DESC
LIMIT ?
```
Using the `HISTORY_PAGE_LIMIT` constant.

Response: server-rendered HTML table. Every value inserted into HTML uses `html_escape`. Duration formatted as `mm:ss` or `"-"` if `ended_at IS NULL`.

### Route table addition

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| GET | `/teach/<slug>/history` | `get_history` | session required (owning teacher) |

---

## Alternatives considered

**Extend `session_log`**: `session_log` is privacy-preserving by design; adding plain email violates its invariant. New table is the right call.

**Hard-delete sessions**: Soft-delete gives recovery path; no data loss risk.

**`last_insert_rowid()` for upsert**: Unreliable on `INSERT OR IGNORE` when the row exists. Two-step `INSERT OR IGNORE` + `SELECT` is correct.

**Memory-only recording link**: Room may be evicted before upload; DB slot is durable.

---

## Test strategy

### Property / invariant coverage

- `upsert_student` twice with same (teacher_id, email) → same student_id both times
- `upsert_student` with mixed-case email variants (e.g. `"ALICE@test"`, `"alice@TEST"`) → same student_id
- `open_event` → row has `ended_at IS NULL`, `duration_secs IS NULL`
- `close_event` → row has correct `ended_at` and `duration_secs = MAX(0, ended_at - started_at)`
- `close_event` with `ended_at < started_at` (negative) → `duration_secs = 0` (clamped)
- `close_event` twice → second call is a no-op (first-writer-wins; no error)
- `link_recording` → `session_events.recording_id` is set
- `link_recording` with wrong `teacher_id` → row unchanged (ownership enforced)
- `consume_recording_slot` after TTL → returns None (slot expired)

### Failure-path coverage

- `GET /teach/<slug>/history` without session cookie → 401
- `GET /teach/<slug>/history` with another teacher's cookie → 401
- `GET /teach/<slug>/history` with no events → 200, empty table
- `GET /teach/<slug>/history` with 150 events → only 100 returned in DESC order
- History page: student email containing `<script>` is HTML-escaped, not executed
- WS `lobby_join` with email missing `@` → malformed close
- Archive cutoff: event where `ended_at = now - 90d - 1s` → archived; `ended_at = now - 90d` (boundary) → not archived (strict `<` predicate)
- Archive cutoff for live session (ended_at IS NULL): uses `started_at` via COALESCE → only archived if started 90+ days ago
- `consume_recording_slot` when no slot exists → None (no error)
- Best-effort: `open_event` DB failure during admission → session proceeds, no crash

### Regression guards

- `resolve_teacher_from_cookie` resolves after migration 0005 (sessions table unchanged)
- `POST /auth/login` still works after migration 0005 (no conflict with new tables)
- Existing recording upload flow works when no recording slot exists (best-effort skip)
- `run_one_cleanup_cycle` still prunes `login_attempts` and `recording_gate_attempts` as before
- Ended-reason enum mapping: all four `EndedReason` variants map to the correct stored string

### Fixture reuse plan

`common::make_session_event(app, teacher_id, email, started_at, ended_at) -> SessionEventId` — inserts a student + session_event directly via SQL with no WS calls. Uses the direct-SQL pattern from `insert_teacher_no_password`. Available from `server/tests/common/mod.rs`.

All existing WS tests use `signup_teacher` (delegates to `register_teacher`); no changes to WS fixtures needed.

### Test runtime budget + flaky policy

All new tests are DB-only (no Argon2, no WS, no HTTP). Total new test runtime: < 1 s. No real-time sleeps. Archive boundary tests insert rows with synthetic `started_at`/`ended_at` values. The WS lifecycle integration test (`ws_session_handshake.rs`) is extended by one assertion (session_event row has non-NULL `ended_at` after clean hangup).

