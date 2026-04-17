# Netem harness (Sprint 4)

Manual network-impairment harness for exercising the adapt loop on a
single development machine. See `knowledge/runbook/netem.md` for the
full runbook.

## Prerequisites

- Linux (the harness uses `tc` with `netem`; macOS and Windows are not
  supported by this script).
- `iproute2` installed (`tc` on the PATH).
- `sudo` access (tc qdisc changes require it).
- Two browser instances on the same machine (Chrome + Chrome Incognito
  works well) pointed at `http://localhost:3000`.

## Files

- `impair.sh` — apply loss + jitter to loopback.
  - Defaults: 2% loss, 20ms jitter, 10ms base delay.
  - Override via env: `LOSS=10% JITTER=30ms ./impair.sh`.
  - Interface: `IFACE=lo` by default.
- `clear.sh` — remove the qdisc. Idempotent.

## Expected observations

At **2 % loss / 20 ms jitter** (spec target, exit criterion):

- Adapt loop enters `poor` quality tier within one or two ticks (2 s each).
- Ladder degrades video rung 0 → 1 within ~8 s (DEGRADE_SAMPLES × tick).
- Subjective audio stays "good" on headphones.
- **Floor-violation surface does NOT fire.**

At **10 % loss** (pressure test):

- Ladder descends through video rungs 1 → 2 → 3 (terminal).
- Audio rungs then start degrading for teacher (rung 1, 2, 3).
- For student: audio clamped at rung 1 (96 kbps floor).
- Floor-violation surface fires within ~25 s of sustained loss.
- Reconnect banner appears if ICE transiently disconnects.

## Not in CI

This harness is explicitly a manual check. CI has no `tc`, no `sudo`,
no `netem` kernel module, and no way to run two interactive browsers.
Pure-logic coverage of the adapt + quality + reconnect state machines
is covered by `web/assets/tests/*.test.js` which DO run in CI.
