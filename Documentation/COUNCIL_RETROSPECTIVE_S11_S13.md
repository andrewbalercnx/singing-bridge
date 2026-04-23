# Council Process Retrospective — Sprints 11–13

_Generated 2026-04-23. Covers S11, S11A, S12, S12A, S13 with full cross-sprint comparison._

---

## Executive Summary

The period covers two code reviews (S11, S13), two plan reviews (S12, S12A), and one remediation code review (S11A). The headline result is a sharp regression in S13: 74 findings across 7 rounds with only R1 findings ever resolved (14% overall), the codegraph dropping back to an 21-token placeholder, and the sprint archived as COMPLETE with 63 OPEN findings. S11A remains the reference benchmark (100%, 2 rounds, 172s wall time). S13 is the worst code review on record by every measure.

Three structural issues are newly identified this period:
1. **Hard block gap**: once R1 has any resolutions, the hard block never fires again regardless of R2–R7 tracker state.
2. **Codegraph regression in S13**: 21 tokens (0% of materials) — the new JS/HTML files were not indexed, reverting to S9 behaviour.
3. **test_quality dominance on UI sprints**: 38 findings in S13 (51%), 35 OPEN at archive — the lens generates more findings than the agent can address.

---

## 1. Cross-Sprint Summary

| Sprint | Type  | Total | Rounds | Resolved | High open@close | Wall/round | Input/member |
|--------|-------|-------|--------|----------|-----------------|-----------|--------------|
| S11    | code  | 30    | 4      | 53%      | 6               | ~421s     | ~30,406      |
| S11A   | code  | 16    | 2      | **100%** | 0               | **172s**  | **17,788**   |
| S12    | plan  | 36    | 4      | 0%       | 9               | n/a       | n/a          |
| S12A   | plan  | 51    | 6†     | 100%‡    | 0               | 510s (R6) | 16,265 (R6)  |
| **S13**| code  | **74**| **7**  | **14%**  | **0**†          | 296s (R2) | 30,691 (R2)  |

† S12A forced-APPROVED at R6 (max-rounds exceeded). ‡ All 51 resolved at archive, not during review.
† S13 had 0 open Highs at R7 (forced-APPROVED) but 63 OPEN Medium/Low findings.

S13's 74 findings is a new record (previous worst: S8 at 54). Seven rounds is a new record.

---

## 2. Finding Volume by Round

### Sprint 11

| Round | New H | New M | New L | Resolved this round |
|-------|-------|-------|-------|---------------------|
| R1    | 5     | 5     | 2     | —                   |
| R2    | 0     | 4     | 1     | partial (tracker updated) |
| R3    | 1     | 3     | 2     | partial             |
| R4    | 0     | 3     | 4     | partial             |

S11 ended with 14 OPEN, 16 resolved (53%). Better than S8/S9/S11's 0%, but still left 6 open Highs requiring S11A.

### Sprint 13 — new findings per round

| Round | New H | New M | New L | Resolved this round |
|-------|-------|-------|-------|---------------------|
| R1    | 7     | 12    | 4     | **11** (9 ADDRESSED + 2 WONTFIX) |
| R2    | 3     | 6     | 4     | **0**               |
| R3    | 2     | 4     | 2     | **0**               |
| R4    | 3     | 4     | 1     | **0**               |
| R5    | 1     | 1     | 4     | **0**               |
| R6    | 1     | 5     | 4     | **0**               |
| R7    | 0     | 2     | 4     | **0**               |

The pattern is stark: R1 was worked properly (11 resolutions); R2–R7 were not (63 findings accumulated, all OPEN). This is the **partial-resolution hard block gap** — see section 5.1.

---

## 3. Lens Distribution

| Lens         | S11 | S11A | S13 | S13 OPEN |
|-------------|-----|------|-----|----------|
| test_quality | 6   | 6    | **38** | 35 (92%) |
| code_quality | 12  | 6    | 20  | 18 (90%) |
| domain       | 7   | 1    | 11  | 10 (91%) |
| security     | 5   | 3    | 5   | 0 (0%)   |

**Security** performed well in S13: only 5 findings, all resolved by archive. This is the correct behaviour for a UI-heavy sprint — the security attack surface was narrow.

**test_quality** is the dominant problem lens for S13. 38 findings (51% of total) on a sprint consisting entirely of HTML/JS UI — the lens correctly identified that a front-end feature with no test scaffolding is undertested. But the volume (38 vs 6 in S11A) overwhelmed the agent's capacity to address them. 35 remain OPEN.

**code_quality** generated 20 findings with 18 OPEN. High volume relative to sprint scope suggests the JS implementation had structural issues the agent didn't resolve.

---

## 4. Token Efficiency

| Sprint | Round | Input/member | Source files | Source % | Codegraph | Wall time |
|--------|-------|-------------|--------------|----------|-----------|-----------|
| S11A   | R2    | 17,788      | 6,620        | 41%      | 338       | 172s      |
| S12A   | R6    | 16,265      | 1,156        | 9%       | 198       | 510s      |
| S13    | R2    | 30,691      | 14,603       | **54%**  | **21**    | 296s      |

Two regressions in S13:

**Source file tokens back to 54%.** S13 introduced large JS and HTML files (`library.js`, `library.html`). Diff-based rendering was working (sprint base commit existed) but the new files are rendered in full on first appearance, inflating the source section. At R2 this is expected; the regression would be visible if R3+ metrics existed.

