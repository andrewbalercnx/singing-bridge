#!/usr/bin/env python3
"""File: scripts/findings-digest.py

Purpose: Aggregate FINDINGS_Sprint*.md files (current and archived under
Documentation/findings-archive/) and write an advisory digest to
Documentation/FINDINGS_DIGEST.md.

Role:
  Closes the quality-tracking loop across sprints. Reports finding
  counts by severity and lens, resolution rates, and recurring patterns.
  Advisory only — never mutates any FINDINGS file.

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
  - Rows with fewer than 7 pipe-separated columns are skipped silently.

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
ARCHIVE_DIR = REPO_ROOT / "Documentation" / "findings-archive"
OUTPUT_PATH = REPO_ROOT / "Documentation" / "FINDINGS_DIGEST.md"

RESOLVED_STATUSES = {"ADDRESSED", "VERIFIED", "WONTFIX"}
UNRESOLVED_STATUSES = {"OPEN", "REOPENED", "RECURRING"}


def _parse_sprint_number(stem: str) -> int | None:
    m = re.search(r"Sprint(\d+)", stem, re.IGNORECASE)
    return int(m.group(1)) if m else None


def load_findings_file(path: Path) -> list[dict]:
    """Parse a FINDINGS markdown table into a list of row dicts."""
    sprint = _parse_sprint_number(path.stem)
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cols = [c.strip() for c in line.strip("|").split("|")]
        if len(cols) < 7:
            continue
        # Skip header and separator rows.
        if cols[0] in ("#", "---", "") or cols[0].startswith("-"):
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
                "severity": cols[2],
                "lens": cols[3],
                "tag": cols[4],
                "status": cols[6].upper(),
            }
        )
    return rows


def _collect_findings(repo_root: Path) -> list[dict]:
    paths: list[Path] = []
    # Current sprint findings files.
    paths.extend(sorted(repo_root.glob("FINDINGS_Sprint*.md")))
    # Archived.
    archive = repo_root / "Documentation" / "findings-archive"
    if archive.is_dir():
        paths.extend(sorted(archive.glob("FINDINGS_Sprint*.md")))

    all_rows: list[dict] = []
    for p in paths:
        all_rows.extend(load_findings_file(p))
    return all_rows


def build_digest(rows: list[dict], generated_at: str) -> str:
    if not rows:
        return f"# Findings Digest\n\n_Generated: {generated_at}_\n\nNo findings files found.\n"

    total = len(rows)
    resolved = sum(1 for r in rows if r["status"] in RESOLVED_STATUSES)
    unresolved = total - resolved
    resolution_rate = resolved / total * 100 if total else 0

    # By severity.
    by_severity: dict[str, int] = defaultdict(int)
    for r in rows:
        by_severity[r["severity"].capitalize()] += 1

    # By lens.
    by_lens: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        lens = r["lens"] or "unknown"
        status = "resolved" if r["status"] in RESOLVED_STATUSES else "open"
        by_lens[lens][status] += 1

    # By sprint.
    by_sprint: dict[int | None, list[dict]] = defaultdict(list)
    for r in rows:
        by_sprint[r["sprint"]].append(r)

    lines = [
        "# Findings Digest",
        "",
        f"_Generated: {generated_at}_",
        "",
        "## Summary",
        "",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total findings | {total} |",
        f"| Resolved | {resolved} ({resolution_rate:.0f}%) |",
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
    for sprint in sorted(k for k in by_sprint if k is not None):
        sprint_rows = by_sprint[sprint]
        s_total = len(sprint_rows)
        s_resolved = sum(1 for r in sprint_rows if r["status"] in RESOLVED_STATUSES)
        lines.append(f"- **Sprint {sprint}**: {s_total} findings, {s_resolved} resolved")

    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Advisory findings digest across sprints.")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--stdout", action="store_true", help="Print to stdout instead of writing file.")
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
