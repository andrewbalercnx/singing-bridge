#!/usr/bin/env python3
"""File: scripts/council-review.py
Purpose: Orchestrate the multi-expert Council of Experts plan/code review pipeline (parallel members + consolidator) for the pair-programming workflow.

Role:
  Default reviewer entry point. Reads scripts/council-config.json, fans
  out to configured experts across Codex CLI / Gemini / Claude with
  automatic fallback and retry, enforces a quorum, then consolidates
  findings into REVIEW_Sprint<N>.md and auto-maintains
  FINDINGS_Sprint<N>.md across rounds. Handles sprint-aware diffs,
  convergence guardrails, and secret redaction.

Exports:
  - main, _parse_args -- CLI entrypoint + argparse helper
  - _parse_findings, _read_tracker, _write_tracker -- findings schema
  - _derive_tag, _derive_lens -- deterministic tag/lens derivation
  - LENS_MAP, SOURCE_EXTENSIONS -- shared constants
  - compute_convergence_score, extract_verdict -- review-text helpers
  - find_untracked_source_files, preflight_code_review,
    PreflightResult -- Sprint 2 pre-flight check surface

Last updated: Sprint 12a (2026-04-21) -- metrics v2 schema + helper extraction; selective routing + tracker v3 + security enforcement; output-discipline clause + terse console

Council of Experts review system for pair programming workflow.

Submits plans/code to focused expert reviewers using multiple platforms:
  - Codex CLI (account auth, no API key needed) — primary for most roles
  - Google Gemini (API key) — primary for performance/cost/UX roles
  - Anthropic Claude (API key) — consolidator and fallback

Council composition, models, and phase assignments are configured in
council-config.json.

Usage:
    ./scripts/council-review.py plan <sprint> "<title>"
    ./scripts/council-review.py code <sprint> "<title>"

Requires environment variables (depending on council-config.json):
    GOOGLE_API_KEY      — Gemini models
    ANTHROPIC_API_KEY   — Claude models
    (Codex members authenticate via stored credentials — run 'codex login' once)
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

# Source-file extensions considered for code review materials AND
# pre-flight untracked-file detection. Single source of truth.
SOURCE_EXTENSIONS: set[str] = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java",
    ".rb", ".swift", ".kt", ".cs", ".cpp", ".c", ".h",
    ".yml", ".yaml", ".toml", ".json", ".sh", ".html", ".css",
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

QUORUM_THRESHOLD = 3  # Minimum successful council reviews needed

# ---------------------------------------------------------------------------
# Secret Redaction
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9\-_]{20,}", re.IGNORECASE),
    re.compile(r"sk-ant-[A-Za-z0-9\-_]{20,}", re.IGNORECASE),
    re.compile(r"AIza[0-9A-Za-z\-_]{35}"),
    re.compile(r"xox[bprs]-[A-Za-z0-9\-_]{10,}"),
    # Sprint 6 R1 #21: expand coverage to common credential formats.
    # GitHub classic PATs start with ghp_; fine-grained ones use
    # github_pat_; OAuth app tokens use gho_/ghu_/ghs_/ghr_.
    re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{50,}"),
    # AWS access key ID — 20-char alphanumeric prefixed by AKIA/ASIA/AIDA/AGPA/AROA.
    re.compile(r"(?:AKIA|ASIA|AIDA|AGPA|AROA|ANPA|ANVA|AIPA|AIDI)[A-Z0-9]{16}"),
    # AWS secret access key — 40-char base64ish that appears after
    # aws_secret_access_key= or in JSON "SecretAccessKey":"...".
    re.compile(
        r"(?:aws_secret_access_key|secretaccesskey)\s*[=:]\s*['\"]?[A-Za-z0-9+/=]{40}['\"]?",
        re.IGNORECASE,
    ),
    # Compound assignment names: catches FOO_API_KEY=..., SERVICE_SECRET_KEY=...,
    # PROJECT_TOKEN=..., AUTH_TOKEN=..., *_PRIVATE_KEY=..., *_CREDENTIALS=...
    re.compile(
        r"(?:[A-Z0-9_]+_)?"
        r"(?:API[_-]?KEY|API[_-]?TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|"
        r"SECRET[_-]?KEY|SECRET|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|"
        r"CREDENTIALS|CREDENTIAL|TOKEN)"
        r"\s*[=:]\s*['\"]?[A-Za-z0-9\-_\.+/=]{8,}['\"]?",
        re.IGNORECASE,
    ),
    re.compile(r"Bearer\s+[A-Za-z0-9\-_\.+/=]{8,}", re.IGNORECASE),
]


METRICS_SCHEMA_VERSION = 2
METRICS_SCHEMA_KEY = "_schema"
METRICS_SCHEMA_VALUE = "council_metrics"


def _compute_findings_by_lens(findings: list[dict]) -> dict[str, int]:
    """Count findings grouped by lens. Returns a plain dict so it
    serialises cleanly as JSON. Findings with missing/empty lens are
    bucketed under ``unknown`` to match tracker load-time defaults."""
    counts: dict[str, int] = {}
    for f in findings:
        lens = (f.get("lens") or "unknown") or "unknown"
        counts[lens] = counts.get(lens, 0) + 1
    return counts


def _compute_findings_counts(findings: list[dict]) -> tuple[dict[str, int], dict[str, int]]:
    by_sev = {"high": 0, "medium": 0, "low": 0}
    by_status = {
        "ADDRESSED": 0, "WONTFIX": 0, "OPEN": 0,
        "RECURRING": 0, "VERIFIED": 0, "REOPENED": 0,
    }
    for f in findings:
        sev = (f.get("severity") or "").lower()
        if sev in by_sev:
            by_sev[sev] += 1
        st = (f.get("status") or "").upper()
        if st in by_status:
            by_status[st] += 1
    return by_sev, by_status


def _write_metrics_row(out_file: Path, row: dict) -> None:
    """Append a row to the metrics JSONL. Writes the schema sentinel
    as the first line of a new file; appends only data rows thereafter.
    The sentinel row has the shape
    ``{"_schema": "council_metrics", "version": N}`` and is never
    interleaved with data rows."""
    out_file.parent.mkdir(exist_ok=True)
    write_header = not out_file.exists() or out_file.stat().st_size == 0
    with out_file.open("a", encoding="utf-8") as fh:
        if write_header:
            fh.write(json.dumps({
                METRICS_SCHEMA_KEY: METRICS_SCHEMA_VALUE,
                "version": METRICS_SCHEMA_VERSION,
            }) + "\n")
        fh.write(json.dumps(row) + "\n")


def _emit_metrics(
    repo_root: Path,
    sprint: str,
    review_type: str,
    round_num: int,
    *,
    members_active: int,
    members_succeeded: int,
    elapsed_s: float,
    verdict: str | None,
    tracker_file: Path,
    security_bypassed: bool = False,
    prompt_token_estimates: dict | None = None,
) -> None:
    """Append one per-round metrics row. Helpers own the schema math;
    this function is the wiring layer."""
    findings: list[dict] = []
    if tracker_file.exists():
        try:
            findings = _read_tracker(tracker_file)
        except Exception:  # noqa: BLE001
            findings = []
    by_sev, by_status = _compute_findings_counts(findings)
    record = {
        "sprint": sprint,
        "review_type": review_type,
        "round": round_num,
        "members_active": members_active,
        "members_succeeded": members_succeeded,
        "elapsed_seconds": round(elapsed_s, 2),
        "findings_total": len(findings),
        "findings_high": by_sev["high"],
        "findings_medium": by_sev["medium"],
        "findings_low": by_sev["low"],
        "findings_addressed": by_status["ADDRESSED"],
        "findings_wontfix": by_status["WONTFIX"],
        "findings_open": by_status["OPEN"],
        "findings_verified": by_status["VERIFIED"],
        "findings_reopened": by_status["REOPENED"],
        "findings_recurring": by_status["RECURRING"],
        "findings_by_lens": _compute_findings_by_lens(findings),
        "security_bypassed": bool(security_bypassed),
        "tracker_check_skipped": bool(
            prompt_token_estimates.get("tracker_check_skipped", False)
        ),
        "verdict": verdict or "UNKNOWN",
    }
    if prompt_token_estimates:
        record.update(prompt_token_estimates)
    _write_metrics_row(
        repo_root / "council" / f"metrics_Sprint{sprint}.jsonl", record
    )


def redact_secrets(text: str) -> str:
    """Redact common secret patterns from text before sending to external APIs."""
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


# ---------------------------------------------------------------------------
# Environment — source API keys from ~/.zprofile if not already in env
# ---------------------------------------------------------------------------


def ensure_api_keys_from_profile():
    """Source API keys from ~/.zprofile if they're missing from the environment."""
    zprofile = Path.home() / ".zprofile"
    if not zprofile.exists():
        return

    needed = {"GOOGLE_API_KEY", "ANTHROPIC_API_KEY"}
    missing = {k for k in needed if not os.environ.get(k)}
    if not missing:
        return

    try:
        for line in zprofile.read_text().splitlines():
            line = line.strip()
            if not line.startswith("export "):
                continue
            rest = line[len("export "):]
            if "=" not in rest:
                continue
            key, _, value = rest.partition("=")
            key = key.strip()
            value = value.strip()
            # Sprint 6 R1 #22: strip inline comments before stripping
            # quotes, so `FOO=bar  # my api key` doesn't end up as
            # `bar  # my api key`. The simple heuristic is "# preceded
            # by whitespace" — it avoids mangling values that legitimately
            # contain #, like base64 or URL anchors, because those
            # aren't preceded by whitespace.
            if " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            elif "\t#" in value:
                value = value.split("\t#", 1)[0].rstrip()
            value = value.strip('"').strip("'")
            if key in missing and value:
                os.environ[key] = value
                missing.discard(key)
                print(f"  [env] Sourced {key} from ~/.zprofile", file=sys.stderr)
    except Exception as e:
        print(f"  [env] Warning: could not parse ~/.zprofile: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def load_config(config_path: Path) -> dict:
    """Load council configuration from JSON file."""
    if not config_path.exists():
        print(f"ERROR: Config not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    with open(config_path) as f:
        return json.load(f)


def get_active_members(
    config: dict,
    review_type: str,
    *,
    lenses: set[str] | None = None,
) -> list[dict]:
    """Return only council members whose phases include the review type.

    When ``lenses`` is non-None (only valid for code reviews), the
    filter is narrowed to members whose ``role`` is in the set. The
    caller is responsible for validating lens names and for enforcing
    the security-non-removable rule before passing ``lenses`` here.
    """
    members = [
        m for m in config["council"]["members"]
        if review_type in m.get("phases", ["plan", "code"])
    ]
    if lenses is not None:
        members = [m for m in members if m.get("role") in lenses]
    return members


# ---------------------------------------------------------------------------
# Selective routing — Sprint 6
# ---------------------------------------------------------------------------


class LensArgError(Exception):
    """Raised when a --lenses or --auto-lenses invocation is malformed
    or violates the security-non-removable rule."""


def _known_lens_roles(config: dict) -> list[str]:
    return sorted({m["role"] for m in config["council"]["members"]})


def parse_lenses_arg(raw: str, valid_roles: list[str]) -> set[str]:
    """Parse the comma-separated ``--lenses`` value. Rejects degenerate
    inputs (empty string, lone commas, whitespace-only, blank entries,
    duplicates, unknown names) with a specific message per R1 #9.

    Returns the parsed set on success; raises ``LensArgError`` on any
    failure. Callers surface the message to stderr and exit 2.
    """
    stripped = raw.strip()
    if not stripped:
        raise LensArgError("--lenses value is empty")
    if stripped in (",", ",,"):
        raise LensArgError("--lenses value is a lone comma")
    parts = raw.split(",")
    seen: list[str] = []
    for part in parts:
        token = part.strip()
        if not token:
            raise LensArgError(
                f"--lenses contains an empty entry (near {part!r})"
            )
        if token in seen:
            raise LensArgError(
                f"--lenses contains a duplicate entry: {token!r}"
            )
        seen.append(token)
    unknown = [t for t in seen if t not in valid_roles]
    if unknown:
        raise LensArgError(
            f"--lenses contains unknown lens(es) {unknown}. "
            f"Valid lenses: {valid_roles}"
        )
    return set(seen)


def auto_lens_set(changed_paths: list[str], valid_roles: list[str]) -> set[str]:
    """Compute the auto-routed lens set from a list of changed file
    paths. Rules:

    - ``security`` is always included.
    - ``code_quality`` is always included (always-on keeps the lens
      honest against duplication / complexity regressions).
    - ``test_quality`` is included when any path contains a test file
      (paths matching ``tests/``, ``*test*``, or ``*spec*``).
    - ``domain`` is included when any path is under ``knowledge/``.

    Quorum guarantee: if the diff-driven set would fall below
    QUORUM_THRESHOLD, lenses are promoted from the fallback list
    [test_quality, domain] in order until quorum is reached or no
    valid lenses remain. This prevents --auto-lenses from aborting
    when a narrow diff doesn't trigger the optional seats.

    Lenses not present in ``valid_roles`` are dropped silently — the
    council may not have every seat configured.
    """
    lenses = {"security", "code_quality"}
    for path in changed_paths:
        lower = path.lower()
        if "tests/" in lower or "/test" in lower or "spec" in lower:
            lenses.add("test_quality")
        if path.startswith("knowledge/"):
            lenses.add("domain")
    lenses &= set(valid_roles)
    # Ensure auto-lenses never produce a set too small to form quorum
    fallback_promotion = ["test_quality", "domain"]
    for candidate in fallback_promotion:
        if len(lenses) >= QUORUM_THRESHOLD:
            break
        if candidate in valid_roles and candidate not in lenses:
            lenses.add(candidate)
    return lenses


def enforce_security_lens(
    lenses: set[str],
    *,
    allow_no_security: bool,
    review_type: str,
) -> tuple[set[str], bool]:
    """Enforce the security-non-removable rule for code reviews.

    Returns ``(lenses, security_bypassed)``. Raises ``LensArgError``
    when ``security`` is absent and ``allow_no_security`` was not
    passed — the fail-closed default prevents a code review from
    reaching APPROVED with no security reviewer.

    Sprint 6 R1 #17: also rejects any non-empty ``lenses`` for plan
    reviews at the shared-logic layer, not just at the argparse
    layer. Internal callers can no longer silently get partial lens
    selection for plan reviews.
    """
    if review_type not in {"plan", "code"}:
        raise LensArgError(
            f"unknown review_type {review_type!r}; expected "
            "'plan' or 'code'"
        )
    if review_type == "plan":
        if lenses:
            raise LensArgError(
                "plan reviews run every active member; "
                "--lenses is not accepted for plan phase."
            )
        return lenses, False
    if "security" in lenses:
        return lenses, False
    if not allow_no_security:
        raise LensArgError(
            "code reviews require the security lens. Either add "
            "'security' to --lenses or pass --allow-no-security to "
            "explicitly acknowledge the bypass."
        )
    return lenses, True


def validate_api_keys(config: dict, active_members: list[dict]) -> dict[str, str]:
    """Validate API keys required by active members + consolidator."""
    required = set()
    optional = set()
    for member in active_members:
        env = member.get("api_key_env")
        if env:
            required.add(env)
        fallback = member.get("fallback")
        if fallback and fallback.get("api_key_env"):
            optional.add(fallback["api_key_env"])

    consolidator = config["council"]["consolidator"]
    cons_env = consolidator.get("api_key_env")
    if cons_env:
        required.add(cons_env)
    consolidator_fb = consolidator.get("fallback")
    if consolidator_fb and consolidator_fb.get("api_key_env"):
        optional.add(consolidator_fb["api_key_env"])

    keys = {}
    missing = []
    for env_var in sorted(required):
        val = os.environ.get(env_var)
        if val:
            keys[env_var] = val
        else:
            missing.append(env_var)

    if missing:
        print(f"ERROR: Missing required API key(s): {', '.join(missing)}", file=sys.stderr)
        print("Set them in your environment before running council review.", file=sys.stderr)
        sys.exit(1)

    for env_var in sorted(optional - required):
        val = os.environ.get(env_var)
        if val:
            keys[env_var] = val

    return keys


# ---------------------------------------------------------------------------
# API Clients
# ---------------------------------------------------------------------------


def call_google(
    model: str, contents: str,
    max_tokens: int, temperature: float, api_key: str, timeout: float,
) -> str:
    """Call Google GenAI API."""
    from google import genai
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=contents,
        config={"max_output_tokens": max_tokens, "temperature": temperature},
    )
    text = response.text
    if text is None:
        raise RuntimeError("Google API returned empty/blocked response (safety filter or quota exceeded)")
    return text


def call_anthropic(
    model: str, system: str, user_content: str,
    max_tokens: int, temperature: float, api_key: str, timeout: float,
) -> str:
    """Call Anthropic API."""
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system,
        messages=[{"role": "user", "content": user_content}],
    )
    return message.content[0].text


