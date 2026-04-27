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

## Sprint 25: Bot Peer for Manual UX Testing — 2026-04-27

**Files changed:**
- `server/src/http/test_peer.rs` — new: `GET /test-peer` + `POST /test-peer/session` handlers; `TokenStore` (one-time use, 30s TTL, cap=100); atomic `DashMap::entry()` duplicate guard; `Secure` cookie flag for HTTPS
- `server/src/config.rs` — `test_peer: bool`, `test_peer_script: Option<String>` config fields; `validate_prod_config()` rejects `test_peer=true`
- `server/src/http/mod.rs` — register `/test-peer` routes under `#[cfg(debug_assertions)]` + runtime `test_peer` flag
- `server/src/state.rs` — `active_bots` and `token_store` fields (both `#[cfg(debug_assertions)]`)
- `server/src/main.rs` — wire `active_bots` and `token_store` into `AppState`
- `server/tests/http_test_peer.rs` — new: 14 integration tests (mode validation, 409 guard, teacher no-slug/no-variant, bot exit cleanup, 503 spawn failure, token auth, cookie TTL, capacity exhaustion, teacher 202 happy path)
- `server/tests/common/mod.rs` — `TestOpts.test_peer_script`, `TestOpts.test_peer`, `active_bots`, `token_store` in harness
- `web/assets/teacher.js` — `data-testid="admit-btn"` on admit button; `window._sbSend` localhost bridge
- `web/student.html` — `data-testid="session-active"` on `#session`
- `web/assets/tests/teacher.test.js` — new: JS regression tests for `Signalling.send` serialization and teacher.js bot-API contracts
- `web/assets/tests/student.test.js` — new: `data-testid="session-active"` regression guard
- `scripts/test_peer.py` — new: Playwright bot (teacher + student modes); TTS WAV; cookie set from `urlparse(server).hostname`
- `scripts/requirements-test-peer.txt` — new: playwright, gtts, pydub, httpx

**Commit:** `7bebf93`

## Sprint 24: Synthesis modal + variant management — 2026-04-26

**Files changed:**
- `web/library.html` — added `<dialog id="synth-modal">` static skeleton
- `web/assets/library.js` — synthesis modal (`openSynthModal`, `handleSynthSubmit`, `buildOmrSection`, `initSynthModal`); re-synthesise gated on `has_midi`; PartInfo.index round-trip; removed dead `formEl` from `synthesise()`; `showNewVariantButton`
- `web/assets/tests/library.test.js` — 143 tests; new modal tests, part-index round-trip, WAV-only re-synth gating, hasMidi=true failure path
- `web/assets/theme.css` — synth-modal CSS
- `server/src/http/library.rs` — server-side bounds on `tempo_pct` [25,300], `transpose_semitones` [-12,12], `part_indices` max 32

**Commit:** `5748b38`

## Sprint 20: Lesson support for students without headphones (and iOS) — 2026-04-25

**Files changed:**
- `web/assets/browser.js` — iOS UA reclassified to `supported`; `iosAecForced: true` added to return shape
- `web/assets/self-check.js` — iOS path: hide headphones checkbox, show iOS label, `onConfirm(false)`
- `web/student.html` — added `#ios-note` section
- `web/assets/student.js` — `deriveAcousticProfile()`, `applyChatMode()` with `lastChatModeApplied` debounce, `onChattingMode` callback
- `web/assets/signalling.js` — `connectStudent` sends `acoustic_profile`; handles `chatting_mode`/`acoustic_profile_changed`; `connectTeacher` adds `sendSetAcousticProfile`/`sendChattingMode`
- `web/assets/vad.js` — new: energy+hysteresis VAD; `create(track, opts)`, `tickVad` pure export, `suppress`/`forceMode`/`teardown` API
- `web/assets/tests/vad.test.js` — new: 33 tests covering all 9 state×event cells, boundary values, forceMode/suppress compound interactions
- `web/assets/accompaniment-drawer.js` — `setAcousticProfile(profile)` handle method; `audio.muted` when profile ≠ `headphones`; teacher-only muting banner
- `web/assets/tests/accompaniment-drawer.test.js` — 8 Sprint 20 acoustic profile tests added
- `web/teacher.html` — added `<script src="/assets/vad.js">`
- `web/assets/teacher.js` — VAD creation/teardown in session lifecycle; chat chip (4 states + ios_forced non-interactive); override button hidden for ios_forced; `onAcousticProfileChanged` calls `updateChatChip()`
- `server/src/ws/protocol.rs` — `AcousticProfile` enum; `SetAcousticProfile`/`ChattingMode` in `ClientMsg`; `AcousticProfileChanged`/`ChattingMode` in `ServerMsg`; `acoustic_profile` on `LobbyEntryView`/`LobbyJoin`
- `server/src/state.rs` — `LobbyEntry.acoustic_profile: AcousticProfile` replaces `headphones_confirmed: bool`
- `server/src/ws/lobby.rs` — `join_lobby` accepts `acoustic_profile`; `confirm_headphones` no-op for `IosForced`
- `server/src/ws/mod.rs` — `handle_set_acoustic_profile` + `handle_chatting_mode` (both teacher-only with role guards)
- `server/tests/ws_acoustic_profile.rs` — new: 12 integration tests
- `server/tests/ws_headphones.rs` — updated assertions to use `acoustic_profile` field
- `knowledge/decisions/0001-mvp-architecture.md` — Sprint 20 amendment: iOS reclassification rationale, `iosAecForced` signal, iOS audio limitations

