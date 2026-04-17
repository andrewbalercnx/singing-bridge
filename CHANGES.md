# Changes

> Each completed sprint appends an entry here. Format:
>
> ```markdown
> ## Sprint N: Title — YYYY-MM-DD
>
> **Files changed:**
> - `path/to/file` — description
>
> **Commit:** `<sha>`
> ```

## Sprint 3: Video track + two-tile UI + browser-compat gating — 2026-04-17

**Files changed:**
- `web/assets/browser.js` — NEW: UMD-wrapped pure detector `detectBrowser(ua, features)` → `{name, version, tier, reasons, device, isIOS, isInAppWebView}`; 13-UA fixture set (BROWSER_UA_FIXTURES) incl. CriOS, Android WebView, Facebook/Instagram/TikTok in-app; Chrome/Firefox/Safari version floors (BROWSER_FLOORS).
- `web/assets/video.js` — NEW: UMD module; pure `hasVideoTrack` + `orderCodecs` (Node-exported); browser-only `startLocalVideo`, `attach/detachRemoteVideo`, `applyCodecPreferences` via `RTCRtpTransceiver.setCodecPreferences`.
- `web/assets/controls.js` — NEW: pure `deriveToggleView`; DOM `wireControls({audioTrack, videoTrack, onHangup})` toggles `track.enabled` only (no renegotiation).
- `web/assets/signalling.js` — UMD conversion exposing `dispatchRemoteTrack`, `acquireMedia`, `teardownMedia` for Node tests. `wireBidirectionalMedia(pc, detect)` adds audio + video transceivers, applies mobile H.264 preference, routes `ontrack` by kind. Partial-failure cleanup: audio stream stopped if video acquisition throws. `refs.audio` → `refs.media`.
- `web/assets/student.js` — landing-page gate (block/degraded notices), local-video preview, mute/video-off/end-call controls. Explicit `let handle = null` guards closures against temporal-dependency bugs.
- `web/assets/teacher.js` — tier badge + tier_reason rendered per lobby entry (textContent only); local-video preview; controls.
- `web/student.html`, `web/teacher.html` — `#remote-video` (playsinline), `#local-video` (playsinline + muted), `.tiles` grid, controls bar; student.html adds `#block-notice`, `#degraded-notice`. New `<script>` load order: browser → sdp → audio → video → overlay → controls → signalling → (page).
- `web/assets/styles.css` — `.tiles` responsive grid (mobile stack / desktop 2-col), `.tile`, `.controls`, `.tier-badge` + reason styling, dark-mode parity.
- `server/src/ws/protocol.rs` — `Tier` enum (Supported/Degraded/Unworkable) with conservative `Degraded` default; `MAX_TIER_REASON_CHARS = 200` (char cap) + `MAX_TIER_REASON_BYTES = 4×chars` (byte cap); `#[serde(default)]` tier + tier_reason on `ClientMsg::LobbyJoin`; `LobbyEntryView` carries both.
- `server/src/state.rs` — `LobbyEntry` gains `tier`, `tier_reason`; `view()` projects both.
- `server/src/ws/lobby.rs` — char-safe `truncate_to_chars` using `char_indices().nth()` → in-place `String::truncate(byte_idx)`, one pass, no allocation. 6 unit tests. `join_lobby` threads tier + truncated reason. `AdmitOutcome::NoRoom` dead variant removed.
- `server/src/ws/mod.rs` — threads tier + tier_reason from `ClientMsg`; rejects with `FieldTooLong` when `tier_reason.len() > MAX_TIER_REASON_BYTES`, paralleling email/browser/device_class.
- `server/tests/common/mod.rs` — `get_html` uses a fresh per-call reqwest client (no cookie jar) so `cookie: None` genuinely means unauthenticated; fixes latent test-infra bug where Sprint 2's student-view test was actually hitting teacher.html.
- `server/tests/ws_lobby.rs` — `student_join_visible_to_teacher` extended to assert `tier` + `tier_reason` round-trip.
- `server/tests/ws_lobby_tier.rs` — NEW: 7 tests covering default-Degraded, unknown-tier→WS close 1008 `malformed_message`, multi-byte truncation at 200 chars (fixture uses 3-byte '中' codepoint at byte boundary), exact-cap accepted, byte-cap reject path, supported round-trip, unworkable round-trip.
- `server/tests/http_teach_debug_marker.rs` — both views now assert `#remote-video`, `#local-video`, `playsinline` on both, `muted` on `#local-video`, `#mute`/`#video-off`/`#hangup` buttons, `.tiles` container. Student view additionally asserts `#block-notice` + `#degraded-notice`.
- `web/assets/tests/{browser,video,controls,signalling}.test.js` — NEW Node suites: 20 browser (property + 9 version-floor boundary + failure paths + WebView marker + iOS CriOS + tablet), 13 video (hasVideoTrack + orderCodecs stability + null preservation), 6 controls (deriveToggleView), 11 signalling (dispatch + acquireMedia both failure phases + teardownMedia partial-init variants).

**Commit:** `07800f4` (code review APPROVED R2, 95% convergence)

---

## Sprint 2: High-fidelity bidirectional audio — 2026-04-17