def call_codex(
    system: str, user_content: str, timeout: float,
    review_mode: bool = False,
) -> str:
    """Call Codex CLI using account auth.

    Sprint 5: previously wrote the combined prompt to a NamedTemporaryFile
    that the subprocess never read (the prompt is piped via stdin via
    ``input=``). Removing the tempfile eliminates a dead-code leak path
    — if the write had raised, ``prompt_file`` would have been unbound
    and the ``finally`` unlink would have masked the original error with
    a NameError.
    """
    combined_prompt = f"{system}\n\n---\n\n{user_content}"

    try:
        # Always use 'codex exec --full-auto' — the 'codex review' subcommand
        # in v0.114.0+ no longer accepts positional prompt arguments or stdin.
        cmd = ["codex", "exec", "--full-auto"]
        result = subprocess.run(
            cmd,
            input=combined_prompt,
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError("Codex CLI not found. Install: npm install -g @openai/codex")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Codex timed out after {timeout:.0f}s")

    if result.returncode != 0:
        stderr_first_line = (result.stderr or "").split("\n")[0][:120]
        print(f"  [debug] Codex stderr: {stderr_first_line}", file=sys.stderr)
        raise RuntimeError(f"Codex exited {result.returncode}")
    output = result.stdout.strip()
    if not output:
        raise RuntimeError("Codex produced no output")
    return output


def call_claude_cli(
    system: str, user_content: str, timeout: float, model: str = "sonnet",
) -> str:
    """Call the local `claude` CLI in non-interactive mode (Sprint 127 v6).

    `claude -p "<prompt>"` runs a one-shot Claude Code invocation from the
    current working directory. When cwd is the repo root, the CLI
    auto-loads `.mcp.json` so the reviewer inherits the project's MCP tool
    suite (including `codegraph_*`). Output is captured from
    stdout. The CLI handles auth from the user's existing Claude Code
    session; no API key required.

    `model` selects the Claude model alias (e.g. "sonnet", "opus", "haiku").
    """
    combined_prompt = f"{system}\n\n---\n\n{user_content}"

    # Write prompt to a temp file to avoid shell-quoting issues with long
    # markdown content containing backticks, quotes, dollar signs, etc.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(combined_prompt)
        prompt_file = f.name

    try:
        # Sprint 6 R1 #14: use `plan` mode instead of
        # `bypassPermissions`. Reviewers use read-only MCP tools
        # (codegraph_*) but must NOT edit the repo. `plan` permits
        # tool use for queries while blocking writes, matching the
        # reviewer's read-only role. Repository content enters the
        # prompt via the stdin-piped `combined_prompt`, which is
        # treated as reference material, not instructions.
        cmd = ["claude", "-p", "--model", model, "--permission-mode", "plan"]
        with open(prompt_file, "r") as inp:
            result = subprocess.run(
                cmd,
                stdin=inp,
                capture_output=True, text=True, timeout=timeout,
            )
    except FileNotFoundError:
        raise RuntimeError(
            "claude CLI not found. Install from https://claude.ai/download"
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"claude CLI timed out after {timeout:.0f}s")
    finally:
        try:
            os.unlink(prompt_file)
        except OSError:
            pass

    if result.returncode != 0:
        stderr_first_line = (result.stderr or "").split("\n")[0][:200]
        print(f"  [debug] claude stderr: {stderr_first_line}", file=sys.stderr)
        raise RuntimeError(f"claude CLI exited {result.returncode}")
    output = result.stdout.strip()
    if not output:
        raise RuntimeError("claude CLI produced no output")
    return output


def call_model(
    platform: str, model: str, system: str, user_content: str,
    max_tokens: int, temperature: float, api_key: str, timeout: float,
    review_mode: bool = False,
) -> str:
    """Dispatch to the appropriate platform API."""
    if platform == "google":
        combined = f"{system}\n\n---\n\n{user_content}"
        return call_google(model, combined, max_tokens, temperature, api_key, timeout)
    elif platform == "anthropic":
        return call_anthropic(model, system, user_content, max_tokens, temperature, api_key, timeout)
    elif platform == "codex":
        return call_codex(system, user_content, timeout, review_mode=review_mode)
    elif platform == "claude_cli":
        return call_claude_cli(system, user_content, timeout, model=model)
    else:
        raise ValueError(f"Unknown platform: {platform}")


# ---------------------------------------------------------------------------
# Material Gathering
# ---------------------------------------------------------------------------


def read_file_safe(path: Path, max_lines: int = 500) -> str:
    """Read a file, truncating if too long."""
    if not path.exists():
        return f"[File not found: {path}]"
    try:
        lines = path.read_text().splitlines()
        if len(lines) > max_lines:
            return "\n".join(lines[:max_lines]) + f"\n\n[... truncated, {len(lines)} total lines]"
        return "\n".join(lines)
    except Exception as e:
        return f"[Error reading {path}: {e}]"


def get_changed_files(sprint: str | None = None, repo_root: Path | None = None) -> list[str]:
    """Get list of changed files for code review."""
    cwd = str(repo_root) if repo_root else None

    # Strategy 1: Sprint-aware diff from recorded base commit
    if sprint and repo_root:
        base_file = repo_root / f".sprint-base-commit-{sprint}"
        if base_file.exists():
            base_sha = base_file.read_text().strip()
            result = subprocess.run(
                ["git", "diff", "--name-only", f"{base_sha}..HEAD"],
                capture_output=True, text=True, cwd=cwd,
            )
            if result.returncode == 0 and result.stdout.strip():
                files = [f for f in result.stdout.strip().split("\n") if f]
                if files:
                    return files

    # Strategy 2: Uncommitted changes
    result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        capture_output=True, text=True, cwd=cwd,
    )
    if result.stdout.strip():
        files = [f for f in result.stdout.strip().split("\n") if f]
        if files:
            return files

    # Strategy 3: Recent commits
    result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD~10..HEAD"],
        capture_output=True, text=True, cwd=cwd,
    )
    if result.stdout.strip():
        files = [f for f in result.stdout.strip().split("\n") if f]
        if files:
            return files

    # Strategy 4: Parse plan file for expected files
    if sprint and repo_root:
        plan_file = repo_root / f"PLAN_Sprint{sprint}.md"
        if plan_file.exists():
            files = _parse_plan_file_list(plan_file)
            if files:
                return files

    return []


def _parse_plan_file_list(plan_file: Path) -> list[str]:
    """Extract file paths from the 'Files to Create/Modify' table in a PLAN file."""
    in_table = False
    files = []
    for line in plan_file.read_text().splitlines():
        if "Files to Create/Modify" in line or "Files Changed" in line:
            in_table = True
            continue
        if in_table:
            if line.startswith("|") and "`" in line:
                parts = line.split("`")
                if len(parts) >= 2:
                    path = parts[1].strip()
                    if path and not path.startswith("--"):
                        files.append(path)
            elif line.strip() == "" or line.startswith("#"):
                in_table = False
    return files


def gather_plan_materials(sprint: str, repo_root: Path) -> str:
    """Gather materials for a plan review."""
    sections = []

    plan_file = repo_root / f"PLAN_Sprint{sprint}.md"
    if plan_file.exists():
        content = read_file_safe(plan_file, max_lines=1000)
        sections.append(f"### {plan_file.name} (PRIMARY — this is what you are reviewing)\n```\n{content}\n```")
    else:
        print(f"ERROR: Plan file not found: {plan_file}", file=sys.stderr)
        sys.exit(1)

    changes_file = repo_root / "CHANGES.md"
    if changes_file.exists():
        content = read_file_safe(changes_file, max_lines=200)
        sections.append(f"### CHANGES.md (project history)\n```\n{content}\n```")

    history_file = repo_root / "Documentation" / "PLAN_history.md"
    if history_file.exists():
        content = read_file_safe(history_file, max_lines=300)
        sections.append(f"### Documentation/PLAN_history.md (prior decisions, truncated)\n```\n{content}\n```")

    # --- Codebase structure context for files mentioned in the plan ---
    plan_files = _parse_plan_file_list(plan_file)
    if plan_files:
        # Only include files that already exist (Modify, not Create)
        existing_files = [f for f in plan_files if (repo_root / f).exists()]
        if existing_files:
            codegraph_context = _generate_codegraph_context(existing_files, repo_root)
            if codegraph_context:
                sections.append(codegraph_context)

    return "\n\n".join(sections)