**Codegraph dropped to 21 tokens (0%).** The JS/HTML files were not indexed — the codegraph only covers Python, Rust, and SQL. S11A had 338 codegraph tokens providing structured context. In S13, reviewers had no codegraph signal at all, reverting to S9-era behaviour. This is fixable: `index-codebase.py` already has JS/TS indexing support (added in Sprint 1d5c749).

---

## 5. Structural Issues

### 5.1 Hard block gap: partial resolution exempts all future rounds

The code-review hard block fires when `resolved_count == 0`. In S13:
- R1: 11 findings resolved → `resolved_count = 11`, hard block disabled for all subsequent rounds
- R2–R7: 0 new resolutions each round → but `resolved_count` is still 11 (cumulative), so the block never fires

The block was designed to catch the S8/S9/S11 pattern where the tracker was never touched at all. It doesn't catch the S13 pattern: partial engagement at R1, then abandonment.

**Fix needed:** also check whether any findings raised in the *previous round* have been resolved before allowing the next round to proceed. Specifically: if round N > 2 and the count of findings from round N-1 with OPEN status equals the count added in round N-1 (i.e. nothing from last round was addressed), emit a warning or block.

### 5.2 Codegraph not covering JS/HTML

S13 introduced significant JS code. The codegraph showed 21 tokens (a near-empty DB response) because JS files are indexed but the DB hadn't been refreshed with the new files. The CLAUDE.md `--incremental` step at sprint start should have caught this, but it appears it was skipped or the new files were written after the last index run.

The PostToolUse hook auto-increments after Write/Edit, so this should self-correct during implementation. But the R2 metrics showing 21 tokens suggests the council ran before the hook had indexed the new files.

### 5.3 test_quality volume on UI sprints

38 test_quality findings for a front-end sprint is predictable: the lens correctly identifies that JS UI code has no test infrastructure. But the volume is too high to address in a single sprint. Options:

- Accept that UI sprints will have a high test_quality finding count and plan a dedicated test sprint
- Route `--lenses security,code_quality,domain` for the first UI sprint code review (skip test_quality until scaffolding exists), with explicit `--allow-no-security` exemption acknowledged
- Add a test scaffold deliverable to the plan before implementation

### 5.4 S13 archived COMPLETE with 63 OPEN findings

This is the most serious outcome. The sprint was declared COMPLETE and committed. The 63 OPEN findings represent known quality and test-coverage debt in the library UI. They will surface as regressions or failures in S14 and later sprints.

---

## 6. What Worked

- **S11A remains the benchmark**: 100% resolution, 2 rounds, 172s, 17,788 input/member. The process works when scope is narrow and the tracker is maintained.
- **Security lens self-limited correctly in S13**: 5 findings, all resolved. Security correctly identified the narrow attack surface of a UI sprint and didn't over-flag.
- **Plan-review tracker warning** (added this period): fires at plan R3+ with ≥3 open Highs. Would have fired on S12A R3 (9 open Highs, 0 resolved at that point).
- **`--max-rounds` flag**: now available. S12A's forced-approval via escalation clause was the trigger; the flag is now a clean override instead of hitting the guardrail silently.
- **check-sprint-completion.py**: step-0 enforcement is in place. Would have caught S12's incomplete implementation before S12A was needed.

---

## 7. Recommendations

### Immediate (S14 in progress)

| Issue | Action |
|-------|--------|
| Hard block gap | Extend block to fire when findings from round N-1 are all still OPEN at round N (separate from cumulative resolved count) |
| S13 OPEN findings | Before S14 code review, audit which S13 OPEN findings affect S14 scope and address them in FINDINGS_Sprint13.md |
| Codegraph for JS | Run `python3 scripts/index-codebase.py --incremental` after any Write/Edit of `.js`/`.html` files; verify codegraph tokens > 100 before first council run |

### Process (next council-dev sprint)

| Issue | Priority | Notes |
|-------|----------|-------|
| Hard block: per-round check | P1 | Fire when N-1 round findings are 100% still OPEN, separate from cumulative check |
| test_quality routing for UI sprints | P2 | Use `--auto-lenses` on first UI code review; if test infrastructure doesn't exist, test_quality findings are aspirational not actionable |
| Codegraph JS pre-check | P2 | Add assertion to council-review.py: if JS/TS files are in the diff and codegraph tokens < 50, warn that the DB may be stale |

---

## 8. Updated Cross-Sprint Trend

| Sprint | Resolved % | Rounds | Input/member | Src file % | Notes |
|--------|-----------|--------|-------------|------------|-------|
| S9     | 0%        | 5      | 39,957      | 65%        | Baseline failure |
| S10    | 67%       | 2      | 32,194      | 63%        | Reference success |
| S11    | 53%       | 4      | ~30,406     | ~56%       | Partial |
| S11A   | **100%**  | **2**  | **17,788**  | **41%**    | Reference benchmark |
| S12A   | 100%‡     | 6†     | 16,265      | 9%         | Forced; plan review |
| S13    | 14%       | 7      | 30,691      | 54%        | Worst code review |

The trend since S11A is negative for code reviews. S11A's efficiency came from narrow scope + full tracker discipline. S13 expanded scope to a full UI sprint without corresponding test infrastructure, and tracker discipline failed from R2 onwards.
