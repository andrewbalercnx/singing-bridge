# PLAN_Sprint20.md — Lesson support for students without headphones (and iOS)

**Status:** DRAFT R2 — addressing R1 council findings
**Date:** 2026-04-25
**Sprint base commit:** TBD (set at implementation start)
**Implementation note:** JS deliverables are Sprint 19–independent and can begin now. Rust deliverables must land on top of Sprint 19 (PgPool refactor touches every query file; rebase risk is high).

---

## Problem Statement

ADR-0001 deliberately disables browser AEC/NS/AGC to protect singing fidelity, and mitigates the resulting echo with *"please wear headphones."* This works for equipped adult learners but excludes:

- Young children on a family laptop or tablet with built-in speakers
- Teenagers on school Chromebooks (headphones often forbidden)
- Anyone joining from an iPhone or iPad — iOS Safari forces voice DSP on regardless of `getUserMedia` constraints

Three concrete failure modes today:
1. **Doubled backing track at the teacher.** Student open speakers leak the accompaniment back into their mic; teacher hears local copy plus delayed bleed.
2. **Teacher-voice echo.** Teacher speaks → student speakers → student mic → teacher hears their own voice ~300 ms late.
3. **iOS students get a "degraded" warning**, even though the experience is functional and improving it is outside our control.

---

## User Outcome

**Who benefits and what job are they doing?**
A singing teacher conducting lessons with young students (children, classroom, mobile) who cannot reliably wear headphones. The teacher wants to run a complete lesson — coaching, backing track, bidirectional voice — without hearing their own echo or a doubled track, and without becoming an audio engineer to make it work.

**What does success look like from the user's perspective?**
A teacher admits a student on a school Chromebook (speakers + integrated mic) or an iPad. The lesson runs for 30 minutes. The teacher hears the student's voice clearly, does not hear their own voice returned, and the backing track does not double. When the teacher talks between takes, AEC engages on the student side automatically. When the student sings, it turns off within 3 seconds of the teacher's last word. The teacher does not click anything to make this happen, and can force it off when demonstrating vocally.

**Why is this sprint the right next step?**
The product currently works only for well-equipped adult learners. The most common student cohort — children on a family device — is excluded by the headphones requirement. This sprint is the minimum increment needed to make the product viable for that cohort and for any iOS user.

---

## Current State

### `browser.js`
- `isIOS()` detects iPhone/iPad/iPod/CriOS/FxiOS.
- iOS UA → `tier: 'degraded'`, `reasons: ['iOS forces voice processing on all browsers; audio quality will be reduced.']`.
- Return shape: `{ name, version, tier, reasons, device, isIOS, isInAppWebView }`.

### `student.js`
- Browser compat gate: `tier === 'degraded'` → shows `#degraded-notice` with reason text.
- Self-check `onConfirm(hp: bool)`: if `hp`, sends `HeadphonesConfirmed` WS message.
- `connectStudent` sends `LobbyJoin { slug, email, browser, device_class, tier, tier_reason }` — no `acoustic_profile` field today.

### Rust — `protocol.rs`
- `LobbyEntryView`: `headphones_confirmed: bool` (`#[serde(default)]` = false).
- `ClientMsg::HeadphonesConfirmed` — unit variant, student-only.
- No `AcousticProfile` enum; no `ChattingMode`, `SetAcousticProfile`, or `AcousticProfileChanged` messages.

### Rust — `state.rs`
- `LobbyEntry`: `headphones_confirmed: bool`. No acoustic profile.

### `accompaniment-drawer.js`
- `getOneWayLatencyMs` opt wired (Sprint 14). No muting logic. No profile awareness.

### `teacher.js`
- Renders `headphones_confirmed` chip per lobby entry. No VAD. No chat chip.

### No VAD module exists.

---

## Proposed Solution

### Overview

Three independent concerns, designed to compose:

1. **Acoustic profile model** — replaces the `headphones_confirmed` boolean with a three-state enum (`Headphones / Speakers / IosForced`), auto-detected at join and overridable by the teacher.
2. **Conditional accompaniment muting** — when profile ≠ `Headphones`, the teacher's local audio element is muted.
3. **VAD-driven chat mode** — energy-based VAD on the teacher's mic triggers `applyConstraints({ echoCancellation: true })` on the student side during spoken coaching, and releases it when the teacher is quiet. Protected by two hard gates: (a) suppressed entirely while accompaniment is playing, (b) suppressed when teacher enters "Demonstrating" mode (force-off chip state) to protect vocal-demonstration fidelity.

