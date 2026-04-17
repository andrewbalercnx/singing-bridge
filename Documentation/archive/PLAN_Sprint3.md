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
