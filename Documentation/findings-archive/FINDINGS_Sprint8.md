# Findings Tracker: Sprint 8 (code)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R1 | High | domain | breath-ring-source-semantics | Breath-ring source semantics are ambiguous across roles and can invert the intended meaning on the student view. The ... | OPEN |  | R1,R2,R3,R4,R5 |
| 2 | R1 | High | domain | remote-audio-playout-latency | Remote audio playout latency handling is incomplete. The plan omits the required `playoutDelayHint = 0` on incoming a... | OPEN |  | R1,R2,R3,R4,R5 |
| 3 | R1 | High | test_quality | existing-server-html-debug | The existing server HTML debug-marker test will break after the session DOM moves to `session-ui.js`, and the plan do... | OPEN |  | R1,R2,R3,R4,R5 |
| 4 | R1 | High | test_quality | muted-banner-feature-has | The muted-banner feature has no executable test coverage despite depending on mute state, RMS thresholds, timeout beh... | OPEN |  | R1,R2,R3,R4,R5 |
| 5 | R1 | High | code_quality | session-ui | `session-ui.js` ownership conflicts with `controls.js`, and the post-sprint control wiring path is undefined. The pla... | OPEN |  | R1,R2,R3,R4,R5 |
| 6 | R1 | Medium | code_quality | mountsessionui-scoped-as-monolit | `mountSessionUI` is scoped as a monolith with no decomposition plan and is likely to violate the project complexity b... | OPEN |  | R1,R2,R3,R4,R5 |
| 7 | R1 | Medium | code_quality | setremotestream-lifecycle-rules | `setRemoteStream` lifecycle rules are missing for stream replacement, analyser disconnection, and RAF cancellation. T... | OPEN |  | R1,R2,R3,R4,R5 |
| 8 | R1 | Medium | security | user-controlled-peer-identity | User-controlled peer identity rendering lacks an explicit `.textContent` invariant and lacks XSS-safety tests for bot... | OPEN |  | R1,R2,R3,R4,R5 |
| 9 | R1 | Medium | security | plan-references-same-origin | The plan references same-origin self-hosted fonts but also mentions preconnect behavior that only makes sense for ext... | OPEN |  | R1,R2,R3,R4,R5 |
| 10 | R1 | Medium | test_quality | several-ui-invariants-not | Several UI invariants are not testable as written because thresholds and transitions are unspecified. This affects Me... | OPEN |  | R1,R2,R3,R4,R5 |
| 11 | R1 | Medium | domain | muted-banner-trigger-definition | The muted-banner trigger definition is incomplete relative to track-enabled state and analyser placement. The plan mu... | OPEN |  | R1,R2,R3,R4,R5 |
| 12 | R1 | Medium | code_quality | updatepeername-remotename-remote | `updatePeerName`, `remoteName`, and `remoteRoleLabel` are underspecified. The call site, rendering target, and need f... | OPEN |  | R1,R2,R3,R4,R5 |
| 13 | R1 | Medium | code_quality | new-source-files-touched | New source files and touched coordinators are missing explicit header-block requirements and ownership updates in the... | OPEN |  | R1,R2,R3,R4,R5 |
| 14 | R1 | Low | code_quality | self-preview-mirror-should | The self-preview mirror should be expressed as a CSS class in `theme.css`, not an inline style. (File: `web/assets/se... | OPEN |  | R1,R2,R3,R4,R5 |
| 15 | R1 | Low | domain | say-button-semantics-should | The "Say" button semantics should be fixed in the plan so it cannot drift into push-to-talk without an ADR change. (F... | OPEN |  | R1,R2,R3,R4,R5 |
| 16 | R2 | High | domain | muted-banner-design-depends | The muted-banner design depends on analysing an unmuted raw local audio track while muting only the WebRTC sender tra... | OPEN |  | R2,R3,R4,R5 |
| 17 | R2 | Medium | code_quality | plan-leaves-post-sprint | The plan leaves the post-sprint fate of `controls.js` undefined by saying it either retains only `teardownMedia` re-e... | OPEN |  | R2,R3,R4,R5 |
| 18 | R2 | Medium | code_quality | new-file-specs-session | New file specs for `session-ui.js` and `theme.css` still omit the mandated source-file header block. (File: `PLAN_Spr... | OPEN |  | R2,R3,R4,R5 |
| 19 | R2 | Medium | code_quality | buildremotepanel-opts-takes-full | `buildRemotePanel(opts)` takes the full callback-bearing `opts` bag instead of a narrow rendering-only parameter set.... | OPEN |  | R2,R3,R4,R5 |
| 20 | R2 | Medium | code_quality | headphonesconfirmed-remains-unde | `headphonesConfirmed` remains underspecified. The plan defines initial state but not whether the chip is display-only... | OPEN |  | R2,R3,R4,R5 |
| 21 | R2 | Medium | test_quality | control-wiring-tests-incomplete | Control wiring tests are incomplete. The test plan does not specify click-to-callback coverage for mic/video controls... | OPEN |  | R2,R3,R4,R5 |
| 22 | R2 | Low | code_quality | buildbaselinestrip-audioctx-expo | `buildBaselineStrip(audioCtx)` exposes an `audioCtx` parameter with no stated responsibility. If the strip is render-... | OPEN |  | R2,R3,R4,R5 |
| 23 | R2 | Low | test_quality | fmttime-behavior-unspecified-neg | `fmtTime` behavior is unspecified for negative or non-finite input. The plan should either clamp to zero or explicitl... | OPEN |  | R2,R3,R4,R5 |
| 24 | R2 | Low | test_quality | test-plan-omits-smoke | The test plan omits smoke tests for Note and Say button callback wiring. (File: `web/assets/session-ui.js`, Location:... | OPEN |  | R2,R3,R4,R5 |
| 25 | R3 | Medium | code_quality | controls | `controls.js` disposal is incomplete because `deriveToggleView` still exists as a live exported utility with active t... | OPEN |  | R2,R3,R4,R5 |
| 26 | R3 | Medium | code_quality | teardown-omits-audioctx | Teardown omits `audioCtx.close()`, which leaves audio resources open and contradicts established project cleanup patt... | OPEN |  | R2,R3,R4,R5 |
| 27 | R3 | Medium | code_quality | plan-marks-localstream-as | The plan marks `localStream` as null-safe but also specifies muted-banner analysis through `createMediaStreamSource(o... | OPEN |  | R2,R3,R4,R5 |
| 28 | R3 | Medium | test_quality | runaudioloop-lacks-direct-unit | `runAudioLoop` lacks a direct unit test for the `onFrame(selfRms, remoteRms)` contract, so broken analyser-to-RMS wir... | OPEN |  | R2,R3,R4,R5 |
| 29 | R3 | Low | domain | onsaystub-semantics-contradictor | `onSayStub` semantics are contradictory: one section says it only logs intent for Sprint 8, while another says the ex... | OPEN |  | R3,R4,R5 |
| 30 | R3 | Low | code_quality | onnotestub-onsaystub-leak-sprint | `onNoteStub` and `onSayStub` leak sprint-local implementation detail into the public `mount` API and should be named ... | OPEN |  | R2,R3,R4,R5 |
| 31 | R3 | Low | test_quality | buildbaselinestrip | `buildBaselineStrip.setElapsed` has no integration test proving it formats and renders elapsed time through `fmtTime`... | OPEN |  | R2,R3,R4,R5 |
| 32 | R4 | High | domain | playoutdelayhint-0-becomes-unrea | `playoutDelayHint = 0` becomes unreachable once `#remote-audio` is removed, so the plan no longer guarantees the ADR-... | OPEN |  | R4,R5 |
| 33 | R4 | Medium | code_quality | runaudioloop-analyserself-analys | `runAudioLoop(analyserSelf, analyserRemote, onFrame)` does not define whether null analysers are valid inputs, even t... | OPEN |  | R2,R3,R4,R5 |
| 34 | R4 | Medium | code_quality | top-level-mount-orchestration | The top-level `mount` orchestration has no explicit complexity or size bound, despite the plan constraining the helpe... | OPEN |  | R2,R3,R4,R5 |
| 35 | R4 | Low | test_quality | test-plan-names-rmstoringstyle | The test plan names `rmsToRingStyle` as a direct test target even though the decomposition does not define it as an e... | OPEN |  | R2,R3,R4,R5 |
| 36 | R4 | Low | test_quality | teardown-assertion-audioctx | The teardown assertion for `audioCtx.close()` appears in lifecycle prose but is missing from the formal Test Strategy... | OPEN |  | R2,R3,R4,R5 |
| 37 | R4 | Low | code_quality | muted-banner-section-contains | The muted-banner section contains a duplicated “Banner trigger rules” block. (File: `PLAN_Sprint8.md`, Location: Mute... | OPEN |  | R2,R3,R4,R5 |
| 38 | R4 | Low | security | font-acquisition-step-does | The font acquisition step does not require pinned, integrity-checked package retrieval before committing WOFF2 assets... | OPEN |  | R2,R3,R4,R5 |
| 39 | R5 | Medium | code_quality | plan-claims-lint-comment | The plan claims a lint comment enforces the `mount` 40-line bound, but no lint configuration exists in the repository... | OPEN |  | R2,R3,R5 |
| 40 | R5 | Medium | test_quality | formal-test-strategy-omits | The formal Test Strategy omits direct `runAudioLoop` unit cases for null analysers, even though the decomposition def... | OPEN |  | R2,R3,R5 |
| 41 | R5 | Medium | test_quality | playoutdelayhint-0-guard-appears | The `playoutDelayHint = 0` guard appears in implementation prose but is not promoted into the formal regression guard... | OPEN |  | R2,R3,R5 |
| 42 | R5 | Low | security | font-acquisition-workflow-relies | The font acquisition workflow relies on `npm ci` but does not explicitly require a committed `package-lock.json`, whi... | OPEN |  | R2,R3,R5 |
| 43 | R5 | Low | test_quality | stream-replacement-test-checks | The stream-replacement test checks RAF uniqueness but does not assert disconnection of the old `MediaStreamAudioSourc... | OPEN |  | R2,R3,R5 |
| 44 | R5 | Low | test_quality | regression-strategy-does-not | The regression strategy does not explicitly record that the six existing `deriveToggleView` cases still pass after re... | OPEN |  | R2,R3,R5 |
| 45 | R5 | Low | code_quality | controls | `controls.test.js` becomes misleading if `controls.js` is deleted and the test imports from `session-ui.js`. (File: `... | OPEN |  | R2,R3,R5 |
| 46 | R2 | Medium | test_quality | runaudioloop-still-lacks-real | `runAudioLoop` still lacks a real unit test of the shipped function, including callback argument ordering and null-an... | OPEN |  | R2,R3 |
| 47 | R2 | Medium | test_quality | session-ui-integration-coverage | Session UI integration coverage is missing for actual behavior paths. The muted-banner tests do not call `checkAndUpd... | OPEN |  | R2,R3 |
| 48 | R2 | Medium | test_quality | low-latency-playout-requirement | The low-latency playout requirement has no regression guard. `playoutDelayHint = 0` is set in production code, but no... | OPEN |  | R2,R3 |
| 49 | R2 | Medium | code_quality | mount-remains-far-above | `mount` remains far above the committed size bound, so the implementation still fails its stated decomposition contra... | OPEN |  | R2,R3 |
| 50 | R2 | Medium | code_quality | svgicon-uses-innerhtml-which | `svgIcon` uses `innerHTML`, which contradicts the file-level invariant and the documented test strategy. The current ... | OPEN |  | R2,R3 |
| 51 | R2 | Low | security | font-asset-provenance-not | Font asset provenance is not reproducible or CI-enforced. The repository contains committed WOFF2 binaries and checks... | OPEN |  | R2,R3 |
| 52 | R2 | Low | code_quality | video-toggle-state-does | The video toggle state does not swap icons, leaving the `vid-off` asset unused and making the inactive visual state i... | OPEN |  | R2,R3 |
| 53 | R2 | Low | test_quality | remote-stream-replacement-covera | Remote-stream replacement coverage does not verify disconnection of the old `MediaStreamAudioSourceNode`, so audio-re... | OPEN |  | R2,R3 |
| 54 | R3 | Low | security | font-asset-provenance-not | Font asset provenance is not enforced. The repository has committed font checksums, but `package.json` has no pinned ... | OPEN |  | R3 |
