# PLAN_Sprint12.md — Accompaniment pipeline + library backend

**Sprint goal:** Promote the PDF-to-audio pipeline from spike to a production sidecar, build the DB schema and all REST API routes for the accompaniment library, and establish authenticated media delivery.

**Status:** APPROVED (R4, originally scoped as full Sprint 12; restructured to backend-only after council approval)

---

## Problem statement

The singing lesson tool needs backing-track support. Before any UI or in-session playback can be built, the underlying pipeline and data layer must exist: a hardened Python sidecar (OMR, synthesis, rasterisation), DB tables, Rust HTTP routes, and media delivery. Sprint 13 adds the library management UI; Sprint 14 adds in-session playback.

Spec refs: `SPRINTS.md §Sprint 12`, `knowledge/decisions/0001-mvp-architecture.md`, `knowledge/architecture/signalling.md`.

---

## Current state (from codegraph)

| Area | State |
|------|-------|
| `spike/pdf_to_piano_audio/` | Working Flask app + pipeline: OMR (Audiveris), part selection (music21/mido), WAV synthesis (FluidSynth), PDF rasterisation, bar-coord extraction. Tests exist. |
| `server/src/blob.rs` | `BlobStore` trait + `DevBlobStore`; used by recordings today. |
| `server/migrations/` | 5 migrations through `0005_session_history.sql`. |
| `server/src/http/` | 12 handler files; pattern is well-established. |

**No accompaniment tables, sidecar service, or library routes exist yet.**

---

## Proposed solution

### Architecture overview

```
Browser (teacher)
      |
      |  HTTP
      v
  Rust server  ──HTTP──>  Python sidecar (internal only)
      |
      v
  SQLite DB + Azure Blob Storage
```

### Key design decisions

| Decision | Choice | Alternative rejected | Reason |
|----------|--------|----------------------|--------|
| Sidecar framework | Flask (same as spike) | FastAPI | Continuity; spike tests reuse |
| Sidecar auth | `SIDECAR_SECRET` shared bearer token; sidecar validates every request | Network-only trust | SSRF mitigation; defence-in-depth |
| Bar timings storage | Computed once at MIDI creation, stored as JSON in DB | Recompute on playback | Deterministic, fast playback startup |
| PDF page rasterisation | Stored as blobs (PNG, 150 DPI), served via Rust proxy | Serve raw PDF + client renderer | Consistent cross-browser rendering |
| Audio delivery (WAV) | Short-lived signed URLs (dev: in-memory token; prod: Azure SAS `sp=r`, 5-min TTL) | Public blob URL | Prevents private asset exposure |
| Sidecar unavailable | 503 with JSON error; no cascade | Crash | Lesson must continue even if OMR is broken |

---

## Component design

### 1. DB migrations

**`server/migrations/0006_accompaniments.sql`**

```sql
CREATE TABLE accompaniments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id       INTEGER NOT NULL REFERENCES teachers(id),
  title            TEXT    NOT NULL,
  pdf_blob_key     TEXT,
  midi_blob_key    TEXT,
  page_blob_keys_json TEXT,          -- JSON array of blob keys, one per rasterised page
  bar_coords_json  TEXT,             -- [{bar, page, x, y, w, h}] at 150 DPI, top-left origin
  bar_timings_json TEXT,             -- [{bar, time_s}] at tempo_pct=100
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  CHECK (title != '')
);
CREATE INDEX idx_accomp_teacher ON accompaniments(teacher_id, created_at DESC);

CREATE TABLE accompaniment_variants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  accompaniment_id    INTEGER NOT NULL REFERENCES accompaniments(id),
  label               TEXT    NOT NULL,
  wav_blob_key        TEXT    NOT NULL,
  tempo_pct           INTEGER NOT NULL DEFAULT 100
                        CHECK (tempo_pct >= 25 AND tempo_pct <= 300),
  transpose_semitones INTEGER NOT NULL DEFAULT 0
                        CHECK (transpose_semitones >= -12 AND transpose_semitones <= 12),
  respect_repeats     INTEGER NOT NULL DEFAULT 0
                        CHECK (respect_repeats IN (0, 1)),
  duration_s          REAL,
  created_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  CHECK (label != '')
);
CREATE INDEX idx_variant_accomp ON accompaniment_variants(accompaniment_id, created_at DESC);
```

