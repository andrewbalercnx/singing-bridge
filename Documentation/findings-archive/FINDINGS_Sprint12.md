# Findings Tracker: Sprint 12 (plan)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R1 | High | security | sidecar-trust-defined-only | Sidecar trust is defined only by network placement, and `SIDECAR_URL` is unrestricted. This creates an unauthenticate... | OPEN |  | R1,R2,R3,R4 |
| 2 | R1 | High | security | accompaniment-asset-delivery-aut | Accompaniment asset delivery auth is undefined for WAV blobs, and the student page-fetch path is not specified consis... | OPEN |  | R1,R2,R3,R4 |
| 3 | R1 | High | domain | live-score-following-not | Live score following is not fully specified. The plan has no continuous client-side time advancement between teacher ... | OPEN |  | R1,R2,R3,R4 |
| 4 | R1 | High | test_quality | tempo-bar-mapping-rules | Tempo and bar-mapping rules are incomplete. `tempo_pct` has no enforced valid range, `tempo_pct=0` is unguarded, the ... | OPEN |  | R1,R2,R3,R4 |
| 5 | R1 | High | security | resource-bounds-missing-new | Resource bounds are missing on the new processing path. The sidecar endpoints have no explicit upload-size cap, `/ras... | OPEN |  | R1,R2,R3,R4 |
| 6 | R1 | Medium | test_quality | new-websocket-protocol-variants | New WebSocket protocol variants are added without explicit serde roundtrip coverage and without enumerated JS scenari... | OPEN |  | R1,R2,R3,R4 |
| 7 | R1 | Medium | test_quality | sidecar-test-error-contracts | Sidecar test and error contracts are underspecified. The mock fixture scope, per-method `SidecarClient` coverage, and... | OPEN |  | R1,R2,R3,R4 |
| 8 | R1 | Medium | code_quality | upload-type-detection-cross | Upload type detection and cross-asset validation rules are not stated precisely. The plan does not define signature p... | OPEN |  | R1,R2,R3,R4 |
| 9 | R1 | Low | domain | playback-sync-rationale-overstat | The playback-sync rationale overstates precision. The design tolerates bounded start-offset error rather than true ze... | OPEN |  | R1,R2,R3,R4 |
| 10 | R2 | High | domain | client-side-bar-lookup | Client-side bar lookup uses the wrong tempo-scaling inversion, so score following will select the wrong bar at any no... | OPEN |  | R2,R3,R4 |
| 11 | R2 | High | security | student-delivery-accompaniment-a | Student delivery of accompaniment assets is still unspecified for page images and bar data. `AccompanimentState` carr... | OPEN |  | R2,R3,R4 |
| 12 | R2 | Medium | code_quality | new-memory-media-token | The new in-memory media token store has no cap, eviction rule, or expiry sweep. This introduces an unbounded resource... | OPEN |  | R2,R3,R4 |
| 13 | R2 | Medium | security | sidecar-allowlist-semantics-unde | Sidecar allowlist semantics are underspecified. The plan does not require exact parsed-host comparison for `SIDECAR_H... | OPEN |  | R2,R3,R4 |
| 14 | R2 | Medium | test_quality | sidecar-protocol-test-plan | The sidecar and protocol test plan still has contract gaps. Missing cases include `/synthesise` upper tempo boundary ... | OPEN |  | R2,R3,R4 |
| 15 | R2 | Medium | test_quality | media-token-invariants-specified | Media-token invariants are specified in prose but not covered by tests. Single-use page-blob tokens, invalidation aft... | OPEN |  | R2,R3,R4 |
| 16 | R2 | Low | security | get-api-media-token | `GET /api/media/<token>` distinguishes expired from unknown tokens with different status codes. That creates a token-... | OPEN |  | R2,R3,R4 |
| 17 | R2 | Low | test_quality | js-clock-advancement-scenario | The JS clock-advancement scenario does not specify fake-timer use, so the planned test can become flaky and violate t... | OPEN |  | R2,R3,R4 |
| 18 | R2 | Low | test_quality | json-size-limits-bar | JSON size limits for `bar_coords_json` and `bar_timings_json` are specified but not represented in handler-level test... | OPEN |  | R2,R3,R4 |
| 19 | R3 | High | security | accompanimentplay-ownership-vali | `AccompanimentPlay` ownership validation does not scope the asset and variant to the authenticated teacher. This perm... | OPEN |  | R3,R4 |
| 20 | R3 | Medium | test_quality | synthesise-parameter-boundary-te | `/synthesise` parameter-boundary tests use the wrong error code and the error table lacks a dedicated code for invali... | OPEN |  | R3,R4 |
| 21 | R3 | Medium | security | expired-media-token-status | The expired-media-token status code is contradictory across the plan. Design and tests require `404`, while failure-p... | OPEN |  | R3,R4 |
| 22 | R3 | Medium | domain | natural-track-end-behavior | Natural track-end behavior is unspecified. If the audio element ends naturally, server playback state can remain stal... | OPEN |  | R3,R4 |
| 23 | R3 | Medium | security | sidecar-secret-required-producti | `SIDECAR_SECRET` is required in production but has no minimum-length validation. This weakens the sidecar trust bound... | OPEN |  | R3,R4 |
| 24 | R3 | Low | test_quality | planned-size-limit-tests | The planned size-limit tests for `bar_coords_json` and `bar_timings_json` target the wrong endpoint and do not exerci... | OPEN |  | R3,R4 |
| 25 | R3 | Low | test_quality | client-clock-skew-correction | The client clock-skew correction cap at `±500 ms` is untested. (File: `PLAN_Sprint12.md`, Location: `accompaniment-dr... | OPEN |  | R3,R4 |
| 26 | R3 | Low | domain | binary-search-behavior-when | Binary-search behavior when no bar satisfies the lookup condition at track start is unspecified. (File: `PLAN_Sprint1... | OPEN |  | R3,R4 |
| 27 | R3 | Low | security | azure-sas-permission-scope | Azure SAS permission scope is unspecified. The plan must require read-only blob tokens. (File: `PLAN_Sprint12.md`, Lo... | OPEN |  | R3,R4 |
| 28 | R4 | Medium | domain | respect-repeats-1-variants | `respect_repeats=1` variants use a single parent-level `bar_timings_json` that reflects only one linear pass, so scor... | OPEN |  | R4 |
| 29 | R4 | Medium | test_quality | empty-but-non-null | An empty but non-null `bar_timings` array crashes the JS fallback path because `seekToBar(bar_timings[0].bar)` derefe... | OPEN |  | R4 |
| 30 | R4 | Medium | code_quality | magic-byte-detection-spec | The magic-byte detection spec reads only 8 bytes, which is insufficient for WAV detection because `WAVE` is at bytes ... | OPEN |  | R4 |
| 31 | R4 | Medium | security | ssrf-block-list-omits | The SSRF block list omits IPv6 ULA and link-local ranges, leaving the IPv6 equivalent of the RFC1918 guard incomplete... | OPEN |  | R4 |
| 32 | R4 | Low | security | variant-level-http-ownership | Variant-level HTTP ownership validation is still underspecified for routes that accept both asset and variant IDs; th... | OPEN |  | R4 |
| 33 | R4 | Low | domain | pickup-bar-handling-undocumented | Pickup-bar handling is undocumented; the intended exclusion of measure 0 from `bar_timings_json` and `bar_coords_json... | OPEN |  | R4 |
| 34 | R4 | Low | test_quality | part-indices-max-length | The `part_indices` max-length boundary is specified but not tested; `len == 33` needs an explicit sidecar test. (File... | OPEN |  | R4 |
| 35 | R4 | Low | test_quality | sidecar-error-code-apperror | Sidecar error-code-to-`AppError` mappings are mostly untested on the Rust side; representative integration tests are ... | OPEN |  | R4 |
| 36 | R4 | Low | code_quality | prod-media-token-paragraph | The prod media-token paragraph is duplicated and partially contradictory; it should be merged into a single authorita... | OPEN |  | R4 |
