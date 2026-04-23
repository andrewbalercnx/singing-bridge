## Plan Review: Sprint 14 - In-session accompaniment playback + score view (R3)

**Round:** 3  
**Verdict:** APPROVED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Design Assessment
The plan is coherent and implementable. The architecture is stable across server, websocket, and frontend boundaries. The remaining issues are narrow and locally fixable.

### Completeness
The plan covers the main deliverables and most regression-prone paths. A few edge conditions and one state-transition path still need explicit specification or tests.

### Findings
- **[Medium]** Resume-from-pause token handling is internally inconsistent. The lifecycle section says resume reuses stored URLs, but the `AccompanimentPlay` decomposition revokes old tokens and issues new ones whenever a snapshot exists. The plan must split same-track resume from replacement play and specify different token behavior. (File: `PLAN_Sprint14.md`, Location: `§1 Media token lifecycle + handler decomposition`) (Source: domain)
- **[Medium]** `seekToBar` assumes `bar_coords` is sorted by bar number, but no server invariant or frontend sort guarantees that precondition. Binary search on unsorted input returns wrong coordinates silently. The plan must either validate strict bar ordering server-side or sort on receipt before binary search. (File: `web/assets/score-view.js`, Location: `seekToBar`; supporting source: `server/src/sidecar.rs`) (Source: code_quality)
- **[Low]** The plan does not specify how the rAF loop is cancelled on rapid state changes. A boolean stop flag is not sufficient to guarantee a single live loop. The plan should require storing the frame handle and calling `cancelAnimationFrame` before starting a new loop. (File: `web/assets/accompaniment-drawer.js`, Location: `§2`) (Source: code_quality)
- **[Low]** `AccompanimentPause` validation is not explicitly decomposed. The bounds table covers `position_ms`, but the handler steps document validation only for Play. The plan should add an explicit Pause validation step and name the message type in the malformed-position test. (File: `server/src/ws/accompaniment.rs`, Location: `handler decomposition`) (Source: code_quality)
- **[Low]** No websocket test pins idle `AccompanimentStop` or idle `AccompanimentPause` behavior. These retry-driven states are reachable and should be defined. (File: `server/tests/ws_accompaniment.rs`) (Source: test_quality)
- **[Low]** No Rust websocket test covers acceptance of `position_ms = 14_400_000`. Rejection at `14_400_001` is covered, but the exact upper boundary remains unpinned in the server validation path. (File: `server/tests/ws_accompaniment.rs`) (Source: test_quality)
- **[Low]** `seekToBar` behavior is unspecified when the target score image has not loaded and `naturalWidth` is zero. The plan should define deferral and re-application on image load. (File: `PLAN_Sprint14.md`, Location: `§3 score-view.js`) (Source: domain)

### Excluded Findings
No findings excluded.

### Recommendations
- Add explicit edge-case tests for idle Stop, idle Pause, and exact-boundary `position_ms`.
- Tighten frontend loop lifecycle language so the single-loop invariant is inspectable from the plan.
- Define score-view behavior for unloaded images to avoid silent highlight loss.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Playback state lifecycle | domain | Resume semantics need a distinct same-track path |
| Score navigation correctness | code_quality, domain | `seekToBar` needs stronger preconditions and load-state handling |
| Validation and regression coverage | code_quality, test_quality | Edge cases need explicit handler rules and boundary tests |
| Security posture | security | No security issues remain |