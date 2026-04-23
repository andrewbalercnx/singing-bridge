# PLAN_Sprint14.md — In-session accompaniment playback + score view

**Sprint goal:** Teacher selects a backing track during a lesson; both parties hear it and see a synchronised bar-by-bar score walkthrough.

**Status:** REVISED (R1 findings addressed)

---

## Problem statement

Sprint 12 built the pipeline and library backend. Sprint 13 built the library management UI. Sprint 14 wires accompaniment into the live session: new WebSocket messages carry playback state, clients advance position locally between teacher actions, and a score overlay highlights the current bar. The teacher has full controls; the student is read-only.

Spec refs: `SPRINTS.md §Sprint 14`, `PLAN_Sprint12.md` (protocol design), `knowledge/architecture/signalling.md` (WS single-writer pump), `knowledge/decisions/0001-mvp-architecture.md`.

---

## Current state (after Sprint 13)

| Area | State |
|------|-------|
| `server/src/ws/protocol.rs` | `ClientMsg` has 13 variants; `ServerMsg` has 15 variants; `ErrorCode` has 14 variants — no `Forbidden`, no accompaniment variants |
| `server/src/ws/mod.rs` | Dispatches all `ClientMsg` variants in a `match` at line 247; new variants plug in here by calling into `ws/accompaniment.rs` |
| `server/src/state.rs` | `ActiveSession` inside `Arc<RwLock<RoomState>>` — no accompaniment state; mutated under write lock, no `.await` under guard (invariant from `knowledge/architecture/signalling.md`) |
| `server/src/sidecar.rs` | `BarCoord { bar, page, x_frac, y_frac, w_frac, h_frac }` and `BarTiming { bar, time_s }` are the canonical types |
| `web/assets/signalling.js` | WS dispatch via `this.handlers.get(msg.type)` handler map; new `AccompanimentState` type wired the same way |
| `web/assets/` | `teacher.js` + `student.js` + `session-core.js` exist; no `accompaniment-drawer.js` or `score-view.js` |
| `web/teacher.html` / `web/student.html` | No `#accompaniment-drawer-root` or `#score-view-root` containers |
| Media tokens | `MediaTokenStore::insert(blob_key, ttl)` returns a 64-char hex token; served at `/api/media/<token>` with `Cache-Control: private, max-age=300`; `invalidate_by_blob_keys` supports immediate revocation |

---

## Proposed solution

### Architecture: playback sync contract

Server relays `AccompanimentState` over the existing WebSocket on every teacher action. Every broadcast is a **full snapshot**: WAV URL, page URLs, bar coords, and bar timings are included in every message (not just on Play). Clients do not need to cache metadata across messages; the server re-emits stored URLs from `AccompanimentSnapshot`. Clients advance position locally via `Date.now()` between messages; no server-side clock tick needed.

**Bounded start-offset error (~50 ms) is acceptable for lesson use.**

**Variant restriction:** None based on `respect_repeats`. The production sidecar (`sidecar/app.py`) parses the `respect_repeats` field but does not pass it to `midi_to_wav` — both variant types synthesize from the same MIDI file and produce identical WAVs. `bar_timings` is derived from that same MIDI tick structure, so timing is consistent for all variants. If `respect_repeats` is ever implemented in the sidecar, bar_timings will need to become per-variant; that is a future concern. Sprint 14 imposes no `respect_repeats` restriction.

---

## Component design

### 1. WebSocket protocol additions (`server/src/ws/protocol.rs`)

**New `ErrorCode` variant:**
```rust
// Add to existing ErrorCode enum:
Forbidden,  // student sent a teacher-only message
```

**New `ClientMsg` variants:**
```rust
// Teacher only — student receives ErrorCode::Forbidden
AccompanimentPlay { asset_id: i64, variant_id: i64, position_ms: u64 },
AccompanimentPause { position_ms: u64 },
AccompanimentStop,
```

**New `ServerMsg` variant — always a full snapshot:**

Cleared-state contract: `asset_id: None, variant_id: None, is_playing: false, position_ms: 0, tempo_pct: None, wav_url: None, page_urls: None, bar_coords: None, bar_timings: None`. All clients treat `asset_id: None` as the canonical stop signal.

