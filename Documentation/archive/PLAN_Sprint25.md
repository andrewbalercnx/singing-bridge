# PLAN_Sprint25.md — Bot Peer for Manual UX Testing

**Status:** DRAFT  
**Sprint base commit:** f59e71a46f6e84d3313cf82aa50fbcf7f425d560

---

## Problem Statement

Testing the session experience — audio quality, accompaniment delivery, score modal, TTS — requires two humans coordinating a live call. Every UI or audio change therefore has an invisible barrier between writing the code and validating the subjective result. This slows iteration and makes it impractical to test from the other participant's perspective without scheduling a second person.

Sprint 24/25 shipped the score modal, native audio controls, and MP3/MP4 support. All of these need subjective validation from both the teacher and student perspectives.

---

## User Outcome

**1. Who benefits and what job are they doing?**  
A developer (or the teacher themselves) who has just shipped or changed any part of the session experience — accompaniment playback, TTS, audio routing, score view — and needs to validate it from the *other* role's perspective. They are doing a subjective UX and audio quality check, alone, without a second person on call.

**2. What does success look like from the user's perspective?**  
Developer runs one curl command (`curl "localhost:8080/test-peer?slug=myroom&mode=student"`). They open the teacher session page. Within 10 seconds a bot student appears in their lobby; they click Admit; within another 10 seconds they hear TTS audio through the WebRTC connection ("Hello, I'm ready.") and can fully evaluate what a student hears during a lesson. Swapping `mode=teacher` gives them the student's experience — they hear a real accompaniment play and the teacher's scripted TTS prompts. Bot exits cleanly after 3 minutes.

**3. Why is this sprint the right next step?**  
The library and session features are now rich enough that subjective testing has real value but also real cost (coordination overhead). This sprint eliminates that overhead permanently — every future sprint can be self-tested by one developer.

---

## Current State (from codegraph)

- `/ws` is the single WebSocket upgrade point (`ws/mod.rs`). Role resolution happens on the first `LobbyJoin` / `LobbyWatch` message.
- Teacher auth: `resolve_teacher_from_cookie()` in `ws/mod.rs` promotes a cookie-bearing connection to `Role::Teacher` only if the DB confirms ownership.
- Dev-only routes use a runtime-gate pattern: `if state.config.dev { r = r.route(...) }` plus a compile-time `#[cfg(debug_assertions)]` wrapper (see `http/mod.rs:87–90`).
- Playwright is already a dev dependency (`package.json`); E2E tests in `tests/e2e/` use `--use-fake-ui-for-media-stream`.
- `AccompanimentPlay` WS message delivers a WAV URL to both parties; each plays their own local copy — no audio routing through the WebRTC mic track required for accompaniment.
- `Config` struct is defined in `server/src/config.rs` with `from_env()`.
- Student join form: `#join-form`, email input `#join-email`, submit is `type="submit"` inside the form. Session becomes visible at `#session` (hidden → shown on admission). Teacher session page lobby contains Admit buttons.

---

## Design

### Runtime flag + compile-time gate

New `Config` field `test_peer: bool`, read from `SB_TEST_PEER=true`. Defaults to `true` in `dev_default()`. In `from_env()`, setting `SB_TEST_PEER=true` in a production context is rejected: `validate_prod_config()` (called at startup when `dev=false`) returns an error if `test_peer` is true.

Route registration:

```rust
// server/src/http/mod.rs
#[cfg(debug_assertions)]
if state.config.test_peer {
    r = r
        .route("/test-peer", get(test_peer::get_test_peer))
        .route("/test-peer/session", post(test_peer::post_test_peer_session));
}
```

This means: release builds (`cfg(not(debug_assertions))`) never compile the route, so 404 is guaranteed regardless of env. Dev builds additionally require the env flag. Both guards are required.

### New config field for test subprocess override

```rust
// server/src/config.rs
pub test_peer: bool,
pub test_peer_script: Option<String>,  // None → "python3 scripts/test_peer.py"
```

