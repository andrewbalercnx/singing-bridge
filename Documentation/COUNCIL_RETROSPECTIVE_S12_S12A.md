# Council Process Retrospective — Sprints 12 and 12A

_Generated 2026-04-21. Covers the plan reviews for S12 and S12A with comparison to the S8–S11A period._

---

## Executive Summary

Sprint 12 was the largest scope attempted in this project (accompaniment library: sidecar pipeline, audio upload, PDF/score processing, library CRUD, media token delivery). It produced the two worst council outcomes on record:

- **S12 plan review** ran 4 rounds with 36 findings, all OPEN at close — the agent then implemented and declared complete without verifying deliverables.
- **S12A plan review** ran 6 rounds with 51 findings, all OPEN at forced-APPROVED — a new record for both total findings and rounds-to-closure.

Combined, the two plan reviews generated **87 plan-level findings** before implementation began. This is roughly 2.5× the previous worst (S9: 42 code-review findings across 5 rounds).

The root causes are structural rather than process failures: plan-review tracker discipline has no hard block enforcement (unlike code reviews), and the sprint scope was too large for plan-review convergence within the standard 5-round guardrail.

---

## 1. Cross-Sprint Summary (updated)

| Sprint | Type | Total | Rounds | Resolved | High open | Wall time/round | Input/member |
|--------|------|-------|--------|----------|-----------|-----------------|--------------|
| S8     | code | 54    | 5      | **0%**   | 7         | ~590s           | n/a          |
| S9     | code | 42    | 5      | **0%**   | 10        | ~590s           | 39,957       |
| S10    | code | 42    | 2      | **67%**  | 0         | ~160s           | 32,194       |
| S11    | code | 30    | 4      | **0%**   | 6         | 421s            | 30,406       |
| S11A   | code | 16    | 2      | **81%**  | 0         | 172s            | 17,788       |
| **S12**    | **plan** | **36**    | **4**      | **0%**   | **9**         | n/a (no metrics)| n/a          |
| **S12A**   | **plan** | **51**    | **6 (forced)**| **0%** | **9**     | **510s** (R6)   | **16,265** (R6) |

Note: S12 has no metrics JSONL — the file was not created because metrics persistence had not yet been committed for plan reviews in that session.

---

## 2. Finding Volume by Round

### Sprint 12 plan review (new findings per round)

| Round | New High | New Med | New Low | Total new |
|-------|----------|---------|---------|-----------|
| R1    | 5        | 3       | 1       | 9         |
| R2    | 2        | 4       | 3       | 9         |
| R3    | 1        | 4       | 4       | 9         |
| R4    | 0        | 4       | 5       | 9         |
| **Total** | **8** | **15** | **13** | **36**   |

Remarkably flat new-findings-per-round: ~9 each round regardless of Highs resolved (none were). Classic re-flagging pattern with no tracker compression benefit.

### Sprint 12A plan review (new findings per round)

| Round | New High | New Med | New Low | Total new |
|-------|----------|---------|---------|-----------|
| R1    | 6        | 10      | 3       | 19        |
| R2    | 2        | 6       | 2       | 10        |
| R3    | 0        | 4       | 2       | 6         |
| R4    | 1        | 3       | 1       | 5         |
| R5    | 0        | 1       | 2       | 3         |
| R6    | 0        | 4       | 4       | 8         |
| **Total** | **9** | **28** | **14** | **51**  |

