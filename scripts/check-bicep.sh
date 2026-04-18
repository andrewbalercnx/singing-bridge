#!/usr/bin/env bash
# File: scripts/check-bicep.sh
# Purpose: CI lint — assert min=max=1 replica in container-app.bicep.
# Role: Prevents accidental scale-out which would break SQLite file-locking.
# Last updated: Sprint 5 (2026-04-18) -- initial implementation

set -euo pipefail

BICEP="infra/bicep/container-app.bicep"

if ! grep -q "minReplicas: 1" "$BICEP"; then
  echo "ERROR: minReplicas must be 1 in $BICEP" >&2
  exit 1
fi

if ! grep -q "maxReplicas: 1" "$BICEP"; then
  echo "ERROR: maxReplicas must be 1 in $BICEP" >&2
  exit 1
fi

# Verify both appear within 3 lines of each other (same scale block).
MIN_LINE=$(grep -n "minReplicas: 1" "$BICEP" | head -1 | cut -d: -f1)
MAX_LINE=$(grep -n "maxReplicas: 1" "$BICEP" | head -1 | cut -d: -f1)
DIFF=$(( MAX_LINE - MIN_LINE ))
if [ "$DIFF" -lt 0 ] || [ "$DIFF" -gt 3 ]; then
  echo "ERROR: min/maxReplicas are not adjacent in $BICEP (lines $MIN_LINE, $MAX_LINE)" >&2
  exit 1
fi

echo "OK: min=max=1 replica confirmed in $BICEP"
