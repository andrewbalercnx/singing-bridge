#!/usr/bin/env python3
"""File: scripts/findings-digest.py

Purpose: Aggregate FINDINGS_Sprint*.md files (current and archived under
Documentation/findings-archive/) and write an advisory digest to
Documentation/FINDINGS_DIGEST.md.

Role:
  Closes the quality-tracking loop across sprints. Reports finding
  counts by severity and lens, recurring patterns (actionable / watchlist),
  and resolved-but-recurring patterns (resolved in sprint N, open again in
  sprint M > N). Advisory only — never mutates any FINDINGS file.

Exports:
  - load_findings_file -- parse one FINDINGS markdown table into list[dict]
  - build_digest -- compose the markdown body from aggregated rows
  - main -- CLI entry point

Depends on:
  - external: python stdlib only (re, sys, pathlib, datetime, collections,
    argparse)

Invariants:
  - Only rows with status ADDRESSED, VERIFIED, or WONTFIX count as resolved.
  - OPEN and REOPENED rows count as unresolved; RECURRING counts as unresolved.
  - Sprint number is parsed from the filename stem (FINDINGS_Sprint<N>.md).
  - Files with no parseable findings table emit a warning to stderr and are
    skipped (returncode still 0).
  - Actionable patterns: tag appears in >= 3 distinct sprints.
  - Recurring patterns watchlist: tag appears in exactly 2 distinct sprints.
  - Resolved-but-recurring: tag was resolved (ADDRESSED/VERIFIED/WONTFIX) in
    sprint N and then OPEN/REOPENED in sprint M > N.

Last updated: Sprint 6 (2026-04-18) -- initial implementation
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "Documentation" / "FINDINGS_DIGEST.md"

RESOLVED_STATUSES = {"ADDRESSED", "VERIFIED", "WONTFIX"}
UNRESOLVED_STATUSES = {"OPEN", "REOPENED", "RECURRING"}

# Thresholds for pattern classification.
ACTIONABLE_MIN_SPRINTS = 3
WATCHLIST_MIN_SPRINTS = 2


def _parse_sprint_number(stem: str) -> int | None:
    m = re.search(r"Sprint(\d+)", stem, re.IGNORECASE)
    try:
        return int(m.group(1)) if m else None
    except (AttributeError, ValueError):
        return None


def load_findings_file(path: Path) -> list[dict]:
    """Parse a FINDINGS markdown table. Returns list of row dicts (may be empty)."""
    sprint = _parse_sprint_number(path.stem)
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cols = [c.strip() for c in line.strip("|").split("|")]
        if len(cols) < 7:
            continue
        if cols[0] in ("#", "") or re.match(r"^-+$", cols[0]):
            continue
        try:
            int(cols[0])
        except ValueError:
            continue
        rows.append(
            {
                "sprint": sprint,
                "num": cols[0],
                "round": cols[1],
                "severity": cols[2].capitalize(),
                "lens": cols[3],
                "tag": cols[4],
                "status": cols[6].upper(),
            }
        )
    return rows


def _collect_findings(repo_root: Path) -> list[dict]:
    paths: list[Path] = []
    paths.extend(sorted(repo_root.glob("FINDINGS_Sprint*.md")))
    archive = repo_root / "Documentation" / "findings-archive"
    if archive.is_dir():
        paths.extend(sorted(archive.glob("FINDINGS_Sprint*.md")))

    all_rows: list[dict] = []
    for p in paths:
        rows = load_findings_file(p)
        if not rows:
            print(f"skipping {p.name}: no findings table found", file=sys.stderr)
            continue
        all_rows.extend(rows)
    return all_rows


def _classify_patterns(rows: list[dict]) -> tuple[list[str], list[str], list[str]]:
    """Return (actionable_tags, watchlist_tags, recurring_tags) sorted."""
    # Group by tag: collect (sprint, status) pairs.
    tag_sprints: dict[str, set[int]] = defaultdict(set)
    tag_events: dict[str, list[tuple[int, str]]] = defaultdict(list)  # (sprint, status)

    for r in rows:
        tag = r["tag"]
        sprint = r["sprint"]
        if sprint is not None:
            tag_sprints[tag].add(sprint)
            tag_events[tag].append((sprint, r["status"]))

    # Resolved-but-recurring: tag resolved in sprint N, open again in sprint M > N.
    recurring: list[str] = []
    for tag, events in tag_events.items():
        events_sorted = sorted(events, key=lambda x: x[0] if x[0] is not None else 0)
        last_resolved_sprint: int | None = None
        for sprint, status in events_sorted:
            if status in RESOLVED_STATUSES:
                last_resolved_sprint = sprint
            elif status in UNRESOLVED_STATUSES and last_resolved_sprint is not None:
                if sprint is not None and sprint > last_resolved_sprint:
                    recurring.append(tag)
                    break

    # Actionable vs watchlist by distinct sprint count.
    actionable: list[str] = []
    watchlist: list[str] = []
    for tag, sprints in tag_sprints.items():
        n = len(sprints)
        if n >= ACTIONABLE_MIN_SPRINTS:
            actionable.append(tag)
        elif n == WATCHLIST_MIN_SPRINTS:
            watchlist.append(tag)

    return sorted(actionable), sorted(watchlist), sorted(recurring)


def build_digest(rows: list[dict], generated_at: str) -> str:
    header = ["# Findings Digest", "", f"_Generated: {generated_at}_", ""]

    if not rows:
        return "\n".join(header + ["None yet.", ""])

    total = len(rows)
    resolved = sum(1 for r in rows if r["status"] in RESOLVED_STATUSES)
    unresolved = total - resolved
    rate = resolved / total * 100 if total else 0

    by_severity: dict[str, int] = defaultdict(int)
    for r in rows:
        by_severity[r["severity"]] += 1

    by_lens: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        lens = r["lens"] or "unknown"
        key = "resolved" if r["status"] in RESOLVED_STATUSES else "open"
        by_lens[lens][key] += 1

    by_sprint: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        if r["sprint"] is not None:
            by_sprint[r["sprint"]].append(r)

    actionable, watchlist, recurring = _classify_patterns(rows)

    lines = header + [
        "## Summary",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Total findings | {total} |",
        f"| Resolved | {resolved} ({rate:.0f}%) |",
        f"| Open / unresolved | {unresolved} |",
        "",
        "## By Severity",
        "",
        "| Severity | Count |",
        "|----------|-------|",
    ]
    for sev in ("High", "Medium", "Low"):
        n = by_severity.get(sev, 0)
        if n:
            lines.append(f"| {sev} | {n} |")

    lines += [
        "",
        "## By Lens",
        "",
        "| Lens | Resolved | Open |",
        "|------|----------|------|",
    ]
    for lens in sorted(by_lens):
        d = by_lens[lens]
        lines.append(f"| {lens} | {d.get('resolved', 0)} | {d.get('open', 0)} |")

    lines += ["", "## By Sprint", ""]
    for sprint in sorted(by_sprint):
        sprint_rows = by_sprint[sprint]
        s_total = len(sprint_rows)
        s_resolved = sum(1 for r in sprint_rows if r["status"] in RESOLVED_STATUSES)
        lines.append(f"- **Sprint {sprint}**: {s_total} findings, {s_resolved} resolved")

    lines += [
        "",
        "## Actionable patterns",
        "",
        f"Tags appearing in {ACTIONABLE_MIN_SPRINTS}+ sprints — systematic attention recommended.",
        "",
    ]
    if actionable:
        for tag in actionable:
            sprints_for_tag = sorted(
                r["sprint"] for r in rows if r["tag"] == tag and r["sprint"] is not None
            )
            lines.append(f"- **{tag}** — sprints {', '.join(str(s) for s in sprints_for_tag)}")
    else:
        lines.append("_(none)_")

    lines += [
        "",
        "## Recurring patterns watchlist",
        "",
        f"Tags appearing in exactly {WATCHLIST_MIN_SPRINTS} sprints — worth monitoring.",
        "",
    ]
    if watchlist:
        for tag in watchlist:
            sprints_for_tag = sorted(
                r["sprint"] for r in rows if r["tag"] == tag and r["sprint"] is not None
            )
            lines.append(f"- **{tag}** — sprints {', '.join(str(s) for s in sprints_for_tag)}")
    else:
        lines.append("_(none)_")

    lines += [
        "",
        "## Resolved-but-recurring",
        "",
        "Tags resolved in one sprint that reopened in a later sprint.",
        "",
    ]
    if recurring:
        for tag in recurring:
            lines.append(f"- **{tag}**")
    else:
        lines.append("_(none)_")

    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Advisory findings digest across sprints.")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)

    rows = _collect_findings(args.repo_root)
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    digest = build_digest(rows, generated_at)

    if args.stdout:
        sys.stdout.write(digest)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(digest, encoding="utf-8")
        print(f"Wrote {args.output}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