**Commit:** `fdefc1f`

## Sprint 19: PostgreSQL application migration — 2026-04-25

**Files changed:**
- `server/src/db.rs` — replaced `SqlitePool`/WAL pragma with `PgPool`; `init_pool` + `run_migrations` separation (ADR 0002); added `test_helpers` module with `TestDb` RAII guard and `make_test_db()` for panic-safe per-test DB lifecycle
- `server/src/auth/rate_limit.rs` — INSERT-before-COUNT tightens signup TOCTOU race; updated invariant docs
- `server/src/auth/password.rs` — `and_then` → `map` cleanup; SQL `$N` placeholders throughout
- `server/src/config.rs` — `SB_DATABASE_URL` mandatory (no SQLite fallback); `sslmode=verify-full` + localhost rejection in prod; DSN-style URL detection with clear error; `parse_env_missing_database_url_errors` test added
- `server/src/cleanup.rs` — `PgPool`; `$N` placeholders; inline tests use `TestDb` (panic-safe, deduplicated)
- `server/src/ws/session_history.rs` — `PgPool`; `$N` placeholders; `ON CONFLICT DO NOTHING`; inline tests use `TestDb`
- `server/src/ws/session_log.rs` — `PgPool`; `$N` placeholders
- `server/src/ws/mod.rs` — `$N` placeholders in slug queries
- `server/src/http/login.rs` — `PgPool`; `$N` placeholders; `RETURNING id`
- `server/src/http/signup.rs` — `$N` placeholder
- `server/src/http/teach.rs` — `$N` placeholders
- `server/src/http/history.rs` — `PgPool`; `$N` placeholders
- `server/src/http/library.rs` — `PgPool`; `$N` placeholders; `RETURNING id`
- `server/src/http/recordings.rs` — `PgPool`; `$N` placeholders; `RETURNING id`
- `server/src/http/recording_gate.rs` — `PgPool`; `$N` placeholders
- `server/tests/common/mod.rs` — per-test PostgreSQL DB via `DATABASE_TEST_URL`; panic-safe `Drop` impl; URL construction preserves query params; unified `shutdown()` replaces split `shutdown`/`cleanup`
- `server/tests/regression.rs` — new: CITEXT case-insensitivity + uniqueness guards; FK enforcement (invalid teacher_id, cascade deletion); session persistence across simulated restart
- `server/tests/db_pool.rs` — rewritten to use `spawn_app()`; concurrent-connection verification
- `server/tests/ws_shutdown.rs` — updated for private `server_handle` field
- `server/migrations/` — all 6 files rewritten for PostgreSQL (BIGSERIAL, BYTEA, CITEXT, `$N`)
- `server/tests/db_pragmas.rs` — deleted (SQLite-specific)
- `infra/bicep/container-app.bicep` — NFS storage removed; `SB_DATABASE_URL` wired via KV reference; Cloudflare IPv6 ranges added to `ipSecurityRestrictions`

**Commit:** `3bbfd38`

## Sprint 18: Shared PostgreSQL platform — 2026-04-24

