## Code Review: Sprint 20 - Lesson support for students without headphones (and iOS) (R1)

**Round:** 1  
**Verdict:** CHANGES_REQUESTED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Implementation Assessment
The implementation does not fully match the approved Sprint 20 iOS behavior. The remaining gaps are in browser classification and teacher-side controls.

### Code Quality
The code path is serviceable but several core entry points remain overgrown. The new protocol and UI branches were added into already large functions without enough isolation.

### Test Coverage
Coverage is not sufficient for the main Sprint 20 behavior. The client-side VAD, signalling, and iOS-specific flows still lack direct tests.

### Findings
- **[High]** iOS clients are not classified consistently as `supported` with `iosAecForced`, so some iOS browsers still fall back to degraded-phone handling. (File: `web/assets/browser.js`, Location: `isIOS`, `detectBrowser`) (Source: domain)
- **[High]** The teacher override UI cannot represent the full acoustic-profile state model, so `ios_forced` cannot be set or restored from the teacher side. (File: `web/assets/teacher.js`, Location: `renderEntry`) (Source: domain)
- **[High]** The teacher chat-mode chip remains interactive when the active acoustic profile is `ios_forced`, which violates the Sprint 20 rule that this state is locked on and non-interactive. (File: `web/assets/teacher.js`, Location: `updateChatChip`, `onAcousticProfileChanged`, `onPeerConnected`) (Source: domain)
- **[Medium]** The primary Sprint 20 client behavior has no direct test coverage. Teacher VAD-to-WS wiring, new signalling messages, the iOS self-check path, and `applyChatMode` debounce/reconnect behavior are not exercised. (Files: `web/assets/teacher.js`, `web/assets/signalling.js`, `web/assets/self-check.js`, `web/assets/student.js`; Locations: corresponding test coverage absent or incomplete) (Source: test_quality)
- **[Medium]** The WebSocket protocol tests do not cover all required Sprint 20 server paths. Unknown `entry_id` handling for `set_acoustic_profile`, explicit `headphones` and `speakers` lobby joins, and the invariant that teachers do not receive relayed `chatting_mode` are not asserted. (File: `server/tests/ws_acoustic_profile.rs`, Location: protocol coverage gaps) (Source: test_quality)
- **[Medium]** Core functions continued to grow past the project threshold, which makes the new Sprint 20 branches harder to reason about and harder to test. The main hotspots are `admit()`, `cleanup()`, `connectTeacher()`, `connectStudent()`, `join_lobby()`, `reject()`, and the large submit handler in `student.js`. (Files: `server/src/ws/lobby.rs`, `server/src/ws/mod.rs`, `web/assets/signalling.js`, `web/assets/student.js`) (Source: code_quality)
- **[Medium]** Login rate limiting is off by one relative to the configured threshold, and it no longer matches the signup limiter semantics after the PostgreSQL migration. (Files: `server/src/auth/password.rs`, `server/src/auth/rate_limit.rs`, Location: `record_and_check_limits`, `check_and_record`) (Source: security)
- **[Low]** `AcousticProfile::Unknown` can still serialize as `"unknown"` if normalization is bypassed, because the outbound invariant is not enforced at the view boundary. (Files: `server/src/ws/protocol.rs`, `server/src/state.rs`, Location: `AcousticProfile`, `LobbyEntry::view`) (Source: code_quality)
- **[Low]** Several VAD edge cases from the Sprint 20 plan are still untested, including `forceMode('on')` while already active, `suppress(false)` in default auto mode, and the hangover hysteresis-band case. (File: `web/assets/tests/vad.test.js`, Location: missing cases) (Source: test_quality)

### Excluded Findings
- `validate_prod_config` uses substring matching for localhost detection — Reason: low-severity hardening outside the Sprint 20 implementation path, with `sslmode=verify-full` still providing the primary control. (Source: security)
- `parse_env_missing_database_url_errors` mutates process-wide env vars without a serialization guard — Reason: test-only nondeterminism outside the reviewed feature scope. (Source: security)
- `IosForced` is trust-client advisory state — Reason: documented design with no current security consequence and no required code change. (Source: security)
- `Sprint 111` header typo in `history.rs` — Reason: non-functional documentation typo. (Source: code_quality)

