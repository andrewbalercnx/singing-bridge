# Council Process Retrospective — Sprints 8 & 9

_Generated 2026-04-19. Covers Sprints 8 and 9 with cross-sprint comparison against Sprints 1–7._

---

## Executive Summary

Three structural problems dominate:

1. **Tracker discipline has collapsed** — Sprints 8 and 9 archived with 0% of findings resolved. The findings tracker is central to council effectiveness: deduplication, compact token representation, and audit trail all depend on it. With everything permanently OPEN the council is flying blind across rounds.

2. **Implementation drift in late rounds** — Both sprints generated new High findings in R3 and R4. In Sprints 1–7 this never happened past R2. This is a signal that the fix cycle is introducing new issues, not just resolving old ones.

3. **Source file tokens dominate materials (65%)** — The codegraph section is contributing only 21 tokens. The materials budget is being consumed by raw source files rather than structured codegraph queries. This is the primary target for the next token efficiency gain.

---

## 1. Findings Resolution: Critical Regression

| Sprint | Total | Rounds | Resolved % | High open at close |
|--------|-------|--------|------------|-------------------|
| S1     | 85    | 5      | **100%**   | 0                 |
| S2     | 30    | 4      | **100%**   | 0                 |
| S3     | 40    | 2      | **100%**   | 0                 |
| S4     | 73    | 6      | **0%**     | 8                 |
| S5     | 64    | 2      | **95%**    | 0                 |
| S6     | 79    | 4      | **94%**    | 0                 |
| S7     | 25    | 4      | **72%**    | 0                 |
| S8     | 54    | 5      | **0%**     | 7                 |
| S9     | 42    | 5      | **0%**     | 10                |

Sprints 1–3 maintained perfect resolution. Sprints 5–6 are close. Sprints 4, 8, 9 archived with no resolutions recorded at all.

**What this breaks:**

- **Consolidator deduplication**: the DEDUP step checks the tracker for ADDRESSED findings. With everything OPEN, the consolidator cannot distinguish "already fixed" from "still a problem". It will either redundantly re-raise resolved issues or suppress them based on text similarity alone — both are wrong.
- **Compact tracker**: the optimisation only compresses ADDRESSED/WONTFIX/VERIFIED/RECURRING rows. An all-OPEN tracker at R5 gives no compression. Sprint 9 R5 spent 9,770 tokens on the tracker (26% of materials) with zero benefit from the compact representation.
- **Audit trail**: there is no record of what was actually fixed, by whom, or when. "42 OPEN findings, APPROVED" is a governance signal, not a safety signal.

**Root cause**: the agent is addressing findings in code but not updating the tracker. The update step (`Editor: Update the Status and Resolution columns`) is being skipped.

**Fix (immediate)**: Make tracker update part of the commit checklist in CLAUDE.md. After each implementation commit addressing council findings, the tracker must be updated before the next review round runs. This is already in the sprint process instructions but is not being followed.

---

## 2. Per-Round Finding Pattern: Late-Round High Findings

New findings per round and severity:

| Sprint | R1           | R2          | R3          | R4          | R5          | R6          |
|--------|--------------|-------------|-------------|-------------|-------------|-------------|
| S1     | 47 (11H)     | 16 (2H)     | 8 (1H)      | 6 (1H)      | 8 (0H)      | —           |
| S3     | 32 (8H)      | 8 (0H)      | —           | —           | —           | —           |
| S5     | 50 (13H)     | 14 (0H)     | —           | —           | —           | —           |
| S6     | 35 (13H)     | 17 (3H)     | 19 (1H)     | 8 (0H)      | —           | —           |
| **S8** | **15 (5H)**  | **17 (1H)** | **8 (0H)**  | **7 (1H)**  | **7 (0H)**  | —           |
| **S9** | **11 (4H)**  | **11 (1H)** | **9 (3H)**  | **7 (2H)**  | **4 (0H)**  | —           |

Sprints 3 and 5 converged in 2 rounds — a sign of tight plan review and careful implementation. In Sprints 8 and 9:
- Sprint 8: new High at R4 (after R3 was clean)
- Sprint 9: 3 new Highs at R3, 2 at R4 — re-escalation after apparent improvement

