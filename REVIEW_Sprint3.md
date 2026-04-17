## Plan Review: Sprint 3 - video track + two-tile UI + browser gating (R2)

**Round:** 2  
**Verdict:** APPROVED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Design Assessment
The plan is coherent. The implementation strategy is stable. The trust model, browser gating, and Rust protocol handling are internally sound.

### Completeness
The plan covers the main deliverables and the critical regressions from R1. A small number of documentation and test gaps remain.

### Findings
- **[Medium]** `acquireMedia` has no direct Node test for the all-success path. The plan only pins the partial-failure cleanup path. Add one test that injects successful `audioImpl` and `videoImpl` and asserts the returned `{ audio, video }` shape. (File: `web/assets/signalling.js`, Location: `acquireMedia`) (Source: Test Quality Expert)
- **[Low]** The `browser.js` module surface is inconsistent with later sections. §3.1 lists only `detectBrowser`, while §4.2 and §5.4 require `BROWSER_FLOORS` and `BROWSER_UA_FIXTURES` exports. Add both exports to the authoritative module surface. (File: `PLAN_Sprint3.md`, Location: §3.1 module surface table) (Source: Code Quality Expert, Test Quality Expert)
- **[Low]** Risk table row R6 still cites the pre-flip test name. The correct guard is `test_lobby_join_without_tier_defaults_to_degraded`. (File: `PLAN_Sprint3.md`, Location: §6 risk table, R6 row) (Source: Code Quality Expert, Test Quality Expert, Security Expert)
- **[Low]** `orderCodecs` test coverage omits `null` entries even though the implementation explicitly guards for them. Add a test that fixes the contract for null preservation or null dropping. (File: `web/assets/tests/video.test.js`, Location: `orderCodecs` test suite) (Source: Test Quality Expert)
- **[Low]** Browser detection fixtures omit Chrome on iOS. Add a `CriOS` fixture and an assertion that it resolves to `degraded` via the iOS branch. (File: `web/assets/browser.js`, Location: `BROWSER_UA_FIXTURES`) (Source: Test Quality Expert)
- **[Low]** §4.12 uses mismatched prose and code for `truncate_to_chars`. The prose says `char_indices`, but the snippet uses `s.chars().take(max_chars).collect()`. Align the prose with the actual snippet. (File: `server/src/ws/lobby.rs`, Location: §4.12 `truncate_to_chars`) (Source: Domain Expert)

### Excluded Findings
- Duplicate `BROWSER_FLOORS` export concern with an added checklist note — Reason: merged into the broader module-surface inconsistency finding. (Source: Test Quality Expert)
- Duplicate R6 stale test-name concern — Reason: merged into one consolidated finding. (Source: Security Expert)

### Recommendations
Add the missing success-path and edge-case tests before implementation starts. Clean up the plan text so §3, §4, §5, and §6 describe the same contract.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Browser module contract | Code Quality, Test Quality | §3.1 must declare all required exports |
| Tier default guard naming | Code Quality, Test Quality, Security | R6 still references the old test name |
| Overall soundness of R2 revisions | Domain, Code Quality, Test Quality, Security | R1 issues were substantively resolved |