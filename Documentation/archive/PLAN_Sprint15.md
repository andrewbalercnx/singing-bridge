# PLAN_Sprint15.md — Web MIDI Keyboard Recording

## Problem statement

Sprint 14 delivered in-session accompaniment playback. Sprint 15 adds a second input path for MIDI assets: the teacher can record a performance directly from a MIDI keyboard in the browser, bypassing the PDF/OMR upload flow entirely.

**Spec refs:** `SPRINTS.md` Sprint 15 deliverables and exit criteria.

---

## Current state

**Relevant existing code:**

| File | Role |
|------|------|
| `web/assets/library.js` | Page script for accompaniment library (UMD module, no bundler, ES5 style) |
| `web/library.html` | Library page template — file upload section, asset list |
| `web/assets/tests/library.test.js` | 69 passing tests covering all existing library.js helpers |
| `server/src/http/library.rs` | All library API routes; `POST /teach/:slug/library/assets` accepts `audio/midi` (magic-byte validated: `MThd`) |

**Server already supports:**
- `POST /teach/:slug/library/assets` — accepts `audio/midi` content type, creates an asset with `midi_blob_key`, does **not** require a sidecar call
- `POST /teach/:slug/library/assets/:id/midi` — replaces the MIDI on an existing asset

No server changes are needed. All work is in `library.js`, `library.html`, and the test file.

---

## Proposed solution

Implement entirely in the browser using the Web MIDI API and a pure-JS MIDI file serializer. No external dependencies, no server changes.

**Chosen approach:** MIDI capture + in-browser Type-1 MIDI serialization, then upload to the existing `POST /assets` endpoint.

**Alternatives considered:**
- Use a third-party MIDI library (e.g. JZZ, tone.js): rejected — no bundler; would require a `<script>` tag from a CDN, adding external dependency and violating the self-hosted asset convention.
- Upload raw MIDI events as JSON and serialize server-side: rejected — adds server complexity for no benefit; server already has a working MIDI ingest path.

---

## Component design

### 1. `web/library.html` — MIDI recording UI

Add a new `<section id="midi-record-section">` below the existing `#upload-section`:

```html
<section id="midi-record-section" hidden>
  <h2>Record from keyboard</h2>
  <div id="midi-device-row" hidden>
    <label for="midi-device-select">Keyboard
      <select id="midi-device-select"></select>
    </label>
  </div>
  <div id="midi-title-row">
    <label for="midi-title-input">Title
      <input type="text" id="midi-title-input" maxlength="255"
             placeholder="e.g. Ave Maria (improvised)">
    </label>
  </div>
  <div id="midi-controls">
    <button id="midi-record-btn" type="button">Start recording</button>
    <button id="midi-stop-btn" type="button" hidden>Stop</button>
  </div>
  <div id="midi-note-display" aria-live="polite" hidden></div>
  <p id="midi-upload-progress" hidden>Uploading…</p>
  <p id="midi-error" class="error" hidden></p>
</section>
<p id="midi-unavailable-note" class="hint" hidden>
  MIDI keyboard recording requires Chrome or Edge.
</p>
```

The section is `hidden` by default; `initMidiRecording` reveals it on success or sets `#midi-unavailable-note` visible on failure.

### 2. `web/assets/library.js` — MIDI recording module

New functions added to the existing IIFE (after the Upload section, before `init`):

#### `initMidiRecording(bannerEl)`
- Calls `navigator.requestMIDIAccess({ sysex: false })`
- On success with ≥1 input port: reveals `#midi-record-section`, populates device picker if >1 device
- On success with 0 ports: sets up `onstatechange` listener to show section when a device connects
- On failure (unavailable API, permission denied): shows `#midi-unavailable-note`; never throws

#### `startMidiCapture(port)`
- Stores `captureStart = performance.now()`; clears event buffer; resets `heldNotes` Set
- Attaches `port.onmidimessage = onMidiMessage`
- Shows `#midi-stop-btn`, hides `#midi-record-btn`
- Shows `#midi-note-display`

#### `onMidiMessage(evt)`
- Accepts status bytes: `0x80–0x8F` (note_off), `0x90–0x9F` (note_on), `0xB0–0xBF` (control_change)
- Silently ignores all other status bytes (program change, sysex, clock, etc.)
- Normalises note_on with velocity = 0 → note_off (both type stored and held-note accounting)
- Elapsed time = `evt.timeStamp - captureStart`; clamped to `max(0, elapsed)` before storage
- Pushes `{ deltaMs, type, channel, data1, data2 }` to event buffer
- Event buffer capped at **10 000 events**; on cap hit, recording is stopped automatically (same as pressing Stop) with a status message indicating truncation
- Maintains `heldNotes` Set (MIDI note numbers currently pressed); updates `#midi-note-display.textContent` with note names (A–G + octave, e.g. "C4 E4 G4")

#### `stopMidiCapture()`
- Detaches `port.onmidimessage`
- Shows `#midi-record-btn`, hides `#midi-stop-btn`, hides `#midi-note-display`
- Returns the captured event buffer (frozen array)