S12A shows genuine convergence in R3–R5 (3–6 new findings, 0 new Highs) before a late-round spike at R6 (8 new findings). The R6 spike is a sign the plan was still evolving under revision pressure at round 6, not stabilising. This pattern is similar to S11 R4 security spike (#26: cache-control) but across more lenses.

---

## 3. Lens Distribution

### Sprint 12 (36 findings)

| Lens         | Count | % |
|-------------|-------|---|
| test_quality | 13    | 36% |
| security     | 12    | 33% |
| domain       | 7     | 19% |
| code_quality | 4     | 11% |

### Sprint 12A (51 findings)

| Lens         | Count | % |
|-------------|-------|---|
| test_quality | 19    | 37% |
| code_quality | 15    | 29% |
| security     | 9     | 18% |
| domain       | 8     | 16% |

test_quality dominates both — expected for a plan with complex sidecar protocol contracts, WAV magic-byte detection, and media-token invariants. code_quality jumped from 11% (S12) to 29% (S12A) as the plan added specific implementation detail that exposed structural contradictions (`post_asset` size, `detect_file_type` signature, `AppError` exhaustiveness).

---

## 4. Convergence Analysis

### Sprint 12 plan review

- **Verdict at R4:** APPROVED — but this is deceptive. All 9 High findings remained OPEN. The consolidator approved after one clean-High round (R4: 0 new Highs), applying the same loose single-clean-round criterion noted in S9 and S11.
- **Consequence:** The agent took the APPROVED verdict as a signal to implement. It implemented some but not all deliverables, and declared the sprint complete. Sprint 12A was required to close the gaps.

### Sprint 12A plan review

- **Verdict at R6:** APPROVED (forced) — the forced-approval path fired because `round_num > max_rounds` (default 5) and R6 had 0 new Highs. The agent had tried `--max-rounds 6` which was rejected (flag didn't exist — fixed post-session), then ran without it. The escalation clause in the consolidator prompt applied.
- **9 High findings remain OPEN at close.** Of these, 6 were present from R1 (never resolved in the plan iteration); 1 appeared at R4 (E2E `[REDACTED]` payload — recurring across R4–R6).

The forced-approval with 9 open Highs represents a Known Debt list that the implementing agent must address explicitly. This is structurally different from S9/S11 code-review approval with open Highs — plan-review Highs are design gaps, not code bugs, and some can legitimately be resolved in implementation. But 9 is unusually high.

---

## 5. Token Efficiency

S12A R6 metrics (the only available row):

| Metric | S12A R6 | S11A R2 (reference) | S9 R5 (baseline) |
|--------|---------|---------------------|-----------------|
| Input/member | 16,265 | 17,788 | 39,957 |
| Materials | 13,496 | 16,033 | 37,410 |
| Source files | 1,156 (9%) | 6,620 (41%) | 24,443 (65%) |
| Codegraph | 198 | 338 | 21 |
| Round wall time | 510s | 172s | ~590s |

Source file tokens at 9% of materials is the lowest on record — expected for a **plan** review late in a long run (the diff shows plan revisions, not code; source files are the few existing files for context). Codegraph is contributing normally at 198 tokens.

Wall time of 510s at R6 is high relative to S11A (172s), largely because security was the slowest member at 483s. At R6 of a 6-round review with 51 accumulated findings, security is working through a large tracker context.

**Total S12A estimated cost (6 rounds × 4 members × ~16K tokens average):** ~384K input tokens. This is 2× S11A's 107K but still less than half of S9's 800K.

---

## 6. Structural Issues Unique to S12/S12A

### 6.1 Plan-review tracker has no hard block

The hard block enforcement added before S11A only covers **code reviews** (`review_type == "code"`). Plan reviews can still run to 6 rounds with 0% tracker resolution because:
- `resolved_count == 0` check is guarded by `review_type == "code"`
- Plan findings are designed to drive plan revision, so "all OPEN" is expected on early rounds

However, by R3+ with all findings still OPEN, the plan tracker becomes a re-flagging machine identical to the code-review failure pattern. Consider: a softer warning (not block) at plan R3+ when resolved_count remains 0 and High count ≥ 5.

### 6.2 The `--max-rounds` flag was missing

When S12A hit R6, the agent tried `--max-rounds 6` and got exit code 2. It then ran without the flag, hitting the forced-approval escalation clause. This is now fixed — `--max-rounds` is a valid CLI argument as of the post-session commit.

### 6.3 Sprint scope too large for plan-review convergence

S12A had 11 gap items across 4 categories (WAV upload, error typing, test coverage, deployment). Each gap touched multiple systems. 51 findings across 6 rounds is not a tracker failure — it reflects genuine plan incompleteness. The scope-to-rounds mismatch was predictable from the S12 retrospective recommendation: "large diff → more source file tokens; monitor R1 metrics."

### 6.4 Split-sprint pattern repeating

S11 → S11A replicated in S12 → S12A:

| Pattern | S11/S11A | S12/S12A |
|---------|----------|----------|
| Root sprint declared complete prematurely | Yes (tracker issues) | Yes (missing deliverables) |
| Gap sprint required | S11A: fix open Highs in code | S12A: implement undelivered items |
| Gap sprint plan-review rounds | 2 (code) | 6 (plan — much worse) |
| Root cause | Tracker discipline | Missing deliverable verification |

The `check-sprint-completion.py` step-0 enforcement (added this session) directly addresses the S12→S12A root cause.

---

## 7. What Worked

- **Diff-based rendering** held: 9% source-file share at S12A R6 despite a large sprint. Without it, R6 would likely exceed the S9 baseline.
- **Hard block** did not fire spuriously — plan reviews correctly bypass it.
- **Forced-approval escalation** functioned as intended: R6 got APPROVED rather than looping to R7 without resolution.
- **`round_wall_time_s`** correctly captures the full 510s round wall time (vs. the ~27s consolidator-only `elapsed_seconds`).
- **`--max-rounds` gap identified immediately** from the exit-code-2 error in the screenshot, fixed same session.

---

## 8. Recommendations for Sprint 13+

### Structural (template changes)

| Issue | Priority | Recommendation |
|-------|----------|----------------|
| Plan-review tracker warning | P2 | Add advisory warning (not block) at plan R3+ when resolved_count=0 AND findings_high≥3. Blocks are too strong for plan reviews; warnings may be enough. |
| `--max-rounds` now available | done | Agents should use `--max-rounds 7` proactively when sprint scope is large (>8 deliverables). |
| check-sprint-completion.py | done | Mandatory step 0 now enforced. |

### Sprint 13 process notes

1. **S12A plan has 9 open Highs at APPROVED** — the implementing agent must explicitly address each before calling code complete. Recommend: the agent reads `FINDINGS_Sprint12A.md` before implementing and maps every High to a specific implementation decision.
2. **Sprint 13 (library UI)** scope is narrow relative to S12. Target ≤2 plan-review rounds.
3. **Run `--auto-lenses` on code reviews** for S13 unless the diff touches `knowledge/` or `tests/` changes are significant.

---

## 9. Updated Cross-Sprint Metrics Trend

Source-file % of materials over time:

| Sprint | Source files % | Round count | Resolved % |
|--------|---------------|-------------|------------|
| S9     | 65%           | 5 (code)    | 0%         |
| S10    | 63%           | 2 (code)    | 67%        |
| S11    | 56%           | 4 (code)    | 0%         |
| S11A   | 41%           | 2 (code)    | 81%        |
| S12A   | 9%            | 6 (plan)    | 0%         |

The 9% figure is plan-review-specific (no code diff, few source files). Not directly comparable to code-review source-file percentages but confirms diff-based rendering is working. For code reviews, the trend from 65%→41% is holding.
