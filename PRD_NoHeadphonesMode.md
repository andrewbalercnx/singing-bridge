# PRD — Lesson support for students without headphones (and iOS)

**Status:** Draft
**Date:** 2026-04-25
**Owner:** Andrew Bale
**Engineering sprint:** Sprint 20
**Related ADR:** [ADR-0001 §Echo](knowledge/decisions/0001-mvp-architecture.md)

---

## 1. Problem

ADR-0001 makes a deliberate trade-off: browser AEC, noise suppression, and AGC are turned off because they destroy singing fidelity. The mitigation for the resulting echo is a single setup note — *"please wear headphones."* This works for adult students who have their own equipment.

It excludes a significant cohort:

- Young children using a family laptop or tablet with built-in speakers
- Teenagers in classroom or shared environments (Chromebook + integrated mic)
- Anyone joining from an iPhone or iPad — iOS Safari forces voice DSP on regardless of `getUserMedia` constraints

We can ensure the *teacher* has good equipment; we cannot ensure the *student* does. Without addressing this, the product is restricted to a narrow user base of well-equipped adult learners.

The problem has three concrete failure modes today:

1. **Doubled backing track at the teacher.** Accompaniment plays on both peers; the student's open speakers leak the track back into their mic, and the teacher hears their own local copy plus the time-shifted bleed.
2. **Teacher-voice echo.** The teacher speaks → student speakers play it → student mic captures it → teacher hears their own voice ~300 ms late. Classic open-room echo loop, with AEC off.
3. **iOS students get a "degraded" warning.** Even though the experience is workable, the framing tells students their device is wrong rather than quietly handling it.

---

## 2. Users

- **Primary:** the student who cannot or does not wear earphones — children, classroom/shared-device users, mobile users
- **Secondary:** the teacher, who needs the lesson to "just work" without becoming an audio engineer mid-lesson

---

## 3. Use cases

1. **Family laptop, no headphones.** An 8-year-old joins from a MacBook with built-in speakers; teacher wants to play a backing track and coach.
2. **Classroom Chromebook.** A teenager joins from a school device; headphones forbidden by school policy; integrated mic + speakers.
3. **iPad student.** Adult student joins from an iPad on the sofa; iOS forces AEC on; cannot disable.
4. **Inaccurate self-report.** Student checked "I'm wearing headphones" in the lobby but isn't actually wearing them; teacher hears echo and needs a one-click fix.
5. **Mid-lesson device change.** Student starts on headphones, takes them off mid-lesson; teacher needs to flip the profile without ending the session.

---

## 4. Goals

- A complete singing lesson — including backing-track playback and bidirectional voice — works end-to-end for students on speakers OR iOS
- The teacher never hears a doubled backing track or their own voice returning through the student's mic
- During singing, the student's voice reaches the teacher in full music-mode fidelity (the diagnostic signal is preserved)
- Teacher action to make the above happen is **minimal**: auto-detection where possible, automatic chat-mode AEC toggle, with a manual override only for edge cases
- iOS becomes a **first-class supported configuration**, not a degraded warning

## 5. Non-goals

- Real-time duet ("everyone sings in time over the network") — still explicitly off-table per ADR-0001
- Removing the headphones recommendation for the default case — headphones remain the highest-fidelity option and stay preferred
- Solving the iOS sample-rate-resampling fidelity loss — outside our control
- Server-side audio mixing or SFU work — sessions remain strictly P2P
- Auto-detection of headphones via output-device enumeration — browsers don't reliably expose this and we won't pretend otherwise

---

## 6. User stories

**Teacher:**
- As a teacher, when I admit a student on speakers, I can see a clear "Speakers" indicator on their lobby row.
- As a teacher, when the active session is on speakers or iOS, the backing track plays only on the student's machine; my local audio element is muted but the controls (play / pause / scrub / tempo) still work.
- As a teacher, when I start speaking between takes, AEC engages on the student's mic automatically — I don't click anything.
- As a teacher, when I stop talking, music-mode fidelity returns within 3 seconds.
- As a teacher, if the student misreported headphones, I can flip the profile from the lobby row or the in-session panel in one click.
- As a teacher, when I'm playing accompaniment, chat-mode auto-engagement is suppressed so the music's fidelity isn't compromised — even if I quietly comment over the track.
- As a teacher, I can see the live chat-mode state in the session UI (Auto-listening / On / Suppressed) and can force it on or off if VAD misbehaves.

**Student:**
- As a student on speakers, I hear the backing track from my own machine without delay, and the teacher hears me plus the natural room mix.
- As a student on iOS, I see "Supported" with a small note about my device — not a "degraded" warning.
- As a student on speakers, when the teacher starts talking I can hear them clearly without their voice echoing back to them.

---

## 7. Functional requirements