#### `serializeMidi(events, opts)` — **pure function, exported for tests**
- `opts: { ticksPerBeat?: number, bpm?: number }` (defaults: 480, 120)
- Guards: throws `RangeError` if `bpm <= 0` or `ticksPerBeat <= 0`
- Negative `deltaMs` on any event is clamped to 0 before tick conversion
- `microsPerBeat = Math.round(60_000_000 / bpm)`
- `msPerBeat = 60_000 / bpm`
- Absolute tick for event `i` = `Math.round(events[i].deltaMs * ticksPerBeat / msPerBeat)`
- Delta tick for encoding = `tick[i] − tick[i−1]` (always ≥ 0 after clamping)
- Builds a Type-1 MIDI file as a `Uint8Array`:
  - **Header chunk (MThd)**: `4D 54 68 64 00 00 00 06 00 01 00 02 tt tt` where `tt tt` = ticksPerBeat big-endian
  - **Track 0 (tempo track)**: `delta=0 FF 51 03 <3-byte microsPerBeat>` then `00 FF 2F 00` (end-of-track); total chunk body = 11 bytes
  - **Track 1 (note track)**: events encoded with VLQ delta-tick, status byte, data bytes; track ends with `00 FF 2F 00`; empty recording → chunk body = 4 bytes (just end-of-track)

VLQ encoding helper (private):
```js
function encodeVlq(value) { /* standard VLQ: 7 bits per byte, MSB=1 for continuation */ }
```

**Example invariant:** event at `deltaMs=500`, `bpm=120`, `ticksPerBeat=480`:
- `msPerBeat = 500`, tick = `round(500 * 480 / 500)` = `480` ticks

#### `startUpload` — add optional `onSuccess(data)` callback

The existing `startUpload(opts)` gains one optional field:

```js
opts.onSuccess  // function(data) — called with parsed JSON on 201
```

Existing callers pass no `onSuccess` and are unaffected. `uploadMidi` passes one to drive the post-upload expansion. The `startUpload` implementation already calls `loadAssets` on success; `onSuccess` is invoked _after_ that call returns (synchronously, before awaiting the re-render).

Regression: add one test asserting an existing caller with no `onSuccess` still completes without error.

#### `uploadMidi(opts)` — wraps `startUpload` for MIDI blobs
- `opts` mirrors `startUpload` opts but accepts a `Uint8Array` instead of `File`
- Wraps the array in a `Blob` with `type: 'audio/midi'`
- Calls `startUpload` with `file = blob` and `onSuccess = function(data) { autoExpand = data.id; }`
- Post-upload expand flow: `loadAssets` already re-renders the asset list; the `onSuccess` callback stores the target id in a `pendingAutoExpandId` variable. `renderSummary` is updated to call `expandAsset` immediately after creating the `<li>` when `asset.id === pendingAutoExpandId` (then clears it). This fires synchronously during the `loadAssets` re-render, so the DOM row exists before `expandAsset` runs.

#### `init()` additions
- After `initUpload(bannerEl)`, call `initMidiRecording(bannerEl)`
- Wire `#midi-record-btn` → `startMidiCapture(selectedPort)`
- Wire `#midi-stop-btn` → capture events, call `uploadMidi` with title from `#midi-title-input`

**Exported additions to the returned object:**
```js
serializeMidi: serializeMidi,
initMidiRecording: initMidiRecording,   // exported for degradation test
```

---

## Test Strategy

### Property / invariant coverage

**VLQ encoding:**
- 0 → `[0x00]`
- 127 → `[0x7F]`
- 128 → `[0x81, 0x00]`
- 16383 → `[0xFF, 0x7F]`
- 16384 → `[0x81, 0x80, 0x00]`

**`serializeMidi` byte-level invariants:**
- `serializeMidi([])` — bytes 0–3 = `[0x4D, 0x54, 0x68, 0x64]` (`MThd`)
- `serializeMidi([])` — format word = `[0x00, 0x01]` (Type-1)
- `serializeMidi([])` — numTracks word = `[0x00, 0x02]`
- `serializeMidi([])` — ticks/beat word = `[0x01, 0xE0]` (480 default)
- `serializeMidi([])` — tempo track contains `[0xFF, 0x51, 0x03]`
- `serializeMidi([])` — both tracks end with `[0x00, 0xFF, 0x2F, 0x00]`
- `serializeMidi([])` — note track chunk length = 4 (just end-of-track)
- `serializeMidi([])` — tempo track chunk length = 11 (set-tempo + end-of-track)
- `serializeMidi` with `bpm=60` — microsPerBeat bytes encode `1_000_000` (`0x0F 0x42 0x40`)
- Delta tick: event at `deltaMs=500`, `bpm=120`, `ticksPerBeat=480` → tick = **480** (500ms = 1 beat at 120 BPM)
- `serializeMidi` with default opts — same result as explicit `{ ticksPerBeat: 480, bpm: 120 }`

