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
