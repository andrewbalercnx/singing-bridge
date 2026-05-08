#!/usr/bin/env python3
"""File: scripts/council-retrospective.py

Purpose: Generate a council process retrospective for one or more sprints
by feeding structured findings data and metrics to a cheap model (Haiku),
then printing the draft to stdout or writing it to a file.

Role:
  Standalone CLI. Reads FINDINGS_Sprint<N>.md from the findings archive
  and metrics_Sprint<N>.jsonl from council/, builds a data summary, and
  calls claude-haiku-4-5-20251001 to draft a structured retrospective in
  the established format. The human (or Claude) then edits the draft before
  committing it as Documentation/COUNCIL_RETROSPECTIVE_S<X>_S<Y>.md.

  Using Haiku for the data-aggregation and prose-drafting step saves ~95%
  of the token cost vs. doing this in the main Claude session.

Exports: None (CLI only)
Depends: pathlib, re, json, subprocess, sys, argparse
Last updated: Sprint 26 (2026-05-06) -- initial implementation
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_FINDINGS_DIR = _REPO_ROOT / "Documentation" / "findings-archive"
_COUNCIL_DIR = _REPO_ROOT / "council"
_RETRO_DIR = _REPO_ROOT / "Documentation"

_DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_findings(sprint: str) -> list[dict]:
    path = _FINDINGS_DIR / f"FINDINGS_Sprint{sprint}.md"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        if not re.match(r"\|\s*\d+\s*\|", line):
            continue
        cols = [c.strip() for c in line.split("|")[1:-1]]
        if len(cols) < 7:
            continue
        rows.append({
            "id": cols[0],
            "round": cols[1],
            "severity": cols[2],
            "lens": cols[3],
            "tag": cols[4],
            "finding": cols[5],
            "status": cols[6],
            "resolution": cols[7] if len(cols) > 7 else "",
        })
    return rows


def _load_metrics(sprint: str) -> list[dict]:
    path = _COUNCIL_DIR / f"metrics_Sprint{sprint}.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('{"_schema"'):
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _summarise_sprint(sprint: str, findings: list[dict], metrics: list[dict]) -> dict:
    total = len(findings)
    by_sev: dict[str, int] = {"High": 0, "Medium": 0, "Low": 0}
    by_lens: dict[str, int] = {}
    by_status: dict[str, int] = {}
    max_round = 0

    for f in findings:
        by_sev[f["severity"]] = by_sev.get(f["severity"], 0) + 1
        by_lens[f["lens"]] = by_lens.get(f["lens"], 0) + 1
        by_status[f["status"]] = by_status.get(f["status"], 0) + 1
        m = re.match(r"R(\d+)", f["round"])
        if m:
            max_round = max(max_round, int(m.group(1)))

    resolved = by_status.get("ADDRESSED", 0) + by_status.get("WONTFIX", 0) + by_status.get("VERIFIED", 0)
    pct = round(resolved / total * 100) if total else 0

    # pull token / timing from metrics
    last_metric = metrics[-1] if metrics else {}
    review_type = last_metric.get("review_type", "?")
    input_per_member = last_metric.get("est_input_tokens_per_member")
    codegraph_tokens = last_metric.get("est_mat_codegraph_tokens")
    src_tokens = last_metric.get("est_mat_source_files_tokens")

    return {
        "sprint": sprint,
        "review_type": review_type,
        "total": total,
        "high": by_sev.get("High", 0),
        "medium": by_sev.get("Medium", 0),
        "low": by_sev.get("Low", 0),
        "by_lens": by_lens,
        "by_status": by_status,
        "rounds": max_round,
        "resolved_pct": pct,
        "open_at_close": by_status.get("OPEN", 0),
        "input_per_member": input_per_member,
        "codegraph_tokens": codegraph_tokens,
        "src_tokens": src_tokens,
        "high_findings": [f for f in findings if f["severity"] == "High"],
        "open_findings": [f for f in findings if f["status"] == "OPEN"],
        "wontfix_findings": [f for f in findings if f["status"] == "WONTFIX"],
    }


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def _format_summary_table(summaries: list[dict]) -> str:
    lines = ["| Sprint | Type | Findings | H/M/L | Rounds | Resolved% | Open@close |"]
    lines.append("|--------|------|----------|-------|--------|-----------|------------|")
    for s in summaries:
        h, m, lo = s["high"], s["medium"], s["low"]
        lines.append(
            f"| S{s['sprint']} | {s['review_type']} | {s['total']} "
            f"| {h}/{m}/{lo} | {s['rounds']} | {s['resolved_pct']}% "
            f"| {s['open_at_close']} |"
        )
    return "\n".join(lines)


def _format_lens_table(summaries: list[dict]) -> str:
    all_lenses = ["security", "code_quality", "test_quality", "domain"]
    header = "| Sprint | " + " | ".join(all_lenses) + " |"
    sep = "|--------|" + "|".join("------" for _ in all_lenses) + "|"
    lines = [header, sep]
    for s in summaries:
        cells = [str(s["by_lens"].get(l, 0)) for l in all_lenses]
        lines.append(f"| S{s['sprint']} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _format_high_findings(summaries: list[dict]) -> str:
    parts = []
    for s in summaries:
        highs = s["high_findings"]
        if highs:
            items = "\n".join(
                f"  - F{f['id']} [{f['lens']}] {f['tag']}: {f['finding'][:120]}... → {f['status']}"
                for f in highs
            )
            parts.append(f"S{s['sprint']} High findings:\n{items}")
    return "\n\n".join(parts) if parts else "(none)"


def _format_token_table(summaries: list[dict]) -> str:
    lines = ["| Sprint | Input/member | Src tokens | Codegraph tokens |"]
    lines.append("|--------|-------------|------------|-----------------|")
    for s in summaries:
        ipm = s["input_per_member"] or "n/a"
        src = s["src_tokens"] or "n/a"
        cg = s["codegraph_tokens"] or "n/a"
        lines.append(f"| S{s['sprint']} | {ipm} | {src} | {cg} |")
    return "\n".join(lines)


def _load_format_reference() -> str:
    """Return the most recent retrospective as a format example (truncated)."""
    retros = sorted(_RETRO_DIR.glob("COUNCIL_RETROSPECTIVE_*.md"))
    if not retros:
        return ""
    text = retros[-1].read_text()
    # Truncate to first 120 lines — enough to show structure without bloating the prompt
    lines = text.splitlines()[:120]
    return "\n".join(lines)


def _build_prompt(summaries: list[dict], sprint_range: str) -> str:
    summary_table = _format_summary_table(summaries)
    lens_table = _format_lens_table(summaries)
    high_findings = _format_high_findings(summaries)
    token_table = _format_token_table(summaries)
    format_ref = _load_format_reference()

    format_section = ""
    if format_ref:
        format_section = f"""
