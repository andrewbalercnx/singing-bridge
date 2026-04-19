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

## Sprint 8: Variation A "The Warm Room" Session UI — 2026-04-19

**Files changed:**
- `web/assets/session-ui.js` — Variation A session UI: breath ring, audio meters, muted banner, 5-button control cluster, self-preview, end-call dialog; `mount(container, opts)` → `{ teardown, setRemoteStream }`; exports `deriveToggleView` (relocated from deleted `controls.js`), `fmtTime`, `buildBaselineStrip`, `buildMutedBanner`, `runAudioLoop`
- `web/assets/theme.css` — design tokens (colours, typography, radii, shadows), session layout CSS, `@font-face` declarations, mobile breakpoint
- `web/assets/fonts/` — self-hosted WOFF2 subsets: Fraunces 400/500 (normal+italic), Poppins 400/500/600; `CHECKSUMS.txt` for provenance
- `web/assets/signalling.js` — `playoutDelayHint = 0` moved into `dispatchRemoteTrack` (testable via pure export); removed duplicate from `ontrack` handler
- `web/assets/teacher.js` — replaced `wireControls` with `sbSessionUI.mount` into `#session-root`; removed static `localVideo` reference
- `web/assets/student.js` — same as teacher.js; removed `localVideo` reference
- `web/teacher.html` — replaced tiles/controls block with `#session-root`; kept recording buttons outside; added `theme.css` + `session-ui.js`; replaced `controls.js` script tag
- `web/student.html` — same; added `<meta name="viewport">`; added `theme.css`
- `web/assets/controls.js` — **deleted**; `deriveToggleView` relocated to `session-ui.js`
- `web/assets/tests/controls.test.js` — import updated to `session-ui.js`
- `web/assets/tests/session-ui.test.js` — 27 tests: fmtTime, deriveToggleView, buildBaselineStrip (setElapsed via actual function), buildMutedBanner (checkAndUpdate), runAudioLoop onFrame contract, mount lifecycle, XSS, button callbacks
- `web/assets/tests/signalling.test.js` — added 2 tests: `playoutDelayHint = 0` regression guard, missing receiver no-throw
- `server/tests/http_teach_debug_marker.rs` — updated assertions for Sprint 8 DOM structure; added no-Google-Fonts, session-root, viewport meta, session-ui.js/theme.css load-order guards

**Commit:** `644063e`

## Sprint 6: Session Recording — 2026-04-18