`SB_TEST_PEER_SCRIPT=echo` in the test process env lets integration tests exercise spawn/cleanup without launching real Playwright.

### New HTTP routes

```
GET  /test-peer?slug=X&mode=teacher|student   → spawn bot; 202 Accepted
POST /test-peer/session                        → exchange one-time token; 200 Set-Cookie
      body: application/json { "token": "..." }
```

The token is sent in the POST body (not as a query parameter) to avoid exposure in access logs and proxy logs. The slug is recovered exclusively from the token entry — `/test-peer/session` accepts no `slug` field (prevents cross-slug replay).

### One-time token store

`server/src/http/test_peer.rs` holds `TokenStore`:

```rust
struct TokenEntry { slug: String, expires: Instant }
struct TokenStore {
    inner: DashMap<String, TokenEntry>,
    cap: usize,  // hard max: 100 live tokens
}
```

Operations:
- `insert(slug)` → generates 32-byte hex token. Sweeps expired entries first. If `inner.len() >= cap` after sweep, returns `Err(CapExceeded)`.
- `consume(token)` → removes and returns `TokenEntry` if present and not expired; `Err(NotFound)` otherwise. Slug in entry is authoritative — caller does not supply slug.

### `get_test_peer` handler (ordered correctly)

1. Parse and validate `mode` param (`teacher` | `student`; else 400).
2. Parse `slug` param.
3. **Check `active_bots` first** — if slug present, return 409 (no token created).
4. For `teacher` mode: query `teachers WHERE slug = $1` → get `teacher_id`; return 404 with `{ "error": "no_teacher" }` if missing. Then find first WAV variant: `SELECT a.id, v.id FROM accompaniments a JOIN accompaniment_variants v ON v.accompaniment_id = a.id WHERE a.teacher_id = $1 AND v.deleted_at IS NULL ORDER BY a.title ILIKE '%rainbow%' DESC, v.created_at ASC LIMIT 1`; return 404 with `{ "error": "no_wav_variant" }` if none.
5. Generate one-time token via `TokenStore::insert(slug)`.
6. Determine subprocess command: `config.test_peer_script.as_deref().unwrap_or("python3")`.
7. Build args: `scripts/test_peer.py --server URL --slug SLUG --mode MODE [--asset-id X --variant-id Y]`. Pass the one-time token via **stdin** (not as a CLI argument) to avoid exposure in process listings: write `TOKEN\n` to the child's stdin immediately after spawn, then close stdin. The bot reads the token from `sys.stdin.readline().strip()` at startup.
8. Spawn via `tokio::process::Command`. On spawn failure, return 503 with `{ "error": "bot_unavailable" }`.
9. **Insert slug into `active_bots` before spawning cleanup task** — guarantees cleanup can always observe an inserted slug, including on immediate subprocess exit.
10. Wrap cleanup in `tokio::spawn` task; on task completion (normal or crash), remove slug from `active_bots`.
11. Return `202 Accepted` with `{ "mode": "...", "slug": "..." }`.

Implementation shape: extract steps 3–5 into `validate_and_reserve(slug, mode, state)` and steps 6–10 into `spawn_bot(slug, mode, cmd, args, state)` to keep the handler body within the project's function-size convention.

### `post_test_peer_session` handler

Route: `POST /test-peer/session`. Body: `application/json` `{ "token": "<hex>" }`.

1. Deserialize body → extract `token`. Call `TokenStore::consume(token)` → get `TokenEntry { slug }`. Return 401 if not found/expired.
2. Query `teachers WHERE slug = $1` → `teacher_id`. Return 404 if missing.
3. Call `auth::issue_session_cookie(&pool, teacher_id, 180)`. This existing helper generates a 32-byte random raw cookie, stores `SHA-256(raw)` as `cookie_hash` in `sessions` with `expires_at = now_unix + 180`, and returns the raw token. The session is fully compatible with `resolve_teacher_from_cookie` — no schema changes required.
4. Set `Set-Cookie: sb_session=<raw>; HttpOnly; SameSite=Strict; Path=/; Max-Age=180`.
5. Return 200.

