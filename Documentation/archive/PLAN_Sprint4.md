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