**Schema invariants:**
- `bar_coords_json`: `[{bar, page, x, y, w, h}]` — pixel coords on 150 DPI PNG, top-left origin, 0-based page index. Bar index 1-based (music21 measure numbers).
- `bar_timings_json`: `[{bar, time_s}]` — seconds from track start at `tempo_pct=100`. Playback scaling: `effective_time_s = stored_time_s * (100.0 / tempo_pct)` → used by Sprint 14 client as `stored_time_s ≤ currentPositionMs / 1000 * (tempo_pct / 100)`.
- `page_blob_keys_json`: `["<uuid>.png", ...]` one entry per page, in order.
- DB `CHECK` constraints reject zero tempo and out-of-range transpose at write time.

**Resource bounds (enforced in Rust handlers before DB write):**
- `bar_coords_json` ≤ 500 KB.
- `bar_timings_json` ≤ 100 KB.
- `page_blob_keys_json` ≤ 10 KB (≤ 200 pages).

### 2. Python sidecar (`sidecar/`)

Promoted and hardened from `spike/pdf_to_piano_audio/`. Key changes from spike:

- **Stateless** — spike used file-based sessions; sidecar accepts bytes in, returns bytes/JSON out.
- **Bearer auth** — `Authorization: Bearer <SIDECAR_SECRET>` required on every non-`/healthz` request. Missing env var at startup → process exits.
- **Resource limits:**
  - Max upload: 50 MB (→ 413 `PAYLOAD_TOO_LARGE`)
  - Max DPI: 300 (→ 422 `DPI_EXCEEDED`)
  - Max pages for rasterise/OMR: 40 (→ 422 `PAGE_COUNT_EXCEEDED`)
  - `part_indices` max 32 entries

**Error code enum:**

| `code` | HTTP | Meaning |
|--------|------|---------|
| `AUDIVERIS_MISSING` | 503 | Audiveris binary not found |
| `FLUIDSYNTH_MISSING` | 503 | FluidSynth binary not found |
| `OMR_FAILED` | 422 | Audiveris non-zero exit or no output |
| `INVALID_MUSICXML` | 422 | music21 could not parse the file |
| `INVALID_MIDI` | 422 | mido could not parse the file |
| `INVALID_PART_INDICES` | 422 | Part indices out of range or empty |
| `INVALID_PARAMS` | 422 | Parameter out of valid range (tempo_pct, transpose_semitones, dpi) |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds 50 MB |
| `PAGE_COUNT_EXCEEDED` | 422 | PDF > 40 pages |
| `DPI_EXCEEDED` | 422 | DPI > 300 |
| `UNAUTHORIZED` | 401 | Missing or invalid bearer token |

**Endpoints (all `multipart/form-data` in, JSON or binary out):**

| Method | Path | Input | Output |
|--------|------|-------|--------|
| GET | `/healthz` | — | `{ status: "ok" }` (no auth) |
| POST | `/omr` | `pdf` (file) | `{ musicxml: str (base64), page_count: int }` |
| POST | `/list-parts` | `musicxml` (file) | `[{ index, name, instrument, has_notes }]` |
| POST | `/extract-midi` | `musicxml` + `part_indices` (JSON array) | MIDI bytes |
| POST | `/bar-timings` | `midi` (file) | `{ timings: [{ bar, time_s }] }` |
| POST | `/bar-coords` | `pdf` + `musicxml` | `{ coords: [{ bar, page, x, y, w, h }], dpi: 150 }` |
| POST | `/rasterise` | `pdf` + `dpi` (default 150, max 300) | ZIP of PNGs |
| POST | `/synthesise` | `midi` + `tempo_pct` (25–300) + `transpose_semitones` (−12–12) + `respect_repeats` (0/1) | WAV bytes |

