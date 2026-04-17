## Code Review: Sprint 3 - video track + two-tile UI + browser gating (R1)

**Round:** 1  
**Verdict:** CHANGES_REQUESTED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Implementation Assessment
The implementation is structurally aligned with the approved plan. The main blockers are coverage gaps around browser gating behavior.

### Code Quality
The code is generally clear and conservative. A few low-risk cleanup items remain in the Rust WebSocket path and supporting constants.

### Test Coverage
Coverage is broad across the new browser helpers, signalling flow, and WebSocket tier handling. It is not yet sufficient for the browser-gating edge cases and a few critical UI/media regressions.

### Findings
- **[High]** The unworkable feature-gate path for `hasGetUserMedia === false` is not independently tested. A regression in that branch would allow blocked browsers through the gate. (File: `web/assets/tests/browser.test.js`, Location: feature-absent gating tests) (Source: test_quality)
- **[High]** Android WebView detection via the `; wv)` marker is untested. A common in-app browser class can bypass the intended unworkable classification without a fixture covering it. (Files: `web/assets/browser.js`, `web/assets/tests/browser.test.js`, Location: in-app WebView detection and fixtures) (Source: test_quality)
- **[Medium]** The WebSocket integration tests only exercise `"tier":"degraded"`. They do not verify end-to-end handling for `"supported"` or `"unworkable"`. (Files: `server/tests/ws_lobby.rs`, `server/tests/ws_lobby_tier.rs`, Location: lobby join integration tests) (Source: test_quality)
- **[Medium]** The served HTML tests do not assert `muted` on `#local-video`. Removing that attribute would cause immediate self-audio feedback and the regression would be silent. (File: `server/tests/http_teach_debug_marker.rs`, Location: student and teacher page assertions) (Source: test_quality)
- **[Medium]** `teardownMedia` is only tested with fully populated media state. Null or partial-init inputs are unverified. (File: `web/assets/tests/signalling.test.js`, Location: `teardownMedia` tests) (Source: test_quality)
- **[Medium]** `acquireMedia` is only tested for video-phase failure. Audio-phase failure propagation is unverified. (File: `web/assets/tests/signalling.test.js`, Location: `acquireMedia` tests) (Source: test_quality)
- **[Medium]** `truncate_to_chars` does unnecessary work on oversized inputs. It performs two character scans and allocates a new `String` instead of truncating in place. (File: `server/src/ws/lobby.rs`, Location: `truncate_to_chars`) (Source: domain)
- **[Low]** `tier_reason` lacks the field-level byte cap applied to the other lobby string fields. Oversized values are silently truncated after allocation and traversal instead of being rejected consistently. (File: `server/src/ws/mod.rs`, Location: `handle_lobby_join`) (Source: domain, security)
- **[Low]** `truncate_to_chars` has no direct unit test that pins exact boundary behavior independently of WebSocket integration coverage. (File: `server/src/ws/lobby.rs`, Location: `truncate_to_chars`) (Source: test_quality)
- **[Low]** Android tablet classification is not covered by browser fixtures. (File: `web/assets/tests/browser.test.js`, Location: `detectDevice` coverage) (Source: test_quality)
- **[Low]** The in-session control button and tile container DOM is not pinned by server HTML tests. (File: `server/tests/http_teach_debug_marker.rs`, Location: page structure assertions) (Source: test_quality)
- **[Low]** `block-notice` and `degraded-notice` are not asserted in served student HTML despite being required by the landing-page gating flow. (File: `server/tests/http_teach_debug_marker.rs`, Location: student page assertions) (Source: test_quality)
- **[Low]** `AdmitOutcome::NoRoom` is dead code. The enum variant is never constructed because the function returns before the outcome match when no room is available. (File: `server/src/ws/lobby.rs`, Location: `admit`) (Source: code_quality)
- **[Low]** `MAX_TIER_REASON_LEN` is a misleading name for a character-count limit. (File: `server/src/ws/protocol.rs`, Location: constant definition) (Source: code_quality)

### Excluded Findings
- Third-party STUN disclosure to Google — Reason: valid product/privacy concern, but not a defect in the Sprint 3 implementation and not a review blocker for this change set. (Source: security)
- `server/src/ws/mod.rs` header export comment is incomplete — Reason: documentation nit with negligible impact. (Source: code_quality)

### Required Changes (if CHANGES_REQUESTED)
1. **File**: `web/assets/tests/browser.test.js`  
   **Location**: feature-gating tests  
   **Current behavior**: The unworkable path is only tested with `hasRTCPeerConnection: false`.  
   **Required change**: Add a test case with `hasRTCPeerConnection: true` and `hasGetUserMedia: false` and assert `tier === 'unworkable'`.  
   **Acceptance criteria**: The test suite fails if the `hasGetUserMedia === false` branch no longer produces `unworkable`.

2. **File**: `web/assets/tests/browser.test.js`  
   **Location**: in-app WebView fixture coverage  
   **Current behavior**: No Android WebView UA fixture exercises the `; wv)` marker.  
   **Required change**: Add an Android WebView fixture and assert both `isInAppWebView === true` and `tier === 'unworkable'`.  
   **Acceptance criteria**: The test suite fails if `; wv)` is no longer recognized as an in-app WebView or no longer maps to `unworkable`.

3. **File**: `server/tests/ws_lobby.rs`, `server/tests/ws_lobby_tier.rs`  
   **Location**: lobby join integration tests  
   **Current behavior**: Only `"degraded"` is covered end to end.  
   **Required change**: Add integration coverage for `"supported"` and `"unworkable"` round-trip behavior.  
   **Acceptance criteria**: Teacher-visible lobby state preserves both values exactly.

4. **File**: `server/tests/http_teach_debug_marker.rs`  
   **Location**: student and teacher page assertions  
   **Current behavior**: `playsinline` is checked, but `muted` on `#local-video` is not.  
   **Required change**: Assert that the `#local-video` element includes `muted`.  
   **Acceptance criteria**: The tests fail if `muted` is removed from the local preview video.

### Recommendations
- Add direct unit tests for `truncate_to_chars` and switch it to in-place truncation with `char_indices`.
- Add signalling tests for partial media teardown and audio-acquisition failure.
- Add HTML assertions for control buttons, tile containers, and browser-gating notice elements.
- Remove dead `AdmitOutcome::NoRoom` or make it reachable by design.
- Align `tier_reason` length handling with the other user-supplied fields.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|------------------|-----------|
| Browser gating tests | Test Quality, Consolidator | Critical unworkable branches are not fully pinned |
| Tier reason length handling | Domain, Security | Inconsistent field validation and unnecessary oversized-input work |
| Rust WebSocket quality | Domain, Code Quality | Small cleanup and efficiency issues in lobby handling |
| HTML and signalling regression tests | Test Quality, Consolidator | Important UX and media behaviors are under-tested |