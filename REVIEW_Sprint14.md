## Plan Review: Sprint 14 - In-session accompaniment playback + score view (R5)

**Round:** 5  
**Verdict:** CHANGES_REQUESTED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Design Assessment
The plan is structurally strong. Full-snapshot broadcasts, token revocation, and client sync rules are mostly clear. Approval is blocked by unresolved spec contradictions and incomplete handler/test coverage in the accompaniment control path.

### Completeness
The plan covers the main deliverables. It still leaves several edge cases and invariants unspecified. The remaining gaps are concentrated in accompaniment handler semantics, resume behavior, and WebSocket test coverage.

### Findings
- **[Medium]** Resume semantics are internally contradictory. The lifecycle table says resume reuses stored token URLs, while `handle_accompaniment_play` unconditionally revokes old tokens and issues new ones, which forces URL churn and audio reload on resume. (File: `PLAN_Sprint14.md`, Location: §1 token lifecycle table and `handle_accompaniment_play` steps 4–5) (Source: Domain Expert)
- **[Medium]** The plan still contradicts itself on `respect_repeats`. The architecture section says Sprint 14 imposes no restriction, but component design still rejects `respect_repeats = true` and the UI still filters to `respect_repeats = false`. (File: `PLAN_Sprint14.md`, Location: proposed solution variant restriction paragraph and §1 ownership validation / teacher UI spec) (Source: Domain Expert)
- **[Medium]** Role-guard behavior is incompletely specified for accompaniment control handlers. `handle_accompaniment_pause` has no decomposition, `handle_accompaniment_stop` has no explicit `check_role` step, and Stop lacks a negative student-role WS test. This leaves authorization semantics underspecified on a state-clearing path. (File: `PLAN_Sprint14.md`, Location: §1 dispatch wiring / handler decomposition / test strategy) (Source: Code Quality Expert, Security Expert)
- **[Medium]** `seekToBar` relies on ordered `bar_coords`, but the plan does not require server-side sorting or assert the invariant before broadcast. Binary search on unsorted input returns incorrect bars. (File: `PLAN_Sprint14.md`, Location: §1 snapshot construction and §3 `score-view.js`) (Source: Code Quality Expert)
- **[Low]** The rAF stop mechanism is underspecified. The plan says the loop stops on pause, but does not require storing the rAF handle and calling `cancelAnimationFrame(handle)`. (File: `PLAN_Sprint14.md`, Location: §2 `accompaniment-drawer.js`) (Source: Code Quality Expert)
- **[Low]** Idle-state behavior is not fully pinned by WS tests. There is no test for `AccompanimentStop` or `AccompanimentPause` when no accompaniment state exists. (File: `PLAN_Sprint14.md`, Location: WebSocket roundtrip tests) (Source: Test Quality Expert)
- **[Low]** Server-side acceptance of `position_ms = 14_400_000` is not covered by a Rust WS test. Only rejection at `14_400_001` is explicitly tested at that layer. (File: `PLAN_Sprint14.md`, Location: WebSocket roundtrip tests) (Source: Test Quality Expert)
- **[Low]** `AccompanimentPause` malformed `position_ms` is not covered by a Rust WS test, even though Pause has its own validation path. (File: `PLAN_Sprint14.md`, Location: WebSocket roundtrip tests) (Source: Test Quality Expert)
- **[Low]** `seekToBar` behavior is unspecified when the target image has not loaded and `naturalWidth === 0`, which yields a collapsed highlight at `(0,0)`. (File: `PLAN_Sprint14.md`, Location: §3 `score-view.js`) (Source: Domain Expert)
- **[Low]** The WS test list has a numbering gap at `#10`, which creates ambiguity in the execution spec. (File: `PLAN_Sprint14.md`, Location: WebSocket roundtrip tests) (Source: Test Quality Expert)

### Excluded Findings
- Security recommendation to replace new `ErrorCode::Forbidden` with existing `NotOwner` was excluded. The underlying interoperability concern is valid, but the stronger issue is missing handler/test specification for role checks, not the choice of code name. (Source: Security Expert)

### Required Changes
1. **File**: `PLAN_Sprint14.md`  
   **Location**: §1 token lifecycle table and `handle_accompaniment_play` decomposition  
   **Current behavior**: Resume is described as reusing stored URLs, but Play always revokes and reissues tokens.  
   **Required change**: Make resume semantics consistent. Either add a same-asset same-variant resume branch that preserves stored URLs, or remove the reuse claim and explicitly specify reissue-on-resume behavior and client reload semantics.  
   **Acceptance criteria**: The lifecycle table and handler steps describe the same behavior, and the client behavior on resume follows directly from that text without contradiction.

2. **File**: `PLAN_Sprint14.md`  
   **Location**: proposed solution variant restriction paragraph, §1 ownership validation, teacher UI variant picker  
   **Current behavior**: One section says there is no `respect_repeats` restriction, while later sections still enforce one.  
   **Required change**: Remove the server rejection and UI filter, or restore the restriction everywhere with a clear justification.  
   **Acceptance criteria**: All sections describe the same variant eligibility rule.

3. **File**: `PLAN_Sprint14.md`  
   **Location**: §1 dispatch wiring / handler decomposition / WebSocket roundtrip tests  
   **Current behavior**: Pause and Stop are not fully decomposed, and Stop lacks an explicit student-role rejection test.  
   **Required change**: Add explicit step-by-step decomposition for `handle_accompaniment_pause` and `handle_accompaniment_stop`, with role check first and validation order defined. Add a WS test for student `AccompanimentStop` rejection.  
   **Acceptance criteria**: Each control handler has explicit role and validation steps, and the test list covers student rejection for Play, Pause, and Stop.

4. **File**: `PLAN_Sprint14.md`  
   **Location**: §1 snapshot construction and §3 `score-view.js`  
   **Current behavior**: `seekToBar` binary-searches `bar_coords` without a stated sort invariant.  
   **Required change**: Require `bar_coords` to be sorted ascending by `bar` before broadcast, and add an assertion in snapshot construction.  
   **Acceptance criteria**: The plan states the invariant explicitly and identifies where it is enforced.

### Recommendations
- Specify rAF cancellation via stored handle plus `cancelAnimationFrame`.
- Add WS coverage for idle Pause/Stop, Pause malformed bounds, and acceptance of `position_ms = 14_400_000`.
- Define `seekToBar` behavior before image load by deferring highlight rendering until `load`.
- Renumber the WS test list sequentially.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Handler semantics | Code Quality, Security | Pause/Stop behavior is underspecified |
| Authorization coverage | Security, Code Quality | Role checks must be explicit in handlers and tests |
| Playback state consistency | Domain | Resume behavior contradicts token lifecycle text |
| Variant rules | Domain | `respect_repeats` policy is internally inconsistent |
| Score navigation invariants | Code Quality, Domain | `seekToBar` depends on missing preconditions and load-state handling |
| Test coverage | Test Quality, Security | WS suite still misses important negative and boundary cases |