**Guards:**
- `serializeMidi([], { bpm: 0 })` → throws `RangeError`
- `serializeMidi([], { bpm: -1 })` → throws `RangeError`
- `serializeMidi([], { ticksPerBeat: 0 })` → throws `RangeError`
- Event with negative `deltaMs` → clamped to tick 0; produces same output as `deltaMs: 0`

### `onMidiMessage` filtering and normalization

Tests use synthetic `{ data: Uint8Array }` objects passed directly to `onMidiMessage`:
- Status `0x90` (note_on), velocity > 0 → event pushed with type `note_on`; note added to held set; display updated
- Status `0x80` (note_off) → event pushed with type `note_off`; note removed from held set; display updated
- Status `0x90` (note_on), velocity = 0 → treated as note_off; stored with type `note_off`
- Status `0xB0` (control_change) → event pushed with type `control_change`
- Status `0xC0` (program_change) → ignored; event buffer unchanged
- Status `0xF8` (clock) → ignored; event buffer unchanged
- Status `0xF0` (sysex) → ignored; event buffer unchanged
- Held-note display add: press C4 (midi 60) → display textContent contains "C4"
- Held-note display remove: press C4 then release C4 → display textContent no longer contains "C4"
- Buffer cap: after 10 000 events, recording auto-stops; buffer stays at 10 000; status message shown

### Failure-path coverage

- `initMidiRecording`: `navigator.requestMIDIAccess` absent (undefined) → section stays hidden; unavailable note shown
- `initMidiRecording`: `requestMIDIAccess` returns a rejected promise → section stays hidden; unavailable note shown; no uncaught rejection
- `initMidiRecording` success with ≥1 port → `#midi-record-section` becomes visible
- `initMidiRecording` success with 0 ports → `#midi-record-section` stays hidden until `onstatechange` fires
- `stopMidiCapture` with zero events → `serializeMidi([])` bytes start with `MThd`; upload attempt proceeds
- `stopMidiCapture` with one event → returns buffer of length 1
- `uploadMidi` with an empty title → shows error, does not call fetch (reuses `startUpload` validation)
- `uploadMidi` fetch fails (network error) → shows `#midi-error` text; `#midi-upload-progress` hidden

### Regression guards (one per prior-round finding)

- Sprint 13 R1: all 69 existing library tests pass unchanged; `startUpload` callers with no `onSuccess` still work
- Sprint 12A R2: upload still sends raw body (not FormData); MIDI Blob upload follows same pattern
- Sprint 12 R3: XSS: note names written via `.textContent` only — asserted in held-note display test; device picker option uses `.textContent = port.name` — asserted in device picker XSS test
- Sprint 13 R4: 503 banner — new MIDI upload uses `startUpload` unchanged; existing `upload_does_not_show_banner_on_503` test covers it

### Fixture reuse plan

- All new tests live in `web/assets/tests/library.test.js` (same file, new section at bottom)
- Reuse `makeEl()`, `fetchStub()`, `fetchReject()` helpers
- `serializeMidi` tests: no DOM stubs needed — pure byte-array assertions via `assert.equal` / `assert.deepEqual`
- `onMidiMessage` tests: mock `performance.now` via module-state override; pass synthetic event objects

### Test runtime budget

Target: 69 existing + ~25 new = ~94 tests, all finishing under 2 s (current baseline: 973 ms). No real timers; async tests resolve via `setTimeout(r, 20)`. `delete globalThis.fetch` at the end of every async test.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Web MIDI permission denied at runtime (not just API absent) | `requestMIDIAccess` rejection caught; same degradation path as absent API |
| MIDI device fires messages before recording starts | Events only collected inside `startMidiCapture`; `onmidimessage` not attached until then |
| VLQ tick overflow (very long recording) | Ticks stored as integers; JS number is 53-bit safe up to ~2e13 ticks — no practical limit |
| Blob MIME type mismatch with server magic-byte check | `Blob` type set to `audio/midi`; first 4 bytes of serialized file are always `4D 54 68 64` (MThd) — matches server `MIDI_MAGIC` |
| `expandAsset` called on upload success requires the returned asset `id` | `post_asset` already returns `{ id, title, kind }` in JSON — already used by `startUpload`; we add `onSuccess` callback to receive it |

---

## File change summary

| File | Change |
|------|--------|
| `web/library.html` | Add `#midi-record-section`, `#midi-unavailable-note`, device picker, controls, note display |
| `web/assets/library.js` | Add optional `onSuccess(data)` to `startUpload`; add MIDI recording section: `initMidiRecording`, `startMidiCapture`, `onMidiMessage` (with 10 000-event cap), `stopMidiCapture`, `serializeMidi` (with guards), `uploadMidi` (with `pendingAutoExpandId` / `renderSummary` auto-expand); update `renderSummary` to check `pendingAutoExpandId`; wire in `init()` |
| `web/assets/tests/library.test.js` | Add ~25 tests: VLQ encoding (5), `serializeMidi` byte-level invariants (10+), guard cases (4), `onMidiMessage` filter/normalization/cap (8+), `initMidiRecording` degradation (3), `uploadMidi` title validation (2), device picker XSS (1), `startUpload` no-callback regression (1) |