| # | Requirement |
|---|---|
| F1 | **Acoustic profile model** with three states: `Headphones` / `Speakers` / `IosForced`, stored on the lobby entry and propagated to the active session. |
| F2 | **Auto-detection at the student.** iOS UA → `IosForced` (self-check skips the headphones checkbox). Desktop self-check checked → `Headphones`. Desktop self-check unchecked → `Speakers`. |
| F3 | **Manual override (teacher).** Teacher can change the profile pre-admit (lobby row) and post-admit (in-session panel). Override propagates to the student client live. |
| F4 | **Conditional accompaniment muting.** When profile ≠ `Headphones`, the teacher's local audio element for the backing track is muted; the audio element still loads so scrub/tempo/score-viewer work; an in-drawer banner explains why. |
| F5 | **VAD-driven chat mode.** A simple energy + hysteresis VAD on the teacher's outbound mic detects voice onset and silence, and emits a `ChattingMode { enabled }` message to the student. The student client calls `applyConstraints({ echoCancellation, noiseSuppression })` accordingly. |
| F6 | **3 s hangover.** Chat mode stays on for at least 3 seconds after VAD detects silence, so quick coaching back-and-forth doesn't thrash the DSP. |
| F7 | **Accompaniment-playing gate.** Chat-mode rising edges are suppressed entirely while a backing track is actively playing — the music's fidelity on the teacher's ear wins in that window. |
| F8 | **Manual chat override.** Teacher can force chat mode on or off via the live chip — wins over VAD until cleared. |
| F9 | **iOS treatment.** iOS UA → automatic `IosForced` profile; UI labels iOS clearly ("📱 iOS — AEC locked") without the "degraded" connotation; chat-mode chip shows "Always on — iOS forces voice processing" and is non-interactive. |
| F10 | **Backwards compatibility.** Default path (Headphones profile) behaves bit-identically to Sprint 17 — zero subjective change, zero protocol-breaking change for clients that still send `HeadphonesConfirmed`. |

## 8. Non-functional requirements

| # | Requirement |
|---|---|
| N1 | **No SDP renegotiation** on any profile or chat-mode transition. Opus stays in music mode throughout; only browser-side DSP flags flip. |
| N2 | **Chat-mode engagement latency** ≤ 100 ms (VAD detection window + a single WS round-trip). |
| N3 | **Profile-change propagation** ≤ 200 ms (teacher click → student client adopts new behaviour). |
| N4 | **Default-path zero regression.** Subjective listening test under `Headphones` profile is indistinguishable from Sprint 17. |
| N5 | **No additional persistence.** Acoustic profile is per-session, in-memory only — no DB migration. |

---

## 9. Success metrics

- Pilot: at least one full 30-minute lesson with a student on a Chromebook (speakers + integrated mic), with the teacher reporting no audible echo
- Pilot: at least one full 30-minute lesson with a student on iPad, same criterion
- Pilot: at least one teacher-initiated profile override mid-lesson, with the teacher reporting the change took effect immediately
- Subjective listening test: teacher-side audio fidelity in `Headphones` profile is rated equal to Sprint 17 (no perceived loss)
- Zero new "I can hear my own voice" support reports across sessions for two weeks post-launch

---

## 10. Risks and open questions

- **VAD false positives during accompaniment.** Mitigated by hard suppression while `is_playing = true`. Risk if `is_playing` state is stale on the client; mitigation: trust the latest `AccompanimentState` server broadcast.
- **VAD false negatives on quiet whispers.** Mitigated by the manual force-on override on the chat chip.
- **`applyConstraints({ echoCancellation: false })` not honoured on iOS.** Documented and made explicit as the `IosForced` profile; UI surfaces it; no error path on the client when constraints are silently ignored.
- **Profile-change race conditions.** Server is single-writer per socket; last-write-wins is acceptable. Race covered by a server-side test.
- **Chat-mode oscillation around the VAD threshold.** Mitigated by hysteresis (separate on/off thresholds) and the 3 s hangover; covered by fake-timer tests.
- **Open question:** should chat mode also briefly duck the teacher's outbound video bitrate to leave network headroom for the AEC processing on the student's side? Decision for MVP: **no**. Revisit if the audio still glitches under load.
- **Open question:** should we surface a small "echo detected" hint to the teacher (e.g., autocorrelation on the teacher's incoming audio) to *recommend* a profile flip when the student lied about headphones? Decision for MVP: **no**, manual override is sufficient. Revisit after pilot.

---

## 11. Out of scope (this PRD)

- Browser-default AEC tuning (we accept whatever Chrome/Firefox/Safari ship)
- Output-route detection from `enumerateDevices()` labels (unreliable across browsers)
- Server-side mixing or SFU
- A full duet / sing-together mode
- Persisting the acoustic profile per student across sessions
- A noise-suppression-only mode (e.g., for noisy classrooms with headphones)

---

## 12. Acceptance — done means

- All ten functional requirements verified end-to-end on three devices: desktop Chrome (speakers), desktop Chrome (headphones — regression), iPad Safari (iOS forced)
- Chat-mode behaviour verified with a real teacher mic across the four state-machine inputs (VAD on/off × accompaniment playing/not × manual auto/force-on/force-off)
- Council code review APPROVED
- Sprint plan archived per the standard process