```rust
AccompanimentState {
    // Cleared state: asset_id = None, is_playing = false, position_ms = 0, tempo_pct = None, all urls/coords/timings = None
    asset_id: Option<i64>,
    variant_id: Option<i64>,
    is_playing: bool,
    position_ms: u64,          // 0 when cleared
    tempo_pct: Option<i32>,    // None when cleared
    wav_url: Option<String>,             // /api/media/<token>; Some on active, None on cleared
    page_urls: Option<Vec<String>>,      // /api/media/<token> per page; same lifecycle as wav_url
    bar_coords: Option<Vec<BarCoord>>,   // fractional {bar, page, x_frac, y_frac, w_frac, h_frac}
    bar_timings: Option<Vec<BarTiming>>, // [{bar, time_s}] at tempo 100%
    server_time_ms: u64,
},
```

`BarCoord` and `BarTiming` are re-exported from `server/src/sidecar.rs` (already public). No new schema is introduced.

**Bounds (enforced server-side before any state mutation or broadcast):**

| Field | Limit | Reject behaviour |
|-------|-------|-----------------|
| `position_ms` | ≤ 14,400,000 (4 hours) | `ErrorCode::Malformed` |
| `tempo_pct` | 1..=400 | `ErrorCode::Malformed` |
| `page_urls` / `page_blob_keys_json` | ≤ 20 entries | `ErrorCode::Malformed` |
| `bar_coords` deserialized from DB | ≤ 2,000 entries | `ErrorCode::Internal` (data source error) |
| `bar_timings` deserialized from DB | ≤ 2,000 entries | `ErrorCode::Internal` |

**Validation rules (checked in `ws/accompaniment.rs` before state write):**
- `bar_timings`: `bar` values must be strictly increasing (monotone); first `time_s ≥ 0`; subsequent `time_s` non-decreasing. Reject with `ErrorCode::Internal` if DB data fails this.
- `bar_coords`: all fractional fields in `[0.0, 1.0]`; `w_frac > 0`, `h_frac > 0`. Skip entries that fail; do not reject the whole play.
- `page_urls`: page indices in `bar_coords` must be in `0..page_urls.len()`. Entries that reference an out-of-range page are skipped.

**Ownership validation** (in `server/src/ws/accompaniment.rs`):
```sql
SELECT av.wav_blob_key, av.tempo_pct, av.respect_repeats,
       a.bar_coords_json, a.bar_timings_json, a.page_blob_keys_json
FROM accompaniment_variants av
JOIN accompaniments a ON a.id = av.accompaniment_id
WHERE av.id = ?1
  AND av.accompaniment_id = ?2
  AND a.teacher_id = ?3
  AND av.deleted_at IS NULL
  AND a.deleted_at IS NULL
```
Mismatch → `ErrorCode::NotFound`. `respect_repeats = true` → `ErrorCode::NotFound`.

**State storage:** `ActiveSession` gains `accompaniment: Option<AccompanimentSnapshot>`. `AccompanimentSnapshot` stores:
- `asset_id`, `variant_id`, `tempo_pct`, `position_ms`, `is_playing`
- `wav_blob_key: String` — for revocation
- `page_blob_keys: Vec<String>` — for revocation
- `wav_url: String`, `page_urls: Vec<String>` — stored on Play; re-emitted on every subsequent broadcast
- `bar_coords: Vec<BarCoord>`, `bar_timings: Vec<BarTiming>` — stored on Play; re-emitted on every broadcast

Mutations happen under the existing `RwLock<RoomState>` write lock. No `.await` under guard.

**Media token lifecycle:**

| Event | Token action |
|-------|-------------|
| `AccompanimentPlay` (no prior state) | Issue WAV + page tokens (`ttl=7200s`, `no_cache=true`); store blob keys in `AccompanimentSnapshot` |
| `AccompanimentPlay` (replacement — snapshot already exists) | **First:** `invalidate_by_blob_keys(&old_snapshot.all_blob_keys())`. **Then:** issue new tokens, build new snapshot. Old tokens are dead before any broadcast. |
| `AccompanimentPause` / Resume | Re-use stored token URLs from snapshot; no new tokens issued |
| `AccompanimentStop` | `invalidate_by_blob_keys(&snapshot.all_blob_keys())` before cleared-state broadcast |
| Teacher disconnect or session teardown | `invalidate_by_blob_keys(&snapshot.all_blob_keys())` if snapshot is `Some` |