**Files changed:**
- `infra/bicep/shared-postgres.bicep` — new: idempotent Bicep for AllowAzureServices firewall rule, azure.extensions allowlist (citext), and singing_bridge database on vvp-postgres
- `infra/bicep/shared-keyvault.bicep` — new: rcnx-shared-kv with RBAC mode, 90-day purge protection, AuditEvent diagnostics, public access with networkAcls bypass documented
- `infra/bicep/container-app.bicep` — add sharedKvUri param; declare sb-db-url as KV-reference secret (Bicep-authoritative); wire SB_DATABASE_URL env var; add securityContext runAsNonRoot/runAsUser:65532 to server container
- `knowledge/decisions/0002-shared-postgres-platform.md` — new ADR: PostgreSQL shared-server decision, per-project role model, onboarding procedure, KV network risk acceptance, Sprint 19 TLS prerequisite
- `server/src/db.rs` — fix Last updated header format

**Commit:** `856a4b7`

## Sprint 17: Teacher dashboard + session UI redesign — 2026-04-23

**Files changed:**
- `web/assets/dashboard.js` — new: IIFE dashboard page (room name, Enter Room/history/library links, recordings + library fetches; XSS-safe; credentials: include)
- `web/assets/session-panels.js` — new: pure DOM builders `buildSelfPip`, `buildAccmpPanel`, `buildIconBar`, `buildRemotePanel`, `buildEndDialog`; added `svgIcon('score')`; exposed `pauseBtn` on accmpPanel handle
- `web/assets/session-ui.js` — rewritten mount() to v2 three-zone layout (video zone + accmp panel + icon bar); removed dead `buildSelfPreview` and `buildControls`
- `web/assets/accompaniment-drawer.js` — added `panelEl` option: routes setTrackName/setPosition/setPaused to inline panel; closure vars `_assetId`/`_variantId`; rAF starts even without barTimings when panelEl present
- `web/assets/teacher.js` — fixed slug extraction (`split('/')[2]`); mounts accmpPanel inline; wires score-viewer toggle
- `web/assets/theme.css` — sections 16 (session v2 layout: sb-session-v2, sb-video-zone, sb-selfpip, sb-accmp-panel, sb-iconbar) and 17 (dashboard grid)
- `server/src/http/dashboard.rs` — new: GET /teach/:slug/dashboard handler with auth gate, Cache-Control: private no-store, Vary: Cookie
- `server/src/http/teach.rs` — added GET /teach/:slug/session route; updated Exports header; fixed non-owner redirect
- `server/src/slug.rs` — added "session" and "dashboard" to RESERVED_SLUGS
- `server/tests/http_dashboard.rs` — new: 8 integration tests (owner 200, Vary, unauthenticated 302, wrong-owner 302, unknown 404, teach redirect, session wrong-owner, session owner)
- `web/assets/tests/session-panels.test.js` — new: 24 tests for all panel builders
- `web/assets/tests/dashboard.test.js` — new: 9 tests (room name, hrefs, XSS, fetch-failure independence, credentials)
- `web/assets/tests/accompaniment-drawer.test.js` — 8 new panelEl tests (updateState, pauseBtn WS messages, rAF position, loadedmetadata)
- `web/assets/tests/session-ui.test.js` — updated 4 tests for v2 DOM layout; added end-dialog click test; teacher chat test

**Commit:** `a39a5be`

## Sprint 16: Persistent database — 2026-04-23

**Files changed:**
- `infra/bicep/vnet.bicep` — new: VNet (10.0.0.0/16), ACA subnet (10.0.0.0/23), storage subnet (10.0.4.0/28) with Microsoft.Storage service endpoint
- `infra/bicep/container-app.bicep` — NFS storage account (FileStorage Premium, supportsHttpsTrafficOnly=false, deny-by-default ACLs), nfsAzureFile share (NoRootSquash), VNet-integrated CAE, nfsAzureFile storage binding, SB_DATA_DIR=/data, securityContext runAsUser=65532; init container removed; API versions bumped to 2024-03-01
- `infra/bicep/backup-job.bicep` — new: Container App Job (Manual trigger, system-assigned identity), backup blob storage account (deny-by-default, VNet rule), Storage Blob Data Contributor role scoped to backups container; backupImageName required param (no :latest default)
- `infra/backup-job/Dockerfile` — new: python:3.12-slim@sha256 (digest-pinned), runs as UID 65532:65532
- `infra/backup-job/backup.py` — new: VACUUM INTO backup via DefaultAzureCredential; run_backup() function; microsecond timestamp; safe temp-file cleanup
- `infra/backup-job/requirements.txt` — new: azure-storage-blob, azure-identity
- `infra/backup-job/test_backup.py` — new: 5 tests (VACUUM INTO consistency, destination-exists error, upload contract, cleanup on success/failure); pytest fixtures via tmp_path
- `server/src/db.rs` — re-enable WAL (journal_mode=WAL verified via fetch_one; accepts "memory" for in-memory test DBs); max_connections 1→4
- `server/tests/db_pragmas.rs` — new: 6 tests (journal_mode, foreign_keys, busy_timeout, synchronous, concurrent connections, second-connection pragma verification)
- `server/tests/db_error_500.rs` — new: pool closed → POST /auth/register → HTTP 500
- `server/tests/common/mod.rs` — use named shared-cache in-memory URI (file:testmem{n}?mode=memory&cache=shared) so max_connections=4 shares one DB per test
- `knowledge/runbook/deploy.md` — NFS migration cutover procedure, backup/restore runbook, single-replica constraint warning
- `knowledge/decisions/0001-mvp-architecture.md` — document NFS Azure Files v4.1 and accepted unencrypted transport risk
- `web/assets/design_system/gallery.html` — remove 3 Google Fonts link tags (CSP compliance)