**Files changed:**
- `server/migrations/0003_recordings.sql` — recordings + recording_gate_attempts tables; failed_attempts column; token_hash BLOB UNIQUE (no token_hex persisted)
- `server/src/blob.rs` — BlobStore trait (#[async_trait], put/delete/get); DevBlobStore (flat-file, path traversal defense); blob.rs module
- `server/src/cleanup.rs` — run_one_cleanup_cycle (BLOB_GRACE_SECS=86400, gate_attempt_ttl_secs param); cleanup_loop with CancellationToken; 4 tests
- `server/src/config.rs` — recording_max_bytes, dev_blob_dir, gate_rate_limit_max_attempts, gate_rate_limit_window_secs fields
- `server/src/state.rs` — AppState gains blob: Arc<dyn BlobStore>; RoomState gains recording_active + consent_pending bools
- `server/src/http/mod.rs` — recording + gate routes wired; DefaultBodyLimit::disable() on upload route
- `server/src/http/recordings.rs` — post_upload (streaming, magic-byte validation, blob compensation); get_list (sort by date/student, status from failed_attempts); post_send (always rotate token, teacher_id guard); delete_recording (soft-delete); get_recordings_page; get_dev_blob (debug only)
- `server/src/http/recording_gate.rs` — post_verify: per-IP rate limit (DB), per-token lockout, constant-time email hash compare, 403+JSON errors (wrong_email/disabled), attempt INSERT outside transaction
- `server/src/auth/mailer.rs` — send_recording_link + send_token_disabled_notification added to Mailer trait; DevMailer + CloudflareWorkerMailer impls
- `server/src/ws/mod.rs` — RecordStart/RecordConsent/RecordStop/RecordingStopped/RecordingActive handlers; consent_pending flag; RecordStop cancels pending consent
- `server/src/main.rs` — blob store init; cleanup_loop spawn; config.gate_rate_limit_window_secs passed to cleanup
- `web/assets/recorder.js` — MediaRecorder composite (Web Audio API mix + video); streaming upload with X-Student-Email header
- `web/assets/teacher.js` — RecordStart/RecordStop UI; admit captures lastStudentEmail; onRecordConsentResult passes tracks
- `web/assets/student.js` — RecordConsentRequest UI; 30s auto-decline timeout
- `web/assets/recording-gate.js` — email gate form; 403+JSON body parsing (wrong_email/disabled); 429 rate limit message
- `web/recording.html` / `web/recordings.html` — student playback gate page; teacher recording library page

**Commit:** `8b57461`

## Sprint 7: In-session chat + lobby messaging — 2026-04-18

**Files changed:**
- `server/src/ws/protocol.rs` — `ClientMsg::Chat`, `ClientMsg::LobbyMessage`, `ServerMsg::Chat`, `ServerMsg::LobbyMessage`; `MAX_CHAT_CHARS`/`MAX_CHAT_BYTES` constants; unit tests extended
- `server/src/ws/mod.rs` — `handle_chat` + `handle_lobby_message` + `validate_chat_text`; conn.id identity checks; dispatch branches
- `server/tests/ws_chat.rs` — 8 integration tests: relay, validation, empty/oversized rejection, no-session, lobby message delivery and error paths
- `web/teacher.html` — chat panel (log + form) inside session section
- `web/student.html` — chat panel inside session section; lobby-message-banner in lobby-status
- `web/assets/signalling.js` — `onChat`/`onLobbyMessage` callbacks; `sendChat`/`sendLobbyMessage` in returned handles
- `web/assets/teacher.js` — `appendChat` (You/Student labels); chat form wiring; lobby-msg-form in `renderEntry`; panel show/hide on peer events
- `web/assets/student.js` — `appendChat` (Teacher/You labels); `onChat`/`onLobbyMessage` callbacks; chat form wiring; panel show/hide; lobby banner with 8s auto-hide
- `web/assets/tests/chat.test.js` — 11 JS unit tests: label rendering, XSS safety, serialisation, banner, panel visibility

**Commit:** `2de1433`

## Sprint 5: Azure + Cloudflare deployment + TURN + session log — 2026-04-18

**Files changed:**
- `server/src/config.rs` — Config::from_env() decomposed into parse_env() + validate_prod_config(); HTTPS validation for cf_worker_url; session_log_pepper; ws_join_rate_limit fields
- `server/src/auth/secret.rs` — SecretString::PartialEq now uses HMAC-SHA256 for true constant-time on length mismatch; removed unused is_empty()
- `server/src/auth/mailer.rs` — CloudflareWorkerMailer (reqwest, bearer auth, from-from-env); removed broad dead_code allow
- `server/src/ws/protocol.rs` — ServerMsg::Admitted gains optional ice_servers + ttl fields for TURN delivery via WS
- `server/src/ws/session_log.rs` — hash_email + open_row + record_peak (AND ended_at IS NULL) + close_row; removed broad dead_code allow
- `server/src/ws/rate_limit.rs` — WsJoinBucket + check_and_inc + sweep_stale; fields made private; removed broad dead_code allow
- `server/src/ws/mod.rs` — resolve_peer_ip (CF-IP > XFF > socket); cleanup() tautological condition fixed; loss_bp clamped to 10_000; dead Forwarded-header code removed
- `server/src/ws/lobby.rs` — admit() sends ice_servers in Admitted; orphan log-row closed on disconnect race; removed broad dead_code allow
- `server/src/state.rs` — BlockEntry + BLOCK_LIST_CAP=256; ActiveSession with AtomicU16 peaks; Arc<DashMap> rate limit maps + sweeper handle
- `server/src/http/turn.rs` — /turn-credentials requires teacher session cookie (401 otherwise); build_ice_servers extracted; turns:// removed; removed broad dead_code allow
- `server/src/http/health.rs` — /healthz returns {status:"ok"}/200 or 503 after shutdown
- `infra/bicep/container-app.bicep` — CF IP allow-list in ipSecurityRestrictions; min=max=1 replica; secrets via secretRef; removed unused sbJwtSecret param
- `infra/bicep/coturn-vm.bicep` — coturn VM + static IP + NSG; cloud-init uses replace() to inject TURN secret; SSRF denied-peer-ip ranges; 0600 turnserver.conf
- `infra/cloudflare/workers/magic-link-relay.js` — CF Worker with timing-safe bearer auth; from from env only
- `web/assets/ice.js` — TURN credential fetcher with 10s pre-expiry cache; createFetcher() for test isolation
- `web/assets/signalling.js` — makePeerConnection awaited; students use admitted ice_servers; teacher fetches via /turn-credentials with cookie
- `web/assets/student.js` — onBlocked callback wires #blocked-notice
- `web/assets/teacher.js` — rejectAndBlock(id, ttlSecs) + "Reject & block" button
- `web/student.html` / `teacher.html` — ice.js script tag added
- `Dockerfile` — two-stage rust:1.82-bookworm → distroless/cc-debian12; USER 65532
- `.github/workflows/deploy.yml` — OIDC federation (client-id/tenant-id/subscription-id); no long-lived secrets
- `scripts/check-bicep.sh` — CI guard: asserts min=max=1 replica in container-app.bicep
- `knowledge/runbook/deploy.md` — one-time bootstrap + per-release deploy + CF IP refresh
- `knowledge/runbook/rollback.md` — revision list, activate/deactivate, migration compat
- `knowledge/runbook/incident-turn-down.md` — coturn restart, cert renewal, VM unreachable

**Commit:** `c96a125`

## Sprint 4: Bandwidth adaptation + quality hardening — 2026-04-17

**Files changed:**
- `web/assets/adapt.js` — NEW: pure four-rung degradation ladder (studentVideo/teacherVideo/teacherAudio/studentAudio); `initLadderState`, `decideNextRung`, `encodingParamsForRung`, `floorViolated`; state machine split into `stepVideoRung` + `stepAudioRung` + `stepFloorBreach` helpers; student audio rung 1 writes both `maxBitrate=96000` AND `minBitrate=96000`.
- `web/assets/quality.js` — NEW: pure `summariseStats(stats, prevStats)` with multi-SSRC tiebreak by `packetsSent`; `qualityTierFromSummary` with strict `>` threshold semantics; `renderQualityBadge` (textContent + className only); `STATS_FIXTURES`.
- `web/assets/reconnect.js` — NEW: pure `onIceStateEvent` with full `(phase, iceState)` transition table; `healthy→watching→restarting→giveup` with direct `healthy→giveup` on `failed`/`closed`; `STANDARD_FLICKER`, `STRAIGHT_TO_FAILED`, `CLOSED_FROM_HEALTHY` fixtures; browser `startReconnectWatcher` with injectable clock.
- `web/assets/session-core.js` — NEW: UMD pure `applyActions` (sole `setParameters` site; swallows rejections with `console.warn` logging; never touches `track.enabled`); browser `startSessionSubsystems(pc, senders, role, callbacks) → { stopAll() }` drives the 2 s adapt/quality/reconnect loop.
- `web/assets/signalling.js` — priority hints at transceiver creation; `wireBidirectionalMedia` returns `audioSender`/`videoSender`; after data channel opens delegates to session-core; ICE-restart re-offer path on `call_restart_ice` (student only, via `pc.restartIce()` + new offer); `makeTeardown` moved to pure factory and calls `stopAll()`; Google STUN annotated as Sprint-5-to-replace.
- `web/assets/video.js` — `verifyVideoFeedback(sdp)` pure helper; `SDP_WITH_VIDEO`, `SDP_WITH_VIDEO_SAFARI`, `SDP_NO_VIDEO` fixtures.
- `web/assets/student.js` / `teacher.js` — thread `onQuality` / `onFloorViolation` / `onReconnectBanner` callbacks; render quality badge; student hides session + hangs up on floor violation; teacher mirrors notice. Teacher session handle moved off `window` into closure.
- `web/student.html` / `web/teacher.html` — `#quality-badge`, `#reconnect-banner`, `#floor-violation`; new `<script>` load order: adapt → quality → reconnect → session-core → signalling.
- `web/assets/styles.css` — quality-badge (good/fair/poor), reconnect-banner, floor-violation with light/dark themes.
- `tests/netem/impair.sh` + `clear.sh` + `README.md` — NEW: Linux-only manual harness (`tc netem`); input-validated LOSS/JITTER/IFACE; defaults 2% loss / 20 ms jitter / 10 ms delay on `lo`.
- `knowledge/runbook/netem.md` — NEW: procedure + expected observables at 2% (exit criterion) and 10% (floor-violation pressure test).
- `web/assets/tests/adapt.test.js` — NEW: 27 tests covering §5.1 #1–#18 + §5.2 failure paths + `floorViolationEmitted` reset-and-re-fire.
- `web/assets/tests/quality.test.js` — NEW: deltas, multi-SSRC tiebreak (two-snapshot fixture), threshold + boundary equality, byte-counter reset, inbound-only summary, `t.after()` globals cleanup.
- `web/assets/tests/reconnect.test.js` — NEW: happy path, idempotent disconnect, direct arcs for `watching+failed/closed` and `restarting+failed/closed`, terminal giveup, dead-field guard (no `retryCount`).
- `web/assets/tests/session-core.test.js` — NEW: `applyActions` routing, exact parameter forwarding, rejection recovery (Proxy-based `.enabled`-never-accessed guard).
- `web/assets/tests/sdp.test.js`, `video.test.js`, `signalling.test.js` — extensions: FEC survival across fixtures, video m-section byte-identical, Chrome/Safari/absent SDP feedback fixtures, real `makeTeardown` regression guard (exported from pure factory, exercises production function).
- `server/tests/ws_signal_relay.rs` — `ice_restart_offer_relays_opaquely` pins server payload-opacity under ICE restart.
- `server/tests/http_teach_debug_marker.rs` — asserts `#quality-badge`/`#reconnect-banner`/`#floor-violation` on both views (including prod) + script load-order for the new modules on both pages.
- `scripts/index-codebase.py`, `scripts/indexers/typescript.py` — header maintenance (bumped Last updated, fixed stale file-path comment).

**Commit:** `22a46bf`

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