The media endpoint returns `Cache-Control: no-store` for tokens with `no_cache=true` (see §media endpoint change below).

**Media endpoint change (small):** add a `no_cache` flag to `MediaTokenStore::Entry`. Set it to `true` for accompaniment tokens. `GET /api/media/:token` returns `Cache-Control: no-store` when the entry has `no_cache = true`, overriding the default `max-age=300`.

`AccompanimentSnapshot::all_blob_keys() -> Vec<String>` returns `[wav_blob_key] + page_blob_keys` (WAV first, then pages in order). Used as the input to `invalidate_by_blob_keys`.

**Handler decomposition** — `handle_accompaniment_play` in `ws/accompaniment.rs` must be split into discrete steps (each testable in isolation):
1. `check_role(ctx)` → `ErrorCode::Forbidden` if student
2. `validate_play_fields(asset_id, variant_id, position_ms)` → `ErrorCode::Malformed`
3. `fetch_and_validate_variant(db, asset_id, variant_id, teacher_id)` → ownership check + data bounds check
4. `revoke_old_tokens(state, media_tokens)` — **always** called; no-op if `accompaniment` is `None`; revokes old blob keys before any new tokens are issued
5. `issue_tokens(media_tokens, wav_key, page_keys)` → WAV + page token URLs (`no_cache=true`)
6. `build_snapshot(...)` → `AccompanimentSnapshot`
7. Write snapshot under `RwLock` write (no `.await`); drop lock; broadcast

**Dispatch wiring in `mod.rs`:**
```rust
ClientMsg::AccompanimentPlay { asset_id, variant_id, position_ms } =>
    handle_accompaniment_play(ctx, state, asset_id, variant_id, position_ms).await,
ClientMsg::AccompanimentPause { position_ms } =>
    handle_accompaniment_pause(ctx, state, position_ms).await,
ClientMsg::AccompanimentStop =>
    handle_accompaniment_stop(ctx, state).await,
```

### 2. `web/assets/accompaniment-drawer.js`

Standard file header required. Exports: `mount`.

`mount(container, opts)` → `{ teardown, updateState }`.

`opts`: `{ role: 'teacher'|'student', slug, sendWs: fn(msg) }`.

**Teacher view:** asset picker (populated via `GET /teach/<slug>/library/assets`), variant picker showing only `respect_repeats = false` variants, play / pause / stop / scrub controls.
**Student view:** read-only — asset title, current bar indicator, is-playing indicator.

**On teacher control action:** calls `opts.sendWs(ClientMsg)`.

**On `updateState(state)` called with `ServerMsg::AccompanimentState`:**
1. Creates or reuses `<audio>` element. If `wav_url` changed: set `audio.src = state.wav_url`; seek to `state.position_ms / 1000`.
2. If `is_playing`: call `audio.play()`. If `!is_playing`: call `audio.pause()`.
3. Every `updateState` call provides the full snapshot — no client-side caching required. Bar coords, timings, and page URLs come from the message directly.
4. Begins local clock tracking:
   - `serverPositionMs = state.position_ms`
   - `clientRefTime = Date.now()`
5. Compute skew correction once on receipt (not per frame): `skewMs = clamp(state.server_time_ms - Date.now(), -500, 500)`. Store alongside `serverPositionMs` and `clientRefTime`.
6. While `is_playing`, `requestAnimationFrame` loop:
   - `currentPositionMs = serverPositionMs + (Date.now() - clientRefTime) + skewMs`.
   - **Invariant:** `tempo_pct` is always `Some` and in `1..=400` when `is_playing = true`. Defensive JS guard: if `tempo_pct` is missing, `0`, or negative in the rAF path, fall back to `100` and log a console warning.
   - Bar lookup: binary search `state.bar_timings` for largest `time_s` where `time_s ≤ (currentPositionMs / 1000) * (effectiveTempoPct / 100)`, where `effectiveTempoPct = tempo_pct || 100`. (At `tempo_pct=50` the WAV plays at half speed, so 10 real seconds of audio = 5 score seconds: `10 × 50/100 = 5.0`.) If position is before the first bar, use `bar_timings[0].bar`. If past the last bar, hold at the last bar.
   - Emit `seekToBar(bar)` to score-view component.
