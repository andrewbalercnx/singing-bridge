# PLAN_Sprint12A.md — Accompaniment backend: gap closure

**Sprint goal:** Close the gaps between the council-approved Sprint 12 plan and what was actually delivered. All items below were committed to in the approved Sprint 12 plan but were not implemented.

**Status:** DRAFT (R5)

---

## Problem statement

Sprint 12 delivered the core sidecar pipeline, DB schema, library routes, and media token store. A gap audit against the approved plan identified eleven missing items across four categories: upload handling, error typing, test coverage, and deployment infrastructure. Sprint 13 (library UI) and Sprint 14 (in-session playback) both depend on this foundation being complete, so these gaps must be closed before either can proceed.

Spec refs: `PLAN_Sprint12.md`, `SPRINTS.md §Sprint 12`.

---

## Gap inventory

### G1 — WAV direct upload not supported

**Plan said:** `RIFF....WAVE` magic bytes → detect as WAV → insert `accompaniment_variants` row directly (`tempo_pct=100, transpose=0, respect_repeats=0, label=title`).

**Delivered:** Upload only accepts PDF and MIDI; WAV returns 400.

**Fix:** Detect WAV via a 12-byte header read: bytes 0–3 = `RIFF`, bytes 4–7 = size (ignored), bytes 8–11 = `WAVE`. Replay all 12 bytes into the stored stream (byte-identical to source). On WAV: store blob, insert `accompaniments` row (title only, no pdf/midi key), insert `accompaniment_variants` row with columns `(accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones, respect_repeats, created_at)` = `(id, title, key, 100, 0, 0, now)` — column names taken verbatim from `migrations/0006_accompaniments.sql`.

**Upload response — uniform contract:** All upload responses return `{ id, title, kind }` where `kind` is `"pdf"`, `"midi"`, or `"wav"`. WAV additionally returns `variant_id: <i64>` alongside the standard fields. This is a strict superset of the existing shape; PDF/MIDI callers ignore unknown fields.

**Routes affected by WAV-only assets:** `POST /parts`, `POST /midi`, `POST /rasterise` all require a PDF source. `POST /variants` requires a MIDI source. These routes already call `require_pdf_key` / `require_midi_key` which return `AppError::BadRequest("asset has no PDF")` / `"asset has no MIDI"`. No additional code is needed; the guard is already active.

---

### G2 — No 413 before reading body

**Plan said:** Upload > 50 MB → 413 before sidecar call. The asset upload route must have `DefaultBodyLimit::disable()`.

**Delivered:** Body bounded via `AsyncRead::take` but no `Content-Length` early check; upload route missing `DefaultBodyLimit::disable()`.

**Fix:**
1. In `server/src/http/mod.rs`: add `.layer(DefaultBodyLimit::disable())` to the `POST /teach/:slug/library/assets` route.
2. In `post_asset`: check `Content-Length` header before reading any body bytes. If present and > `accomp_upload_max_bytes`, return `AppError::PayloadTooLarge` immediately.

**413 invariant:** The `Content-Length` check fires before any body bytes are consumed. No magic-byte read, no stream setup, no blob store interaction occurs when this path is taken.

---

### G3 — `bar_coords` sidecar client signature mismatch (documentation correction only)

**Plan said:** `bar_coords(&self, pdf: Bytes, musicxml: Bytes)`.

**Delivered:** `bar_coords(&self, pdf: Bytes)`.

**Resolution:** The sidecar is correct. Audiveris re-runs OMR internally from the PDF; passing MusicXML separately serves no purpose. The Sprint 12 plan contained an error. No code change required.

---

### G4 — Missing `AppError` sidecar variants

**Plan said:** `AppError::SidecarUnavailable` (→ 503) and `AppError::SidecarBadInput` (→ 422).

**Delivered:** Reused `AppError::ServiceUnavailable` (→ 503) and `AppError::BadRequest` (→ 400).