**Fidelity tradeoff acknowledged:** When chat mode is active and then the teacher falls silent, AEC stays on the student track for up to 3 s (the hangover window). This is an explicit, bounded tradeoff accepted in the PRD (§6: "when I stop talking, music-mode fidelity returns within 3 seconds"). The teacher can pre-emptively enter "Demonstrating" mode to eliminate even this window when they know they are about to demonstrate vocally.

iOS is a first-class case of `IosForced`: the same profile machinery, with the VAD chip locked on and non-interactive (iOS forces AEC regardless).

### ADR-0001 amendment required

This sprint changes the product policy for iOS browser classification. `knowledge/decisions/0001-mvp-architecture.md` currently classifies iOS Safari as `degraded`. The implementation must include an amendment recording:
- iOS is reclassified to `supported` with the `iosAecForced` signal
- The teacher sees `IosForced` acoustic profile instead of a degraded flag
- The product accepts iOS AEC-on as a known constraint, not a warning

---

## Component Design

### 1. `web/assets/browser.js` — iOS as supported

**Change:** iOS UA → `tier: 'supported'` with `iosAecForced: true` in the return value.

```js
return {
  name, version, tier, reasons, device, isIOS, isInAppWebView,
  iosAecForced: ios,   // true for all iOS browsers; always false on other platforms
};
```

iOS is removed from the `degraded` branch. The student page reads `iosAecForced` to show a small informational label ("📱 AEC is always on for your device — headphones are still recommended") rather than a degraded warning. `reasons` remains empty for iOS.

**Updated tests:** `safari_ios_17` and `chrome_ios` fixtures move from `tier: 'degraded'` to `tier: 'supported'`; both must assert `iosAecForced === true`. All non-iOS fixtures must assert `iosAecForced === false`. The test description is updated to reflect that iOS is no longer degraded.

**File header:** `Last updated: Sprint 20 (2026-04-25) -- iOS reclassified to supported; iosAecForced flag`
**Exports line updated:** add `iosAecForced` to the exported return shape documentation.

---

### 2. Acoustic profile model

#### State values
```
Headphones — student wearing headphones; AEC not needed; full fidelity preserved
Speakers   — student on open speakers; echo mitigation applies
IosForced  — iOS device; AEC always on regardless of constraints
```

Default for all unknown/legacy cases: `Speakers` (conservative — applies mitigation rather than assuming headphones).

#### 2a. LobbyJoin flow (concurrent self-check)

The student sends `LobbyJoin` immediately when the form is submitted, before self-check completes. The `acoustic_profile` in `LobbyJoin` is derived from UA alone at that point:
- iOS (`iosAecForced`) → `"ios_forced"` (no user input needed)
- Non-iOS → `null` / absent → server defaults to `Speakers`

When the student confirms the headphones checkbox in the self-check overlay, the existing `HeadphonesConfirmed` message is sent, which updates the server-side `acoustic_profile` to `Headphones`. This preserves the existing flow without race conditions.

**Precise fallback derivation rule (server-side, post-Sprint 19):**

| `LobbyJoin.acoustic_profile` | `HeadphonesConfirmed` received? | Resolved profile |
|---|---|---|
| `"ios_forced"` | any | `IosForced` |
| `"headphones"` | any | `Headphones` |
| `"speakers"` | any | `Speakers` |
| absent / `null` | yes | `Headphones` |
| absent / `null` | no | `Speakers` |

`IosForced` is never derived from `tier` server-side — it is only set when explicitly sent by the client. This avoids the ambiguity where other `Degraded`-tier devices could be misclassified.

#### 2b. JS side (Sprint 19–independent)

**`student.js`** — compute initial profile from `detect` before calling `connectStudent`:
```js
function deriveAcousticProfile(detect) {
  // Self-check runs concurrently; this sets the UA-derived initial value only.
  // HeadphonesConfirmed message later upgrades Speakers → Headphones if checked.
  return detect.iosAecForced ? 'ios_forced' : null; // null = server defaults Speakers
}
```

Pass as `acoustic_profile` to `connectStudent`. Remove the `degraded-notice` show for iOS; add `#ios-note` shown when `detect.iosAecForced`.

**`signalling.js`** — `connectStudent` includes `acoustic_profile` in `LobbyJoin`. Add callbacks to handle new server messages:
- `acoustic_profile_changed { profile }` → `opts.onAcousticProfileChanged(profile)` if provided; the student has no action to take on a profile change (the profile is for teacher display and muting decisions), so the default implementation is a no-op. The callback is defined in the contract so callers can observe it if needed.
- `chatting_mode { enabled }` → `opts.onChattingMode(enabled)` (student receives; teacher never receives this)

`connectTeacher` sends two new client messages (via exposed methods on the session handle):
- `sendSetAcousticProfile(entryId, profile)` — sends `set_acoustic_profile { entry_id, profile }`
- `sendChattingMode(enabled)` — sends `chatting_mode { enabled }`