def _generate_codegraph_context(source_files: list[str], repo_root: Path) -> str | None:
    """Generate codebase structure context by querying the codegraph DB directly.

    Mirrors the logic of the MCP codegraph_context_for tool — symbols, endpoints,
    and file header (purpose/role) per changed file. Avoids the subprocess overhead
    and schema-guessing of the old --context-for bash path, and returns structured
    output for all indexed file types including JS/TS.

    Returns a markdown section, or None if the DB doesn't exist or no files match.
    """
    import sqlite3 as _sqlite3

    db_path = repo_root / ".claude" / "codebase.db"
    if not db_path.exists() or not source_files:
        return None

    try:
        conn = _sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = _sqlite3.Row
        sections: list[str] = []
        indexed = 0
        try:
            for path in source_files:
                file_row = conn.execute(
                    "SELECT id, path, module, lines FROM files WHERE path = ?",
                    (path,),
                ).fetchone()
                if file_row is None:
                    continue
                indexed += 1
                file_id = file_row["id"]
                lines: list[str] = [f"**{path}** ({file_row['lines']} lines)"]
                hdr = conn.execute(
                    "SELECT purpose, role FROM file_headers WHERE file_id = ?",
                    (file_id,),
                ).fetchone()
                if hdr and hdr["purpose"]:
                    lines.append(f"  Purpose: {hdr['purpose']}")
                if hdr and hdr["role"]:
                    lines.append(f"  Role: {hdr['role']}")
                sym_rows = conn.execute(
                    "SELECT name, kind, line FROM symbols WHERE file_id = ? "
                    "ORDER BY line LIMIT 50",
                    (file_id,),
                ).fetchall()
                if sym_rows:
                    sym_parts = ", ".join(
                        f"{r['name']} ({r['kind']}:{r['line']})" for r in sym_rows
                    )
                    lines.append(f"  Symbols: {sym_parts}")
                ep_rows = conn.execute(
                    "SELECT method, path AS ep_path, handler FROM endpoints "
                    "WHERE file_id = ? ORDER BY method, ep_path",
                    (file_id,),
                ).fetchall()
                if ep_rows:
                    ep_parts = ", ".join(
                        f"{r['method']} {r['ep_path']}" for r in ep_rows
                    )
                    lines.append(f"  Endpoints: {ep_parts}")
                sections.append("\n".join(lines))
        finally:
            conn.close()

        if not sections:
            return None
        header = (
            f"## Codebase Structure Context ({indexed}/{len(source_files)} files indexed)\n"
        )
        return header + "\n\n".join(sections)
    except Exception:
        return None


def _filename_is_safe(rel: str) -> bool:
    """Reject filenames with control characters that would enable
    prompt-injection or newline-tokenisation bugs in review materials."""
    if "\x00" in rel or "\n" in rel or "\r" in rel:
        return False
    return all(ord(c) >= 0x20 and ord(c) != 0x7f for c in rel)


def find_untracked_source_files(repo_root: Path) -> list[str]:
    """Return untracked source files (suffix in SOURCE_EXTENSIONS).

    Filenames containing control characters are dropped with a stderr
    warning. Returns repo-relative paths sorted deterministically.
    Non-git directories return an empty list.
    """
    try:
        result = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            capture_output=True, text=True, cwd=str(repo_root),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    out: list[str] = []
    for f in result.stdout.split("\n"):
        f = f.strip()
        if not f:
            continue
        if not _filename_is_safe(f):
            print(f"preflight: refusing unsafe filename {f!r}", file=sys.stderr)
            continue
        if Path(f).suffix in SOURCE_EXTENSIONS:
            out.append(f)
    return sorted(out)


@dataclass(frozen=True)
class PreflightResult:
    """Outcome of the code-review pre-flight check.

    Field invariants:
      - When `ok` is False, `banner` is empty and `reject_message` is
        non-empty (printed to stderr by main(), exit 4).
      - When `ok` is True and untracked files exist (allow_untracked),
        `banner` is non-empty (injected as the first section of
        review materials) and `reject_message` is empty.
      - On a clean tree, `ok=True` with both `banner` and
        `reject_message` empty.
    """
    ok: bool
    banner: str
    reject_message: str


def preflight_code_review(
    repo_root: Path, allow_untracked: bool
) -> PreflightResult:
    """Detect untracked source files and decide whether to proceed.

    Side-effect-free (except for the sanitiser warning inside
    find_untracked_source_files). main() is responsible for printing
    reject_message and setting exit code 4 on ok=False.
    """
    untracked = find_untracked_source_files(repo_root)
    if not untracked:
        return PreflightResult(ok=True, banner="", reject_message="")
    if not allow_untracked:
        lines = [
            f"Error: {len(untracked)} untracked source file(s) will not appear in review materials:",
            *(f"  {i + 1}. {shlex.quote(f)}" for i, f in enumerate(untracked)),
            "",
            "Commit them before running code review (they'll diff against",
            ".sprint-base-commit-<N>):",
            "  git add <files> && git commit -m 'Sprint N: <summary>'",
            "",
            "Override with --allow-untracked (not recommended for final review).",
        ]
        return PreflightResult(
            ok=False, banner="", reject_message="\n".join(lines),
        )
    banner_lines = [
        "=== PRE-FLIGHT BANNER ===",
        f"⚠ Review includes {len(untracked)} uncommitted source file(s):",
        *(f"  - {shlex.quote(f)}" for f in untracked),
        "=== END BANNER ===",
    ]
    return PreflightResult(
        ok=True, banner="\n".join(banner_lines), reject_message="",
    )


def _get_sprint_base_sha(sprint: str, repo_root: Path) -> str | None:
    """Return the sprint base commit SHA, or None if not recorded."""
    base_file = repo_root / f".sprint-base-commit-{sprint}"
    if base_file.exists():
        sha = base_file.read_text().strip()
        return sha if sha else None
    return None


def _file_header_block(full_path: Path, max_lines: int = 20) -> str:
    """Return the leading comment/header block of a source file (up to max_lines)."""
    try:
        lines = full_path.read_text(errors="replace").splitlines()
    except Exception:
        return ""
    header: list[str] = []
    for line in lines[:max_lines]:
        if not line.strip() and len(header) >= 3:
            break
        header.append(line)
    return "\n".join(header)


def _render_source_file(path: str, repo_root: Path, sprint: str | None = None) -> str:
    """Render one source file for reviewers.

    When a sprint base commit is available, emit the file header block plus
    a git diff of only the changed lines (with 8 lines of context). This
    replaces full-file content and cuts source-file token cost by ~70%.

    Falls back to full content (up to 200 lines) for new files or when no
    sprint base is recorded.
    """
    full_path = repo_root / path
    ext = Path(path).suffix.lstrip(".")

    if sprint:
        base_sha = _get_sprint_base_sha(sprint, repo_root)
        if base_sha:
            diff_result = subprocess.run(
                ["git", "diff", "-U8", f"{base_sha}..HEAD", "--", path],
                capture_output=True, text=True,
                cwd=str(repo_root),
            )
            if diff_result.returncode == 0 and diff_result.stdout.strip():
                header = _file_header_block(full_path)
                header_section = f"```{ext}\n{header}\n```\n" if header else ""
                diff_lines = diff_result.stdout.strip().splitlines()
                if len(diff_lines) > 300:
                    diff_lines = diff_lines[:300]
                    diff_lines.append("... [diff truncated at 300 lines]")
                diff_text = "\n".join(diff_lines)
                return f"### {path}\n{header_section}```diff\n{diff_text}\n```"

    # Fallback: full content (new file or no sprint base)
    content = read_file_safe(full_path, max_lines=200)
    return f"### {path}\n```{ext}\n{content}\n```"


def gather_code_materials(
    sprint: str, repo_root: Path,
    banner: str = "",
    include_untracked: bool = False,
) -> str:
    """Gather materials for a code review.

    When ``banner`` is non-empty it is prepended as the first section
    (clearly delimited). When ``include_untracked`` is True, untracked
    source files are appended to the tracked file list and rendered
    the same way.
    """
    sections = []
    if banner:
        sections.append(banner)

    plan_file = repo_root / f"PLAN_Sprint{sprint}.md"
    if plan_file.exists():
        content = read_file_safe(plan_file, max_lines=350)
        sections.append(f"### {plan_file.name} (approved plan)\n```\n{content}\n```")

    changes_file = repo_root / "CHANGES.md"
    if changes_file.exists():
        content = read_file_safe(changes_file, max_lines=200)
        sections.append(f"### CHANGES.md\n```\n{content}\n```")

    changed_files = get_changed_files(sprint=sprint, repo_root=repo_root)
    source_files = [
        f for f in changed_files
        if Path(f).suffix in SOURCE_EXTENSIONS
        and not f.startswith("Documentation/")
        and "PLAN_" not in f
        and "REVIEW_" not in f
    ]

    if include_untracked:
        # Recompute here is intentional: gather_code_materials is a
        # leaf-callable (tested independently of preflight_code_review).
        # The cost is a single `git ls-files` call; negligible.
        untracked = find_untracked_source_files(repo_root)
        for f in untracked:
            if f not in source_files:
                source_files.append(f)

    for f in source_files[:15]:
        sections.append(_render_source_file(f, repo_root, sprint=sprint))

    # Compute the insertion anchor so the banner (if any) stays first.
    anchor = 1 if banner else 0

    if changed_files:
        file_list = "\n".join(f"- {f}" for f in changed_files)
        sections.insert(anchor, f"### Changed Files\n{file_list}")
        anchor += 1

    # --- Codebase structure context from the semantic index ---
    codegraph_context = _generate_codegraph_context(source_files, repo_root)
    if codegraph_context:
        sections.insert(anchor, codegraph_context)

    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Prompt Construction
# ---------------------------------------------------------------------------


def _round_context(round_num: int) -> str:
    if round_num == 1:
        return "This is the first review of this plan."
    return (
        f"This is round {round_num}. The artifact has been revised to address "
        f"findings from previous rounds.\n\n"
        f"FOCUS on:\n"
        f"1. Whether previous findings have been adequately addressed\n"
        f"2. Any genuinely NEW issues introduced by the revisions\n\n"
        f"Do NOT re-raise findings that have been marked ADDRESSED in the tracker "
        f"unless the fix is demonstrably incomplete. Do NOT introduce novel concerns "
        f"about previously-reviewed sections that haven't changed."
    )


def _compact_tracker_content(tracker_content: str) -> str:
    """Compact a verbose markdown tracker for AI consumption.

    OPEN/REOPENED findings keep full description (reviewers must act on them).
    Resolved findings (ADDRESSED/WONTFIX/VERIFIED/RECURRING) shrink to a
    single line — reviewers only need the tag + status + resolution to avoid
    re-flagging, not the original description.

    Falls back to the raw text if the table cannot be parsed (e.g. empty
    or malformed), so callers need no error handling.
    """
    if not tracker_content:
        return tracker_content
    findings: list[dict] = []
    in_table = False
    header_cols: list[str] = []
    for line in tracker_content.splitlines():
        if line.startswith("| #"):
            in_table = True
            header_cols = [c.strip().lower() for c in line.split("|")[1:-1]]
            continue
        if in_table and line.startswith("|---"):
            continue
        if in_table and line.startswith("|"):
            parts = [p.strip() for p in line.split("|")[1:-1]]
            if len(parts) >= 6:
                col = {
                    name: (parts[i] if i < len(parts) else "")
                    for i, name in enumerate(header_cols)
                }
                findings.append({
                    "id": parts[0],
                    "round": parts[1],
                    "severity": col.get("severity", ""),
                    "lens": col.get("lens", "unknown"),
                    "tag": col.get("tag", "untagged"),
                    "description": col.get("finding", ""),
                    "status": col.get("status", "OPEN"),
                    "resolution": col.get("resolution", ""),
                })
        elif in_table and not line.startswith("|"):
            in_table = False
    if not findings:
        return tracker_content
    actionable = [f for f in findings if f["status"] in ("OPEN", "REOPENED")]
    resolved = [f for f in findings if f["status"] not in ("OPEN", "REOPENED")]
    lines: list[str] = []
    if actionable:
        lines.append("Open findings (require action):")
        for f in actionable:
            reopen = " [Reopened]" if f["status"] == "REOPENED" else ""
            lines.append(
                f"  #{f['id']} {f['round']} {f['severity']} {f['lens']}"
                f" {f['tag']}{reopen}: {f['description']}"
            )
    if resolved:
        lines.append("Resolved — do not re-flag unless new evidence:")
        for f in resolved:
            res = f": {f['resolution']}" if f["resolution"] else ""
            lines.append(
                f"  #{f['id']} {f['round']} {f['severity']} {f['lens']}"
                f" {f['tag']} → {f['status']}{res}"
            )
    return "\n".join(lines)