**Commit:** `a57792a`

## Sprint 15: Web MIDI keyboard recording — 2026-04-23

**Files changed:**
- `web/library.html` — `#midi-record-section` UI: device picker, record/stop controls, note display, progress, error; `#midi-unavailable-note` hint
- `web/assets/library.js` — `encodeVlq`, `serializeMidi` (Type-1 MIDI serializer, PPQ guard ≤32767), `handleMidiMessage`, `startMidiCapture`, `stopMidiCapture`, `initMidiRecording` (Web MIDI API with injectable `accessProvider`), `updateMidiDevicePicker`, `initMidiUploadControls`; `_setPendingAutoExpandId` test hook; `startUpload` `onSuccess` callback; `renderSummary` auto-expand on `_pendingAutoExpandId`
- `web/assets/tests/library.test.js` — 118 tests (49 new MIDI tests): VLQ encoding, MIDI serialization, PPQ limit guard, multi-event relative delta, `handleMidiMessage` filtering/normalisation/cap, `initMidiRecording` degradation/hotplug/XSS, lifecycle integration roundtrip, session isolation, `pendingAutoExpandId` auto-expand

**Commit:** `f13e8b8`

---

## Sprint 14: In-session accompaniment playback — 2026-04-23

**Files changed:**
- `server/src/ws/protocol.rs` — AccompanimentPlay/Pause/Stop ClientMsg; AccompanimentState ServerMsg; ErrorCode::Forbidden; protocol roundtrip tests
- `server/src/ws/accompaniment.rs` — handle_accompaniment_play/pause/stop; revoke_and_clear_accompaniment; media token lifecycle
- `server/src/http/library.rs` — Cache-Control: no-store on get_asset; Referrer-Policy: no-referrer on get_media
- `server/src/state.rs` — AccompanimentSnapshot with all_blob_keys(); active_session.accompaniment field
- `web/assets/accompaniment-drawer.js` — UMD mount: teacher play/pause/stop controls; rAF bar-advancement; clock-skew compensation
- `web/assets/score-view.js` — UMD mount: rasterised page display; bar-highlight overlay; deferred pendingBar on image load
- `web/assets/tests/accompaniment-drawer.test.js` — 23 unit tests (Node.js built-in runner)
- `web/assets/tests/score-view.test.js` — 8 unit tests
- `web/teacher.html` — #accompaniment-drawer-root + #score-view-root containers; scripts wired
- `web/student.html` — same containers and scripts; read-only drawer
- `server/tests/ws_accompaniment.rs` — 22 WS integration tests
- `server/tests/http_library.rs` — media_token_library_cache_control regression guard
- `server/tests/common/mod.rs` — make_session asserts message types
- `tests/e2e/accompaniment.spec.ts` — 11 E2E scenarios (Playwright)

**Commit:** `0367407`

## Sprint 13: Library Management UI — 2026-04-23

**Files changed:**
- `web/library.html` — new library page with upload zone, asset list, sidecar banner
- `web/assets/library.js` — UMD module: load/upload/OMR/synthesise/delete helpers + document mock fix
- `web/assets/tests/library.test.js` — 69 JS unit tests covering all helpers
- `server/src/http/library.rs` — slug ownership on all 9 asset handlers, N+1 fix in list_assets, db_insert_accompaniment dedup
- `server/tests/http_library.rs` — wrong-slug, invalid-slug-404, WAV-detail-flags tests; 43 total
- `scripts/council-config.json` — trailing newline