**Design decision:** `SidecarBadInput` maps to **422 Unprocessable Entity**. This is an intentional change from the current `BadRequest` (400); no existing tests assert 400 on sidecar bad-input paths.

**Fix:** Add to `error.rs`:
```rust
#[error("sidecar unavailable")]
SidecarUnavailable,
#[error("sidecar bad input: {0}")]
SidecarBadInput(Cow<'static, str>),
```
Update `sidecar.rs` `map_code`:
```rust
"AUDIVERIS_MISSING" | "FLUIDSYNTH_MISSING" => AppError::SidecarUnavailable,
_ => AppError::SidecarBadInput(message.to_string().into()),
```
Update `server/src/sidecar.rs` **file header** (lines 8–9) to match the new variant names:
```
// Invariants: Bearer token sent on every request.
//             AUDIVERIS_MISSING / FLUIDSYNTH_MISSING / connection failure → SidecarUnavailable.
//             All other sidecar error codes → SidecarBadInput (surfaces as 422).
//             ZIP response from /rasterise is unzipped here; caller receives Vec<(filename, bytes)>.
```

---

### G5 — Missing upload error codes

**Plan said:** Magic/extension mismatch → 422 `CONTENT_TYPE_MISMATCH`. Unrecognised file type → 422 `UNSUPPORTED_FILE_TYPE`.

**Delivered:** Generic 400 for all bad uploads; no structured JSON error code.

**Design:** Upload uses raw body (not multipart), so the declared MIME type is the request `Content-Type` header. The base MIME type is extracted by stripping parameters (`application/pdf; charset=utf-8` → `application/pdf`) before comparison. Mismatch rule: if the declared base type is `application/pdf`, `audio/midi`, or `audio/wav` but the magic bytes identify a different known format → `CONTENT_TYPE_MISMATCH`. Unrecognised magic bytes entirely → `UNSUPPORTED_FILE_TYPE`.

**Implementation:** Dedicated `AppError` variants (not prefixed `BadRequest` messages):
```rust
#[error("content type mismatch")]
ContentTypeMismatch,
#[error("unsupported file type")]
UnsupportedFileType,
```
Both → 422 (see `parts()` table below).

---

### G6 — Missing Rust integration tests (plan items 2–5, 8–10, 12)

**Delivered:** Plan items #1, #6, #7, #11, #13–17. Items #2–5, #8–10, #12 were not.

**Fix:** Add to `tests/http_library.rs`. See test strategy for full specifications.

---

### G7 — `docker-compose.yml` missing

**Delivered:** Not written.

**Fix:** Write at repo root with `server` and `sidecar` services. Sidecar hostname `sidecar` is a non-loopback Docker hostname; add `SIDECAR_HOST_ALLOWLIST=sidecar` to server environment and document in `.env.example`.

---

### G8 — E2E test foundation missing

**Delivered:** Not written.

**Fix:**
- `tests/e2e/sidecar_stub/app.py` — minimal Flask stub; validates bearer token against `SIDECAR_SECRET` if set; returns hardcoded fixture responses.
- `tests/e2e/sidecar_stub/requirements.txt`
- `tests/e2e/library.spec.ts` — one E2E test: authenticated library page loads with correct title.

---

## Component design

### `post_asset` — flow and helper extraction

`post_asset` is orchestration only. Three helpers are extracted so it stays within reviewable size:

