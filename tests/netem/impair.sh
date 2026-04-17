#!/usr/bin/env bash
# File: tests/netem/impair.sh
# Purpose: Apply packet loss + jitter to the loopback interface so the
#          adapt loop can be exercised against a realistic-ish bad network
#          on a single development machine.
# Role: Manual harness — never run in CI. Requires sudo + tc (Linux).
# Depends: iproute2 (tc), netem kernel module, sudo.
# Invariants: input validation refuses any LOSS / JITTER that is not a
#             simple percentage / duration (prevents shell injection
#             via env); always uses dev loopback.
# Last updated: Sprint 4 (2026-04-17) -- initial implementation
#
# Usage:
#   LOSS=2% JITTER=20ms ./impair.sh
#   ./impair.sh                       # defaults: 2% loss, 20ms jitter
#   ./clear.sh                        # remove impairment

set -euo pipefail

IFACE="${IFACE:-lo}"
LOSS="${LOSS:-2%}"
JITTER="${JITTER:-20ms}"

# Input validation: reject anything that isn't a simple percentage or
# duration. Prevents shell injection via env.
if [[ ! "$LOSS" =~ ^[0-9]+(\.[0-9]+)?%$ ]]; then
  echo "impair.sh: LOSS must be a percentage like '2%' or '0.5%' (got: $LOSS)" >&2
  exit 2
fi
if [[ ! "$JITTER" =~ ^[0-9]+(\.[0-9]+)?(ms|us|s)$ ]]; then
  echo "impair.sh: JITTER must be a duration like '20ms' (got: $JITTER)" >&2
  exit 2
fi
if [[ ! "$IFACE" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "impair.sh: IFACE contains invalid characters (got: $IFACE)" >&2
  exit 2
fi

echo "impair.sh: applying $LOSS loss, $JITTER jitter on $IFACE (requires sudo)"
sudo tc qdisc replace dev "$IFACE" root netem \
  loss "$LOSS" \
  delay 10ms "$JITTER" distribution normal
echo "impair.sh: active — run ./clear.sh to remove"
