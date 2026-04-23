## Code Review: Sprint 17 - Teacher dashboard + session UI redesign (R2)

**Round:** 2  
**Verdict:** CHANGES_REQUESTED  
**Review Method:** Council of Experts (3 reviewers + consolidator)

### Implementation Assessment
The implementation matches the approved server-side security model. The client-side delivery is incomplete against the stated plan.

### Code Quality
The new session and accompaniment UI surface is functional but not well-factored. Public server helpers also expose undocumented APIs.

### Test Coverage
Coverage is materially incomplete. The stated Node-side test strategy is not implemented.

### Findings
- **[High]** Required Node test files are missing for the new public UI and dashboard surface. This leaves planned behavior unverified, including the `buildAccmpPanel` score-toggle contract from prior finding #19. (Files: `web/assets/tests/session-panels.test.js`, `web/assets/tests/dashboard.test.js`, `web/assets/tests/accompaniment-drawer.test.js`) (Source: test_quality)
- **[Medium]** `accompaniment-drawer.js::mount()` remains oversized and still combines construction, wiring, media lifecycle, state sync, and teardown in one function. This is the same unresolved complexity issue tracked in prior finding #20. (File: `web/assets/accompaniment-drawer.js`, Location: `mount`) (Source: code_quality)
- **[Medium]** `session-ui.js::mount()` now exceeds its stated orchestrator boundary and no longer matches the file’s own design contract. (File: `web/assets/session-ui.js`, Location: `mount`) (Source: code_quality)
- **[Medium]** New public HTTP helpers and handler exports lack docstrings. The module boundary is unclear. (Files: `server/src/http/teach.rs`, `server/src/http/dashboard.rs`, Location: `ensure_slug_exists`, `is_owner`, `serve_html`, `set_private_headers`, `inject_debug_marker`, `get_dashboard`) (Source: code_quality)
- **[Medium]** The `panelEl` boundary is misnamed and shape-unsafe. The code expects a control handle, not a DOM element. (Files: `web/assets/accompaniment-drawer.js`, `web/assets/session-panels.js`, Location: `mount`, `buildAccmpPanel`) (Source: code_quality)
- **[Low]** The accompaniment panel API is semantically inconsistent. `setTrackName()` is used to display playback state text. (Files: `web/assets/session-panels.js`, `web/assets/accompaniment-drawer.js`) (Source: code_quality)
- **[Low]** The session layout ASCII caption still reports the wrong teacher control count. This leaves prior finding #21 open. (File: `PLAN_Sprint17.md`) (Source: test_quality)
- **[Low]** `sessionStorage` persistence for `sb-accmp-open` still lacks explicit test coverage. This leaves prior finding #22 open. (File: `web/assets/tests/session-ui.test.js`) (Source: test_quality)

### Excluded Findings
No findings excluded.

### Required Changes
1. **File**: `web/assets/tests/session-panels.test.js`  
   **Location**: new file  
   **Current behavior**: The file does not exist. Planned tests for `buildSelfPip`, `buildAccmpPanel`, `buildIconBar`, and the score-toggle contract are absent.  
   **Required change**: Create the file and add the planned DOM-builder coverage, including all documented `buildAccmpPanel` setters and presence of the score-toggle control.  
   **Acceptance criteria**: The test file exists and verifies `buildSelfPip`, teacher/student `buildIconBar`, all `buildAccmpPanel` setters, and a `scoreToggleBtn` with `aria-label="Toggle score viewer"`.

2. **File**: `web/assets/tests/dashboard.test.js`  
   **Location**: new file  
   **Current behavior**: The file does not exist. Planned dashboard coverage is absent.  
   **Required change**: Create the file and add tests for XSS-safe rendering and independent failure handling of recordings and library fetches.  
   **Acceptance criteria**: Tests verify server-supplied text is rendered via text nodes, `GET /api/recordings` failure does not suppress the library panel, and `GET /library/assets` failure does not suppress the recordings panel.

3. **File**: `web/assets/tests/accompaniment-drawer.test.js`  
   **Location**: `panelEl` path coverage  
   **Current behavior**: Existing tests do not cover the non-null `panelEl` branch.  
   **Required change**: Add positive-path tests for inline panel wiring, pause interaction, seek interaction, and metadata-driven duration updates.  
   **Acceptance criteria**: Tests exercise a provided panel handle and verify pause behavior, seek behavior, and `loadedmetadata` calling the duration setter.

4. **File**: `web/assets/accompaniment-drawer.js`  
   **Location**: `mount`  
   **Current behavior**: One function owns multiple responsibilities and the `panelEl` boundary is misleading.  
   **Required change**: Split `mount()` into focused helpers and rename or validate the panel-handle contract at entry.  
   **Acceptance criteria**: `mount()` is reduced to composition logic, helper boundaries are explicit, and the inline-panel dependency is named or asserted as a handle rather than an element.

5. **File**: `web/assets/session-ui.js`  
   **Location**: `mount`  
   **Current behavior**: The orchestrator exceeds the stated thin-composition limit.  
   **Required change**: Extract shell assembly and teacher-only accompaniment wiring into helpers.  
   **Acceptance criteria**: `mount()` returns to a thin orchestration role consistent with the file contract.

6. **File**: `server/src/http/teach.rs`, `server/src/http/dashboard.rs`  
   **Location**: exported helpers and handler  
   **Current behavior**: Public functions are undocumented.  
   **Required change**: Add `///` docstrings or reduce visibility where public export is unnecessary.  
   **Acceptance criteria**: Every retained public helper and handler has concise API documentation or is no longer public.

### Recommendations
Rename the playback-state setter to match its actual contract, or split state text from track-name display.  
Update `PLAN_Sprint17.md` so the session layout caption reflects five teacher controls.  
Add explicit `sessionStorage` persistence tests for `sb-accmp-open`.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Server security | security | Auth and cache-header invariants are correctly implemented |
| Test completeness | test_quality | Planned Node-side coverage is missing and blocks approval |
| Session/accompaniment UI maintainability | code_quality, consolidator | New UI surface is not sufficiently factored |
| Public API clarity | code_quality, consolidator | Exported boundaries and naming need tightening |