def _tracker_section(tracker_content: str | None, round_num: int) -> str:
    if not tracker_content or round_num <= 1:
        return ""
    compact = _compact_tracker_content(tracker_content)
    return f"""

## Prior Findings Tracker (MUST READ)

Do NOT re-flag ADDRESSED, WONTFIX, or RECURRING items unless you have specific
new evidence the prior resolution is wrong.

{compact}
"""


def _output_discipline_clause(role: str) -> str:
    """Sprint 6 R2 #24: extracted so build_council_prompt stays under
    the 60-line guideline. Security reviews get a higher advisory
    budget to accommodate MCP-query evidence text."""
    if role == "security":
        advisory = 2500
        note = (
            " Security reviews commonly cite MCP query results; the "
            "higher budget accommodates evidence text."
        )
    else:
        advisory = 1500
        note = ""
    return f"""## Output discipline

- Short declarative sentences. No hedging ("perhaps", "might
  consider", "it would be advisable").
- Do not restate findings in any assessment or summary section —
  the Findings block is authoritative.
- No motivational framing ("great work!", "overall, this is
  solid"). Findings-only.
- Advisory budget: aim for ≤ {advisory} tokens.{note}
  If you exceed the budget, emit a final line
  `[TRUNCATED: N findings omitted]` so the consolidator can flag
  the gap to the human. **Never silently drop findings.**"""


def _council_output_format(role: str, label: str, sprint: str, round_num: int, review_type_label: str) -> str:
    return f"""## Output Format

Write your review in EXACTLY this structure:

### {role} Review: Sprint {sprint} (R{round_num})

**Scope:** {label}

#### Findings
List findings ONLY within your area of focus. For each finding, include the file path and location:
- **[High]** description (File: `path/to/file`, Location: function_name or line range)
  - Current: what exists now
  - Fix: specific action to take
- **[Medium]** description (File: `path/to/file`, Location: function_name or line range)
  - Current: what exists now
  - Fix: specific action to take
- **[Low]** description (File: `path/to/file` if applicable)

If you find NO issues in your area, write: "No findings in this area."

#### Assessment
A 2-3 sentence overall assessment of the {review_type_label} from your expert perspective.

IMPORTANT:
- Stay strictly within your area of expertise
- Do NOT comment on areas outside your lens
- Be specific: cite file paths, line numbers (for code), or section names (for plans)
- For each finding, explain WHAT is wrong AND HOW to fix it
- Be EXHAUSTIVE in Round 1: list ALL concerns you can identify in a single pass. The goal is zero new findings from your area in R2+.
- In Round 2+: do NOT re-flag ADDRESSED or RECURRING items from the tracker"""


def build_council_prompt(
    member: dict, materials: str,
    sprint: str, title: str, round_num: int, review_type: str,
    tracker_content: str | None = None,
) -> tuple[str, str]:
    """Build system + user prompts for a council member. Returns (system, user).

    Sprint 6 R2 #24: split into helpers (_round_context, _tracker_section,
    _output_discipline_clause, _council_output_format) so this function
    stays under the 60-line complexity guideline.
    """
    role = member["role"]
    label = member["label"]
    lens = member["lens"]
    review_type_label = "plan" if review_type == "plan" else "code implementation"

    system_prompt = f"""You are {label} on a review council for a pair programming workflow.

## Your Review Lens
{lens}

{_output_discipline_clause(role)}"""

    user_prompt = f"""## Review Type
This is a {review_type_label} review for Sprint {sprint}: {title} (Round {round_num}).
{_round_context(round_num)}
{_tracker_section(tracker_content, round_num)}
## Materials Under Review
{materials}

{_council_output_format(role, label, sprint, round_num, review_type_label)}"""

    return system_prompt, user_prompt


def build_consolidator_prompt(
    council_reviews: dict[str, str],
    sprint: str, title: str, round_num: int, review_type: str,
    member_labels: dict[str, str],
    tracker_content: str | None = None,
    escalation_note: str | None = None,
) -> tuple[str, str]:
    """Build system + user prompts for the consolidator."""
    review_type_cap = "Plan" if review_type == "plan" else "Code"

    review_sections = []
    for role, review_text in council_reviews.items():
        label = member_labels.get(role, role.title())
        review_sections.append(f"### {label}\n{review_text}")
    all_reviews = "\n\n---\n\n".join(review_sections)

    successful_count = sum(1 for r in council_reviews.values() if "UNAVAILABLE" not in r)
    assessment_sections = _consolidator_assessment_sections(review_type)
    tracker_section = _consolidator_tracker_section(tracker_content, round_num)
    escalation_section = f"\n{escalation_note}\n" if escalation_note else ""

    system_prompt = _CONSOLIDATOR_SYSTEM_PROMPT
    user_prompt = _consolidator_user_prompt(
        all_reviews=all_reviews,
        tracker_section=tracker_section,
        escalation_section=escalation_section,
        review_type=review_type,
        review_type_cap=review_type_cap,
        sprint=sprint,
        title=title,
        round_num=round_num,
        successful_count=successful_count,
        assessment_sections=assessment_sections,
    )
    return system_prompt, user_prompt


_CONSOLIDATOR_SYSTEM_PROMPT = """You are the Consolidation Lead for a review council. Multiple domain experts have independently reviewed a plan or implementation. Your job is to synthesise their findings into a single, coherent review with one verdict.

## Output discipline

- Short declarative sentences. No hedging ("perhaps", "might
  consider", "it would be advisable").
- Do not restate findings in any assessment or summary section —
  the Findings block is authoritative.
- No motivational framing ("great work!", "overall, this is
  solid"). Findings-only.
- Advisory budget: aim for ≤ 3000 tokens for the consolidated review.
  If you exceed the budget, emit a final line
  `[TRUNCATED: N findings omitted]` so the human editor sees the gap.
  **Never silently drop findings.**"""


def _consolidator_assessment_sections(review_type: str) -> str:
    if review_type == "plan":
        return """### Design Assessment
[Synthesised evaluation of the proposed approach]

### Completeness
[Does the plan cover all deliverables and edge cases?]"""
    return """### Implementation Assessment
[Does the code correctly implement the approved plan?]

### Code Quality
[Synthesised assessment of clarity, documentation, error handling]

### Test Coverage
[Synthesised assessment of test adequacy]"""


def _consolidator_tracker_section(tracker_content: str | None, round_num: int) -> str:
    if not tracker_content or round_num <= 1:
        return ""
    compact = _compact_tracker_content(tracker_content)
    return f"""

## Prior Findings Tracker
Do NOT re-flag ADDRESSED/WONTFIX/RECURRING items unless the fix is demonstrably incomplete.

{compact}
"""


def _consolidator_user_prompt(
    *, all_reviews: str, tracker_section: str, escalation_section: str,
    review_type: str, review_type_cap: str, sprint: str, title: str,
    round_num: int, successful_count: int, assessment_sections: str,
) -> str:
    """Sprint 6 R2 #26: extracted from build_consolidator_prompt so
    the public function stays under the 60-line complexity guideline."""
    verdict_options = (
        "APPROVED | CHANGES_REQUESTED | PLAN_REVISION_REQUIRED"
        if review_type == "code"
        else "APPROVED | CHANGES_REQUESTED"
    )
    plan_revision_section = (
        "### Plan Revisions (if PLAN_REVISION_REQUIRED)\n"
        "[What needs to change in the plan]\n"
        if review_type == "code"
        else ""
    )
    return f"""## Council Reviews

{all_reviews}
{tracker_section}{escalation_section}
## Consolidation Instructions

1. **Identify overlapping concerns**: Merge findings on the same underlying issue across experts.
2. **Resolve conflicts**: If experts disagree, use judgement to determine which concern dominates.
3. **Filter false positives**: Exclude speculative or out-of-lens findings.
4. **Assign final severity**:
   - [High]: Would cause a bug, security vulnerability, data loss, or spec violation. Blocks approval.
   - [Medium]: Would cause maintainability, performance, or usability problems.
   - [Low]: Improvement suggestion. Optional.
5. **Determine verdict**:
   - APPROVED: Zero [High] findings AND overall design/implementation is sound
   - CHANGES_REQUESTED: One or more [High] findings, OR three or more [Medium] in same area
   - PLAN_REVISION_REQUIRED (code reviews only): Fundamental design flaw discovered during implementation

## Output Format

## {review_type_cap} Review: Sprint {sprint} - {title} (R{round_num})

**Round:** {round_num}
**Verdict:** {verdict_options}
**Review Method:** Council of Experts ({successful_count} reviewers + consolidator)

{assessment_sections}

### Findings
- **[High]** description (File: `path/to/file`, Location: function_name) (Source: expert_name)
- **[Medium]** description (Source: expert_name)
- **[Low]** description (Source: expert_name)

### Excluded Findings
- description — Reason: why excluded (Source: expert_name)
[If none, write "No findings excluded."]

### Required Changes (if CHANGES_REQUESTED)
For each required change:
1. **File**: exact file path
   **Location**: function/class name or line range
   **Current behavior**: what exists now
   **Required change**: exactly what must change
   **Acceptance criteria**: how to verify the fix

{plan_revision_section}### Recommendations
[Consolidated optional improvements]

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| ... | ... | ... |"""


# ---------------------------------------------------------------------------
# Council Execution
# ---------------------------------------------------------------------------

_codex_call_index = 0
_codex_call_lock = None


def _call_member(
    platform: str, model: str, api_key_env: str,
    system_prompt: str, user_prompt: str,
    max_tokens: int, temperature: float,
    api_keys: dict, timeout: float,
    review_mode: bool = False,
) -> str:
    """Make a single API call for a council member."""
    api_key = None if platform == "codex" else api_keys.get(api_key_env, "")
    return call_model(
        platform=platform,
        model=model,
        system=system_prompt,
        user_content=user_prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        api_key=api_key,
        timeout=timeout,
        review_mode=review_mode,
    )