7. On `is_playing = false`: freeze; stop loop. If `asset_id = null`: clear all state; hide drawer content.

**Audio `ended` event (teacher side only):** sends `AccompanimentStop`. Server broadcasts cleared state; both sides stop.

**`bar_timings = null`** (WAV-only asset, no PDF/MIDI): no bar advancement; audio-only mode; score-view not called.

**Audio error handling:** on `audio.onerror`: log error; do not crash; no auto-retry.

### 3. `web/assets/score-view.js`

Standard file header required. Exports: `mount`.

`mount(container)` → `{ teardown, seekToBar(n), updatePages(pageUrls, barCoords) }`.

- `updatePages(pageUrls, barCoords)`: replaces current pages and coord set. Called with data from each `AccompanimentState` message when playing.
- `seekToBar(n)`: binary search `barCoords` for bar `n`; switch page if `coord.page` differs from current. Compute pixel rect from fractional coords: `x = x_frac * img.naturalWidth` etc. Move highlight `<div>`.
- No `barCoords` or empty array → component hidden. No pages → hidden.
- Malformed coord (any fractional field outside `[0,1]`, or `w_frac/h_frac = 0`): skip entry; log warning; no crash.
- `seekToBar` with bar after last entry: hold at last bar. With bar before first entry: hold at first bar.

### 4. Session page wiring

Standard file headers required on any new or modified module-level JS.

- `teacher.html` / `student.html`: add `<div id="accompaniment-drawer-root"></div>` and `<div id="score-view-root"></div>` inside the session UI block.
- `teacher.js` / `student.js`: on session start, `mount` both components; register `AccompanimentState` handler via `signalling.js` handler map; on receipt, call `drawerHandle.updateState(state)` and `scoreHandle.updatePages(state.page_urls, state.bar_coords)`.

---

## Test strategy

### Property / invariant coverage

- **Token revocation:** after `AccompanimentStop`, all blob keys previously inserted must be invalidated (`MediaTokenStore` returns `None` for those tokens).
- **Full snapshot invariant:** every `AccompanimentState` message received by student contains `wav_url`, `page_urls`, `bar_coords`, `bar_timings` when `is_playing = true`.
- **Bounds enforcement:** `position_ms > 14,400,000` and `tempo_pct = 0` are rejected before state mutation.
- **Fractional coords:** `seekToBar` pixel calculation must scale from fractional fields; confirmed by a test using known `x_frac=0.1` on a mocked 1000px-wide image → `x = 100`.

### Failure-path coverage

#### WebSocket roundtrip tests (`server/tests/ws_accompaniment.rs`)
1. Teacher sends `AccompanimentPlay`; student receives full snapshot with `is_playing=true`, `page_urls`, `bar_coords`, `bar_timings` all populated.
2. Teacher sends `AccompanimentPause`; student receives full snapshot with `is_playing=false` — `page_urls` and `bar_coords` **still present** (full snapshot).
3. Teacher sends `AccompanimentPlay` again (Resume from pause); student receives updated `position_ms`; same `wav_url` re-sent from snapshot.
4. Teacher sends `AccompanimentStop`; student receives `AccompanimentState { asset_id: None, is_playing: false, wav_url: None }`.
5. Verify `invalidate_by_blob_keys` effect: after Stop, a `GET /api/media/<token>` for the previously-issued WAV token returns 404.
6. Student sends `AccompanimentPlay` → `Error { code: Forbidden }`.
7. Student sends `AccompanimentPause` → `Error { code: Forbidden }`.
8. Teacher sends `AccompanimentPlay` for `variant_id` belonging to a different asset → `Error { code: NotFound }`.
9. Teacher sends `AccompanimentPlay` for another teacher's valid variant → `Error { code: NotFound }`.
11. Teacher disconnects mid-playback → student receives `AccompanimentState { asset_id: None, is_playing: false }`.
12. `position_ms = 14_400_001` → `Error { code: Malformed }`.
13. `tempo_pct = 0` → `Error { code: Malformed }`.
14. `tempo_pct = 401` → `Error { code: Malformed }`.
15. Rapid `Play / Pause / Play / Stop` sequence: final state is cleared; no phantom `is_playing = true` broadcast.
16. Replacement `AccompanimentPlay` while already playing: old WAV token is revoked before new state is broadcast; old token returns 404; new token returns 200.
17. DB-sourced non-monotone `bar_timings` (injected directly): server returns `ErrorCode::Internal`.
18. DB-sourced `bar_coords` with out-of-range page index (`page=5` but only 2 pages): server skips that entry silently; broadcast `bar_coords` does not include it.
19. All three `ClientMsg` accompaniment variants serde roundtrip.
20. `AccompanimentState` serde roundtrip: all fields populated; all optional fields `None`.
21. Stopped state asserts `position_ms == 0`.