**`teacher.js`** — on `onAcousticProfileChanged`: call `accompanimentHandle.setAcousticProfile(profile)`. Render acoustic profile chip in lobby row (replaces headphones chip); one-click override sends `sendSetAcousticProfile`. See chat chip wiring in §5.

#### 2c. Rust side (post-Sprint 19)

**`protocol.rs`** — new enum:
```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcousticProfile {
    Headphones,
    Speakers,
    IosForced,
}
impl Default for AcousticProfile {
    fn default() -> Self { AcousticProfile::Speakers }
}
```

`LobbyJoin` gains:
```rust
#[serde(default)]
acoustic_profile: Option<AcousticProfile>,
```

`LobbyEntryView` — replace `headphones_confirmed: bool` with `acoustic_profile: AcousticProfile`. The old `headphones_confirmed` field is removed. Backwards-compat: old teacher clients that read `headphones_confirmed` will see it absent; they will lose the chip display but will not crash (they parse JSON leniently). This is acceptable: old clients predating Sprint 20 would not know how to render the profile chip anyway. A `#[serde(default)]` on `headphones_confirmed` in `LobbyEntryView` is **not** kept — the field is deliberately removed to enforce a single authoritative source of acoustic state.

`state.rs` — `LobbyEntry` replaces `headphones_confirmed: bool` with `acoustic_profile: AcousticProfile`. `LobbyEntryMsg` likewise.

**Unknown `acoustic_profile` values** from future clients must not close the socket. The enum uses `#[serde(other)]` on an `Unknown` variant:
```rust
#[serde(other)]
Unknown,  // future-proof: unknown values from newer clients degrade to Speakers
```
In `join_lobby`, `Unknown` is treated as `Speakers`. In `LobbyEntryView` serialization, `Unknown` is never written (it is only a deserialization fallback).

New `ClientMsg` variants:
```rust
SetAcousticProfile {
    entry_id: EntryId,
    profile: AcousticProfile,
},
ChattingMode {
    enabled: bool,
},
// Deprecated: kept for backwards compatibility with pre-Sprint-20 student clients.
// Updates acoustic_profile Speakers → Headphones (no-op for IosForced or Headphones).
HeadphonesConfirmed,
```
The `HeadphonesConfirmed` variant is retained with a deprecation comment explaining why it must persist.

**Auth pattern for new teacher messages:** Both messages follow the existing role-check pattern. At `ws/mod.rs` dispatch, both check `if ctx.role != Role::Teacher { return send_error(ctx, ErrorCode::Forbidden, ...).await; }`. Session binding is via `ConnContext` (established at join/watch), not a per-message slug. This matches how `AccompanimentPlay` and `AccompanimentStop` are guarded today.

New `ServerMsg` variants:
```rust
AcousticProfileChanged {
    profile: AcousticProfile,
},
ChattingMode {
    enabled: bool,
},
```

**`ChattingMode` direction:** `ClientMsg::ChattingMode` is teacher→server only. `ServerMsg::ChattingMode` is server→student only. The teacher client never receives `ServerMsg::ChattingMode`. `connectTeacher` in `signalling.js` does not handle `chatting_mode` as a received message.

**`ws/lobby.rs`** — `join_lobby` sets `acoustic_profile` per the fallback table above. `confirm_headphones` updates `acoustic_profile` to `Headphones` **only if the current profile is `Speakers`**. If the current profile is `IosForced`, `confirm_headphones` is a silent no-op: no state change, no broadcast, no error. This preserves the invariant that an iOS student cannot have their accompaniment-muting protection accidentally lifted by a stale `HeadphonesConfirmed` message. The `headphones_confirmed` field is removed from `LobbyEntry`; `confirm_headphones` no longer sets it.

**`ws/mod.rs`** — `handle_set_acoustic_profile`: teacher-only (role guard); validates `entry_id` in session or lobby (`EntryNotFound` if absent); updates `acoustic_profile`; broadcasts `LobbyState` update; if session active, sends `AcousticProfileChanged` to both peers. `handle_chatting_mode`: teacher-only (role guard); if no active session peer exists, returns `ServerMsg::Error { code: NotInSession }` (no panic, no silent no-op); if session active, relays `ServerMsg::ChattingMode { enabled }` to student only.

**`ChattingMode` state on reconnect:** The server does not persist the last `ChattingMode` state. On reconnect (`onPeerConnected` fires again), VAD is recreated from scratch in `SILENT` state; no `ChattingMode` message is sent until VAD detects voice. The student's `applyConstraints` at reconnect resets to AEC-off (the initial state). This is the correct behavior: a reconnect is a session reset; starting in music mode is always safe.