def run_council_member(
    member: dict, materials: str, api_keys: dict,
    sprint: str, title: str, round_num: int, review_type: str,
    timeout: float,
    codex_stagger: float = 0,
    retry_delay: float = 5,
    tracker_content: str | None = None,
) -> tuple[str, str, float]:
    """Run a single council member with retry + fallback. Returns (role, review_text, elapsed_seconds)."""
    global _codex_call_index, _codex_call_lock

    role = member["role"]
    start = time.monotonic()

    system_prompt, user_prompt = build_council_prompt(
        member, materials, sprint, title, round_num, review_type,
        tracker_content=tracker_content,
    )

    review_mode = (review_type == "code")

    if member["platform"] == "codex" and codex_stagger > 0 and _codex_call_lock:
        import threading
        with _codex_call_lock:
            idx = _codex_call_index
            _codex_call_index += 1
        delay = idx * codex_stagger
        if delay > 0:
            print(f"    {member['label']:25s} stagger {delay:.0f}s...", file=sys.stderr)
            time.sleep(delay)

    primary_err = None
    for attempt in range(2):
        try:
            review = _call_member(
                member["platform"], member["model"], member["api_key_env"],
                system_prompt, user_prompt,
                member["max_tokens"], member["temperature"],
                api_keys, timeout,
                review_mode=review_mode,
            )
            elapsed = time.monotonic() - start
            return role, review, elapsed, {}
        except Exception as err:
            primary_err = err
            primary_type = type(err).__name__
            if attempt == 0:
                print(
                    f"  [debug] {member['label']} attempt 1 failed "
                    f"({primary_type}): {err}, retrying in {retry_delay}s...",
                    file=sys.stderr,
                )
                time.sleep(retry_delay)
            else:
                print(f"  [debug] {member['label']} attempt 2 failed ({primary_type}): {err}", file=sys.stderr)

    fallback = member.get("fallback")
    fb_key_env = fallback.get("api_key_env") if fallback else None
    fb_available = fallback and (fallback.get("platform") == "codex" or fb_key_env in api_keys)
    primary_type = type(primary_err).__name__
    primary_msg = str(primary_err)

    if fb_available:
        fb_platform = fallback["platform"]
        fb_model = fallback["model"]
        print(
            f"  WARNING: {member['label']} primary failed ({member['platform']}/{member['model']}), "
            f"trying fallback ({fb_platform}/{fb_model})...",
            file=sys.stderr,
        )
        try:
            review = _call_member(
                fb_platform, fb_model, fallback.get("api_key_env"),
                system_prompt, user_prompt,
                member["max_tokens"], member["temperature"],
                api_keys, timeout,
                review_mode=review_mode,
            )
            elapsed = time.monotonic() - start
            # Succeeded via fallback — surface the primary error in the return
            # so member_stats can record that a retry/fallback was needed.
            return role, review, elapsed, {"retried": True, "error": f"{primary_type}: {primary_msg}"}
        except Exception as fb_err:
            fb_type = type(fb_err).__name__
            print(f"  [debug] {member['label']} fallback error: {fb_type}: {fb_err}", file=sys.stderr)
            opaque_msg = f"{primary_type}: {primary_msg} (primary) / {fb_type}: {fb_err} (fallback)"
    else:
        opaque_msg = f"{primary_type}: {primary_msg}"

    elapsed = time.monotonic() - start
    placeholder = (
        f"### {role} Review: Sprint {sprint} (R{round_num})\n\n"
        f"**Status:** UNAVAILABLE\n"
        f"**Error:** ({opaque_msg})\n\n"
        f"This expert was unable to complete their review."
    )
    return role, placeholder, elapsed, {"retried": True, "error": opaque_msg, "unavailable": True}


def run_consolidator(
    config: dict, council_reviews: dict[str, str],
    member_labels: dict[str, str],
    sprint: str, title: str, round_num: int, review_type: str,
    api_keys: dict,
    tracker_content: str | None = None,
    escalation_note: str | None = None,
) -> str:
    """Run the consolidator to produce the final unified review."""
    consolidator = config["council"]["consolidator"]
    timeout = config["council"].get("consolidator_timeout_seconds", 180)
    retry_delay = config["council"].get("retry_delay_seconds", 5)

    system_prompt, user_prompt = build_consolidator_prompt(
        council_reviews, sprint, title, round_num, review_type, member_labels,
        tracker_content=tracker_content,
        escalation_note=escalation_note,
    )

    primary_err = None
    platform = consolidator["platform"]
    api_key_env = consolidator.get("api_key_env")
    api_key = None if platform == "codex" else api_keys.get(api_key_env, "")

    for attempt in range(2):
        try:
            return call_model(
                platform=platform,
                model=consolidator["model"],
                system=system_prompt,
                user_content=user_prompt,
                max_tokens=consolidator["max_tokens"],
                temperature=consolidator["temperature"],
                api_key=api_key,
                timeout=timeout,
            )
        except Exception as err:
            primary_err = err
            if attempt == 0:
                print(f"  [debug] Consolidator attempt 1 failed ({type(err).__name__}), retrying...", file=sys.stderr)
                time.sleep(retry_delay)
            else:
                print(f"  [debug] Consolidator attempt 2 failed: {err}", file=sys.stderr)

    fallback = consolidator.get("fallback")
    fb_key_env = fallback.get("api_key_env") if fallback else None
    fb_available = fallback and (fallback.get("platform") == "codex" or fb_key_env in api_keys)
    if fb_available:
        fb_platform = fallback["platform"]
        fb_model = fallback["model"]
        fb_api_key = None if fb_platform == "codex" else api_keys.get(fb_key_env, "")
        try:
            return call_model(
                platform=fb_platform, model=fb_model,
                system=system_prompt, user_content=user_prompt,
                max_tokens=consolidator["max_tokens"], temperature=consolidator["temperature"],
                api_key=fb_api_key, timeout=timeout,
            )
        except Exception as fb_err:
            print(f"  [debug] Consolidator fallback error: {type(fb_err).__name__}: {fb_err}", file=sys.stderr)

    print(f"  WARNING: Consolidator failed — using fallback consolidation", file=sys.stderr)
    return fallback_consolidation(council_reviews, sprint, title, round_num, review_type)


def fallback_consolidation(
    council_reviews: dict[str, str],
    sprint: str, title: str, round_num: int, review_type: str,
) -> str:
    """Produce a synthetic review from raw council outputs when consolidator fails."""
    review_type_cap = "Plan" if review_type == "plan" else "Code"
    has_high = any("[High]" in r for r in council_reviews.values())
    verdict = "CHANGES_REQUESTED" if has_high else "APPROVED"
    successful_count = sum(1 for r in council_reviews.values() if "UNAVAILABLE" not in r)
    all_reviews = "\n\n---\n\n".join(
        f"### {role.title()}\n{text}" for role, text in council_reviews.items()
    )
    return f"""## {review_type_cap} Review: Sprint {sprint} - {title} (R{round_num})

**Round:** {round_num}
**Verdict:** {verdict}
**Review Method:** Council of Experts ({successful_count} reviewers, consolidator FAILED — raw reviews below)

> Note: The consolidator was unable to synthesise these reviews. The verdict is a mechanical
> determination: CHANGES_REQUESTED if any [High] finding exists, else APPROVED.

{all_reviews}
"""


# ---------------------------------------------------------------------------
# Round Tracking
# ---------------------------------------------------------------------------


def increment_round(sprint: str, review_type: str, repo_root: Path) -> int:
    """Increment and return the review round number."""
    round_file = repo_root / f".review-round-sprint{sprint}-{review_type}"
    round_num = int(round_file.read_text().strip()) if round_file.exists() else 0
    round_num += 1
    round_file.write_text(str(round_num))

    if review_type == "plan" and round_num == 1:
        base_file = repo_root / f".sprint-base-commit-{sprint}"
        if not base_file.exists():
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                base_file.write_text(result.stdout.strip())

    return round_num


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def extract_verdict(review_text: str) -> str:
    """Extract the verdict line from review text."""
    for line in review_text.splitlines():
        if "**Verdict:**" in line:
            return line.strip()
    return ""


# ---------------------------------------------------------------------------
# Findings Tracker
# ---------------------------------------------------------------------------


# Canonical mapping from reviewer source labels to lens enum.
# Sourced from council-config.json member roles. Unknown -> "unknown".
LENS_MAP: dict[str, str] = {
    "security": "security",
    "security expert": "security",
    "code_quality": "code_quality",
    "code quality": "code_quality",
    "code quality expert": "code_quality",
    "test_quality": "test_quality",
    "test quality": "test_quality",
    "test quality expert": "test_quality",
    "domain": "domain",
    "domain expert": "domain",
}

import unicodedata as _unicodedata

_TAG_STOPWORDS = {"the", "a", "an", "of", "in", "on", "for", "to", "is", "are", "and", "or"}

_TAG_SPLIT_RE = re.compile(r"[.:]")
_TAG_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_LENS_SOURCE_RE = re.compile(r"\(Source:\s*([^)]+)\)")


def _derive_tag(title: str) -> str:
    """Deterministic tag derivation from a finding title.

    Algorithm:
      1. Split on first `.` or `:`; keep the head.
      2. Unicode-normalise (NFKD) and ASCII-fold (strip diacritics).
      3. Lowercase.
      4. Replace non-[a-z0-9] runs with `-`; strip leading/trailing `-`.
      5. Drop stopwords from token list.
      6. Take first 4 tokens; rejoin on `-`; truncate to 32 chars.
      7. Empty result -> `"untagged"`.

    Pure function; tested in tests/test_tag_derivation.py.
    """
    if not title:
        return "untagged"
    head = _TAG_SPLIT_RE.split(title, maxsplit=1)[0]
    head = _unicodedata.normalize("NFKD", head)
    head = head.encode("ascii", "ignore").decode("ascii")
    head = head.lower()
    head = _TAG_NON_ALNUM_RE.sub("-", head).strip("-")
    if not head:
        return "untagged"
    tokens = [t for t in head.split("-") if t and t not in _TAG_STOPWORDS]
    if not tokens:
        return "untagged"
    tag = "-".join(tokens[:4])[:32].rstrip("-")
    return tag or "untagged"


def _derive_lens(raw_line: str) -> str:
    """Extract lens from a `(Source: ...)` annotation, returning the
    first mapped lens. Falls back to "unknown"."""
    m = _LENS_SOURCE_RE.search(raw_line)
    if not m:
        return "unknown"
    sources = [s.strip().lower() for s in m.group(1).split(",")]
    for src in sources:
        if src in LENS_MAP:
            return LENS_MAP[src]
    return "unknown"


def _parse_findings(review_text: str, round_num: int) -> list[dict]:
    """Extract findings from consolidated review markdown."""
    findings = []
    finding_id = 0
    for line in review_text.splitlines():
        line_stripped = line.strip()
        if not (line_stripped.startswith("-") and "**[" in line_stripped):
            continue
        severity = None
        for sev in ("High", "Medium", "Low"):
            if f"[{sev}]" in line_stripped:
                severity = sev
                break
        if not severity:
            continue
        finding_id += 1
        desc = line_stripped
        marker = f"**[{severity}]**"
        idx = desc.find(marker)
        if idx >= 0:
            desc = desc[idx + len(marker):].strip().lstrip("-").strip()
        lens = _derive_lens(line_stripped)
        tag = _derive_tag(desc)
        if len(desc) > 120:
            desc = desc[:117] + "..."
        findings.append({
            "id": finding_id,
            "round": round_num,
            "severity": severity,
            "lens": lens,
            "tag": tag,
            "description": desc,
            "status": "OPEN",
            "resolution": "",
        })
    return findings


def _read_tracker(tracker_file: Path) -> list[dict]:
    """Parse existing tracker file into findings list.

    Backward-compatible: old 6-column trackers load with
    lens="unknown", tag="untagged". New 8-column trackers round-trip
    cleanly.
    """
    findings = []
    in_table = False
    header_cols: list[str] = []
    for line in tracker_file.read_text().splitlines():
        if line.startswith("| #"):
            in_table = True
            header_cols = [c.strip().lower() for c in line.split("|")[1:-1]]
            continue
        if in_table and line.startswith("|---"):
            continue
        if in_table and line.startswith("|"):
            parts = [p.strip() for p in line.split("|")[1:-1]]
            if len(parts) >= 6:
                fid = parts[0]
                col = {name: (parts[i] if i < len(parts) else "") for i, name in enumerate(header_cols)}
                findings.append({
                    "id": int(fid) if fid.isdigit() else 0,
                    "round": int(parts[1].lstrip("R")) if parts[1].lstrip("R").isdigit() else 0,
                    "severity": col.get("severity", parts[2] if len(parts) > 2 else ""),
                    "lens": col.get("lens", "unknown") or "unknown",
                    "tag": col.get("tag", "untagged") or "untagged",
                    "description": col.get("finding", parts[3] if len(parts) > 3 else ""),
                    "status": col.get("status", parts[4] if len(parts) > 4 else "OPEN"),
                    "resolution": col.get("resolution", parts[5] if len(parts) > 5 else ""),
                    "routed": _parse_routed_column(col.get("routed", "")),
                })
        elif in_table and not line.startswith("|"):
            in_table = False
    return findings


def _parse_routed_column(raw: str) -> list[int]:
    """Parse the ``Routed`` column (Sprint 6 schema v3). Values have
    shape ``R1,R3`` on disk and load as ``[1, 3]``. Absent column
    (v2 tracker) yields ``[]`` — a conservative "we don't know"
    default. Malformed tokens are skipped with a stderr notice rather
    than crashing the whole load."""
    if not raw:
        return []
    out: list[int] = []
    for token in raw.split(","):
        t = token.strip()
        if not t:
            continue
        try:
            if t.startswith(("R", "r")):
                out.append(int(t[1:]))
            else:
                out.append(int(t))
        except ValueError:
            print(
                f"tracker: skipping malformed Routed token {t!r}",
                file=sys.stderr,
            )
    return out


