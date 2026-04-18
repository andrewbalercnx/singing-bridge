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