```rust
// 1. File type detection (G5)
fn detect_file_type(magic: &[u8; 12], declared_ct: Option<&str>) -> Result<FileKind, AppError>;

// 2. Blob stream storage — takes the 12-byte prefix + remaining bounded body
async fn store_asset_blob(
    blob: &dyn BlobStore,
    magic: [u8; 12],
    body_reader: impl AsyncRead + Send + Unpin,
    max_remaining: u64,
    ext: &str,
) -> Result<String, AppError>;
// Returns the generated blob key.

// 3. WAV variant insertion — only called when FileKind::Wav
async fn insert_wav_variant(
    db: &SqlitePool,
    accompaniment_id: i64,
    title: &str,
    wav_blob_key: &str,
    now: i64,
) -> Result<i64, AppError>;
// Returns variant id.

// 4. Accompaniment DB insert — covers all three FileKind branches and delete-on-failure
//    compensation. Extracted so post_asset stays below the project function-size threshold.
async fn db_insert_accompaniment(
    db: &SqlitePool,
    blob: &dyn BlobStore,
    title: &str,
    blob_key: &str,
    kind: FileKind,
    now: i64,
) -> Result<(i64, Option<i64>), AppError>;
// Returns (accompaniment_id, variant_id). variant_id is Some only for FileKind::Wav.
// On any DB error: deletes blob_key from the store (blob compensation) before returning Err.
```

Strict operation order in `post_asset` (no body bytes touched before step 3):

```
1. Parse title from X-Title header (header only, no body); enforce ≤ 255 bytes
2. Check Content-Length header → if present and > max_bytes → AppError::PayloadTooLarge (no body read)
3. Read exactly 12 bytes from body stream; on short-read → AppError::UnsupportedFileType
4. Call detect_file_type(magic, declared_ct) → FileKind or AppError
5. Call store_asset_blob(blob, magic, body_reader, max_bytes - 12, ext) → blob_key
6. Call db_insert_accompaniment(db, blob, title, blob_key, kind, now) → (id, variant_id)
7. Return { id, title, kind [, variant_id] }
```

**Short-body handling (caller, before `detect_file_type`):** If reading 12 bytes from the stream fails (body < 12 bytes), the caller returns `AppError::UnsupportedFileType` immediately. `detect_file_type` is only called when exactly 12 bytes have been read successfully.

`detect_file_type(magic: &[u8; 12], declared_ct: Option<&str>) -> Result<FileKind, AppError>` strips MIME parameters from `declared_ct` at the first `;`, then applies the mismatch rule symmetrically across all three known formats:

| Magic bytes | Identified as | If declared base type present and ≠ expected → |
|-------------|--------------|----------------------------------------------|
| `%PDF` (bytes 0–3) | `FileKind::Pdf` | `ContentTypeMismatch` (expected `application/pdf`) |
| `MThd` (bytes 0–3) | `FileKind::Midi` | `ContentTypeMismatch` (expected `audio/midi`) |
| `RIFF`+`WAVE` (bytes 0–3 and 8–11) | `FileKind::Wav` | `ContentTypeMismatch` (expected `audio/wav`) |
| `RIFF` + non-`WAVE` at bytes 8–11 | — | `UnsupportedFileType` (RIFF container but not audio/wav) |
| Anything else | — | `UnsupportedFileType` |

### WAV 12-byte detection

```
bytes 0–3:  52 49 46 46  ("RIFF")
bytes 4–7:  <file size, little-endian u32, ignored>
bytes 8–11: 57 41 56 45  ("WAVE")
```

All 12 bytes are replayed. Remaining body is bounded by `take(max_bytes.saturating_sub(12))`.

### `AppError::parts()` — complete updated match

```rust
fn parts(&self) -> (StatusCode, &'static str) {
    match self {
        AppError::BadRequest(_)          => (StatusCode::BAD_REQUEST, "bad_request"),
        AppError::Conflict(_)            => (StatusCode::CONFLICT, "conflict"),
        AppError::NotFound               => (StatusCode::NOT_FOUND, "not_found"),
        AppError::Forbidden              => (StatusCode::FORBIDDEN, "forbidden"),
        AppError::Unauthorized           => (StatusCode::UNAUTHORIZED, "unauthorized"),
        AppError::TooManyRequests        => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
        AppError::SessionInProgress      => (StatusCode::CONFLICT, "session_in_progress"),
        AppError::ServiceUnavailable     => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        AppError::PayloadTooLarge        => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
        AppError::SidecarUnavailable     => (StatusCode::SERVICE_UNAVAILABLE, "sidecar_unavailable"),
        AppError::SidecarBadInput(_)     => (StatusCode::UNPROCESSABLE_ENTITY, "sidecar_bad_input"),
        AppError::ContentTypeMismatch    => (StatusCode::UNPROCESSABLE_ENTITY, "content_type_mismatch"),
        AppError::UnsupportedFileType    => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported_file_type"),
        AppError::Sqlx(_) | AppError::Io(_) | AppError::Internal(_) =>
            (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    }
}
```