**`acoustic_profile` trust model:** `acoustic_profile` from the student is advisory. It sets the initial display for the teacher and gates the muting behavior. The teacher can always override it via `SetAcousticProfile`. The server does not enforce acoustic constraints — there is no security boundary at stake; the profile only affects client-side display and client-side `applyConstraints` calls. The trust note in `ws/lobby.rs`: `// acoustic_profile is advisory; teacher override via SetAcousticProfile is authoritative.`

---

### 3. Conditional accompaniment muting — `accompaniment-drawer.js`

**New method on handle:** `handle.setAcousticProfile(profile: string)`

When `profile !== 'headphones'`:
- `audio.muted = true`
- Show in-drawer banner: "Backing track playing on student's machine only"

When `profile === 'headphones'`:
- `audio.muted = false`
- Hide banner

The audio element still loads; `audio.currentTime` tracking and bar advancement are unaffected. The `setAcousticProfile('ios_forced')` case mutes (same as `'speakers'`).

**`mount` opts:** Add `acousticProfile` initial value (default `'headphones'`). Teacher.js passes `acousticProfile: lastStudentAcousticProfile` at mount, then calls `handle.setAcousticProfile(profile)` on changes.

**File header updates:** `Exports` line gains `handle.setAcousticProfile(profile)`; `Invariants` gains: `audio.muted = true when acousticProfile !== 'headphones'`.

---

### 4. VAD module — `web/assets/vad.js`

#### File header
```
// File: web/assets/vad.js
// Purpose: Voice-activity detector for teacher mic — drives chat-mode AEC toggle on the student side.
// Role: Only VAD logic in the client. Emits onVoiceStart/onVoiceSilence to caller; never touches WS directly.
// Exports: window.sbVad = {
//            create(audioTrack, opts) → handle,
//            tickVad(state, rmsNow, nowMs, opts) → { nextState, event | null },
//          }
//          handle: { suppress(bool), forceMode('auto'|'on'|'off'), teardown() }
//          State discriminated union:
//            { name: 'SILENT' }
//            { name: 'ACTIVE' }
//            { name: 'HANGOVER', hangsUntilMs: number }
// Depends: AudioContext, AnalyserNode, MediaStream (browser-only wrapper);
//          tickVad is pure and has no browser dependency.
// Invariants: onVoiceStart never emitted while _suppressed = true.
//             onVoiceSilence never emitted from SILENT state.
//             suppress takes priority over forceMode: if _suppressed=true and forceMode='on',
//               onVoiceStart is NOT emitted until suppress(false) is called.
//             suppress(false) while forceMode='on': emits onVoiceStart immediately.
//             forceMode('off') immediately emits onVoiceSilence if ACTIVE or HANGOVER.
//             forceMode('auto') resumes VAD from SILENT; no immediate event.
//             HANGOVER timer fires at nowMs >= hangsUntilMs (inclusive).
// Last updated: Sprint 20 (2026-04-25) -- initial implementation
```

#### Pure state machine — `tickVad(state, rmsNow, nowMs, opts)`

Three states — discriminated union (same shape used in tests):
- `{ name: 'SILENT' }`
- `{ name: 'ACTIVE' }`
- `{ name: 'HANGOVER', hangsUntilMs: number }`

Full state × event transition table (all 9 cells):

| State | rmsNow >= rmsVoiceOn | rmsNow < rmsVoiceOff AND hangoverExpired | rmsNow < rmsVoiceOff AND hangoverNotExpired | rmsNow in [rmsVoiceOff, rmsVoiceOn) |
|-------|---------------------|------------------------------------------|---------------------------------------------|--------------------------------------|
| SILENT | → ACTIVE, emit `voice_start` | — | — | stay SILENT |
| ACTIVE | stay ACTIVE, reset hangover | → HANGOVER (start timer) | → HANGOVER (start timer) | stay ACTIVE |
| HANGOVER | → ACTIVE, cancel timer | → SILENT, emit `voice_silence` | stay HANGOVER | stay HANGOVER |

Collapsed to 9 `(state, input)` pairs — the inputs are the four RMS ranges × timer state. In practice, `tickVad` receives `(state, rmsNow, nowMs)` and derives the relevant condition:
- `rmsNow >= opts.rmsVoiceOn` → voice-on event
- `rmsNow < opts.rmsVoiceOff` → below-off-threshold event (timer checked separately)
- otherwise → in hysteresis band (no transition)

The hangover timer is part of `state`: `{ name: 'HANGOVER', hangsUntilMs: number }`. Expiry is `nowMs >= hangsUntilMs`.

Hangover boundary: at exactly `nowMs >= hangsUntilMs` (inclusive), the timer is considered expired and the transition to SILENT fires on the next tick that still has `rmsNow < opts.rmsVoiceOff`.