Short TTL (180 s) bounds the bot session tightly. The session expires within the bot's 3-minute lifetime by construction. No explicit revocation is needed.

### `active_bots` state

```rust
// server/src/state.rs
pub active_bots: Arc<DashMap<String, ()>>,  // keyed by slug; value unused
```

`DashMap<String, ()>` (not DashSet, to avoid an extra crate) is sufficient. The slug is inserted **before** the cleanup task is spawned so that cleanup can always observe and remove the entry — even when the subprocess exits immediately:

```rust
// Insert BEFORE spawning the cleanup watcher.
state.active_bots.insert(slug.clone(), ());

let active_bots = Arc::clone(&state.active_bots);
let slug_owned = slug.clone();
tokio::spawn(async move {
    let _ = child.wait().await;           // waits for subprocess exit (normal or crash)
    active_bots.remove(&slug_owned);      // always runs, even on crash / immediate exit
});
```

This guarantees cleanup on any exit path, including zero-delay exits.

### `window._sbSend` exposure (single API, consistent contract)

One identifier, one contract. In `teacher.js`, inside the localhost guard:

```js
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window._sbSend = function(obj) { ws.send(JSON.stringify(obj)); };
}
```

The bot calls it as:

```python
await page.evaluate("window._sbSend({ type: 'accompaniment_play', asset_id: %d, variant_id: %d, position_ms: 0 })" % (asset_id, variant_id))
```

`_sbSend` takes a plain JS object and stringifies it internally — no double-encoding. The bot never calls `JSON.stringify` itself.

### Bot script (`scripts/test_peer.py`)

Dependencies: `playwright` (async API), `gtts`, `wave`, `struct` (stdlib), `asyncio`.

**Startup:**
1. Generate TTS WAVs per phrase using `gtts.gTTS`. Convert mp3 → wav via `pydub` (or `ffmpeg` subprocess if available, else fallback to silence placeholder).
2. Stitch phrases + silence gaps into `tmp/phrases.wav` using `wave` stdlib. Silence buffers are generous (±2 s drift is acceptable for subjective testing).
3. Launch headless Chromium via `playwright.chromium.launch(args=[...])`:
   - `--use-fake-ui-for-media-stream`
   - `--use-file-for-fake-audio-capture=/tmp/.../phrases.wav`
   - `--allow-running-insecure-content`

**Teacher-bot flow (human will be student):**
1. Read token from `sys.stdin.readline().strip()`. `POST /test-peer/session` with body `{ "token": TOKEN }` — receives `Set-Cookie`.
2. Navigate to `/teach/<slug>/session` with that cookie.
3. Wait up to 60 s for `[data-testid="admit-btn"]` to appear (human student joined lobby).
4. Click the Admit button.
5. `await asyncio.sleep(2)` — "Good morning. Let's begin with Somewhere Over the Rainbow." plays via fake mic (timed from WAV stitch).
6. `await asyncio.sleep(3)` — call `page.evaluate("window._sbSend({ type: 'accompaniment_play', asset_id: %d, variant_id: %d, position_ms: 0 })" % (asset_id, variant_id))`.
7. `await asyncio.sleep(45)` — "Well done. Let's try that again from the top."
8. `await asyncio.sleep(90)` — "That's all for today. Great work."
9. `await asyncio.sleep(20)` → `browser.close()`. Total ≤ 180 s.