All new error paths produce `{ code, message }` JSON via the existing `IntoResponse` impl — no raw response bypass.

### Title and label length caps

- `title`: max 255 bytes (validated in `post_asset` after parsing header; return `BadRequest` if exceeded).
- `label`: max 255 bytes (validated in `post_variant`; return `BadRequest` if exceeded).

### docker-compose.yml

```yaml
services:
  server:
    build: ./server
    ports: ["8080:8080"]
    env_file: .env
    environment:
      - SIDECAR_URL=http://sidecar:5050
      - SIDECAR_HOST_ALLOWLIST=sidecar
    depends_on: [sidecar]

  sidecar:
    build: ./sidecar
    env_file: .env
```

`.env.example`:
```
SIDECAR_SECRET=dev-sidecar-secret-change-me-to-32-chars
# SIDECAR_HOST_ALLOWLIST=sidecar  # required when running via docker-compose
```

**`SIDECAR_HOST_ALLOWLIST` validation semantics (normative):** On startup, the server parses `SIDECAR_URL` with `url::Url::parse` and extracts the hostname component. It splits `SIDECAR_HOST_ALLOWLIST` on commas to produce a list of allowed hostnames. Validation requires **exact string equality** between the extracted hostname and at least one entry in the list. No wildcard patterns, no substring matching, no IP range notation. Any mismatch aborts startup with an error. This rule prevents SSRF via environment misconfiguration.

### E2E sidecar stub

`tests/e2e/sidecar_stub/app.py`:
- Validates `Authorization: Bearer` against `SIDECAR_SECRET` env var if set; returns 401 otherwise. If unset, all requests pass (permissive mode).
- File header block included (Purpose, Role, Exports, Last updated).
- Returns hardcoded fixture responses matching documented sidecar JSON contracts.
- Binds on `127.0.0.1:5051`.

### E2E auth pattern

Register via `page.request.post('/auth/register', ...)`, capture the `Set-Cookie` response header, parse it with `set-cookie-parser` (npm, devDependency), and inject into `context.addCookies(...)` before navigation. See the full executable snippet in the test strategy section below.

---

## Phased implementation order

1. G4 — Add `AppError` variants (including `PayloadTooLarge`) + update `parts()` exhaustive match.
2. G5 — `detect_file_type` helper; `ContentTypeMismatch` / `UnsupportedFileType` errors; MIME param stripping.
3. G1 — WAV 12-byte detection + variant auto-creation.
4. G2 — `DefaultBodyLimit::disable()` on upload route; `Content-Length` early reject.
5. G6 — Missing integration tests.
6. G7 — `docker-compose.yml` + `.env.example`.
7. G8 — E2E sidecar stub + `library.spec.ts`.

---

## Test strategy

### Property / invariant coverage
- WAV upload: stored blob is byte-identical to source (12 bytes replayed + remainder bounded by `take(max_bytes - 12)`).
- `RIFF` + non-`WAVE` marker → 422 `unsupported_file_type`.
- Body < 12 bytes → 422 `unsupported_file_type`.
- `Content-Type: application/pdf` + MIDI magic bytes → 422 `content_type_mismatch`.
- `Content-Type: audio/midi` + PDF magic bytes → 422 `content_type_mismatch`.
- `Content-Type: application/pdf; charset=utf-8` (with parameter) + MIDI bytes → 422 `content_type_mismatch` (base type stripped before comparison).
- `Content-Length` > 50 MB (header present, no body bytes sent) → 413 `payload_too_large`; no blob stored.
- `title` > 255 bytes → 400.
- `label` > 255 bytes → 400.