#### API
```js
window.sbVad = {
  create(audioTrack, opts) → handle,
  tickVad(state, rmsNow, nowMs, opts) → { nextState, event | null },
};

// opts:
// { onVoiceStart, onVoiceSilence,
//   hangoverMs = 3000,
//   rmsVoiceOn = 0.04,    // threshold to enter ACTIVE
//   rmsVoiceOff = 0.015,  // threshold to enter HANGOVER (< rmsVoiceOn)
//   pollIntervalMs = 50 }

// handle:
// { suppress(bool), forceMode('auto'|'on'|'off'), teardown() }
```

`tickVad` is exported as a first-class member of `window.sbVad` so tests can import it without instantiating an `AudioContext`.

#### Browser wrapper
- `AudioContext` + `MediaStreamSource(new MediaStream([audioTrack]))` → `AnalyserNode`
- `setInterval(poll, opts.pollIntervalMs)` calling `tickVad`, then dispatching events
**`suppress` takes priority over `forceMode`.** `onVoiceStart` is never emitted while `_suppressed = true`, regardless of `forceMode` value.

- `suppress(true)`: sets `_suppressed = true`; if state is ACTIVE or HANGOVER, immediately emits `onVoiceSilence` and transitions to SILENT. Further `onVoiceStart` emissions blocked until `suppress(false)`.
- `suppress(false)`: clears `_suppressed`. If `_forceMode = 'on'`, immediately emits `onVoiceStart` (the forceMode intent was blocked by suppression; now it fires). Otherwise resumes normal VAD from SILENT; no immediate event.
- `forceMode('on')`: sets `_forceMode = 'on'`. If `_suppressed = false`, immediately emits `onVoiceStart` if not already ACTIVE; VAD tick loop paused. If `_suppressed = true`, stores intent but does not emit (will fire on `suppress(false)`).
- `forceMode('off')`: sets `_forceMode = 'off'`; immediately emits `onVoiceSilence` if ACTIVE or HANGOVER (regardless of suppress state — silence is always safe); transitions to SILENT; VAD tick loop paused. This is the "Demonstrating" state.
- `forceMode('auto')`: clears `_forceMode`; resumes VAD from SILENT (no immediate event; first transition on next tick).
- `teardown()`: clears interval; disconnects `AnalyserNode`; does not close `AudioContext` (it may be shared by the session).

**AudioContext on iOS:** Created inside `onPeerConnected` handler which is inside a user-gesture call chain (the user clicked "Join session"). `AudioContext` will not be suspended. A `ctx.resume()` call is added as a guard after creation.

**Why `AnalyserNode` not `AudioWorkletNode`:** `AnalyserNode` polling at 50 ms has ≤50 ms detection latency — within the 100 ms N2 requirement. No worklet file needed (avoids no-bundler complexity). Works on iOS Safari. The pure `tickVad` function is synchronously testable without `AudioContext`.

---

### 5. Chat mode wiring — teacher.js / student.js

#### Teacher side (`teacher.js`)
After `onPeerConnected`:
```js
vadHandle = window.sbVad.create(localAudioTrack, {
  onVoiceStart() {
    if (!accompanimentIsPlaying) sessionHandle.sendChattingMode(true);
  },
  onVoiceSilence() {
    sessionHandle.sendChattingMode(false);
  },
});
```

**Accompaniment gate:** `accompanimentIsPlaying` is kept in sync from the last `AccompanimentState` received. When `is_playing` changes: `vadHandle.suppress(is_playing)`.

**Chat chip** in session UI — four visible states:
- `Auto-listening` — VAD running, forceMode = 'auto'
- `On` — forceMode = 'on' (teacher forced AEC on)
- `Demonstrating` — forceMode = 'off' (teacher forced AEC off; protecting vocal demo fidelity)
- `Suppressed (track playing)` — suppress=true due to accompaniment

Teacher can click chip to cycle: `auto → on → demonstrating → auto`. The "Demonstrating" label makes the purpose clear.

**`sendChattingMode`** is only called from VAD callbacks (not from forceMode handlers directly). When `forceMode('on')` fires `onVoiceStart`, it goes through the normal `sendChattingMode` path. When `forceMode('off')` fires `onVoiceSilence`, same. This keeps the gate logic in one place.

On `onPeerDisconnected`: `vadHandle.teardown()`.

#### Student side (`student.js`)

New callback in `connectStudent` opts: `onChattingMode({ enabled })`:
```js
let lastChatModeApplied = null;
function applyChatMode(enabled) {
  if (enabled === lastChatModeApplied) return; // debounce: skip if no change
  lastChatModeApplied = enabled;
  if (detect.iosAecForced) return; // iOS: constraints are fixed; no-op
  localAudioTrack.applyConstraints({
    echoCancellation: enabled,
    noiseSuppression: enabled,
    autoGainControl: enabled,
  }).catch(function () {
    // Non-fatal: log only. Some browsers may reject applyConstraints silently.
    console.warn('[student] applyConstraints for chat mode rejected');
  });
}
```