**Files:** `sidecar/app.py`, `sidecar/pipeline/__init__.py`, `sidecar/pipeline/audiveris.py`, `sidecar/pipeline/selector.py`, `sidecar/pipeline/synth.py`, `sidecar/Dockerfile`, `sidecar/requirements.txt`, `sidecar/tests/test_app.py`.

### 3. Rust sidecar client (`server/src/sidecar.rs`)

```rust
pub struct SidecarClient {
    base: Url,            // validated at startup (see config below)
    client: reqwest::Client,
    secret: SecretString, // sent as Authorization: Bearer on every request
}

impl SidecarClient {
    pub async fn omr(&self, pdf: Bytes) -> Result<OmrResult>;
    pub async fn list_parts(&self, musicxml: Bytes) -> Result<Vec<PartInfo>>;
    pub async fn extract_midi(&self, musicxml: Bytes, part_indices: &[usize]) -> Result<Bytes>;
    pub async fn bar_timings(&self, midi: Bytes) -> Result<Vec<BarTiming>>;
    pub async fn bar_coords(&self, pdf: Bytes, musicxml: Bytes) -> Result<Vec<BarCoord>>;
    pub async fn rasterise(&self, pdf: Bytes, dpi: u32) -> Result<Vec<(String, Bytes)>>;
    pub async fn synthesise(&self, req: SynthesiseRequest) -> Result<Bytes>;
    pub async fn healthz(&self) -> Result<()>;
}
```

**Config additions (`server/src/config.rs`):**
- `sidecar_url: Url` — startup validation:
  1. Loopback (`127.0.0.1`, `::1`, `localhost`) → allowed.
  2. Otherwise: check `SIDECAR_HOST_ALLOWLIST` (comma-separated exact hosts/IPs). Each parsed via `url::Url::parse("http://<entry>/")`, compared by `host_str()` exact match.
  3. Private/link-local IPs (RFC 1918, 169.254.x.x) blocked unless explicitly allowlisted.
  4. Non-loopback + not allowlisted → startup failure.
- `sidecar_secret: SecretString` — `SIDECAR_SECRET` env var. Missing or < 32 bytes in prod (`SB_ENV=production`) → startup failure. Dev: warning only.

**Error mapping:**
- `AUDIVERIS_MISSING` / `FLUIDSYNTH_MISSING` / connection error / timeout → `AppError::SidecarUnavailable` → 503.
- `OMR_FAILED` / `INVALID_*` / `PAYLOAD_TOO_LARGE` / `PAGE_COUNT_EXCEEDED` / `DPI_EXCEEDED` → `AppError::SidecarBadInput` → 422.

### 4. Rust library routes (`server/src/http/library.rs`)

All routes require teacher session cookie. All asset/variant lookups join through `teacher_id`:

```sql
-- asset ownership
WHERE a.id = ?1 AND a.teacher_id = ?2 AND a.deleted_at IS NULL
-- variant ownership (also joins accompaniments)
WHERE av.id = ?1 AND av.accompaniment_id = ?2
  AND a.teacher_id = ?3 AND av.deleted_at IS NULL AND a.deleted_at IS NULL
```