## Format reference (first 120 lines of most recent retrospective — match this structure)

```
{format_ref}
```
"""

    return f"""You are generating a council process retrospective for sprint(s): {sprint_range}.

## Cross-sprint summary table

{summary_table}

## Lens distribution

{lens_table}

## Token efficiency

{token_table}

## High-severity findings detail

{high_findings}
{format_section}
## Instructions

Write a complete retrospective document covering:

1. **Executive Summary** — headline metrics and the most important pattern across these sprints (2-3 sentences).
2. **Cross-sprint summary table** — reproduce the summary table above with a short "Notes" column added.
3. **Finding volume by round** — for each sprint, describe how findings accumulated across rounds (use the round numbers in the data). Note any stalling or acceleration patterns.
4. **Lens distribution** — reproduce the lens table. Highlight any lens that dominates (>40% of total) and explain what that implies.
5. **Token efficiency** — reproduce the token table. Note regressions or improvements.
6. **Structural issues** — identify any council process problems visible in the data (e.g. tracker stalling, spurious rounds, high WONTFIX rate, single-lens dominance).
7. **What worked** — genuine positives (complete resolution, fast convergence, security self-limiting correctly, etc.).
8. **Recommendations** — concrete actions, split into Immediate and Process sections.

Use the format reference above for section structure and tone. Be terse and analytical — no padding.
Sprint range: {sprint_range}
Today's date: 2026-05-06
"""


# ---------------------------------------------------------------------------
# Claude invocation
# ---------------------------------------------------------------------------

def _call_haiku(prompt: str, model: str) -> str:
    result = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "text", "--model", model],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        print(f"  [error] claude exited {result.returncode}: {stderr[:200]}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a council retrospective draft using Haiku."
    )
    parser.add_argument(
        "sprints", nargs="+",
        help="Sprint identifiers to include, e.g. 11 11A 12 12A 13",
    )
    parser.add_argument(
        "--output", "-o", default=None,
        help="Write output to this file (default: stdout)",
    )
    parser.add_argument(
        "--model", default=_DEFAULT_MODEL,
        help=f"Claude model to use (default: {_DEFAULT_MODEL})",
    )
    ns = parser.parse_args()

    summaries = []
    for sprint in ns.sprints:
        findings = _load_findings(sprint)
        metrics = _load_metrics(sprint)
        if not findings:
            print(f"  WARNING: no findings found for Sprint {sprint}", file=sys.stderr)
        summaries.append(_summarise_sprint(sprint, findings, metrics))

    sprint_range = f"S{ns.sprints[0]}–S{ns.sprints[-1]}" if len(ns.sprints) > 1 else f"S{ns.sprints[0]}"
    prompt = _build_prompt(summaries, sprint_range)

    print(f"  Calling {ns.model} for retrospective ({sprint_range})...", file=sys.stderr)
    draft = _call_haiku(prompt, ns.model)

    if ns.output:
        Path(ns.output).write_text(draft + "\n")
        print(f"  Draft written to {ns.output}", file=sys.stderr)
    else:
        print(draft)

    return 0


if __name__ == "__main__":
    sys.exit(main())
