# Findings Tracker: Sprint 9 (code)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R1 | High | domain | plan-relies-conn | The plan relies on `conn.entry_id`, but `ConnContext` has no such field. The stated `HeadphonesConfirmed` lookup path... | OPEN |  | R1,R2,R3,R4,R5 |
| 2 | R1 | High | security | plan-does-not-specify | The plan does not specify a student-only role gate for `handle_headphones_confirmed`. The handler must reject non-stu... | OPEN |  | R1,R2,R3,R4,R5 |
| 3 | R1 | High | code_quality | session-ui | `session-ui.js` already exceeds the project module size limit. Adding `buildChatDrawer` there compounds the violation... | OPEN |  | R1,R2,R3,R4,R5 |
| 4 | R1 | High | test_quality | test-plan-omits-teacher | The test plan omits teacher-path coverage for `HeadphonesConfirmed` role rejection, omits teacher self-check property... | OPEN |  | R1,R2,R3,R4,R5 |
| 5 | R1 | Medium | domain | student-flow-does-not | The student flow does not explicitly state that `LobbyJoin` is sent before the user can trigger `HeadphonesConfirmed`... | OPEN |  | R1,R2,R3,R4,R5 |
| 6 | R1 | Medium | code_quality | handle-headphones-confirmed-plan | `handle_headphones_confirmed` is planned inline in `mod.rs`, but lobby mutations are already factored into `lobby.rs`... | OPEN |  | R1,R2,R3,R4,R5 |
| 7 | R1 | Medium | code_quality | toast-design-has-no | The toast design has no explicit cap on simultaneous visible toasts. The plan should bound stack size and test the ca... | OPEN |  | R1,R2,R3,R4,R5 |
| 8 | R1 | Medium | test_quality | plan-does-not-enumerate | The plan does not enumerate several core UI invariants in tests: toast auto-dismiss, self-check teardown stopping tra... | OPEN |  | R1,R2,R3,R4,R5 |
| 9 | R1 | Low | domain | teacher-self-check-persistence | The teacher self-check persistence scope is a product decision but is not documented. The plan should state that `ses... | OPEN |  | R1,R2,R3,R4,R5 |
| 10 | R1 | Low | security | teacher-self-check-sessionstorag | The teacher self-check `sessionStorage` flag is a UX-only convenience and not a trust boundary. The plan should state... | OPEN |  | R1,R2,R3,R4,R5 |
| 11 | R1 | Low | code_quality | new-js-modules-must | New JS modules must include the standard file header block required by project conventions. The plan does not say so.... | OPEN |  | R1,R2,R3,R4,R5 |
| 12 | R2 | Low | security | toast-text-safety-not | Toast text safety is not fully closed in the plan contract. The implementation spec does not explicitly require `.tex... | OPEN |  | R2,R3,R4,R5 |
| 13 | R2 | Low | test_quality | chat-drawer-test-plan | The chat drawer test plan covers suppressed sends but not the successful send path. The plan should require a case wh... | OPEN |  | R2,R3,R4,R5 |
| 14 | R2 | Low | code_quality | chat-drawer | The `chat-drawer.js` export contract is ambiguous. The plan names both a `window.sbChatDrawer` global and a local-dep... | OPEN |  | R2,R3,R4,R5 |
| 15 | R2 | High | code_quality | self-check-flow-allows | The self-check flow allows "Ready" before the headphones toggle is activated, which violates the plan and lets the st... | OPEN |  | R2,R3,R4,R5 |
| 16 | R2 | Medium | code_quality | teacher-self-check-early | The teacher self-check early-return path leaks the already-acquired media stream, leaving camera and microphone track... | OPEN |  | R2,R3,R4,R5 |
| 17 | R2 | Medium | domain | student-confirmation-can-be | Student confirmation can be accepted locally before the WebSocket handle exists, so `HeadphonesConfirmed` is never fl... | OPEN |  | R2,R3,R4,R5 |
| 18 | R2 | Medium | test_quality | server-test-coverage-missing | Server test coverage is missing the two promised `HeadphonesConfirmed` failure-path cases: duplicate confirm idempote... | OPEN |  | R2,R3,R4,R5 |
| 19 | R2 | Medium | test_quality | html-regression-tests-do | HTML regression tests do not assert removal of the old `#lobby-message-banner` and `#chat-panel` elements that the pl... | OPEN |  | R2,R3,R4,R5 |
| 20 | R2 | Low | test_quality | self-check-test-suite | The self-check test suite does not cover the null-stream degraded-render path, and protocol tests do not cover backwa... | OPEN |  | R2,R3,R4,R5 |
| 21 | R2 | Low | security | untagged | `.wrangler/` is untracked and not ignored, which risks committing Cloudflare cache artifacts. (File: `.wrangler/cache... | OPEN |  | R2,R3,R4,R5 |
| 22 | R2 | Low | code_quality | session-ui | The `session-ui.js` header does not document the exported `appendChatMsg` handle method. (File: `web/assets/session-u... | OPEN |  | R2,R3,R4,R5 |
| 23 | R3 | High | domain | live-session-headphones-status | Live session headphones status is wired to the wrong subject, so the UI shows incorrect state after session start. Th... | OPEN |  | R3,R4,R5 |
| 24 | R3 | High | domain | headphonesconfirmed-still-non-id | `HeadphonesConfirmed` is still non-idempotent at the protocol level. The server rebroadcasts unchanged lobby state on... | OPEN |  | R3,R4,R5 |
| 25 | R3 | High | code_quality | sbselfcheck | `sbSelfCheck.show` exceeds the project complexity limit and concentrates unrelated responsibilities in one public fun... | OPEN |  | R3,R4,R5 |
| 26 | R3 | Medium | domain | degraded-self-check-path | The degraded self-check path is still broken on media capture failure. Both call sites skip the overlay entirely when... | OPEN |  | R3,R4,R5 |
| 27 | R3 | Medium | code_quality | two-new-ui-builders | Two new UI builders still exceed the stated function-length cap. The extracted modules remain too large at the functi... | OPEN |  | R3,R4,R5 |
| 28 | R3 | Low | code_quality | new-confirm-headphones-lobby | The new `confirm_headphones` lobby API is missing module-level documentation updates. The header export list is stale... | OPEN |  | R3,R4,R5 |
| 29 | R3 | Low | test_quality | one-server-test-name | One server test name is false documentation. The test asserts `not_in_session` while the name claims `entry_not_found... | OPEN |  | R3,R4,R5 |
| 30 | R3 | Low | test_quality | protocol-tests-still-do | The protocol tests still do not cover backward-compatible deserialization of `LobbyEntryView` when `headphones_confir... | OPEN |  | R3,R4,R5 |
| 31 | R3 | Low | test_quality | session-ui-tests-do | The session UI tests do not clearly demonstrate coverage for the new `appendChatMsg` handle behavior, including post-... | OPEN |  | R3,R4,R5 |
| 32 | R4 | High | code_quality | web-assets-session-ui | `web/assets/session-ui.js` still exceeds the project module size limit, so the prior modularity finding is not fully ... | OPEN |  | R4,R5 |
| 33 | R4 | High | test_quality | self-check-suite-still | The self-check suite still misses the required ready-gating invariant and currently accepts confirm without the headp... | OPEN |  | R4,R5 |
| 34 | R4 | Medium | code_quality | buildchatdrawer-remains-too-larg | `buildChatDrawer` remains too large and mixes DOM construction, event wiring, unread-state handling, and message rend... | OPEN |  | R4,R5 |
| 35 | R4 | Medium | test_quality | client-side-lobbyjoin-headphones | The client-side `LobbyJoin` to `HeadphonesConfirmed` ordering fix still lacks a regression test that exercises wrappe... | OPEN |  | R4,R5 |
| 36 | R4 | Medium | test_quality | there-still-no-regression | There is still no regression test proving the real headphones state is propagated into `sbSessionUI.mount` from the t... | OPEN |  | R4,R5 |
| 37 | R4 | Low | test_quality | appendchatmsg-coverage-incomplet | `appendChatMsg` coverage is incomplete because post-`teardown()` safety is still untested. (File: `web/assets/tests/s... | OPEN |  | R4,R5 |
| 38 | R4 | Low | test_quality | duplicate-confirm-server-test | The duplicate-confirm server test uses a real 200 ms timeout for a negative assertion, which adds avoidable runtime a... | OPEN |  | R4,R5 |
| 39 | R5 | Medium | code_quality | runsessionlifecycle-exceeds-proj | `runSessionLifecycle` exceeds the project function-length cap at 65 lines. (File: `web/assets/session-ui.js`, Locatio... | OPEN |  | R5 |
| 40 | R5 | Low | code_quality | session-ui | `session-ui.js` header invariants no longer match the current size of `mount`. (File: `web/assets/session-ui.js`, Loc... | OPEN |  | R5 |
| 41 | R5 | Low | test_quality | duplicate-headphones-confirmed-s | `duplicate_headphones_confirmed_suppresses_second_broadcast` still uses a real 200 ms timeout for a negative assertio... | OPEN |  | R5 |
| 42 | R5 | Low | test_quality | chat-drawer-tests-do | The chat drawer tests do not exercise the close button click wiring. (File: `web/assets/tests/chat-drawer.test.js`) (... | OPEN |  | R5 |