Mismatch → `AppError::NotFound` (uniform; no leakage).

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/teach/<slug>/library` | HTML page; `Cache-Control: no-store` |
| GET | `/teach/<slug>/library/assets` | List assets (JSON) |
| POST | `/teach/<slug>/library/assets` | Upload PDF / MIDI / WAV |
| GET | `/teach/<slug>/library/assets/<id>` | Asset detail + variants (JSON) |
| DELETE | `/teach/<slug>/library/assets/<id>` | Soft-delete asset + all variants |
| POST | `/teach/<slug>/library/assets/<id>/parts` | List MusicXML parts (proxies sidecar) |
| POST | `/teach/<slug>/library/assets/<id>/midi` | Extract MIDI; stores bar timings |
| POST | `/teach/<slug>/library/assets/<id>/rasterise` | Rasterise PDF pages; store blobs + coords |
| POST | `/teach/<slug>/library/assets/<id>/variants` | Synthesise new WAV variant |
| DELETE | `/teach/<slug>/library/assets/<id>/variants/<vid>` | Soft-delete variant |
| GET | `/api/media/<token>` | Serve blob by short-lived token |

**Upload content-type detection (magic-byte-first):**
1. `%PDF` → PDF; `MThd` → MIDI; `RIFF....WAVE` → WAV.
2. Fallback to extension (case-insensitive) if no magic match.
3. Magic/extension mismatch → 422 `CONTENT_TYPE_MISMATCH`.
4. Unrecognised → 422 `UNSUPPORTED_FILE_TYPE`.
5. > 50 MB → 413 before reading body.

**Upload flow (POST assets):**
1. Detect content type.
2. Store raw file in BlobStore (key = `uuid::Uuid::new_v4().to_string() + ext`).
3. Insert `accompaniments` row.
4. WAV uploaded directly → insert `accompaniment_variants` row (`tempo_pct=100, transpose=0, respect_repeats=0`).
5. Return `{ id, kind: "pdf"|"midi"|"wav" }`.

**Media token store (`MediaTokenStore`, `server/src/http/media_token.rs`):**
- `DashMap<String, TokenEntry>` where `TokenEntry { blob_key, expires_at, kind: Wav|Page }`.
- Hard cap: 1000 tokens. On insert: sweep expired entries first; if still ≥ 1000 evict oldest by `expires_at`.
- On access: opportunistic sweep (non-blocking).
- On session teardown or asset clear: delete all tokens for that asset's blobs.
- `GET /api/media/<token>`: 404 for both unknown and expired tokens (no oracle). WAV and page tokens are multi-use within TTL.

**Prod:** `BlobStore::get_signed_url` returns Azure SAS URL with 5-min TTL, `sp=r` (read-only).

### 5. Deployment + E2E infrastructure

- `sidecar/Dockerfile`: Python 3.12; `apt-get install fluidsynth`; download FluidR3_GM SoundFont (MIT); Java 17 JRE for Audiveris; `pip install -r requirements.txt`.
- `docker-compose.yml` dev: `sidecar` service alongside `server`; `SIDECAR_SECRET` via shared `.env`.
- `SIDECAR_URL` defaults to `http://127.0.0.1:5050`.
- **E2E test foundation (used by Sprints 13 + 14):** Add `tests/e2e/` with Playwright config (`playwright.config.ts`); helper `tests/e2e/helpers/spawn.ts` that starts the dev server + sidecar-stub container and seeds the test DB. Sidecar stub: a minimal Flask app in `tests/e2e/sidecar_stub/` that returns fixture responses for every endpoint without calling Audiveris or FluidSynth. Sprint 12 E2E test: `GET /teach/<slug>/library` returns 200 and the page title is "Library".

---

## Phased implementation order

1. DB migration + sidecar promotion (pipeline copy, bearer auth, error enum, Dockerfile).
2. Rust `sidecar.rs` client + config validation.
3. Rust `library.rs` routes (upload, CRUD, proxy to sidecar).
4. Media token store + `GET /api/media/<token>`.
5. Tests (Rust integration + Python sidecar).

---

## Test strategy

### Property / invariant coverage
- DB `CHECK` constraints reject `tempo_pct < 25`, `tempo_pct > 300`, `transpose_semitones` outside −12–12 at write time.
- Teacher B cannot read, mutate, or delete Teacher A's asset or variant (ownership join enforced).
- Sidecar auth: missing or wrong bearer → 401.
- Upload > 50 MB → 413 before sidecar call.
- `bar_coords_json` > 500 KB / `bar_timings_json` > 100 KB → 422 before DB write.

### Failure-path coverage
- Sidecar unreachable at server start → server starts; library endpoints return 503; WS and session routes unaffected.
- OMR fails (`OMR_FAILED`) → 422; asset row retained; no orphan blob.
- WAV synthesis fails → variant row not inserted; blob not stored; 503 returned.
- Part indices out of range → 422 `INVALID_PART_INDICES`.
- PDF > 40 pages → sidecar 422 `PAGE_COUNT_EXCEEDED` → Rust 422.
- Media token expired → 404 (same as unknown; no oracle).
- Media token for deleted asset → 404 (tokens invalidated on soft-delete).