def _format_routed_column(routed: list[int]) -> str:
    if not routed:
        return ""
    return ",".join(f"R{n}" for n in sorted(set(routed)))


def _text_similarity(a: str, b: str) -> float:
    """Simple word-overlap similarity (Jaccard)."""
    words_a = set(a.lower().split())
    words_b = set(b.lower().split())
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / len(words_a | words_b)


def _merge_findings(
    existing: list[dict],
    new_findings: list[dict],
    round_num: int,
    *,
    routed_lenses: set[str] | None = None,
) -> list[dict]:
    """Merge new findings with existing tracker.

    Sprint 6 routing: when ``routed_lenses`` is provided, findings whose
    ``lens`` is NOT in the set are left completely untouched — no
    status transition, no round-number update, no oscillation-counter
    bump. This is the enforcement point that makes "skipped lens's
    prior-round OPEN findings carry forward" correct without the
    consolidator needing to interpret silence. ``routed_lenses=None``
    preserves pre-Sprint-6 behaviour (every lens is considered routed).

    Oscillation detection: if a finding is reopened for the 3rd time
    (ADDRESSED → re-raised 3+ times), it is auto-marked RECURRING and
    removed from blocking status. Prevents infinite review loops.

    All findings (new and existing) get their ``routed`` list updated
    with ``round_num`` when their lens is in ``routed_lenses``. This
    column is pure audit metadata — useful for post-hoc "which rounds
    ran which lenses" analysis.
    """
    merged = list(existing)
    next_id = max((f["id"] for f in merged), default=0) + 1

    def _lens_routed(lens: str) -> bool:
        return routed_lenses is None or lens in routed_lenses

    for ef in merged:
        ef.setdefault("routed", [])
        if _lens_routed(ef.get("lens", "unknown")) and round_num not in ef["routed"]:
            ef["routed"] = sorted(set(ef["routed"]) | {round_num})

    for nf in new_findings:
        nf_lens = nf.get("lens") or "unknown"
        if not _lens_routed(nf_lens):
            # Defensive: a lens that wasn't routed shouldn't have emitted
            # findings at all. Drop them rather than polluting the tracker.
            continue
        matched = False
        for ef in merged:
            if not _lens_routed(ef.get("lens", "unknown")):
                continue
            if (ef["severity"] == nf["severity"]
                    and _text_similarity(ef["description"], nf["description"]) > 0.4):
                matched = True
                if ef["status"] in ("ADDRESSED", "REOPENED"):
                    # Count how many times this finding has been reopened
                    reopen_count = ef["resolution"].count("Reopened")
                    if reopen_count >= 2:
                        # 3rd reopen — mark as RECURRING (oscillating)
                        ef["status"] = "RECURRING"
                        ef["resolution"] += f" [Oscillating — auto-demoted to Known Debt at R{round_num}]"
                    else:
                        ef["status"] = "REOPENED"
                        ef["resolution"] += f" [Reopened R{round_num}]"
                # Skip RECURRING findings — they stay as Known Debt
                break
        if not matched:
            nf["id"] = next_id
            nf["round"] = round_num
            nf["routed"] = [round_num]
            next_id += 1
            merged.append(nf)

    return merged


def _write_tracker(tracker_file: Path, sprint: str, findings: list[dict], review_type: str) -> None:
    """Write findings tracker as markdown table.

    Schema v3 (Sprint 6, 9 columns): adds ``Routed`` after Resolution
    as per-round audit metadata. Format: comma-separated ``R<int>``
    tokens (e.g. ``R1,R3``). Empty list writes as empty string.
    v2 trackers load with ``routed=[]`` and are upgraded in place on
    the first rewrite.
    """
    lines = [
        f"# Findings Tracker: Sprint {sprint} ({review_type})",
        "",
        "Editor: Update the **Status** and **Resolution** columns after addressing each finding.",
        "Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`",
        "",
        "| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |",
        "|---|-------|----------|------|-----|---------|--------|------------|--------|",
    ]
    for f in findings:
        lens = f.get("lens") or "unknown"
        tag = f.get("tag") or "untagged"
        routed = _format_routed_column(f.get("routed") or [])
        lines.append(
            f"| {f['id']} | R{f['round']} | {f['severity']} | {lens} | {tag} "
            f"| {f['description']} | {f['status']} | {f['resolution']} | {routed} |"
        )
    lines.append("")
    tracker_file.write_text("\n".join(lines))


def update_findings_tracker(
    sprint: str, round_num: int, review_text: str,
    review_type: str, repo_root: Path,
    *,
    routed_lenses: set[str] | None = None,
) -> Path:
    """Parse findings from consolidated review and update the tracker file.

    Sprint 6: ``routed_lenses`` propagates into ``_merge_findings`` so
    a skipped lens's prior findings carry forward untouched.
    """
    tracker_file = repo_root / f"FINDINGS_Sprint{sprint}.md"
    new_findings = _parse_findings(review_text, round_num)

    if not tracker_file.exists():
        # First round: stamp every finding with the round it was routed in.
        for nf in new_findings:
            nf["routed"] = [round_num]
        _write_tracker(tracker_file, sprint, new_findings, review_type)
    else:
        existing = _read_tracker(tracker_file)
        merged = _merge_findings(
            existing, new_findings, round_num,
            routed_lenses=routed_lenses,
        )
        _write_tracker(tracker_file, sprint, merged, review_type)

    return tracker_file


def compute_convergence_score(tracker_file: Path) -> tuple[float, str]:
    """Compute convergence score from tracker.

    Sprint 5: surfaces RECURRING counts alongside resolved/open/reopened
    so that the single-line convergence summary conveys oscillation
    state without needing a separate print. The RECURRING clause is
    appended only when the count is non-zero, keeping healthy-sprint
    output terse.
    """
    if not tracker_file.exists():
        return 0.0, "No tracker"
    findings = _read_tracker(tracker_file)
    if not findings:
        return 1.0, "No findings"
    total = len(findings)
    resolved = sum(1 for f in findings if f["status"] in ("ADDRESSED", "VERIFIED", "WONTFIX"))
    open_count = sum(1 for f in findings if f["status"] == "OPEN")
    reopened = sum(1 for f in findings if f["status"] == "REOPENED")
    recurring = sum(1 for f in findings if f["status"] == "RECURRING")
    score = resolved / total if total > 0 else 1.0
    desc = f"{resolved}/{total} resolved, {open_count} open, {reopened} reopened"
    if recurring:
        desc += f", {recurring} recurring"
    return score, desc


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


_SPRINT_RE = re.compile(r"^\d+[A-Za-z]?$")


def _numeric_sprint(raw: str) -> str:
    """Validate the sprint CLI argument. Sprint 6 R1 #15: the sprint
    is interpolated into repo-relative paths (tracker, base-commit,
    metrics JSONL); a crafted non-numeric value such as ``../../etc``
    would escape the repo root. We accept digits with an optional
    single letter suffix (e.g. 11A) for remediation sprints."""
    if not _SPRINT_RE.match(raw):
        raise argparse.ArgumentTypeError(
            f"sprint must be a number or number+letter (e.g. 12 or 11A); got {raw!r}"
        )
    return raw


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="council-review.py",
        description="Council of Experts review driver (plan or code).",
    )
    parser.add_argument(
        "review_type", choices=["plan", "code"],
        help="Review an implementation plan or the code changes.",
    )
    parser.add_argument(
        "sprint", type=_numeric_sprint,
        help="Sprint number, optionally with a letter suffix (e.g. 12 or 11A).",
    )
    parser.add_argument(
        "title", nargs="+",
        help="Sprint title (quoted or bare tokens).",
    )
    parser.add_argument(
        "--allow-untracked", action="store_true",
        help="(code review only) include untracked source files with a banner.",
    )
    parser.add_argument(
        "--lenses", default=None,
        help="(code review only) comma-separated subset of lens roles "
             "to run (e.g. 'security,code_quality'). Rejected on plan "
             "reviews. See council-config.json for valid roles.",
    )
    parser.add_argument(
        "--auto-lenses", action="store_true",
        help="(code review only) auto-select lenses based on the diff: "
             "security + code_quality always; test_quality when tests/ "
             "changed; domain when knowledge/ changed. Overridden by "
             "--lenses.",
    )
    parser.add_argument(
        "--allow-no-security", action="store_true",
        help="(code review only) explicitly acknowledge skipping the "
             "security lens. Required when --lenses omits security. "
             "Recorded as security_bypassed=true in metrics.",
    )
    parser.add_argument(
        "--skip-tracker-check", action="store_true",
        help="(code review only) bypass the tracker-staleness hard block. "
             "Use only when the prior round genuinely produced no actionable "
             "findings (e.g. plan-only feedback already incorporated). "
             "Recorded in metrics.",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Show per-member timing and the full header block. "
             "Default console output is terse.",
    )
    parser.add_argument(
        "--max-rounds", type=int, default=None, dest="max_rounds",
        help="Override the max-rounds guardrail from council-config.json "
             "for this run only (e.g. --max-rounds 8 for a large sprint).",
    )
    return parser.parse_args(argv)


def _resolve_routed_lenses(
    args: argparse.Namespace,
    config: dict,
    changed_paths: list[str],
) -> tuple[set[str] | None, bool]:
    """Resolve the routing decision from CLI args + config + diff.

    Returns ``(routed_lenses, security_bypassed)``. A ``None`` first
    value means "no routing — run every active member". The security
    bypass flag records whether the caller opted out of the security
    lens.

    Plan reviews always return ``(None, False)`` — the plan has no
    per-lens file signature, and the routing flags are rejected at
    argparse level.
    """
    if args.review_type == "plan":
        if args.lenses or args.auto_lenses or args.allow_no_security:
            raise LensArgError(
                "--lenses / --auto-lenses / --allow-no-security are "
                "only valid for code reviews"
            )
        return None, False

    valid = _known_lens_roles(config)
    lenses: set[str] | None = None
    if args.lenses is not None:
        lenses = parse_lenses_arg(args.lenses, valid)
    elif args.auto_lenses:
        lenses = auto_lens_set(changed_paths, valid)

    if lenses is None:
        return None, False

    lenses, bypassed = enforce_security_lens(
        lenses,
        allow_no_security=args.allow_no_security,
        review_type=args.review_type,
    )
    return lenses, bypassed


def _apply_forced_verdict(
    consolidated: str,
    tracker_file: Path,
    review_output_file: Path,
    round_num: int,
    max_rounds: int,
    verdict: str | None,
) -> str | None:
    """Force an APPROVED verdict when max rounds is exceeded and no
    genuinely-new [High] findings were raised this round. Returns the
    updated verdict string, or None when no override was applied.
    Sprint 6: extracted from main() to keep the orchestrator readable."""
    if round_num <= max_rounds or not verdict or "APPROVED" in verdict:
        return None
    updated_findings = _read_tracker(tracker_file)
    new_high_this_round = [
        f for f in updated_findings
        if f["round"] == round_num
        and f["severity"] == "High"
        and f["status"] == "OPEN"
    ]
    if new_high_this_round:
        print()
        print(f"  WARNING: {len(new_high_this_round)} new [High] finding(s) at round {round_num} despite exceeding max rounds.")
        print(f"  These are genuinely new concerns. The editor should address them or escalate to the human.")
        return None
    print()
    print(f"  FORCED VERDICT: No new [High] findings at round {round_num} (past max {max_rounds}).")
    print(f"  Overriding consolidator verdict to APPROVED with Known Debt.")
    forced = re.sub(
        r"(\*\*Verdict:\*\*\s*).*",
        r"\1APPROVED (forced — max rounds exceeded, no new [High] findings)",
        consolidated, count=1,
    )
    forced = re.sub(
        r"(## Verdict:\s*).*",
        r"\1APPROVED (forced — max rounds exceeded, no new [High] findings)",
        forced, count=1,
    )
    if "## Known Debt" not in forced:
        open_items = [f for f in updated_findings if f["status"] in ("OPEN", "REOPENED", "RECURRING")]
        if open_items:
            debt_lines = ["\n\n## Known Debt\n",
                          "The following items remain unresolved but are accepted as known debt:\n"]
            for item in open_items:
                debt_lines.append(f"- [{item['severity']}] {item['description']} (from R{item['round']}, status: {item['status']})")
            forced += "\n".join(debt_lines) + "\n"
    review_output_file.write_text(forced)
    new_verdict = "APPROVED (forced — max rounds exceeded, no new [High] findings)"
    print(f"    Updated verdict: {new_verdict}")
    return new_verdict