#### JS drawer tests (`web/assets/tests/accompaniment-drawer.test.js`)
Using Node.js fake clock (`globalThis.Date.now` mock) and stubbed `Audio`:

1. Teacher clicks Play → `AccompanimentPlay` sent via WS.
2. Student container has no Play/Pause/Stop buttons.
3. `updateState({ is_playing: true, wav_url: '...', ... })` → `Audio.play()` called.
4. `updateState({ is_playing: false, ... })` → `Audio.pause()` called; rAF loop stopped.
5. Bar advancement `tempo_pct=100`: advance 3000 ms → `seekToBar` called with bar at `time_s ≤ 3.0`.
6. Bar advancement `tempo_pct=50`: advance 10,000 ms → `seekToBar` called with a bar where `time_s ≤ 5.0`. Derives from `10s × (50/100) = 5.0s`. The incorrect inverse formula `10s × (100/50) = 20.0s` would select a bar past the 5-second mark and this test would fail.
7. Clock-skew positive clamp: `server_time_ms` is 600 ms in the past (server clock lagging) → skew correction clamped to +500 ms.
8. Clock-skew negative clamp: `server_time_ms` is 600 ms in the future (server clock ahead) → skew correction clamped to -500 ms.
9. Before-first-bar: `position_ms=0`, `bar_timings=[{bar:1, time_s:0.5}]` → `seekToBar(1)`.
10. After-last-bar: position past final entry → hold at last bar.
11. `bar_timings = null` (WAV-only) → `seekToBar` never called; no error.
12. `bar_timings = []` (empty array, has page data) → `seekToBar` never called; no error. (Distinct from null — component visible but no bar advance.)
13. `tempo_pct = null` in active state → falls back to `effectiveTempoPct=100`; logs warning; `seekToBar` called as if tempo 100; no crash.
14. `Play → Pause → updateState(Pause message)` — Pause message includes `page_urls`/`bar_coords` from full snapshot; `seekToBar` callable without re-fetch.
15. Audio `ended` event → `AccompanimentStop` sent via WS; rAF loop cleared.
16. `AccompanimentStop` received (`asset_id: null`) → `Audio.pause()`; loop cleared; UI returns to idle; `position_ms` asserted as 0.
17. `wav_url = null` → no Audio element created; no error.
18. `audio.onerror` fires → no crash; error logged.
19. `teardown()` idempotent; clears loop and DOM.
20. Rapid `Play/Pause/Play/Stop`: intermediate states do not leak a running rAF loop.
21. `position_ms = 14_400_000` (max valid) → accepted; `position_ms = 14_400_001` → rejected.
22. `tempo_pct = 1` and `tempo_pct = 400` → accepted; `tempo_pct = 0` and `tempo_pct = 401` → rejected.

#### JS score-view tests (`web/assets/tests/score-view.test.js`)
1. `seekToBar(3)` with known `{x_frac:0.1, y_frac:0.2, w_frac:0.5, h_frac:0.1}` on a 1000×800px image → highlight at `{left:100, top:160, width:500, height:80}`.
2. `seekToBar(n)` for bar on page 2 → correct page `<img>` displayed.
3. `seekToBar` with bar before first entry → hold at first bar.
4. `seekToBar` with bar after last entry → hold at last bar.
5. Missing coord for a bar → highlight hidden; no throw.
6. Malformed coord (`x_frac = 1.5`) → entry skipped; no crash.
7. `updatePages([], [])` → component hidden; `seekToBar` is no-op.
8. `updatePages(null, null)` → component hidden; no crash.

