## Plan Review: Sprint 17 - Teacher dashboard + session UI redesign (R3)

**Round:** 3  
**Verdict:** APPROVED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Design Assessment
The plan is structurally sound. The route split, UI decomposition, and test strategy are coherent. Prior blocking issues are closed.

### Completeness
The deliverables are covered at a workable level. Remaining gaps are limited to test lock-in, small documentation drift, and one maintainability constraint that the plan does not yet enforce.

### Findings
- **[Medium]** `buildAccmpPanel` includes a score-viewer-toggle control in the design, but the test plan does not lock its presence or behavior. This leaves part of the public UI surface unguarded. (File: `PLAN_Sprint17.md`, Location: Test Strategy / `session-panels.test.js`) (Source: test_quality)
- **[Medium]** `accompaniment-drawer.js::mount()` is already 232 lines and the sprint touches this file without requiring a split. The plan does not enforce the project’s stated function-size discipline on a hot path that is already over budget. (File: `web/assets/accompaniment-drawer.js`, Location: `mount`, lines 73–305) (Source: code_quality)
- **[Low]** The session layout ASCII art caption still says `teacher: all 4`, while the canonical teacher control count is 5. The document contradicts itself. (File: `PLAN_Sprint17.md`, Location: Part 2 Target layout ASCII art caption) (Source: test_quality, domain, code_quality)
- **[Low]** The plan states session teardown clears `sessionStorage.removeItem('sb-accmp-open')`, but no test is assigned to verify that behavior. (File: `PLAN_Sprint17.md`, Location: Risks and mitigations / session UI tests) (Source: test_quality)
- **[Low]** The non-owner redirect path in `get_dashboard()` is not shown with the same cache-header invariant as the owner path, and the redirect tests do not assert it. The same risk exists for `get_session()`. (Files: `server/src/http/dashboard.rs`, `server/tests/http_dashboard.rs`, `server/src/http/teach.rs`) (Source: security)
- **[Low]** The plan leaves the `get_session()` / `get_teach()` handler structure open, which creates avoidable duplication risk around auth and cache-header behavior. (File: `server/src/http/teach.rs`, Location: proposed `get_session()` handler) (Source: code_quality)

### Excluded Findings
- Recording send/delete HTTP methods are not specified. Reason: speculative. The finding depends on an unverified implementation choice and does not show a demonstrated plan defect. (Source: security)

### Recommendations
Keep the plan prescriptive where it is protecting invariants. Avoid “either approach is acceptable” language on handler structure and test coverage boundaries.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Session UI spec text | test_quality, domain, code_quality | ASCII caption still contradicts canonical teacher button count |
| Session UI test coverage | test_quality | Interactive accompaniment-panel behavior needs full test lock |
| Frontend maintainability | code_quality | Existing `mount()` size violation should be corrected while touched |
| Auth/cache response handling | security, code_quality | Owner-only response invariants should be centralized and asserted |