**Commit:** `3f1543b`

## Sprint 12A: Accompaniment backend gap closure — 2026-04-21

**Files changed:**
- `server/src/error.rs` — PayloadTooLarge (413), SidecarUnavailable (503), SidecarBadInput (422), ContentTypeMismatch (422), UnsupportedFileType (422) variants; SidecarBadInput message redacted from HTTP responses
- `server/src/sidecar.rs` — map_code updated to SidecarUnavailable / SidecarBadInput; file header invariants corrected
- `server/src/http/library.rs` — WAV 12-byte detection + transaction-backed dual-table insert; detect_file_type / store_asset_blob / db_insert_accompaniment helpers; Content-Length 413 guard; title / label length caps; uniform {id,title,kind} upload response
- `server/src/http/mod.rs` — DefaultBodyLimit::disable() on upload route
- `server/src/http/media_token.rs` — initial (Sprint 12 foundation; committed here)
- `server/src/sidecar.rs` — initial (Sprint 12 foundation; committed here)
- `server/src/blob.rs` — get_bytes added (Sprint 12 foundation)
- `server/src/config.rs` — SIDECAR_HOST_ALLOWLIST exact-hostname validation, prod sidecar secret check (Sprint 12 foundation)
- `server/src/state.rs` — sidecar + media_tokens fields (Sprint 12 foundation)
- `server/src/lib.rs` — pub mod sidecar (Sprint 12 foundation)
- `server/src/main.rs` — SidecarClient + MediaTokenStore wiring (Sprint 12 foundation)
- `server/migrations/0006_accompaniments.sql` — initial schema (Sprint 12 foundation)
- `server/tests/http_library.rs` — 39 integration tests (17 existing + 22 new)
- `server/tests/common/mod.rs` — sidecar_url TestOpts override (Sprint 12 foundation)
- `sidecar/` — production sidecar package (Sprint 12 foundation)
- `docker-compose.yml` — server + sidecar services with SIDECAR_HOST_ALLOWLIST
- `.env.example` — sidecar secret + allowlist documentation
- `tests/e2e/sidecar_stub/app.py` — minimal Flask stub for E2E tests
- `tests/e2e/sidecar_stub/requirements.txt` — Flask ≥ 3.0
- `tests/e2e/library.spec.ts` — E2E smoke test: authenticated library page loads

**Commit:** `e362ed5`

---

## Sprint 11A: Sprint 11 findings remediation — 2026-04-21

**Files changed:**
- `server/src/http/history.rs` — Cache-Control: no-store on all 3 response paths; format_duration unit tests; rename duration_s → duration_display
- `server/src/ws/session_history.rs` — StudentId / SessionEventId opaque newtypes with private inner fields
- `server/src/ws/session_log.rs` — PartialEq on SessionLogId (prerequisite for identity guard)
- `server/src/ws/lobby.rs` — extract open_history_row helper with log_id identity guard; remove redundant inner teacher_id unwrap; update Depends header
- `server/src/state.rs` — rename student_id → session_student_id; add doc comment
- `server/tests/http_history.rs` — cache-control tests for 200 + both 401 paths
- `server/tests/ws_session_handshake.rs` — replace sleep with polling loop; two-branch assertion

**Commit:** `4071574`

## Sprint 11: Persistent student records + session history — 2026-04-21

**Files changed:**
- `server/migrations/0005_session_history.sql` — students, session_events, recording_sessions tables
- `server/src/ws/session_history.rs` — upsert_student, open/close event, recording slot, archive
- `server/src/ws/session_log.rs` — make EndedReason::as_str pub
- `server/src/ws/lobby.rs` — wire session_history into admit; set session_teacher_id
- `server/src/ws/mod.rs` — email validation on join; close_event on cleanup; set_recording_slot on consent
- `server/src/state.rs` — session_event_id, student_id, session_teacher_id on ActiveSession
- `server/src/http/history.rs` — GET /teach/<slug>/history handler with HTML escaping
- `server/src/http/mod.rs` — register history route
- `server/src/http/recordings.rs` — consume_recording_slot + link_recording on upload
- `server/src/cleanup.rs` — archive_old_events in cleanup cycle
- `server/tests/common/mod.rs` — make_session_event helper
- `server/tests/http_history.rs` — 7 history endpoint tests
- `server/tests/ws_session_handshake.rs` — email validation + session_event persistence tests