### Regression guards

- `ErrorCode::Forbidden` added to enum: existing error roundtrip tests must still pass.
- **Library token cache guard (enforcing test):** add `media_token_library_cache_control` to `server/tests/http_library.rs` — issues a token without `no_cache`, fetches via `GET /api/media/<token>`, asserts `Cache-Control: private, max-age=300`. This test will catch any regression where the `no_cache` flag is applied globally.
- All existing A/V, chat, recording, and session history flows: all existing tests pass unmodified.

### E2E tests (`tests/e2e/accompaniment.spec.ts`, Playwright)

Two-browser context (teacher + student). Pre-seeded asset (WAV + MIDI variant with `respect_repeats=false`, rasterised pages, fixture `bar_timings` / `bar_coords`) inserted into DB before each test. Audio stubbed via `page.evaluate` to avoid autoplay blocking.

1. **Drawer visible** — teacher admits student; drawer appears; asset picker populated with seeded asset.
2. **Play + student hears** — teacher clicks Play; student drawer shows "playing"; both Audio stubs reach `currentTime > 0` within 2 s.
3. **Pause** — teacher pauses; student Audio `paused === true` within 1 s; student score overlay still shows correct bar.
4. **Resume** — teacher resumes; student Audio plays again; no metadata re-fetch (verified by asserting no new network requests to `/api/media/`).
5. **Stop** — teacher clicks Stop; student drawer idle; previously issued media tokens return 404.
6. **Natural end** — Audio `ended` stub fires on teacher; student receives cleared state within 1 s.
7. **Score highlights bar** — after 1 s of playback, assert highlight `<div>` visible and within first bar's bounding rect.
8. **Page switch** — scrub to position in bar on page 2; assert second page `<img>` displayed and highlight visible.
9. **WAV-only asset** — no PDF/MIDI; teacher plays; no score panel; no JS console error.
10. **Student cannot control** — student page has no Play/Pause/Stop buttons.
11. **Disconnect clears state** — teacher disconnects; student drawer returns to idle.

Each scenario asserts no browser console errors.

### Fixture reuse plan

- `server/tests/common/` helper: `seed_accompaniment_asset(db, teacher_id)` inserts an accompaniment with known `bar_coords_json` (fractional fixture) and `bar_timings_json`.
- JS tests reuse the `makeEl()` helper from `library.test.js` pattern for DOM stubs.
- E2E: `tests/e2e/helpers/seed_accompaniment.ts` wraps the DB helper for Playwright use.

### Test runtime budget

- Rust WS + validation tests: ≤ 8 s additional.
- JS unit tests: ≤ 6 s additional (fake clocks).
- E2E (Playwright, two-browser): ≤ 90 s.
- Flaky policy: no real sleep in unit/Rust tests; E2E uses `waitForFunction` with 3 s timeout.

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Audio start-offset > 200 ms perceived | Medium | Medium | Both ends receive `server_time_ms`; skew correction closes most of the gap |
| Score view highlight at wrong position | Low | Low | Fractional-to-pixel conversion tested with fixture coords before E2E |
| Bar coords misaligned (OMR error) | Low | Medium | `selector.py` scales per-bar timings; out-of-range entries skipped in client |
| Student Audio blocked by autoplay policy | Medium | Medium | Audio play triggered by WS message after teacher action; E2E stubs Audio; note for manual Safari testing |
| `TOKEN_CAP` exhaustion during long session | Low | Medium | 2-hour TTL; cap swept on insert; 21 tokens per play × reasonable lesson count stays well under cap |

---

## Known gap: teacher-side playback latency compensation (TODO, not Sprint 14)

When the teacher listens to the backing track, they hear it approximately one audio RTT ahead of what the student hears (because the student's microphone → teacher's earpiece round-trip adds latency). This makes it harder for the teacher to evaluate whether the student's timing is matching the track.

The one-way latency estimate is already available from the debug overlay (`rtt_ms / 2`). A future sprint should delay teacher-side audio playback start by this estimate, so that from the teacher's perspective the student's voice and the backing track are in sync.

This is **not implemented in Sprint 14**. Sprint 14 starts both ends at the same wall-clock moment (modulo WS delivery latency) which is already a UX improvement over no sync at all.