### Failure-path coverage
- Sidecar wiremock `/omr` returns 503 → `POST /parts` returns 503, JSON `code: "sidecar_unavailable"`; `GET /healthz` returns 200. Per-test `MockServer` instance.
- Sidecar wiremock `/omr` returns valid musicxml; `/list-parts` returns error with non-MISSING code → `POST /parts` returns 422, JSON `code: "sidecar_bad_input"`. Verifies `SidecarBadInput` mapping.
- Sidecar wiremock returns `bar_timings_json` > 100 KB → `POST /midi` returns 422; no blob stored.
- Sidecar wiremock returns `bar_coords_json` > 500 KB → `POST /rasterise` returns 422; no page blobs stored.
- WAV-only asset: `POST /parts` → 400 "asset has no PDF"; `POST /midi` → 400 "asset has no PDF"; `POST /rasterise` → 400 "asset has no PDF".

### Regression guards
- All 17 existing `http_library.rs` tests pass unchanged.
- All 35 Python sidecar tests pass unchanged.
- All 104 Rust unit tests pass unchanged.

### New test cases (additions to `tests/http_library.rs`)
| # | Description | Asserts |
|---|-------------|---------|
| 18 | Upload MIDI → 201; `accompaniments` row with `midi_blob_key` set; no variant row auto-created | status 201; `kind="midi"`; DB variant count = 0 |
| 19 | Upload WAV → 201; `accompaniments` + `accompaniment_variants` rows created; stored blob bytes equal uploaded bytes | status 201; `kind="wav"`; `variant_id` present; DB variant count = 1; `blob.get_bytes(wav_key) == uploaded_bytes` |
| 20 | `RIFF` + non-`WAVE` at bytes 8–11 → 422; JSON `code: "unsupported_file_type"` | status 422; `code` field value |
| 21 | Body 3 bytes (< 12) → 422 `unsupported_file_type` | status 422; `code` field value |
| 22 | `Content-Type: application/pdf` + MIDI bytes → 422; JSON `code: "content_type_mismatch"` | status 422; `code` field value |
| 23 | `Content-Type: audio/midi` + PDF bytes → 422; JSON `code: "content_type_mismatch"` | status 422; `code` field value |
| 24 | `Content-Type: audio/wav` + PDF bytes → 422 `content_type_mismatch` | status 422; `code` field value |
| 24b | `Content-Type: audio/wav` + MIDI bytes → 422 `content_type_mismatch` | status 422; `code` field value |
| 24c | `Content-Type: application/pdf` + WAV bytes (`RIFF`+`WAVE`) → 422 `content_type_mismatch` | status 422; `code` field value |
| 24d | `Content-Type: audio/midi` + WAV bytes (`RIFF`+`WAVE`) → 422 `content_type_mismatch` | status 422; `code` field value |
| 24e | `Content-Type: application/pdf; charset=utf-8` (with param) + MIDI bytes → 422 `content_type_mismatch` | status 422; `code` field value |
| 25 | Unknown magic `00 00 00 00` → 422; JSON `code: "unsupported_file_type"` | status 422; `code` field value |
| 26 | `Content-Length: 52428801` header, no body → 413; JSON `code: "payload_too_large"`; blob store unchanged | status 413; `code` field; blob count unchanged |
| 27 | `title` 256 bytes → 400 | status 400 |
| 28 | `label` 256 bytes in `POST /variants` → 400 | status 400 |
| 29 | Wiremock bar-timings returns 101 KB → `POST /midi` → 422; no new blob (per-test mock) | status 422; blob store unchanged |
| 30 | Wiremock bar-coords returns 501 KB → `POST /rasterise` → 422; no new blobs (per-test mock) | status 422; blob store unchanged |
| 31 | Wiremock `/omr` returns 503 → `POST /parts` → 503, `code: "sidecar_unavailable"`; `GET /healthz` → 200 | status 503 + 200; `code` field |
| 32 | Same per-test `MockServer` stubs `/omr` with valid musicxml response AND `/list-parts` returns `{ code: "INVALID_MUSICXML", error: "..." }` → `POST /parts` → 422, `code: "sidecar_bad_input"` | status 422; `code` field; `/omr` stub required to reach `/list-parts` path |
| 33 | WAV-only asset: `POST /parts` → 400 "asset has no PDF" | status 400 |
| 34 | WAV-only asset: `POST /midi` → 400 "asset has no PDF" | status 400 |
| 35 | WAV-only asset: `POST /rasterise` → 400 "asset has no PDF" | status 400 |