**Commit:** `49af15b`

## Sprint 10: Password auth (replace magic link) — 2026-04-21

**Files changed:**
- `server/migrations/0004_password_auth.sql` — adds password_hash column + login_attempts table
- `server/src/auth/password.rs` — Argon2id hashing, verify, DUMMY_PHC, record_and_check_limits
- `server/src/auth/mod.rs` — registers password module, exposes extract_cookie_value
- `server/src/http/login.rs` — POST /auth/register, GET+POST /auth/login, POST /auth/logout
- `server/src/http/signup.rs` — magic-link routes gated behind password_reset_enabled
- `server/src/http/mod.rs` — updated router with new auth routes
- `server/src/config.rs` — login rate-limit fields + password_reset_enabled
- `server/src/cleanup.rs` — prune login_attempts > 24h
- `server/Cargo.toml` — add argon2 = "0.5"
- `server/tests/common/mod.rs` — register_teacher, insert_teacher_no_password fixtures
- `server/tests/http_signup.rs` — rewritten for password auth; 27 tests
- `server/tests/ws_lobby.rs` — fix test that re-registered an already-inserted teacher
- `web/assets/login.js` — email+password login form handler
- `web/assets/signup.js` — updated for /auth/register with password fields

**Commit:** `6290487`

## Sprint 9: Lobby completion + Warm Room chat — 2026-04-19

**Files changed:**
- `server/src/ws/protocol.rs` — `HeadphonesConfirmed` ClientMsg; `headphones_confirmed: bool` in `LobbyEntryView`; serde default + roundtrip tests
- `server/src/state.rs` — `headphones_confirmed` field on `LobbyEntry`; propagated via `view()`
- `server/src/ws/connection.rs` — `entry_id: Option<EntryId>` for O(1) headphones lookup
- `server/src/ws/lobby.rs` — `confirm_headphones()` with idempotence short-circuit; `join_lobby` populates `ctx.entry_id`
- `server/src/ws/mod.rs` — `HeadphonesConfirmed` dispatch; role guard
- `server/tests/ws_headphones.rs` — 5 integration tests: happy path, role guard, idempotence, post-admission guard, ordering guard
- `web/assets/self-check.js` — camera self-preview, mic level meter, headphones toggle; teacher sessionStorage gate; null-stream degraded path; refactored into `buildOverlayDOM`/`startMicMeter`/`makeTeardown`/`show`
- `web/assets/chat-drawer.js` — Warm Room chat drawer; split into `buildDrawerHeader`/`buildDrawerForm`/`buildMessageLog` helpers
- `web/assets/lobby-toast.js` — dark navy pill toast; max-3 eviction; two-stage auto-dismiss
- `web/assets/session-panels.js` — extracted from session-ui.js: `buildRemotePanel`, `buildControls`, `buildEndDialog`; reduces session-ui.js from 442 to 324 lines
- `web/assets/session-ui.js` — chat drawer wiring, `appendChatMsg` on handle, `setSayBadge`, uses `sbSessionPanels`
- `web/assets/signalling.js` — `sendHeadphonesConfirmed` on student handle; `Signalling` class moved to factory (Node-testable)
- `web/assets/teacher.js` — `lastStudentHeadphones` tracking; headphones chip in lobby entries; self-check always shown
- `web/assets/student.js` — self-check + headphones flush race fix; lobby toast; `onLobbyMessage` wiring
- `web/assets/theme.css` — `.sb-btn-badge`, `.sb-chat-drawer*`, `.sb-lobby-toast*`, `.sb-self-check*`, `.headphones-chip`
- `web/teacher.html`, `web/student.html` — removed `#chat-panel`/`#lobby-message-banner`; added script tags
- `web/assets/tests/self-check.test.js` — 14 tests incl. disabled-gating regression, null-stream, teacher stream-stop
- `web/assets/tests/chat-drawer.test.js` — 13 tests for chat drawer incl. open/close/unread/submit
- `web/assets/tests/lobby-toast.test.js` — 5 tests for toast lifecycle
- `web/assets/tests/session-ui.test.js` — headphonesConfirmed propagation tests, post-teardown appendChatMsg
- `web/assets/tests/signalling.test.js` — Signalling frame-ordering regression guard (4 tests)
- `server/tests/http_teach_debug_marker.rs` — session-panels.js load-order assertions

**Commit:** `3e1e592`

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