**Student-bot flow (human will be teacher):**
1. Navigate to `/teach/<slug>` (the student join page).
2. Fill `#join-email` with `test-bot@singing-bridge.dev`. Submit `#join-form` (`.press("Enter")` or `page.locator("#join-form").evaluate("f => f.submit()")`).
3. Wait for `#session` to become visible (admitted by human teacher) — up to 90 s.
4. `await asyncio.sleep(2)` — "Hello, I'm ready." plays via fake mic.
5. `await asyncio.sleep(20)` — "Sorry, can we slow that down a little?"
6. `await asyncio.sleep(30)` — "Thank you, that was really helpful."
7. `await asyncio.sleep(20)` → `browser.close()`. Total ≤ 75 s.

**Hard timeout:** `asyncio.wait_for(main(), timeout=180)` — script exits after 3 minutes regardless.

### UI additions

- `data-testid="admit-btn"` on each lobby row's Admit button in `teacher.js` (lobby panel).
- `data-testid="session-active"` on the `#session` section once the session is active in `student.js` (already present as `#session`; add `data-testid` to that existing element via JS when it is revealed).

### File map

| File | Concrete change |
|------|-----------------|
| `server/src/config.rs` | Add `test_peer: bool` + `test_peer_script: Option<String>`; read `SB_TEST_PEER`, `SB_TEST_PEER_SCRIPT`; `validate_prod_config()` rejects `test_peer: true` |
| `server/src/state.rs` | Add `active_bots: Arc<DashMap<String, ()>>` |
| `server/src/http/mod.rs` | Add `pub mod test_peer`; mount routes under `#[cfg(debug_assertions)] if config.test_peer` |
| `server/src/http/test_peer.rs` | New file: structured header block required; `TokenStore`, `get_test_peer`, `get_test_peer_session`, `validate_and_reserve` helper, `spawn_bot` helper |
| `web/assets/teacher.js` | Add `window._sbSend` under localhost guard; add `data-testid="admit-btn"` to lobby row Admit button |
| `web/student.html` | Add `data-testid="session-active"` to `#session` element |
| `web/assets/tests/teacher.test.js` | Add `window._sbSend` JS unit test; add `data-testid="admit-btn"` DOM regression |
| `web/assets/tests/student.test.js` | Add `data-testid="session-active"` DOM regression |
| `scripts/test_peer.py` | New file: structured header block required; Playwright bot script |
| `scripts/requirements-test-peer.txt` | New file: `playwright`, `gtts`, `pydub` |

---

## Test Strategy

### Property / invariant coverage

- **Token store**: insert → consume succeeds, returning correct slug; consume same token again → `NotFound`; insert token, advance past TTL → consume returns `NotFound`; insert 100 tokens within TTL → 101st returns `CapExceeded`; `sweep_expired` removes all past-TTL entries and leaves live ones.
- **Route gating**: with `test_peer: false`, `GET /test-peer` returns 404; with `test_peer: true` (debug build), returns 202 (mock subprocess).
- **Prod-config rejection**: `Config::from_env()` with `SB_TEST_PEER=true` and `dev=false` → startup error.
- **`dev_default()` regression**: `Config::dev_default().test_peer` is `true`.
- **Active-bot guard**: spawn with echo script → wait for exit → `active_bots` is empty → second spawn succeeds (202, not 409).
- **409 guard (deterministic, no timing)**: in a unit test, pre-insert slug directly into `state.active_bots` → call handler → returns 409 and `token_store` contains no entry for that slug. (Avoids reliance on subprocess timing — the `echo` subprocess exits before a second HTTP request arrives.)
- **Mode validation (table-driven)**: `""`, `"wizard"`, `"TEACHER"`, `"student "` → all return 400; `"teacher"`, `"student"` → 202.
- **Slug binding**: generate token for slug A via `POST /test-peer/session` with that token → response cookie is valid for slug A; slug A's teacher session resolves correctly.
- **Bot-session TTL**: call `POST /test-peer/session` with a valid token → response `Set-Cookie` header includes `Max-Age=180`; DB row `expires_at` is within ±5 s of `now_unix + 180`.

### Failure-path coverage