def _prepare_council_dir(repo_root: Path, config: dict) -> Path:
    """Resolve + recreate the council output directory. Bounds-checked
    to stay inside the repo root (defence against a malicious
    ``output_dir`` in the config file)."""
    output_dir_value = config["council"].get("output_dir", "council")
    council_dir = (repo_root / output_dir_value).resolve()
    repo_root_resolved = repo_root.resolve()
    if not str(council_dir).startswith(str(repo_root_resolved) + os.sep):
        print(
            "ERROR: council.output_dir resolves outside repo root. Refusing.",
            file=sys.stderr,
        )
        sys.exit(1)
    if council_dir.exists():
        shutil.rmtree(council_dir)
    council_dir.mkdir(parents=True)
    return council_dir


def _run_parallel_council(
    active_members: list[dict],
    materials: str,
    api_keys: dict[str, str],
    sprint: str,
    title: str,
    round_num: int,
    review_type: str,
    tracker_content: str | None,
    council_dir: Path,
    config: dict,
    *,
    verbose: bool,
) -> tuple[dict[str, str], int, dict[str, dict]]:
    """Fan out to every active member, collect their reviews, write
    each to ``council_dir/<role>.md``, return (council_reviews,
    successful_count, member_stats). Sprint 6: extracted from main() to
    control complexity (R1 #20)."""
    codex_stagger = config["council"].get("codex_stagger_seconds", 2)
    retry_delay = config["council"].get("retry_delay_seconds", 5)
    parallel_timeout = config["council"].get("parallel_timeout_seconds", 180)

    print(f"  Running {len(active_members)} council members in parallel...")
    council_reviews: dict[str, str] = {}
    member_stats: dict[str, dict] = {}

    with ThreadPoolExecutor(max_workers=len(active_members)) as executor:
        futures = {
            executor.submit(
                run_council_member,
                member, materials, api_keys,
                sprint, title, round_num, review_type,
                parallel_timeout,
                codex_stagger=codex_stagger,
                retry_delay=retry_delay,
                tracker_content=tracker_content,
            ): member
            for member in active_members
        }
        for future in as_completed(futures):
            member = futures[future]
            role = member["role"]
            try:
                role, review_text, elapsed, err_meta = future.result(timeout=parallel_timeout + 30)
                council_reviews[role] = review_text
                (council_dir / f"{role}.md").write_text(review_text)
                unavailable = "UNAVAILABLE" in review_text
                stat: dict = {
                    "elapsed_s": round(elapsed, 2),
                    "output_tokens_est": len(review_text) // 4,
                    "unavailable": unavailable,
                }
                if err_meta.get("retried"):
                    stat["retried"] = True
                    stat["retry_error"] = err_meta.get("error", "")
                member_stats[role] = stat
                status = "UNAVAILABLE" if unavailable else "done"
                retry_note = " [retried]" if err_meta.get("retried") else ""
                if verbose or unavailable or err_meta.get("retried"):
                    print(f"    {member['label']:25s} {status:12s} ({elapsed:.1f}s){retry_note}")
            except Exception as e:  # noqa: BLE001
                err_str = f"{type(e).__name__}: {e}"
                print(
                    f"  [debug] {member['label']} future error: {err_str}",
                    file=sys.stderr,
                )
                council_reviews[role] = (
                    f"### {role} Review: Sprint {sprint} (R{round_num})\n\n"
                    f"**Status:** UNAVAILABLE\n"
                    f"**Error:** ({type(e).__name__}: {e})\n\n"
                    f"This expert was unable to complete their review."
                )
                member_stats[role] = {
                    "elapsed_s": None,
                    "output_tokens_est": 0,
                    "unavailable": True,
                    "retry_error": err_str,
                }
                print(f"    {member['label']:25s} FAILED       ({err_str})")

    successful = sum(1 for r in council_reviews.values() if "UNAVAILABLE" not in r)
    print()
    print(f"  Council complete: {successful}/{len(active_members)} experts succeeded")
    return council_reviews, successful, member_stats


def _print_header(
    review_type: str, sprint: str, round_num: int, title: str,
    active_members: list[dict], consolidator: dict, *, verbose: bool,
) -> None:
    """Sprint 6 R1 #20: terse 3-line header by default; full detail
    under --verbose."""
    lens_names = ",".join(m["role"] for m in active_members)
    print(f"==> Council {review_type} review: Sprint {sprint} R{round_num} ({title})")
    print(f"    Lenses: {len(active_members)} ({lens_names}) + consolidator")
    if verbose:
        print(f"    Review type:    {review_type}")
        for m in active_members:
            print(f"      - {m['label']:25s} ({m['platform']}/{m['model']})")
        print(f"    Consolidator:   {consolidator['platform']}/{consolidator['model']}")
    print()


def _gather_materials(
    review_type: str, sprint: str, repo_root: Path,
    *,
    preflight_banner: str, allow_untracked: bool,
) -> str:
    """Gather + redact materials for the chosen review_type."""
    print("  Gathering materials...")
    if review_type == "plan":
        materials = gather_plan_materials(sprint, repo_root)
    else:
        materials = gather_code_materials(
            sprint, repo_root,
            banner=preflight_banner,
            include_untracked=allow_untracked,
        )
    print(f"  Materials: {len(materials):,} chars")
    materials = redact_secrets(materials)
    print()
    return materials


def _print_next_steps(
    verdict: str | None, review_type: str, sprint: str, title: str,
    round_num: int, max_rounds: int, repo_root: Path,
) -> None:
    """Print the "Next:" block + optional compaction hint."""
    print()
    if verdict and "APPROVED" in verdict and "CHANGES_REQUESTED" not in verdict:
        try:
            sys.path.insert(0, str(repo_root / "scripts"))
            from profile import is_enabled as _is_enabled  # type: ignore
            if _is_enabled("compaction", repo_root):
                print(
                    "  → Milestone reached. Consider running /compact before continuing.",
                    file=sys.stderr,
                )
        except Exception:
            pass
        if review_type == "plan":
            print("  Next: Proceed to implementation (Phase 2)")
        else:
            print(f'  Next: ./scripts/archive-plan.sh {sprint} "{title}"')
        return
    remaining = max_rounds - round_num
    if remaining > 0:
        print(f"  Next: Address findings in FINDINGS_Sprint{sprint}.md, then re-run:")
        print(f'        ./scripts/council-review.py {review_type} {sprint} "{title}"')
        print(f"        ({remaining} round(s) remaining before forced approval)")
    else:
        print("  ESCALATION: Max rounds reached. Present unresolved findings to the human.")
        print("  Options: cut scope, override with higher max_rounds, or accept Known Debt.")


def _materials_breakdown(materials: str) -> dict:
    """Estimate token cost of each section in the assembled materials string.

    Sections are delimited by '### ' headers. Classifies each by its
    header prefix into: plan, changes, file_list, codegraph, source_files,
    tracker, other.
    """
    totals: dict[str, int] = {
        "plan": 0, "changes": 0, "file_list": 0,
        "codegraph": 0, "source_files": 0, "other": 0,
    }
    # Split on any markdown heading (## or ###) preceded by a blank line.
    # Prepend sentinel so the first section is also captured.
    import re as _re
    chunks = _re.split(r"\n\n#{2,3} ", "\n\n" + materials)
    for chunk in chunks:
        if not chunk.strip():
            continue
        first_line = chunk.lstrip().splitlines()[0].lower()
        tokens = len(chunk) // 4
        if "plan_sprint" in first_line or "approved plan" in first_line or "primary" in first_line:
            totals["plan"] += tokens
        elif "changes.md" in first_line:
            totals["changes"] += tokens
        elif "changed files" in first_line:
            totals["file_list"] += tokens
        elif "codebase" in first_line or "codegraph" in first_line or "structure context" in first_line:
            totals["codegraph"] += tokens
        elif any(ext in first_line for ext in (".rs", ".py", ".js", ".ts", ".go", ".java")):
            totals["source_files"] += tokens
        else:
            totals["other"] += tokens
    return {f"est_mat_{k}_tokens": v for k, v in totals.items()}


def _estimate_prompt_tokens(
    active_members: list[dict],
    materials: str,
    sprint: str,
    round_num: int,
    review_type: str,
    tracker_content: str | None,
) -> dict:
    """Estimate input/output token budget before running the council.

    Uses char-count ÷ 4 as a token approximation (accurate to ~10% for
    English + code). Returns a dict ready to merge into the metrics record.
    """
    sample_sys, sample_usr = build_council_prompt(
        active_members[0], materials, sprint, "estimate", round_num,
        review_type, tracker_content=tracker_content,
    )
    # All members share identical materials; only the system prompt (lens)
    # differs slightly. Use the first member as representative.
    input_tokens_per_member = (len(sample_sys) + len(sample_usr)) // 4
    max_output_per_member = active_members[0].get("max_tokens", 4096)
    result = {
        "est_input_tokens_per_member": input_tokens_per_member,
        "est_input_tokens_total": input_tokens_per_member * len(active_members),
        "est_max_output_tokens_total": max_output_per_member * len(active_members),
        "est_materials_tokens": len(materials) // 4,
        "active_lens_count": len(active_members),
    }
    result.update(_materials_breakdown(materials))
    return result


