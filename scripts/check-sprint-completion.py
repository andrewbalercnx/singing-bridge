#!/usr/bin/env python3
"""File: scripts/check-sprint-completion.py

Purpose: Print each deliverable from PLAN_Sprint<N>.md as a verification
checklist so the agent can confirm every item is implemented before
declaring a sprint complete.

Role:
  Called by the "Complete" step 0 in CLAUDE.md. Reads the plan file,
  extracts every ## Deliverables bullet, and prints a numbered list.
  The agent must confirm each item exists in the codebase; any
  unimplemented item must be explicitly descoped with a written reason
  before proceeding. Exits non-zero if the plan file is missing.

Exports: None (CLI only)
Depends: pathlib, re, sys, argparse
Last updated: Sprint 12A
"""

import argparse
import re
import sys
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parent.parent


def _find_plan_file(sprint: str) -> Path | None:
    """Return path to PLAN_Sprint<N>.md if it exists (archive or root)."""
    candidates = [
        _REPO_ROOT / f"PLAN_Sprint{sprint}.md",
        _REPO_ROOT / f"Documentation/archive/PLAN_Sprint{sprint}.md",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


_DELIVERABLE_RE = re.compile(
    r"[Dd]eliverable|[Pp]hased.implementation|[Ii]mplementation.order|[Ss]cope"
)


def _extract_deliverables(text: str) -> list[str]:
    """Extract bullet/numbered lines from deliverable-like sections."""
    lines = text.splitlines()
    in_section = False
    items: list[str] = []

    for line in lines:
        # Detect heading
        if re.match(r"^#{1,4}\s+", line):
            in_section = bool(_DELIVERABLE_RE.search(line))
            continue
        if not in_section:
            continue
        # Collect bullet lines (-, *, numbered)
        stripped = line.strip()
        if re.match(r"^[-*]\s+|^\d+\.\s+", stripped):
            # Strip leading bullet marker
            item = re.sub(r"^[-*]\s+|^\d+\.\s+", "", stripped).strip()
            if item:
                items.append(item)

    return items


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Print PLAN_Sprint<N> deliverables as a verification checklist."
    )
    parser.add_argument("sprint", help="Sprint identifier, e.g. 12 or 12A")
    ns = parser.parse_args()

    plan_path = _find_plan_file(ns.sprint)
    if plan_path is None:
        print(
            f"ERROR: PLAN_Sprint{ns.sprint}.md not found "
            f"(checked repo root and Documentation/archive/)",
            file=sys.stderr,
        )
        return 1

    text = plan_path.read_text(errors="replace")
    deliverables = _extract_deliverables(text)

    if not deliverables:
        print(
            f"WARNING: No deliverables section found in {plan_path.relative_to(_REPO_ROOT)}",
            file=sys.stderr,
        )
        print(
            "  Make sure the plan has a '## Deliverables' heading with bullet points.",
            file=sys.stderr,
        )
        return 2

    print(f"Deliverables from {plan_path.relative_to(_REPO_ROOT)}")
    print(f"{'=' * 60}")
    print()
    for i, item in enumerate(deliverables, 1):
        print(f"  [ ] {i:>2}. {item}")
    print()
    print(f"{'=' * 60}")
    print(f"Total: {len(deliverables)} deliverable(s)")
    print()
    print("INSTRUCTIONS (step 0 of Complete):")
    print("  For each item above, verify it is implemented in the codebase.")
    print("  Use codegraph queries or file reads to confirm.")
    print("  Any unimplemented item must be explicitly descoped with a written")
    print("  reason before proceeding to step 1.")
    print("  Do NOT move to step 1 until every item is confirmed or descoped.")
    print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