- `python3` not on PATH (subprocess override set to `/nonexistent`) → handler returns 503 with `{ "error": "bot_unavailable" }`.
- Bot process crashes immediately → slug removed from `active_bots`; subsequent request returns 202.
- One-time token consumed then replayed → 401.
- Teacher mode with slug owning no WAV variants → 404 before subprocess spawn; `active_bots` unchanged.
- Token store at cap → 503 with `{ "error": "bot_capacity" }`.
- **`no_teacher` path**: `GET /test-peer?slug=nonexistent&mode=teacher` → 404 with `{ "error": "no_teacher" }`; `active_bots` unchanged; `token_store` contains no entry for that slug.
- **Token consumed, teacher deleted**: consume a valid token via `POST /test-peer/session`; delete teacher row between consumption and session issuance → 404; same token cannot be replayed (already consumed → 401).

### Regression guards

- All existing Rust integration tests pass (no changes to ws/, lobby.rs, session.rs).
- `npm test` 485/485; tests include:
  - `window._sbSend` JS unit: stub `WebSocket.send` → call `window._sbSend({type:'Ping'})` → assert `send` called with `'{"type":"Ping"}'`.
  - DOM anchor regression: render teacher lobby row → assert `[data-testid="admit-btn"]` present; render student `#session` → assert `data-testid="session-active"` present.
- `GET /ws` upgrade flow unchanged: existing `ws_upgrade` integration tests pass.

### Fixture reuse plan

- `TestApp` / `spawn_app()` in `server/tests/common/mod.rs` used as-is.
- New `server/tests/test_peer.rs` integration test sets `SB_TEST_PEER=true` + `SB_TEST_PEER_SCRIPT=echo` in the test app's config; exercises all handler paths without launching real Playwright.
- Token store tested as a pure unit (no DB, no network) in `server/src/http/test_peer.rs` `#[cfg(test)]` block.

### Test runtime budget

- Unit tests (token store, mode validation): < 1 s.
- Integration tests (route gating, 409, 404, cleanup): < 10 s.
- No automated Playwright test of the bot itself — manual verification per exit criteria.
- Flaky policy: all tests use `SB_TEST_PEER_SCRIPT=echo`; no timing-sensitive subprocess behaviour.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `gtts` requires internet access at bot launch | Cache generated WAVs in `scripts/test_peer/phrases/`; ship pre-generated WAVs; regenerate only when text changes. |
| `--use-file-for-fake-audio-capture` loops; phase drift vs sleep calls | Stitch WAV with ±2 s silence buffers; subjective drift is acceptable for a test tool. |
| `window._sbSend` breaks if teacher.js is refactored | Localhost guard isolates to dev; comment in teacher.js marks it as bot API. |
| Bot fails to find "rainbow" asset on fresh dev DB | Handler returns 404 with `"no_wav_variant"`; message points to `/teach/<slug>/library`. |
| Playwright not installed | `scripts/requirements-test-peer.txt` + setup note; handler returns 503 on spawn failure. |
| Session row accumulation from many bot runs | 180 s TTL means rows expire quickly; daily cleanup job (already in place for recordings) handles old rows. |

---

## Exit Criteria

1. `GET /test-peer?slug=myroom&mode=student` → 202; bot student appears in teacher's lobby within 5 s; teacher clicks Admit; teacher hears TTS greeting ("Hello, I'm ready.") within 10 s of admitting.
2. `GET /test-peer?slug=myroom&mode=teacher` → 202; human visits `/teach/myroom`; bot admits them within 10 s; human hears accompaniment + TTS phrases in correct order.
3. Bot auto-disconnects after 3 minutes; no zombie Playwright processes.
4. `GET /test-peer` with `SB_TEST_PEER` unset → 404 (not 403, not 500).
5. `GET /test-peer` while bot already running for that slug → 409.
6. `SB_TEST_PEER=true` in prod config (`dev=false`) → server fails to start.
7. All existing Rust tests pass; `npm test` 485/485.