### Wiremock isolation policy
Each wiremock-backed test spawns its own `MockServer` instance and a dedicated `TestApp` pointed at it via `TestOpts { sidecar_url: Some(...) }`. No shared mocks across tests. `MockServer` drops at end of each test.

### E2E test (`tests/e2e/library.spec.ts`)
```typescript
import { test, expect } from '@playwright/test';
import { parse as parseCookieHeader } from 'set-cookie-parser'; // npm: set-cookie-parser

test('library page loads for authenticated teacher', async ({ page, context }) => {
  // Register and capture session cookie via fetch (bypasses browser cookie jar).
  // Complete register payload — all three required fields per login.rs.
  // The password field below is intentionally shown in full (not redacted).
  // Value 'test-passphrase-12' is the shared test credential used throughout
  // the Rust integration test suite; it is not a production secret.
  const reg = await page.request.post('/auth/register', {
    data: {
      email: 't@e2e.test',
      slug: 'e2e-room',
      password: 'test-passphrase-12',   // test-only credential — not redacted
    },
  });
  expect(reg.ok()).toBeTruthy();

  // Inject the issued session cookie into the Playwright browser context.
  const rawCookie = reg.headers()['set-cookie'];
  const [parsed] = parseCookieHeader(rawCookie, { decodeValues: false });
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    domain: new URL(page.url() || 'http://localhost:8080').hostname,
    path: parsed.path ?? '/',
    httpOnly: parsed.httpOnly ?? false,
    secure: parsed.secure ?? false,
  }]);

  await page.goto('/teach/e2e-room/library');
  await expect(page).toHaveTitle(/Library/);
});
```
`set-cookie-parser` is the standard npm utility for parsing `Set-Cookie` headers in Node.js test code. Add to `package.json` devDependencies: `"set-cookie-parser": "^2.7"`.

Sidecar stub runs on `127.0.0.1:5051`; server configured with `SIDECAR_URL=http://127.0.0.1:5051`.

### Fixture reuse
- Sidecar stub reuses `sidecar/tests/fixtures/two_part.musicxml` for OMR and list-parts fixture responses.
- Wiremock responses built inline per test; no shared fixtures.

### Test runtime budget
- New Rust tests: ≤ 10 s (all wiremock, no real sidecar).
- E2E: ≤ 15 s (single page-load + register flow against sidecar stub).
- Flaky policy: no real sleep; all mocks respond synchronously; per-test server instances.

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| RIFF body too short to read 12 bytes | Low | Low | Short-read → `UnsupportedFileType`; test #21 covers this |
| `DefaultBodyLimit::disable()` opens DoS surface | Low | Medium | Handler `take(max_bytes - 12)` is the active cap; `Content-Length` 413 is the fast-reject path |
| MIME parameter stripping misses edge cases | Low | Low | Strip at first `;`; test #24 covers the `charset=utf-8` case |
| Sidecar stub diverges from real sidecar contracts | Medium | Medium | Stub shapes documented against `PLAN_Sprint12.md` endpoint table; stub reviewed as part of delivery |
| Docker compose Audiveris download flaky in CI | Low | Low | Compose is dev-only; CI uses wiremock and sidecar stub |
