## Plan Review: Sprint 20 - Lesson support for students without headphones (and iOS) (R3)

**Round:** 3  
**Verdict:** APPROVED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Design Assessment
The plan is coherent and internally consistent. The remaining issues are bounded specification, test, and documentation gaps. No fundamental design flaw remains.

### Completeness
The deliverables are substantially covered. Edge-case handling and public-surface documentation still need a small amount of tightening to make the implementation unambiguous.

### Findings
- **[Medium]** `handle_set_acoustic_profile` needs explicit `Unknown -> Speakers` normalization on the teacher-override write path to preserve the documented invariant that `Unknown` is never stored or broadcast. This also closes the remaining ambiguity around serialization behavior for future enum values. (File: `server/src/ws/mod.rs`, Location: `handle_set_acoustic_profile`) (Source: domain, security, code_quality)
- **[Medium]** `vad.js` lacks planned coverage for the `create()` browser wrapper. The strategy covers `tickVad` state logic but not construction, `ctx.resume()`, polling dispatch, or cleanup. (File: `web/assets/tests/vad.test.js`, Location: `vad.test.js` strategy / `create()`) (Source: test_quality)
- **[Low]** `teardown()` behavior while VAD is not `SILENT` is unspecified. The plan needs an explicit rule on whether cleanup emits a final silence event or remains silent, and the tests need to match that rule. (File: `web/assets/vad.js`, Location: `teardown`; `web/assets/tests/vad.test.js`) (Source: test_quality)
- **[Low]** The teacher override path from `IosForced` to `Headphones` is not directly tested, leaving the intended authority rule under-specified in regression coverage. (File: `server/tests/test_acoustic_profile.rs`; `web/assets/tests/accompaniment-drawer.test.js`) (Source: test_quality)
- **[Low]** The ADR amendment spec omits the remaining iOS sample-rate resampling limitation, so the reclassification rationale is not fully recorded. (File: `PLAN_Sprint20.md`, Location: ADR-0001 amendment section) (Source: domain)
- **[Low]** The file map entry for `signalling.js` does not call out the required `Exports` header update for the new teacher-handle API surface. (File: `PLAN_Sprint20.md`, Location: JS deliverables table / `signalling.js` row) (Source: code_quality)

### Excluded Findings
No findings excluded.

### Recommendations
Add one normalization rule, one wrapper-test block, and one teardown contract statement before implementation starts. Keep the ADR and file-map updates in the same revision so the written plan matches the intended API and platform story.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Acoustic profile normalization | domain, security, code_quality | `Unknown` must normalize to `Speakers` on all write paths |
| VAD test completeness | test_quality | Wrapper lifecycle coverage is still missing |
| Teardown semantics | test_quality | Cleanup contract needs explicit event behavior |
| iOS documentation | domain | Reclassification record is missing the resampling limitation |
| Public API documentation | code_quality | File-map/header guidance should reflect new exports |