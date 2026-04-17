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