### Regression guards
- `Cache-Control: no-store` on `/teach/<slug>/library` (Sprint 11A finding #3 pattern).
- Blob keys from `uuid::Uuid::new_v4()` only — no user-supplied keys (Sprint 6 pattern).

### Library handler tests (`tests/http_library.rs`)
1. Upload PDF → 201; asset row created; PDF blob stored.
2. Upload MIDI directly → variant row inserted with `tempo_pct=100`.
3. Upload WAV directly → variant row with `tempo_pct=100`.
4. Magic-byte/extension mismatch → 422 `CONTENT_TYPE_MISMATCH`.
5. Upload > 50 MB → 413.
6. Teacher B cannot GET Teacher A's asset → 404.
7. Teacher B cannot DELETE Teacher A's asset → 404.
8. `POST /assets/<id>/midi` with wiremock sidecar returning `bar_timings_json` > 100 KB → 422.
9. `POST /assets/<id>/rasterise` with coords > 500 KB → 422.
10. `page_blob_keys_json` > 10 KB → 422.
11. `DELETE /assets/<id>` soft-deletes all variants; asset excluded from list.
12. Sidecar wiremock returns 503 → library route returns 503; health endpoint still 200.
13. Media token: issued → 200 within TTL; expired → 404; unknown → 404.
14. Token store at cap 1000: oldest evicted; new token reachable.
15. Token invalidated on `DELETE /assets/<id>` → 404.
16. `SIDECAR_URL` pointing at non-loopback non-allowlisted host → `Config::validate` returns error.
17. `SIDECAR_SECRET` < 32 bytes in prod mode → `validate_prod_config` returns error.

### Sidecar tests (`sidecar/tests/test_app.py`)
- Each endpoint: happy path; missing auth → 401; wrong secret → 401.
- `/omr`: bad PDF → `OMR_FAILED` (`AUDIVERIS_CMD=false`).
- `/synthesise`: `tempo_pct=0` → `INVALID_PARAMS`; `tempo_pct=24` → `INVALID_PARAMS`; `tempo_pct=25` → 200; `tempo_pct=300` → 200; `tempo_pct=301` → `INVALID_PARAMS`; `transpose_semitones=±13` → `INVALID_PARAMS`; `transpose_semitones=±12` → 200 (`FLUIDSYNTH_CMD=echo`).
- `/rasterise`: `dpi=301` → `DPI_EXCEEDED`; pdf > 40 pages (mocked) → `PAGE_COUNT_EXCEEDED`; `dpi=0` → `INVALID_PARAMS`.
- `/bar-timings`: malformed MIDI → `INVALID_MIDI`; valid MIDI with no notes → `{ timings: [] }`.
- `/list-parts`: malformed MusicXML → `INVALID_MUSICXML`.
- `/extract-midi`: empty `part_indices` → `INVALID_PART_INDICES`; out-of-range index → `INVALID_PART_INDICES`.
- `/bar-coords`: malformed MusicXML → `INVALID_MUSICXML`.

### Fixture reuse
- Sidecar tests: copy `spike/pdf_to_piano_audio/fixtures/two_part.musicxml` to `sidecar/tests/fixtures/`.
- Rust integration tests: `helpers::spawn_app` (existing) + `helpers::spawn_sidecar_mock` using `wiremock`.

### Test runtime budget
- Rust: existing ~30 s + ≤ 10 s new (wiremock; no real sidecar).
- Python: binaries stubbed; target ≤ 15 s.
- Flaky policy: no real sleep anywhere; sidecar tests stub all external binaries.

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Audiveris unavailable in CI | High | High | Stubbed via `AUDIVERIS_CMD=false`; CI never calls real OMR |
| FluidSynth + SoundFont not in Dockerfile | Medium | High | Explicitly installed in `sidecar/Dockerfile` |
| WAV files large (30 MB+) | Medium | Medium | Client fetches via signed URL; server never proxies WAV body |
| OMR quality poor for complex scores | Medium | Low | Teacher can upload MIDI directly; OMR is optional |
| `SIDECAR_SECRET` leaks in logs | Low | High | `SecretString` type; redacted in `Debug` / structured logging |