The `lastChatModeApplied` debounce prevents repeated `applyConstraints` calls from rapid VAD toggles or reconnect races. `lastChatModeApplied` resets to `null` on `onPeerDisconnected`.

---

### 6. iOS UI — `student.js` + `student.html`

- Remove `degraded-notice` show for iOS (tier is now `'supported'`).
- Add `#ios-note` element in `student.html` (hidden by default). Shown when `detect.iosAecForced`:
  `"📱 AEC is always on for your device — headphones are still recommended for best quality."`
- `acoustic_profile: 'ios_forced'` sent in `LobbyJoin`.
- Self-check: when `opts.iosAecForced`, hide headphones checkbox and show a small label instead; call `onConfirm(false)` immediately (profile is fixed).

---

## Protocol Wire Format Summary

**New `ClientMsg` (JSON wire names):**
- `lobby_join` gains optional `acoustic_profile: "headphones"|"speakers"|"ios_forced"` (`#[serde(default)]` → None → server applies fallback table)
- `set_acoustic_profile { type, entry_id, profile }` — teacher-only, role-checked via `ConnContext`
- `chatting_mode { type, enabled }` — teacher-only, role-checked via `ConnContext`; requires active session peer or returns `NotInSession`

**New `ServerMsg` (JSON wire names):**
- `acoustic_profile_changed { type, profile }` — sent to both session peers on profile change
- `chatting_mode { type, enabled }` — relayed to student only; teacher never receives this
- `lobby_state` entries replace `headphones_confirmed` with `acoustic_profile`

**Removed from wire:**
- `LobbyEntryView.headphones_confirmed` — removed; single authoritative `acoustic_profile` replaces it

**Unchanged:**
- `HeadphonesConfirmed` ClientMsg — still accepted; updates `acoustic_profile` to `Headphones`

---

## File Map

### JS deliverables (Sprint 19–independent)

| File | Change | Header updates |
|------|--------|---------------|
| `web/assets/browser.js` | iOS → `supported`; add `iosAecForced` flag | Add `iosAecForced` to Exports; Last updated |
| `web/assets/vad.js` | New module | Full header (see §4) |
| `web/assets/self-check.js` | Skip headphones checkbox on iOS | Exports: add `iosAecForced` opt; Invariants; Last updated |
| `web/assets/student.js` | `deriveAcousticProfile`; iOS note; `applyChatMode`; `acoustic_profile` in join | Last updated |
| `web/assets/teacher.js` | VAD create/teardown; chat chip; `setAcousticProfile`; profile override | Last updated |
| `web/assets/accompaniment-drawer.js` | `setAcousticProfile` method; `audio.muted`; banner | Exports, Invariants, Last updated |
| `web/assets/signalling.js` | `acoustic_profile` in `LobbyJoin`; new server msg handlers; `sendSetAcousticProfile`, `sendChattingMode` | Last updated |
| `web/student.html` | Add `#ios-note` element | n/a (no code header) |
| `web/assets/tests/browser.test.js` | iOS tier → supported; assert `iosAecForced` | Last updated |
| `web/assets/tests/vad.test.js` | New — full state machine + forceMode + suppress tests | Full header |
| `web/assets/tests/accompaniment-drawer.test.js` | Add muting + banner tests | Last updated |
| `knowledge/decisions/0001-mvp-architecture.md` | ADR-0001 amendment: iOS reclassified to supported + `iosAecForced` | n/a |

### Rust deliverables (post-Sprint 19)

| File | Change | Header updates |
|------|--------|---------------|
| `server/src/ws/protocol.rs` | `AcousticProfile` enum; update `LobbyJoin`, `LobbyEntryView`; remove `headphones_confirmed`; add 4 new msg variants | Last updated |
| `server/src/state.rs` | Replace `headphones_confirmed` with `acoustic_profile: AcousticProfile` | Last updated |
| `server/src/ws/lobby.rs` | `join_lobby` fallback table; update `confirm_headphones` | Last updated |
| `server/src/ws/mod.rs` | Handlers for `SetAcousticProfile`, `ChattingMode`; `HeadphonesConfirmed` sets profile | Last updated |
| `server/tests/test_acoustic_profile.rs` | New integration tests (inside server crate test path) | Full header |

---

## Test Strategy

### Property / invariant coverage

