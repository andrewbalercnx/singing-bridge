# Council Process Retrospective — Sprints 8–11 (+ 11A)

_Generated 2026-04-21. Covers Sprints 8–11 with cross-sprint comparison and process improvement outcomes._

---

## Executive Summary

The retrospective period covers four main sprints (S8–S11) plus a remediation sprint (S11A/111). The dominant problem across S8, S9, and S11 was **tracker discipline failure** — sprints archived with 0% resolved findings, defeating deduplication and compact representation. Sprint 10 and Sprint 11A demonstrated what the process looks like when it works: 2-round convergence, 67–81% resolution, zero open Highs at close.

Three structural improvements were shipped mid-period:
1. **Diff-based source file rendering** — 35% source-file token reduction by S11, sustained
2. **Metrics persistence** — `council/metrics_Sprint*.jsonl` now git-tracked; early-round row loss eliminated
3. **Hard block on R2+ with all-OPEN tracker** — replaces the ignored warning; confirmed effective in S11A

---

## 1. Cross-Sprint Summary

| Sprint | Total | Rounds | Resolved | High open | Wall time/round | Input/member |
|--------|-------|--------|----------|-----------|-----------------|--------------|
| S8     | 54    | 5      | **0%**   | 7         | ~590s           | n/a          |
| S9     | 42    | 5      | **0%**   | 10        | ~590s           | 39,957       |
| S10    | 42    | 2      | **67%**  | 0         | ~160s           | 32,194       |
| S11    | 30    | 4      | **0%**   | 6         | 421s            | 30,406       |
| S11A   | 16    | 2      | **81%**  | 0         | 172s            | 17,788       |

S10 and S11A are the reference sprints: narrow scope, tracker maintained, 2-round convergence.
S8, S9, S11 are the failure pattern: tracker abandoned, re-flagging every round, no compression benefit.

---

## 2. Token Efficiency Trend

Final-round snapshots (code review):

| | S9 R5 | S10 R2 | S11 R4 | S11A R2 |
|-|-------|--------|--------|---------|
| Input/member | 39,957 | 32,194 | 30,406 | **17,788** |
| Materials | 37,410 | 29,839 | 28,471 | 16,033 |
| Source files | 24,443 (65%) | 18,740 (63%) | 15,893 (56%) | **6,620 (41%)** |
| Codegraph | 21 | 248 | 337 | 338 |
| Round wall time | ~590s | ~159s | 421s | **172s** |

Source files dropped from 65% to 41% of materials across the period — diff-based rendering compounds as sprint scope narrows. Codegraph grew from a 21-token placeholder to a consistent ~335-token structured contribution.

Total sprint cost comparison:
- S9: 5 rounds × 4 members × 39,957 = **800K tokens**
- S11A: 2 rounds × 3 members × 17,788 = **107K tokens** (−87%)

---

## 3. Findings Resolution Rate

| Sprint | Resolved at close | Pattern |
|--------|-------------------|---------|
| S1–S3  | 100%              | Baseline — process working |
| S5–S6  | 72–95%            | Near-baseline |
| S4, S8, S9, S11 | 0%     | Tracker abandoned — editor fixing code but not updating tracker |
| S10    | 67%               | Tracker maintained; plan review ran properly |
| S11A   | 81% (13/16)       | Hard block enforcement active; best rate recorded |

The pattern is binary: either the tracker is maintained (and the sprint converges efficiently) or it is not (and every round re-flags the same issues). There is no middle ground observed.

---

## 4. Per-Round Finding Pattern

New findings per round across recent sprints:

| Sprint | R1 | R2 | R3 | R4 | R5 |
|--------|----|----|----|----|-----|
| S9     | 11 (4H) | 11 (1H) | 9 (3H) | 7 (2H) | 4 (0H) |
| S10    | 12 (6H) | 16 (2H) | — | — | — |
| S11    | 12 (5H) | 6 (0H) | 5 (1H) | 7 (0H) | — |
| S11A   | 8 (1H) | 8 (0H) | — | — | — |

Late-round High findings (S9 R3–R4, S11 R3) correlate with 0% tracker resolution — without deduplication, reviewers re-examine the same code in each round and find new angles on existing issues rather than verifying fixes.

---

## 5. Reviewer Latency

| Sprint | Slowest member | Elapsed | Output tokens | Pattern |
|--------|---------------|---------|---------------|---------|
| S9 R5  | code_quality  | 572s    | 575           | MCP query load |
| S10 R2 | security      | 131s    | 755           | Normal |
| S11 R4 | security      | 395s    | 770           | Anomalous — security active in R4 |
| S11A R2| security      | 157s    | 411           | Normal |