This pattern, combined with the unresolved tracker, almost certainly reflects one of:
1. **Implementation side-effects**: fixing one component breaks an adjacent one. The new Highs in R3–R4 are in code that changed in response to earlier findings.
2. **Reviewer attention shift**: once R1/R2 issues are addressed, reviewers in R3 have more context to look deeper and find issues they had less attention for earlier.
3. **Plan gaps being found in code review**: several R1 Sprint 9 findings were plan-level issues (#1: missing `entry_id` field, #2: missing role gate specification). These should have been caught in plan review.

**Check**: Was plan review run for Sprint 9? The metrics JSONL shows only `review_type: code`. This is worth verifying — if plan review was skipped or ran on a draft plan that subsequently changed, it explains R1's 4 High findings on plan-level concerns.

---

## 3. Token Efficiency (Sprint 9 R5, the only instrumented round)

```
Materials total:   37,410 tokens
  Source file excerpts   24,443  (65%)   ← dominant cost
  Tracker + other         9,770  (26%)   ← all-OPEN tracker, no compression
  File listing            3,004  ( 8%)
  CHANGES.md                 54  ( 0%)
  Plan                       22  ( 0%)
  Codegraph section          21  ( 0%)   ← nearly unused

Input per member:    39,957
  Materials          37,410  (94%)
  Lens + system       2,547   (6%)

Actual output per member (R5):  ~530 tokens  (26% of 2048 ceiling)
```

**The codegraph is not doing its job as a materials compressor.** 21 tokens for the codegraph section means it is being included as a placeholder, not as a structured query output. The original intent was for codegraph to replace raw source file excerpts: instead of sending 24K tokens of source, the materials builder should summarise with codegraph queries and only include targeted excerpts.

This is the highest-leverage remaining token optimisation. The ceiling reduction and auto-lenses work we did will compound poorly if source files grow with the codebase.

**Output utilisation (26%) confirms the max_tokens=2048 reduction was correct**: reviewers are not being constrained by output budget. The bottleneck is input size and reviewer latency.

---

## 4. Reviewer Latency: code_quality is 4.5× Slower

Sprint 9 R5 member elapsed times:

| Reviewer     | Elapsed | Output tokens | Notes |
|--------------|---------|---------------|-------|
| security     | 128s    | 546           |       |
| test_quality | 242s    | 499           |       |
| domain       | 250s    | 531           |       |
| code_quality | **572s**| 575           | *** SLOW *** |
| consolidator | 18s     | 546           |       |

Round wall time is determined by the slowest member: 572s + 18s = **590 seconds (9.8 minutes)** per round. Five rounds = ~49 minutes for code review alone.

Code quality and security output similar token counts, so the 4.5× latency gap is not due to more output — it is due to more MCP codegraph queries. This is intentional (code quality must verify function lengths, type annotations, dead code) but the query latency compounds. Options:

- **Batch MCP queries**: if code_quality is running sequential codegraph queries that are independent, batching them would reduce round-trip overhead.
- **Pre-filter the file list**: currently 3,004 tokens of file listing is passed to every reviewer. Code quality only needs files that changed in the diff. Restricting file list to diff'd files would reduce MCP query scope.
- **Haiku for code_quality mechanical checks**: simple structural checks (line counts, annotation presence) could run on a faster, cheaper model. This is a model-diversity gain as well as a speed gain. Revisit after Sprint 10 data.

---

## 5. Convergence Quality Concern

Sprint 9 converged at R5 with verdict APPROVED, but:
- 42 findings remain OPEN
- 10 are High severity
- R4 introduced 2 new High findings (1 round before convergence)

The convergence criterion is "no new High findings for 2 consecutive rounds". R4 had 2 new Highs; R5 had 0. That is only **1 consecutive round** without new Highs. Either:
- The consolidator applied the criterion loosely (judged 5 rounds of declining findings as sufficient)
- The criterion was met by an alternative path (max rounds proximity warning)

This is a governance concern, not a technical one: **APPROVED does not mean resolved**. The 10 open Highs include:

- `#23`: Live session headphones status wired to wrong subject — incorrect UI state after session start
- `#24`: `HeadphonesConfirmed` non-idempotent at protocol level — server rebroadcasts unchanged state
- `#25`: `sbSelfCheck.show` exceeds complexity limit and concentrates unrelated responsibilities
- `#32`: `session-ui.js` still exceeds module size limit
- `#33`: Self-check suite missing ready-gating invariant

These are real defects in production-bound code. The human reviewer should explicitly WONTFIX or open follow-up sprint tickets for each of these — the current state (archived as OPEN with no resolution note) is not acceptable as a governance record.

**Recommendation**: Add a sprint close checklist step: before archiving, every High finding must have either ADDRESSED+resolution or WONTFIX+justification. Medium and Low can stay OPEN only with a sprint ticket reference.

---

## 6. Missing Metrics for R1–R4

Sprint 9 has only 1 metrics row (R5). The instrumented `council-review.py` was committed to singing-bridge before Sprint 9 started, so this is not a timing issue. Possible causes:

1. **File overwrite**: if the `council/` directory was cleared between rounds, earlier rows were lost.
2. **Metrics write error**: earlier rounds may have raised an exception in `_safe_emit_metrics` that was silently swallowed.
3. **Sprint base commit reset**: if the sprint base was reset between runs, the metrics path may have been regenerated.

**Action**: Add a metrics-write verification at the end of each round: emit a line to stderr confirming the append succeeded. Also check whether `council/metrics_Sprint9.jsonl` existed before R5 (git log of the file may show this).

Without R1–R4 data, we cannot calculate the token cost trajectory across rounds, the per-lens efficiency across the sprint, or verify whether the compact tracker was saving tokens in practice.

---

## 7. Recommendations by Priority

### Immediate (before next sprint)

**P0 — Enforce tracker updates**  
Before running a new review round, check that the findings tracker has been updated to reflect the prior round's addressed items. A pre-flight check in `council-review.py` could warn when the previous round's findings are still all OPEN.

**P0 — Resolve open Highs before archive**  
Sprint 9's 10 open High findings must be triaged now: WONTFIX with justification or logged as Sprint 10 tasks. Do not carry forward unacknowledged Highs.

**P1 — Reduce source file token consumption**  
Source files are 65% of materials (24K tokens). The materials builder should use codegraph queries to generate targeted excerpts rather than raw file slices. Target: reduce source file tokens by 50%, from 24K to ~12K.

**P1 — Investigate missing R1–R4 metrics**  
Verify the metrics write path is working correctly. Add a simple end-of-round confirmation log line.

### Near-term (Sprint 10)

**P2 — Plan review for Sprint 10**  
Sprint 9's R1 findings included multiple plan-level issues. Run plan review and verify it catches structural gaps before implementation begins.

**P2 — Investigate code_quality latency**  
572 seconds for a 575-token output suggests many sequential MCP queries. Add timing to individual MCP calls to understand where time is spent. Consider Haiku for the mechanical checks subset.

**P2 — Convergence criterion enforcement**  
Add an explicit check: if `new_findings_high_this_round > 0` at R(n-1) and `new_findings_high_this_round == 0` at R(n), do NOT approve — require one more round. The consolidator's own judgment is insufficient for this gate.

### Longer-term

**P3 — Model diversity**  
Running 4 identical Sonnet instances risks correlated blind spots. Consider security on Opus (subtle reasoning) and code_quality/test_quality on Haiku (mechanical checks). Collect Sprint 9–10 per-member output quality data first.

**P3 — Compact tracker will only help when the tracker is actually maintained**  
Our compact tracker optimisation compresses ADDRESSED/WONTFIX rows. Until the tracker is updated, it provides no token saving. Fix P0 first.

---

## 8. What Worked Well

- **Security finding quality**: Security contributed focused, early findings (R1, R2 only in S9) and stopped when done. No security findings appeared in R3–R5, which is the correct behaviour — security issues should be caught and resolved early.
- **Auto-lenses**: Security was absent from R3–R5 because auto-lenses correctly stopped routing it when no new security surface was introduced. This is the expected payoff of the auto-lenses default.
- **Consolidator speed**: 18 seconds. The Codex consolidator is fast and reliable. The Google Gemini fallback was not needed.
- **Sprint 3 and Sprint 5 efficiency**: 2-round convergence in both. These sprints had tight plans, clear specs, and the implementation addressed all R1 Highs completely. They are the model to replicate.