def _safe_emit_metrics(
    repo_root: Path, sprint: str, review_type: str, round_num: int,
    *,
    active_members: list[dict],
    council_reviews: dict[str, str],
    elapsed_s: float,
    verdict: str | None,
    tracker_file: Path,
    security_bypassed: bool,
    prompt_token_estimates: dict | None = None,
) -> None:
    """Wrapper around _emit_metrics that never raises into main()."""
    try:
        estimates = dict(prompt_token_estimates or {})
        # Round wall time = slowest member + consolidator (elapsed_s is consolidator only)
        member_stats = estimates.get("member_stats", {})
        member_elapsed = [
            v["elapsed_s"] for v in member_stats.values()
            if isinstance(v, dict) and v.get("elapsed_s") is not None
        ]
        if member_elapsed:
            estimates["round_wall_time_s"] = round(max(member_elapsed) + elapsed_s, 2)
        _emit_metrics(
            repo_root, sprint, review_type, round_num,
            members_active=len(active_members),
            members_succeeded=sum(
                1 for txt in council_reviews.values() if "UNAVAILABLE" not in txt
            ),
            elapsed_s=elapsed_s,
            verdict=verdict,
            tracker_file=tracker_file,
            security_bypassed=security_bypassed,
            prompt_token_estimates=estimates,
        )
        metrics_path = repo_root / "council" / f"metrics_Sprint{sprint}.jsonl"
        print(f"  metrics: R{round_num} → {metrics_path.name}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"  [warn] metrics emit failed: {exc}", file=sys.stderr)


def main():
    global _codex_call_index, _codex_call_lock

    ns = _parse_args(sys.argv[1:])
    review_type = ns.review_type
    sprint = ns.sprint
    title = " ".join(ns.title)

    repo_root = Path(subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True,
    ).stdout.strip() or ".")

    preflight_banner = ""
    if review_type == "code":
        pf = preflight_code_review(repo_root, ns.allow_untracked)
        if not pf.ok:
            print(pf.reject_message, file=sys.stderr)
            sys.exit(4)
        preflight_banner = pf.banner

    ensure_api_keys_from_profile()

    config_path = repo_root / "scripts" / "council-config.json"
    config = load_config(config_path)

    # Honour auto_lenses_code_default from config unless --lenses was
    # given explicitly on the CLI (explicit always wins).
    if (review_type == "code"
            and not ns.lenses
            and not ns.auto_lenses
            and config["council"].get("auto_lenses_code_default", False)):
        ns.auto_lenses = True

    # Sprint 6: resolve selective routing. Compute changed paths for
    # --auto-lenses before we filter active members.
    changed_paths: list[str] = []
    if review_type == "code" and ns.auto_lenses:
        changed_paths = get_changed_files(sprint=sprint, repo_root=repo_root)
    try:
        routed_lenses, security_bypassed = _resolve_routed_lenses(
            ns, config, changed_paths
        )
    except LensArgError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)

    active_members = get_active_members(config, review_type, lenses=routed_lenses)
    if not active_members:
        print(f"ERROR: No council members configured for '{review_type}' phase", file=sys.stderr)
        sys.exit(1)

    api_keys = validate_api_keys(config, active_members)
    round_num = increment_round(sprint, review_type, repo_root)

    _print_header(
        review_type, sprint, round_num, title,
        active_members, config["council"]["consolidator"],
        verbose=ns.verbose,
    )

    materials = _gather_materials(
        review_type, sprint, repo_root,
        preflight_banner=preflight_banner,
        allow_untracked=ns.allow_untracked,
    )

    # Read findings tracker (needed by both council members and consolidator)
    tracker_file = repo_root / f"FINDINGS_Sprint{sprint}.md"
    tracker_content = tracker_file.read_text() if tracker_file.exists() else None

    # Warn when JS/TS files are in the diff but codegraph looks stale.
    # S13: 21 codegraph tokens (effectively empty) because library.js / library.html
    # were not indexed before council ran — reviewers had no structured context.
    # We check the materials token estimate rather than running a live DB query so
    # there is no extra subprocess cost.
    if review_type == "code":
        all_changed = get_changed_files(sprint=sprint, repo_root=repo_root)
        has_js_ts = any(
            f.endswith((".js", ".ts", ".jsx", ".tsx", ".html")) for f in all_changed
        )
        if has_js_ts:
            db_path = repo_root / ".claude" / "codebase.db"
            cg_token_est = 0
            if db_path.exists():
                try:
                    import sqlite3 as _sqlite3
                    with _sqlite3.connect(str(db_path)) as _conn:
                        row = _conn.execute(
                            "SELECT COUNT(*) FROM symbols WHERE file_path LIKE '%.js' "
                            "OR file_path LIKE '%.ts' OR file_path LIKE '%.html'"
                        ).fetchone()
                        cg_token_est = row[0] if row else 0
                except Exception:
                    pass
            if cg_token_est < 10:
                print(file=sys.stderr)
                print("  WARNING: JS/TS/HTML files are in the diff but the codegraph",
                      file=sys.stderr)
                print("  has <10 indexed JS/TS symbols. Reviewers will have no",
                      file=sys.stderr)
                print("  structured codebase context for these files.", file=sys.stderr)
                print("  Run: python3 scripts/index-codebase.py --incremental",
                      file=sys.stderr)
                print("  then re-run this review for full codegraph coverage.",
                      file=sys.stderr)
                print(file=sys.stderr)

    # Block R2+ when the tracker shows zero resolutions from the prior round.
    # An all-OPEN tracker defeats deduplication and compact representation, and
    # is a reliable signal that the editor addressed findings in code but never
    # updated the tracker. Three consecutive sprints (S8, S9, S11) archived
    # with 0% resolved while reviewers kept re-flagging the same issues.
    # Use --skip-tracker-check only when no findings were actionable last round.
    #
    # Per-round gap fix (S13): also block when every finding raised in round
    # N-1 is still OPEN, even if earlier rounds had resolutions. S13 had 11
    # R1 resolutions keeping the cumulative count > 0, but R2–R7 (63 findings)
    # were never touched, allowing the loop to continue unchecked.
    if review_type == "code" and tracker_content and round_num > 1:
        prior_findings = _read_tracker(tracker_file)
        if prior_findings:
            open_count = sum(1 for f in prior_findings if f.get("status", "OPEN") == "OPEN")
            resolved_count = len(prior_findings) - open_count

            # Per-round check: findings raised in the immediately preceding round
            prev_round_findings = [
                f for f in prior_findings if f.get("round") == round_num - 1
            ]
            prev_round_all_open = (
                bool(prev_round_findings)
                and all(f.get("status", "OPEN") == "OPEN" for f in prev_round_findings)
            )

            should_block = (
                (resolved_count == 0 or prev_round_all_open)
                and not ns.skip_tracker_check
            )
            if should_block:
                print(file=sys.stderr)
                if prev_round_all_open and resolved_count > 0:
                    print(
                        f"  BLOCKED: all {len(prev_round_findings)} finding(s) from "
                        f"R{round_num - 1} are still OPEN.",
                        file=sys.stderr,
                    )
                    print(
                        f"  (Earlier rounds have {resolved_count} resolved — "
                        f"but nothing from last round was addressed.)",
                        file=sys.stderr,
                    )
                else:
                    print("  BLOCKED: tracker has 0 resolved findings from prior rounds.",
                          file=sys.stderr)
                    print(f"  {open_count} findings are all OPEN in "
                          f"FINDINGS_Sprint{sprint}.md", file=sys.stderr)
                print(file=sys.stderr)
                print("  Before running this round:", file=sys.stderr)
                print("  1. Open FINDINGS_Sprint" + sprint + ".md", file=sys.stderr)
                print("  2. Set Status → ADDRESSED and add a Resolution note for each",
                      file=sys.stderr)
                print("     finding you fixed in code. Set WONTFIX+reason for any you",
                      file=sys.stderr)
                print("     are deliberately not fixing.", file=sys.stderr)
                print("  3. Re-run this command.", file=sys.stderr)
                print(file=sys.stderr)
                print("  If prior findings were genuinely not actionable, re-run with",
                      file=sys.stderr)
                print("  --skip-tracker-check to override (recorded in metrics).",
                      file=sys.stderr)
                print(file=sys.stderr)
                sys.exit(5)

    # Advisory warning for plan reviews: if we're at R3+ with zero resolutions
    # and ≥3 open Highs, the tracker is in the same loop-state that causes
    # code reviews to re-flag verbatim. No hard block (plan findings are design
    # gaps, not code bugs, and some rounds legitimately stay all-OPEN while the
    # plan is being revised) but the agent needs a clear signal to update the
    # tracker before continuing.
    if review_type == "plan" and tracker_content and round_num >= 3:
        prior_findings = _read_tracker(tracker_file)
        if prior_findings:
            open_count = sum(1 for f in prior_findings if f.get("status", "OPEN") == "OPEN")
            resolved_count = len(prior_findings) - open_count
            high_open = sum(
                1 for f in prior_findings
                if f.get("status", "OPEN") == "OPEN" and f.get("severity", "") == "High"
            )
            if resolved_count == 0 and high_open >= 3:
                print(file=sys.stderr)
                print(f"  WARNING: plan tracker has 0 resolved findings at R{round_num}.",
                      file=sys.stderr)
                print(f"  {high_open} High findings are OPEN in "
                      f"FINDINGS_Sprint{sprint}.md", file=sys.stderr)
                print(file=sys.stderr)
                print("  Reviewers will re-examine the same plan sections and",
                      file=sys.stderr)
                print("  regenerate identical findings. Before continuing:", file=sys.stderr)
                print("  1. For each finding you addressed in the plan revision,",
                      file=sys.stderr)
                print("     set Status → ADDRESSED with a note pointing to the",
                      file=sys.stderr)
                print("     specific plan section that resolves it.", file=sys.stderr)
                print("  2. Set WONTFIX+reason for any you are intentionally deferring.",
                      file=sys.stderr)
                print("  Continuing this round (not blocked)...", file=sys.stderr)
                print(file=sys.stderr)

    prompt_token_estimates = _estimate_prompt_tokens(
        active_members, materials, sprint, round_num, review_type, tracker_content,
    )
    if getattr(ns, "skip_tracker_check", False):
        prompt_token_estimates["tracker_check_skipped"] = True

    council_dir = _prepare_council_dir(repo_root, config)
    member_labels = {m["role"]: m["label"] for m in active_members}

    import threading
    _codex_call_index = 0
    _codex_call_lock = threading.Lock()

    council_reviews, successful, member_stats = _run_parallel_council(
        active_members, materials, api_keys,
        sprint, title, round_num, review_type,
        tracker_content, council_dir, config,
        verbose=ns.verbose,
    )
    prompt_token_estimates["member_stats"] = member_stats

    if successful < QUORUM_THRESHOLD:
        print(f"  ERROR: Quorum not met ({successful} < {QUORUM_THRESHOLD}). Aborting.", file=sys.stderr)
        sys.exit(1)

    max_rounds_key = "max_plan_rounds" if review_type == "plan" else "max_code_rounds"
    max_rounds = config["council"].get(max_rounds_key, 8)
    if getattr(ns, "max_rounds", None) is not None:
        max_rounds = ns.max_rounds
        print(f"  max-rounds override: {max_rounds}", file=sys.stderr)
    warning_at = config["council"].get("convergence_warning_at", 3)

    escalation_note = None
    if round_num > max_rounds:
        escalation_note = (
            f"\nESCALATION: This is round {round_num}, exceeding the configured maximum "
            f"of {max_rounds}. You MUST:\n"
            f"1. Only flag genuinely NEW [High] findings not present in prior rounds\n"
            f"2. If no new [High] findings exist, verdict MUST be APPROVED\n"
            f"3. List all unresolved items in a 'Known Debt' section instead of blocking\n"
        )

    print(f"  Running consolidator...")
    start = time.monotonic()
    consolidated = run_consolidator(
        config, council_reviews, member_labels,
        sprint, title, round_num, review_type, api_keys,
        tracker_content=tracker_content,
        escalation_note=escalation_note,
    )
    elapsed = time.monotonic() - start
    print(f"  Consolidator complete ({elapsed:.1f}s)")
    prompt_token_estimates["est_consolidator_output_tokens"] = len(consolidated) // 4
    prompt_token_estimates["est_consolidator_elapsed_s"] = round(elapsed, 2)

    review_output_file = repo_root / f"REVIEW_Sprint{sprint}.md"
    review_output_file.write_text(consolidated)
    print()
    print(f"==> Review written to {review_output_file.name}")

    tracker_file = update_findings_tracker(
        sprint, round_num, consolidated, review_type, repo_root,
        routed_lenses=routed_lenses,
    )
    print(f"    Findings tracker: {tracker_file.name}")
    try:
        all_findings = _read_tracker(tracker_file)
        new_this_round = [f for f in all_findings if f.get("round") == round_num]
        prompt_token_estimates["new_findings_this_round"] = len(new_this_round)
        prompt_token_estimates["new_findings_high"] = sum(1 for f in new_this_round if f.get("severity", "").lower() == "high")
        prompt_token_estimates["new_findings_medium"] = sum(1 for f in new_this_round if f.get("severity", "").lower() == "medium")
        prompt_token_estimates["new_findings_low"] = sum(1 for f in new_this_round if f.get("severity", "").lower() == "low")
        by_lens: dict[str, int] = {}
        for f in new_this_round:
            lens = f.get("lens", "unknown")
            by_lens[lens] = by_lens.get(lens, 0) + 1
        prompt_token_estimates["new_findings_by_lens"] = by_lens
    except Exception:  # noqa: BLE001
        pass

    verdict = extract_verdict(consolidated)
    if verdict:
        print(f"    {verdict}")
    else:
        print("    WARNING: No verdict found in consolidated review")

    # ----- Forced verdict logic: override consolidator after max rounds -----
    forced = _apply_forced_verdict(
        consolidated, tracker_file, review_output_file,
        round_num, max_rounds, verdict,
    )
    if forced is not None:
        verdict = forced

    # ----- Convergence reporting -----
    # Sprint 5: the recurring count is embedded in `desc` by
    # compute_convergence_score; the prior standalone "RECURRING: ..."
    # print has been removed as redundant.
    if round_num > 1:
        score, desc = compute_convergence_score(tracker_file)
        print(f"    Convergence: {score:.0%} ({desc})")
        if score < 0.5 and round_num >= warning_at:
            print(f"    WARNING: Low convergence at round {round_num}. Consider addressing [High] items only.")

    _safe_emit_metrics(
        repo_root, sprint, review_type, round_num,
        active_members=active_members,
        council_reviews=council_reviews,
        elapsed_s=elapsed,
        verdict=verdict,
        tracker_file=tracker_file,
        security_bypassed=security_bypassed,
        prompt_token_estimates=prompt_token_estimates,
    )
    _print_next_steps(
        verdict, review_type, sprint, title,
        round_num, max_rounds, repo_root,
    )


if __name__ == "__main__":
    main()