code_quality's S9 latency (572s) was resolved by diff-based rendering reducing its working set. Security's S11 R4 latency (395s) coincided with security finding new surfaces in R4 (#26: cache-control) after the implementation evolved in late rounds — this is correct behaviour for a late-breaking security concern, not a process fault.

---

## 6. Convergence Quality

| Sprint | Verdict | Condition met | Open Highs | Assessment |
|--------|---------|---------------|------------|------------|
| S9     | APPROVED | R4 (1H) → R5 (0H): 1 consecutive clean round | 10 | Loose — criterion requires 2 |
| S10    | APPROVED | R1 (6H) → R2 (2H, new): normal convergence | 0 | Sound |
| S11    | APPROVED | R3 (1H) → R4 (0H): 1 consecutive clean round | 6 | Loose — same pattern as S9 |
| S11A   | APPROVED | R1 (1H) → R2 (0H): 1 consecutive clean round | 0 | Acceptable — all 3 OPEN are Low |

S9 and S11 both converged with only 1 consecutive clean round. The configured criterion is "2 consecutive rounds without new Highs". The consolidator applied it loosely in both cases. Given that S11's 6 open Highs required a full remediation sprint, the stricter criterion should be enforced.

---

## 7. Process Improvements Shipped This Period

### Implemented

| Change | Impact |
|--------|--------|
| Diff-based source file rendering | Source files: 65% → 41% of materials; code_quality latency: 572s → 83s |
| Metrics git-tracked (`council/*` + negation) | Per-round rows now persist; early-round data loss eliminated |
| `round_wall_time_s` + `new_findings_by_lens` in metrics | Wall time no longer requires manual calculation; per-lens late-round attribution available |
| Metrics write confirmation to stderr | Silent failures immediately visible |
| Auto-lenses quorum guarantee | Narrow diffs (no test files) no longer abort with quorum error |
| Broader test path detection (`/test`, `spec`) | Rust/JS test files correctly trigger `test_quality` lens |
| Sprint identifier letter suffix (`11A`) | Remediation sprints have natural designators |
| **Hard block on R2+ with all-OPEN tracker** | 0% resolution pattern broken; S11A confirmed effective |

### Still Pending

| Issue | Priority | Notes |
|-------|----------|-------|
| Convergence criterion enforcement (2 consecutive clean rounds) | P2 | Consolidator applies it loosely; needs explicit check in code |
| Security latency investigation | P2 | 395s in S11 R4 was legitimate; monitor S12 |
| Model diversity (Haiku for mechanical checks) | P3 | Defer until S12 data |
| Consolidator-generated tracker updates | P3 | Would address root cause of tracker discipline failures |

---

## 8. Recommendations for Sprint 12

Sprint 12 is explicitly large (accompaniment library — audio, PDF, score sync). Risks:

1. **Large diff → more source file tokens** despite diff rendering. Monitor `est_mat_source_files_tokens` in R1 metrics; if >20K, consider running with explicit `--lenses` to scope the review.

2. **Tracker discipline under complexity pressure** — the hard block enforces R2+, but S12 may generate 40–60 findings across multiple subsystems. Resolution notes need to be specific enough for the consolidator to deduplicate. Keep resolution notes pointing to exact file:line locations.

3. **Plan review is essential** — S9's R1 had 4 High plan-level findings that should have been caught in plan review. S10's plan review ran 4 rounds and caught critical auth design issues before implementation. S12's scope warrants the same.

4. **Convergence criterion** — if the consolidator approves after only 1 clean round on a large sprint, that approval is provisional. Consider running an extra round manually if R(n-1) had High findings.

---

## 9. What Worked Well

- **Sprint 10 and Sprint 11A** demonstrate the process works when tracker discipline holds: 2-round convergence, high resolution rate, no open Highs at close
- **Auto-lenses** correctly routing domain out after R2 in S11 — domain found 7 findings in R1/R2 and exited cleanly
- **S11A R1 caught a real High** (#6: stale log-ID identity bug in `open_history_row`) that would have caused incorrect session history under race conditions
- **WONTFIX quality** improved significantly in S11A — both WONTFIXes have detailed engineering justifications with code references, not just "won't fix"
- **Codegraph** growing from 21 tokens (S9) to 337–515 tokens consistently — it is now a real contributor to materials context
