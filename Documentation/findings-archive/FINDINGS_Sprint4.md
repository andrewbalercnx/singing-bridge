# Findings Tracker: Sprint 4 (code)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R1 | High | test_quality | plan-leaves-encodingparamsforrun | The plan leaves `encodingParamsForRung` untested even though it is the spec-critical translation layer for bitrate fl... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 2 | R1 | High | test_quality | video-before-audio-degradation | The video-before-audio degradation invariant is only half-tested. The plan proves audio does not degrade early. It do... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 3 | R1 | High | test_quality | plan-adds-applyactions-as | The plan adds `applyActions` as the sole WebRTC mutation path without a unit-level test for sender selection, paramet... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 4 | R1 | Medium | code_quality | plan-overloads-web-assets | The plan overloads `web/assets/signalling.js` instead of splitting setup, adaptation, reconnect, and signal handling ... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 5 | R1 | Medium | code_quality | adapt | The `adapt.js` contract is internally inconsistent across exports, constants, state shape, and `floorViolated` signat... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 6 | R1 | Medium | code_quality | quality | The `quality.js` contract drifts across sections. `summariseStats` has conflicting signatures. `qualityTierFromSummar... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 7 | R1 | Medium | code_quality | reconnect-state-machine-effect | The reconnect state-machine effect vocabulary is inconsistent between the pure layer, integration layer, and tests. (... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 8 | R1 | Medium | test_quality | summarisestats-behavior-multiple | `summariseStats` behavior for multiple SSRCs of the same kind is unspecified and untested, which leaves bitrate aggre... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 9 | R1 | Low | test_quality | plan-does-not-directly | The plan does not directly test the exported pure helper `floorViolated`. (File: `PLAN_Sprint4.md`, Location: §3.1, §... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 10 | R1 | Low | test_quality | reconnect-tests-do-not | The reconnect tests do not explicitly cover `'closed'` from `'restarting'`. (File: `PLAN_Sprint4.md`, Location: §4.3,... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 11 | R1 | Low | test_quality | verifyvideofeedback-lacks-safari | `verifyVideoFeedback` lacks a Safari-like SDP fixture, so UA-specific capability parsing is not pinned. (File: `PLAN_... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 12 | R1 | Low | code_quality | file-header-convention-reference | The file-header convention reference points to a non-existent source of truth. (File: `PLAN_Sprint4.md`, Location: §4... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 13 | R2 | Medium | code_quality | adapt-loop-pseudocode-places | The adapt-loop pseudocode places `applyActions(res.actions, senders)` under the `signalling.js` section even though `... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 14 | R2 | Medium | test_quality | decidenextrung-contract-internal | The `decideNextRung` contract is internally inconsistent: §4.1.3 specifies a single `sample` input, while §4.4.2 pass... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 15 | R2 | Medium | code_quality | floorviolated-has-conflicting-pa | `floorViolated` has conflicting parameter contracts across sections. §3.1 defines it against ladder state and `floorB... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 16 | R2 | Medium | code_quality | encodingparamsforrung-has-confli | `encodingParamsForRung` has conflicting argument order across sections. §3.1 and the tests use `(ladderKey, rungIndex... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 17 | R2 | Medium | code_quality | summarisestats-has-conflicting-a | `summariseStats` has conflicting arity across sections. §3.1 specifies `(stats, prevStats)`, while §4.2.1 is titled a... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 18 | R2 | Medium | test_quality | newly-specified-multi-ssrc | The newly specified multi-SSRC tiebreak in `summariseStats` is still untested. The rule can be omitted in implementat... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 19 | R2 | Low | code_quality | referenced-file-header-conventio | The referenced file-header convention source does not exist. §4.10 points to `Documentation/conventions.md`, but that... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 20 | R2 | Low | test_quality | test-budget-overstates-adapt | The test budget overstates `adapt.test.js` coverage. §5.5 claims about 26 tests, but §5.2 only specifies about 21. Th... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 21 | R2 | Low | test_quality | sdp-munger-tests-misnumbered | The SDP munger tests are misnumbered in descending order, which makes the section internally inconsistent and harder ... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 22 | R3 | High | test_quality | plan-still-does-not | The plan still does not pin the spec-critical `minBitrate` branch in `encodingParamsForRung`. `studentAudio` rung 1 i... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 23 | R3 | High | test_quality | video-before-audio-degradation | The video-before-audio degradation invariant remains unproven for the teacher ladder. The current ordering tests cove... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 24 | R3 | Medium | code_quality | session-core | `session-core.js` still lacks a dedicated design section. Logic that belongs to `session-core.js` remains described u... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 25 | R3 | Medium | code_quality | plan-declares-session-core | The plan declares `session-core.js` browser-only while also planning a Node test suite for `applyActions`. The testab... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 26 | R3 | Medium | test_quality | test-strategy-cross-references | Test-strategy cross-references are misnumbered, so the regression matrix and exit criteria are not auditable as writt... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 27 | R3 | Low | code_quality | decidenextrung-heading-still-use | The `decideNextRung` heading still uses singular `sample` while the contract and body use `outboundSamples`. (File: `... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 28 | R3 | Low | test_quality | qualitytierfromsummary-still-lac | `qualityTierFromSummary` still lacks exact-threshold boundary coverage at the specified equality points. (File: `PLAN... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 29 | R4 | Medium | test_quality | multi-ssrc-tiebreak-test | The multi-SSRC tiebreak test is not observable because test #21 calls `summariseStats(..., null)`, which forces both ... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 30 | R4 | Medium | code_quality | 4 | §4.1.4 misstates the call path for `encodingParamsForRung`. The caller is `decideNextRung`, while `applyActions` only... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 31 | R4 | Medium | code_quality | reconnect-state-machine-does | The reconnect state machine does not specify the `healthy -> giveup` transition on `'failed'` or `'closed'`, but the ... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 32 | R4 | Low | test_quality | minbitrate-contract-studentaudio | The `minBitrate` contract for `studentAudio` rung 0 is ambiguous and untested. The plan does not say whether rung 0 s... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 33 | R4 | Low | security | plan-does-not-state | The plan does not state clearly that `minBitrate` is a Chrome-only UA hint and that the rung clamp is the cross-brows... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 34 | R4 | Low | code_quality | documented-applyactions-contract | The documented `applyActions` contract says rejections are swallowed and logged, but the pseudocode shows silent catc... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 35 | R4 | Low | security | impair | `impair.sh` accepts `$LOSS` and `$JITTER` without format validation before passing them to `sudo tc`. This is a local... | OPEN |  | R1,R2,R3,R4,R5,R6 |
| 36 | R5 | Medium | code_quality | decidenextrung-returns-next-stat | `decideNextRung` returns a `next` state that omits `role`, while `floorViolated` depends on `state.role`. This breaks... | OPEN |  | R1,R2,R3,R5,R6 |
| 37 | R5 | Medium | code_quality | startup-transceiver-pseudocode-s | The startup transceiver pseudocode sets `minBitrate: 96_000` for student audio at creation time, which contradicts th... | OPEN |  | R1,R2,R3,R5,R6 |
| 38 | R5 | Medium | code_quality | reconnect-state-machine-table | The reconnect state-machine table claims full `(phase, iceState)` coverage but leaves five pairs undefined. This allo... | OPEN |  | R1,R2,R3,R5,R6 |
| 39 | R5 | Low | test_quality | healthy-give-up-path | The `healthy -> give_up` path on ICE state `'closed'` is specified but has no dedicated reconnect test fixture. (File... | OPEN |  | R1,R2,R3,R5,R6 |
| 40 | R5 | Low | test_quality | submitted-plan-truncated-after | The submitted plan is truncated after mid-§5.2, so §5.3 to §5.5 cannot be audited and prior tracker items tied to tho... | OPEN |  | R1,R2,R3,R5,R6 |
| 41 | R6 | Medium | test_quality | submitted-plan-truncated-after | The submitted plan is truncated after §5.1, which prevents audit of §5.2–§5.5 and leaves failure-path coverage, regre... | OPEN |  | R1,R2,R3,R6 |
| 42 | R6 | Low | test_quality | multi-ssrc-tiebreak-fixture | The multi-SSRC tiebreak fixture does not specify T1 `packetsSent`, so the intended tiebreak source is not pinned dete... | OPEN |  | R1,R2,R3,R6 |
| 43 | R6 | Low | test_quality | reconnect-transition-restarting | The reconnect transition `restarting + 'closed' -> giveup` is still not visible as a named test in the submitted port... | OPEN |  | R1,R2,R3,R6 |
| 44 | R6 | Low | code_quality | decidenextrung-still-carries-red | `decideNextRung` still carries a redundant `role` parameter even though `role` is now invariant in the state object, ... | OPEN |  | R1,R2,R3,R6 |
| 45 | R6 | Low | code_quality | sample-example-4 | The `Sample` example in §4.2.1 includes a `role` field that is absent from the canonical type in §3.1, so the type co... | OPEN |  | R1,R2,R3,R6 |
| 46 | R1 | High | test_quality | maketeardown-regression-coverage | `makeTeardown` regression coverage is false assurance because the test exercises an inline replica instead of the pro... | OPEN |  | R1,R2,R3 |
| 47 | R1 | High | test_quality | decidenextrung-prev-outboundsamp | `decideNextRung(prev, outboundSamples, role)` exposes a `role` parameter that is ignored while callers and tests trea... | OPEN |  | R1,R2,R3 |
| 48 | R1 | Medium | code_quality | decidenextrung-119-lines-inlines | `decideNextRung` is 119 lines and inlines three separate decision systems. The function is past the project’s logic-s... | OPEN |  | R1,R2,R3 |
| 49 | R1 | Medium | code_quality | reconnect-state-carries-dead | Reconnect state carries dead API/state surface. `onIceStateEvent` accepts unused `nowMs`, and `retryCount` is increme... | OPEN |  | R1,R2,R3 |
| 50 | R1 | Medium | test_quality | reconnect-transition-coverage-in | Reconnect transition coverage is incomplete. The `watching + failed` and `restarting + failed` table rows are not dir... | OPEN |  | R1,R2,R3 |
| 51 | R1 | Medium | test_quality | teacher-html-coverage-omits | Teacher HTML coverage omits script load-order assertions even though teacher and student pages share the same depende... | OPEN |  | R1,R2,R3 |
| 52 | R1 | Medium | test_quality | quality | `quality.test.js` leaves `global.window` and `global.document` live if the assertion path throws, which can contamina... | OPEN |  | R1,R2,R3 |
| 53 | R1 | Medium | code_quality | summarisestats-73-lines-exceeds | `summariseStats` is 73 lines and exceeds the project’s logic-size limit. The current shape hides separate outbound an... | OPEN |  | R1,R2,R3 |
| 54 | R1 | Medium | security | hardcoded-google-stun-server | The hardcoded Google STUN server leaks client IPs to a third party. Sprint 4 reconnect behavior increases the frequen... | OPEN |  | R1,R2,R3 |
| 55 | R1 | Low | code_quality | wirebidirectionalmedia-accepts-u | `wireBidirectionalMedia` accepts an unused `role` parameter, which misstates the API surface and adds noise to call s... | OPEN |  | R1,R2,R3 |
| 56 | R1 | Low | test_quality | adaptation-tests-miss-reset | Adaptation tests miss the reset-and-re-fire path for `floorViolationEmitted`, so the one-shot guard is not verified a... | OPEN |  | R1,R2,R3 |
| 57 | R1 | Low | test_quality | quality-tests-miss-byte | Quality tests miss the byte-counter reset path and the inbound-only summary edge case, leaving two small summary/tier... | OPEN |  | R1,R2,R3 |
| 58 | R1 | Low | test_quality | prod-html-coverage-checks | Prod HTML coverage checks only absence of the debug marker and does not verify that the Sprint 4 UI elements are stil... | OPEN |  | R1,R2,R3 |
| 59 | R1 | Low | domain | several-rust-test-helpers | Several Rust test helpers use bare `unwrap()` in assertion-oriented parsing paths, which degrades failure diagnostics... | OPEN |  | R1,R2,R3 |
| 60 | R1 | Low | security | window | `window._handle` exposes the teacher signalling handle on global scope, enabling page-level scripts or extensions to ... | OPEN |  | R1,R2,R3 |
| 61 | R1 | Low | code_quality | adaptation-state-documentation-i | Adaptation state documentation is incomplete because `floorViolationEmitted` is not described in the file header/stat... | OPEN |  | R1,R2,R3 |
| 62 | R1 | Low | code_quality | threshold-names-adapt | Threshold names in `adapt.js` and `quality.js` look shared but carry intentionally different values, which invites in... | OPEN |  | R1,R2,R3 |
| 63 | R1 | Low | code_quality | scripts-indexers-typescript | `scripts/indexers/typescript.py` has an incorrect header path comment. (File: `scripts/indexers/typescript.py`, Locat... | OPEN |  | R1,R2,R3 |
| 64 | R2 | High | code_quality | teacher | `teacher.js` is missing the `window.signallingClient.connectTeacher({` call, leaving the file syntactically invalid a... | OPEN |  | R2,R3 |
| 65 | R2 | Medium | test_quality | review-materials-still-do | The review materials still do not make the `floorViolationEmitted` reset-and-re-fire test visible, so the failure-pat... | OPEN |  | R2,R3 |
| 66 | R2 | Low | test_quality | drive-helper-still-accepts | The `drive` helper still accepts a dead `role` parameter after the `decideNextRung` API change, which misstates test ... | OPEN |  | R2,R3 |
| 67 | R2 | Low | test_quality | reconnect-test-29-has | Reconnect test `#29` has a stale name that refers to a removed role parameter and no longer describes what the test p... | OPEN |  | R2,R3 |
| 68 | R3 | Medium | code_quality | connectteacher-connectstudent-ex | `connectTeacher` and `connectStudent` exceed the project’s 60-line logic limit and still inline too much event-handli... | OPEN |  | R3 |
| 69 | R3 | Medium | test_quality | reset-re-fire-path | The reset-and-re-fire path for `floorViolationEmitted` is still not tested, so regressions in the recovery branch can... | OPEN |  | R3 |
| 70 | R3 | Low | domain | shared-rust-test-helper | The shared Rust test helper `admit_pair` uses a bare JSON-path `unwrap()`, which weakens failure diagnostics in all r... | OPEN |  | R3 |
| 71 | R3 | Low | security | startsessionsubsystems-resolves | `startSessionSubsystems` resolves `window.sbAdapt`, `window.sbQuality`, and `window.sbReconnect` at call time instead... | OPEN |  | R3 |
| 72 | R3 | Low | code_quality | degrade-rtt-ms-reused | `DEGRADE_RTT_MS` is reused across modules for different thresholds, which invites incorrect assumptions during mainte... | OPEN |  | R3 |
| 73 | R3 | Low | code_quality | initladderstate-silently-coerces | `initLadderState` silently coerces invalid roles to `'teacher'` instead of rejecting bad input at the module boundary... | OPEN |  | R3 |