**Files changed:**
- `web/assets/sdp.js` — SDP munger: upserts Opus music-mode fmtp params (stereo, maxaveragebitrate=128000, FEC, CBR=0); UMD shim for Node test runner.
- `web/assets/tests/sdp.test.js` — 13 Node property + boundary tests for the SDP munger.
- `web/assets/audio.js` — `startLocalAudio` (DSP-off getUserMedia), `attachRemoteAudio` (idempotent + autoplay recovery), `detachRemoteAudio`, pure `hasTrack` predicate.
- `web/assets/tests/audio.test.js` — 6 Node tests for `hasTrack`.
- `web/assets/debug-overlay.js` — dev-only live overlay (codec params, DSP flags, getStats); self-gated on `<meta name="sb-debug">`; PT-specific `parseOpusFmtp`; safe `setRow` via dataset traversal.
- `web/assets/loopback.js` — mic→speaker round-trip measurement via AudioWorklet cross-correlation; `setupAudioGraph`, `schedulePulses`, `analyzeCapture` helpers.
- `web/assets/loopback-worklet.js` — `AudioWorkletProcessor` that transfers captured blocks to main thread via MessagePort.
- `web/assets/signalling.js` — wires bidirectional audio, SDP munge on every `setLocalDescription`, debug overlay lifecycle, `makeTeardown` factory.
- `web/{teacher,student}.html` — add `<!-- sb:debug -->`, `#remote-audio`, `#unmute-audio`, headphones note, `#sb-debug`, three new `<script>` tags.
- `web/loopback.html` — dev-only harness UI.
- `server/src/http/teach.rs` — `inject_debug_marker` (strips comment in prod, injects meta in dev); `Cache-Control: private, no-store` + `Vary: Cookie`.
- `server/src/http/loopback.rs` — dev-only `/loopback` route; 404 in prod.
- `server/src/http/mod.rs` — register `/loopback`.
- `server/tests/http_teach_debug_marker.rs` — 3 tests: dev student view, dev teacher view, prod (no marker, no comment).
- `server/tests/http_loopback.rs` — 3 tests: dev serves HTML, prod returns 404, missing file returns error.
- `server/tests/http_csp.rs` — dev/prod split; `verify_html_has_no_inline_script` extended to `/teach/:slug` + `/loopback`.
- `server/tests/common/mod.rs` — `TestOpts.dev` field, `TestApp::get_html` helper.
- `.github/workflows/ci.yml` — add `node --test web/assets/tests/*.test.js` step.
- `package.json` — `{"private": true, "type": "commonjs"}` for UMD/Node compat.

**Commit:** `ea612cf` (code review APPROVED R2)

---

## Sprint 1: Signalling foundation + teacher identity + lobby — 2026-04-17

**Files changed:**
- `Cargo.toml`, `server/Cargo.toml`, `rust-toolchain.toml` — single-crate Rust workspace scaffold (axum, tokio, sqlx).
- `server/migrations/0001_initial.sql` — teachers, magic_links, sessions, signup_attempts tables.
- `server/src/{main,lib,config,db,error,state}.rs` — binary entry, pool setup with WAL + busy_timeout, typed AppError with redacted internal messages + Retry-After, per-room AppState using `tokio::sync::RwLock` + atomic room-cap counter.
- `server/src/auth/{slug,magic_link,mailer,rate_limit,mod}.rs` — slug validator + reserved list, atomic consume UPDATE, dev-mode mail file sink (0600 files), transactional per-email + per-IP rate limit, session-cookie extractor with server-side expiry check.
- `server/src/http/{mod,signup,teach,static_assets,security_headers}.rs` — /signup, /auth/verify (CSP-safe external script), /auth/consume, /teach/<slug>, /assets/*; strict CSP (`script-src 'self'; connect-src 'self'`).
- `server/src/ws/{mod,protocol,connection,lobby,session}.rs` — WebSocket upgrade with Origin check, tagged-union ClientMsg/ServerMsg + PumpDirective, per-connection outbound pump as sole socket writer, slug-aware role resolution on first lobby message, explicit async cleanup (no `Drop` work).
- `web/{teacher,student}.html`, `web/assets/{signalling,teacher,student,verify,signup}.js`, `web/assets/styles.css` — vanilla-JS browser client with `signallingClient.connectTeacher` / `connectStudent`, textContent-only rendering of student-supplied strings, fragment-based verify flow.
- `server/tests/{common,http_signup,http_origin,http_csp,magic_link,ws_lobby,ws_lobby_cap,ws_lobby_rejection,ws_session_handshake,ws_shutdown,ws_signal_relay,state_concurrency}.rs` — 45 integration tests covering signup/consume, rate limiting, re-signup idempotency, cross-origin WS rejection, lobby join/admit/reject with close codes, signal relay + payload cap boundary, graceful shutdown ordering, concurrent magic-link consume exactly-once, concurrent room-cap enforcement.
- `knowledge/decisions/0001-mvp-architecture.md` — foundational ADR (committed earlier but referenced throughout Sprint 1).
- `CLAUDE.md`, `SPRINTS.md` — tier-3 index entry for ADR-0001, Sprint 1 status COMPLETE.
- `Documentation/archive/PLAN_Sprint1.md` — archived plan.

**Commit:** `b91a8c1` (plus R2 follow-ups)

