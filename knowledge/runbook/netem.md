# Runbook: netem harness (Sprint 4)

> File: knowledge/runbook/netem.md  
> Purpose: Manual procedure for exercising the bandwidth adaptation,
>          reconnect, and floor-violation paths on one Linux dev box.  
> Audience: sprint 4+ maintainers verifying adapt-loop behaviour before
>          shipping a change that touches `web/assets/adapt.js`,
>          `web/assets/quality.js`, `web/assets/reconnect.js`, or
>          `web/assets/session-core.js`.  
> Last updated: Sprint 4 (2026-04-17)

## Prerequisites

- Linux host. macOS `dnctl`/`pfctl` can do similar work but this
  runbook uses `tc netem`.
- `iproute2` installed (`tc --version` works).
- `sudo` on the host.
- Chrome (two profiles: Default + Incognito is fine).
- The dev server running on `localhost:3000` (`cargo run -p
  server`; see main README).

## Why this harness exists

Real bandwidth constraints are rare on a dev LAN. Without netem we
can't empirically demonstrate the four-rung degradation order
(ADR-0001 §Bandwidth degradation order) or the student's 96 kbps
audio floor. The harness applies loss + jitter to loopback so both
"peers" running on the same box feel a plausible bad network.

## Procedure

1. Start the server:
   ```
   cargo run -p server
   ```
2. In browser window A (Chrome), sign up a teacher and land on
   `/teach/<slug>`.
3. In browser window B (Chrome Incognito), visit the same URL, enter
   an email, wait in the lobby, get admitted.
4. Confirm the session is healthy — `quality-badge` shows "good",
   no `reconnect-banner`, no `floor-violation`.
5. Run `./tests/netem/impair.sh` to apply 2 % loss / 20 ms jitter.
6. Watch the debug overlay (enabled in dev builds; see
   `debug-overlay.js`). You should see:
   - `inbound.packetsLost` climb.
   - `candidate.rtt` rise.
   - `quality-badge` transition `good` → `fair` → `poor`.
7. After ~8 s sustained: the adapt loop should step `studentVideo`
   rung 0 → 1 (bitrate cap drops from 1.5 Mbps to 500 kbps). With the
   debug overlay open, the outbound video bitrate counter should
   flatten near the new cap.
8. Subjective audio check: sing into the mic. Student-side audio to
   teacher should remain intelligible. Sibilants may thin slightly;
   there should be no pumping or pitched artefacts.
9. Stop impairment:
   ```
   ./tests/netem/clear.sh
   ```
10. Rung counters should recover (slower than they degraded — 8 good
    ticks to upgrade one rung, per `IMPROVE_SAMPLES=8`).

## Pressure test — does the floor surface fire?

1. Start clean: `./tests/netem/clear.sh`.
2. Apply heavy impairment:
   ```
   LOSS=10% JITTER=30ms ./tests/netem/impair.sh
   ```
3. Within ~25 s:
   - Student side shows `floor-violation` ("Your connection can't
     support this lesson.") and the session hangs up.
   - Teacher side shows its mirror notice ("This student's connection
     can't support the lesson.") after the student hangs up.

## Pressure test — does reconnect fire?

1. Start clean.
2. In Chrome DevTools, Network tab → "Offline" checkbox on the
   student window for 2–3 seconds, then back to "Online".
3. Observe: `reconnect-banner` appears within 3 s of disconnect; the
   session recovers without user action within ~5 s total.
4. If the disconnect lasts longer than `ICE_WATCH_MS + ICE_RESTART_MS`
   (3 s + 5 s = 8 s), the watcher gives up; the student hangs up and
   sees the "Teacher disconnected" error (existing path).

## What to file if the harness shows something different

If the adapt loop degrades audio BEFORE video (out of ADR order), file
a sprint-4 regression: the degradation order is a spec invariant
(`§5.1 #5, #6` in `PLAN_Sprint4.md`).

If the student floor-violation fires at 2 % loss / 20 ms jitter,
loosen `DEGRADE_LOSS` / `DEGRADE_RTT_MS` in `adapt.js` and re-run.
Those thresholds are tuned for "good at 2 %" (the sprint exit
criterion).

## See also

- `knowledge/decisions/0001-mvp-architecture.md` §Bandwidth
  degradation order — the rules this harness empirically validates.
- `PLAN_Sprint4.md` §6 R3, §6 R8 — risk notes this runbook relates to.
- `tests/netem/README.md` — script-level usage.