### Required Changes
1. **File**: `web/assets/browser.js`  
   **Location**: `isIOS`, `detectBrowser`  
   **Current behavior**: Some iOS browsers, including Firefox on iOS and iPadOS desktop-mode cases, are not consistently classified as `supported + iosAecForced`.  
   **Required change**: Detect all iOS clients before degraded-phone branching and classify them as `tier: 'supported'` with `iosAecForced: true`.  
   **Acceptance criteria**: Automated coverage shows Safari iPhone, FxiOS, CriOS, and iPadOS desktop-mode UAs all resolve to `supported` and `iosAecForced: true`.

2. **File**: `web/assets/teacher.js`  
   **Location**: `renderEntry`  
   **Current behavior**: The teacher override control only represents `headphones` and `speakers`. `ios_forced` is collapsed and cannot be restored.  
   **Required change**: Make the override control represent all authoritative acoustic-profile states, including `ios_forced`, or provide an explicit restore path for `ios_forced`.  
   **Acceptance criteria**: A teacher can see, set, and restore `ios_forced` without losing that state through the UI.

3. **File**: `web/assets/teacher.js`  
   **Location**: `updateChatChip`, `onAcousticProfileChanged`, `onPeerConnected`  
   **Current behavior**: The chat-mode chip still cycles interactively while the active profile is `ios_forced`.  
   **Required change**: Lock the chip into the required always-on state when the session profile is `ios_forced` and block user cycling in that state.  
   **Acceptance criteria**: With `ios_forced` active, the chip is non-interactive and remains fixed in the required state across connect, reconnect, and profile-change events.

4. **File**: `web/assets/tests/teacher.test.js`, `web/assets/tests/signalling.test.js`, `web/assets/tests/self-check.test.js`, plus client tests for `student.js` behavior  
   **Location**: new and updated test cases  
   **Current behavior**: The main Sprint 20 client flows are not directly tested.  
   **Required change**: Add tests for teacher VAD-to-`chatting_mode`, signalling payloads and handlers, iOS self-check bypass behavior, and `applyChatMode` debounce/reconnect invariants.  
   **Acceptance criteria**: The test suite fails if these behaviors regress and includes explicit assertions for the Sprint 20 message shapes and UI state transitions.

5. **File**: `server/tests/ws_acoustic_profile.rs`  
   **Location**: new protocol-path tests  
   **Current behavior**: Several required server behaviors remain unasserted.  
   **Required change**: Add tests for unknown `entry_id` on `set_acoustic_profile`, explicit `headphones` and `speakers` lobby joins, and non-relay of `chatting_mode` back to the teacher.  
   **Acceptance criteria**: Each path has a dedicated automated test and the teacher non-relay case is asserted with a bounded no-message window.

6. **File**: `server/src/auth/password.rs`  
   **Location**: `record_and_check_limits`  
   **Current behavior**: The login limiter blocks one attempt earlier than the configured threshold and diverges from signup semantics.  
   **Required change**: Align the comparison with the INSERT-before-COUNT convention used in `server/src/auth/rate_limit.rs`.  
   **Acceptance criteria**: A test with a configured limit of `1` allows the first attempt and blocks the second in both login and signup flows.

### Recommendations
- Enforce the outbound `AcousticProfile::Unknown` invariant at `LobbyEntry::view()`.
- Split the oversized lobby, cleanup, signalling, and student submit functions into named helpers before the next feature pass.
- Add the remaining VAD edge-case tests so the state machine behavior is explicit.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| iOS behavior | domain | Sprint 20 iOS semantics are not fully implemented in browser and teacher clients |
| Client-side verification | test_quality, code_quality | Core Sprint 20 client paths are hard to trust because they are large and under-tested |
| Protocol coverage | test_quality | Several required server message paths still lack automated checks |
| Maintainability | code_quality | New behavior was added into already oversized functions |
| Auth correctness | security | Rate-limit semantics drifted and need to be realigned |