**`tickVad` state machine (all 9 cells from §4):**
1. SILENT + rms >= rmsVoiceOn → ACTIVE, event = `voice_start`
2. SILENT + rms < rmsVoiceOff → stay SILENT, event = null
3. SILENT + rms in hysteresis band → stay SILENT, event = null
4. ACTIVE + rms >= rmsVoiceOn → stay ACTIVE, no event, hangover timer reset
5. ACTIVE + rms < rmsVoiceOff → enter HANGOVER (start timer), no event yet
6. ACTIVE + rms in hysteresis band → stay ACTIVE, no event
7. HANGOVER + rms >= rmsVoiceOn → → ACTIVE, cancel timer, no event
8. HANGOVER + rms < rmsVoiceOff + timer expired (nowMs >= hangsUntilMs) → SILENT, event = `voice_silence`
9. HANGOVER + rms < rmsVoiceOff + timer not expired → stay HANGOVER, no event

**`forceMode` (pure state machine via `vadHandle`):**
- `forceMode('off')` while ACTIVE → emits `onVoiceSilence`; subsequent ticks emit no events
- `forceMode('off')` while SILENT → no event emitted; ticks still silent
- `forceMode('on')` while SILENT (not suppressed) → emits `onVoiceStart`; subsequent ticks emit no events
- `forceMode('on')` while ACTIVE → no event (already active); ticks still silent
- `forceMode('auto')` after `forceMode('off')` → VAD resumes from SILENT; no immediate event
- `forceMode('on')` → `forceMode('auto')` → VAD resumes from SILENT; no immediate event; `onVoiceStart` does not re-fire

**suppress + forceMode interaction:**
- `suppress(true)` → `forceMode('on')` → no `onVoiceStart` emitted (suppress wins)
- `suppress(true)` → `forceMode('on')` → `suppress(false)` → `onVoiceStart` emitted immediately
- `suppress(true)` while ACTIVE → `onVoiceSilence` emitted → `forceMode('on')` → no event → `suppress(false)` → `onVoiceStart` emitted

**`suppress`:**
- `suppress(true)` while ACTIVE → emits `onVoiceSilence`, transitions to SILENT
- `suppress(true)` while SILENT → no event
- `suppress(false)` after `suppress(true)` → resumes; does NOT re-emit; first transition on next tick
- `suppress(true)` followed by RMS above threshold → no `onVoiceStart` emitted

**Acoustic profile derivation (`deriveAcousticProfile`):**
- iOS UA → `'ios_forced'`
- non-iOS → `null`

**Backwards compat — server fallback table (Rust, all rows):**
- `LobbyJoin` with `acoustic_profile: "headphones"` → `Headphones` (explicit)
- `LobbyJoin` with `acoustic_profile: "speakers"` → `Speakers` (explicit)
- `LobbyJoin` with `acoustic_profile: "ios_forced"` → `IosForced` (regardless of subsequent `HeadphonesConfirmed`)
- `LobbyJoin` with `acoustic_profile: null` + `HeadphonesConfirmed` received → `Headphones`
- `LobbyJoin` with `acoustic_profile: null` + no `HeadphonesConfirmed` → `Speakers`
- `LobbyJoin` with unknown `acoustic_profile` value → `Speakers` (`Unknown` variant via `#[serde(other)]`)
- `HeadphonesConfirmed` when profile is `IosForced` → no-op; profile stays `IosForced`; no broadcast

**VAD threshold boundary (JS):**
- `rms === rmsVoiceOn` (exact match) → satisfies `>= rmsVoiceOn` → SILENT transitions to ACTIVE
- `rms === rmsVoiceOff` (exact match) → does NOT satisfy `< rmsVoiceOff` → falls in hysteresis band → no transition

**Serde round-trips (Rust):**
- All three `AcousticProfile` variants round-trip to/from JSON snake_case
- `LobbyEntryView` without `acoustic_profile` field → default `Speakers`
- Unknown string (e.g., `"bluetooth"`) in `acoustic_profile` field → deserialises to `Unknown` variant → treated as `Speakers` in handler

### Failure-path coverage
- `SetAcousticProfile` from student role → `Forbidden`
- `ChattingMode` from student role → `Forbidden`
- `SetAcousticProfile` with unknown `entry_id` → `EntryNotFound`
- `handle_chatting_mode` with no active session peer → `NotInSession` error, no panic
- `applyChatMode` with `detect.iosAecForced = true` → `applyConstraints` never called
- `accompaniment-drawer.setAcousticProfile('speakers')` → `audio.muted = true` + banner shown
- `accompaniment-drawer.setAcousticProfile('headphones')` → `audio.muted = false` + banner hidden
- `accompaniment-drawer.setAcousticProfile('ios_forced')` → `audio.muted = true` (same as speakers)
- `sendChattingMode` blocked while `accompanimentIsPlaying = true` (no WS message sent)
- `applyChatMode(true)` followed by `applyChatMode(true)` → `applyConstraints` called once (debounce)
- `applyConstraints` rejection → `console.warn` only; no uncaught error
- `lastChatModeApplied` reset on disconnect: after `onPeerDisconnected` resets `lastChatModeApplied = null`, a subsequent `applyChatMode(true)` must call `applyConstraints` even if the last applied value was also `true` (stale debounce state must not suppress post-reconnect application)

