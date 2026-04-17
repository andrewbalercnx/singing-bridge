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
