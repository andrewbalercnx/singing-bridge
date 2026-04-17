#!/usr/bin/env bash
# File: tests/netem/clear.sh
# Purpose: Remove netem qdisc from the loopback interface.
# Depends: iproute2 (tc), sudo.
# Last updated: Sprint 4 (2026-04-17) -- initial implementation

set -euo pipefail

IFACE="${IFACE:-lo}"
if [[ ! "$IFACE" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "clear.sh: IFACE contains invalid characters (got: $IFACE)" >&2
  exit 2
fi

echo "clear.sh: removing netem qdisc from $IFACE (requires sudo)"
# Idempotent: exit 0 even if no qdisc is active.
sudo tc qdisc del dev "$IFACE" root 2>/dev/null || true
echo "clear.sh: cleared"