### Regression guards
- Sprint 17 regression: `Headphones` profile → `applyChatMode` can still fire, but `applyConstraints` sets AEC on/off correctly (no false activation at baseline)
- Sprint 14 regression: teacher `audio.currentTime` tracking correct when `audio.muted = true`; bar advancement unaffected
- Mount-time muting: `mount({ acousticProfile: 'speakers' })` immediately sets `audio.muted = true` and shows banner (does not require a subsequent `setAcousticProfile` call)
- Sprint 3 regression: iOS UAs route through `isIOS()` → `tier = 'supported'` (test updated to assert new behavior; not removed)
- Sprint 20 backwards compat: `LobbyJoin` without `acoustic_profile` → server derives `Speakers`; `HeadphonesConfirmed` still upgrades to `Headphones`
- `HeadphonesConfirmed` → server sets `acoustic_profile = Headphones` (existing path still works)

### Fixture reuse plan
- All iOS `BROWSER_UA_FIXTURES` entries reused for `iosAecForced` assertions
- Existing `protocol.rs` roundtrip test structure reused for new message variants
- Existing fake-Audio stub in `accompaniment-drawer.test.js` reused for muting tests
- `tickVad` unit tests use fake `nowMs` input (no real timers; no `Date.now` stub needed)

### Test runtime budget
- JS tests (all new + updated): < 5 s (pure state machine; no DOM; no `AudioContext`)
- Rust integration tests (`server/tests/test_acoustic_profile.rs`): < 5 s (in-memory state, no network)
- Flaky policy: no real timers in VAD tests — `nowMs` is a parameter; deterministic

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| AEC active during teacher vocal demo | "Demonstrating" force-off chip; teacher pre-empts; 3 s hangover is explicit PRD tradeoff |
| VAD false positive during a cappella singing with quiet teacher | "Demonstrating" mode; 3 s hangover limits duration |
| `applyConstraints` silently ignored on iOS | `IosForced` profile documents this; UI surfaces it; no error path |
| VAD threshold wrong for real mics | `rmsVoiceOn` / `rmsVoiceOff` configurable via opts; teacher has manual chip |
| `AudioContext` suspended on iOS | `ctx.resume()` called inside `onPeerConnected` (post-user-gesture) |
| Sprint 19 rebase conflicts on Rust files | Rust Sprint 20 files (`protocol.rs`, `state.rs`, `lobby.rs`, `mod.rs`) all touched by Sprint 19; rebase onto Sprint 19 HEAD before starting Phase 2 |

---

## Implementation Order

### Phase 1 — JS (can start immediately)
1. `browser.js` + `browser.test.js` — iOS → supported; `iosAecForced`; ADR-0001 amendment
2. `vad.js` + `vad.test.js` — pure `tickVad` function first, then `AnalyserNode` wrapper
3. `accompaniment-drawer.js` + tests — `setAcousticProfile`, muting, banner
4. `self-check.js` — iOS checkbox skip
5. `student.js` + `student.html` — profile derivation, iOS note, `applyChatMode`
6. `signalling.js` — new message sending/handling
7. `teacher.js` — VAD wiring, chat chip, profile override

### Phase 2 — Rust (after Sprint 19 merges)
1. `protocol.rs` — `AcousticProfile` enum; remove `headphones_confirmed`; new message variants
2. `state.rs` — field replacement
3. `ws/lobby.rs` — join derivation; `confirm_headphones` update
4. `ws/mod.rs` — new handlers
5. `server/tests/test_acoustic_profile.rs` — protocol + role guard + session-edge tests

### Phase 3 — Integration + exit criteria
- End-to-end: desktop Chrome (speakers), iPad Safari (`IosForced`), desktop Chrome (headphones regression)
- Chat-mode state machine manual verification with real teacher mic

---

## Open Questions (resolved)

1. **`ChattingMode` while no session:** → `NotInSession` error. Documented above.
2. **`ChattingMode` direction:** → Teacher sends; student receives only. Teacher never receives it. Documented above.
3. **Reconnect chat mode state:** → Non-persistent; VAD starts fresh; student resets to AEC-off. Documented above.
4. **Student sees chat chip?** → No. Teacher-side only.
5. **VAD thresholds in UI?** → No. Manual chip is the safety valve.
