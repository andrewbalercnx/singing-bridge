# singing-bridge — Sprint Roadmap

## Product summary

Browser-based, low-friction, high-fidelity audio/video tool for singing
lessons. A teacher has a persistent, magic-link–authenticated room at a
stable URL (`/teach/<slug>`). Students visit that URL, enter an email,
and wait in a lobby where the teacher sees their email, browser, and
device class. The teacher manually admits one student at a time into a
bidirectional full-fidelity A/V session.

**Design principles driving every sprint:**
- Student install is "go to a webpage, enter email" — no downloads, no device pickers, no options
- Audio fidelity is prioritised over latency; latency is minimised where it doesn't compromise fidelity
- Bidirectional high fidelity (the teacher often demonstrates)
- AEC/NS/AGC off by default; headphones recommended via a single setup note
- When bandwidth tightens, audio to the teacher is the last thing dropped

## Deployment target

- **Compute / storage**: Azure (Container Apps for the Rust server, VM for coturn, SQLite on attached volume)
- **Edge / DNS / TLS / magic-link email**: Cloudflare (pattern reused from prior rcnx.io projects)
- **Production URL**: `singing.rcnx.io`

---

## Sprint 1: Signalling foundation + teacher identity + lobby

**Goal:** A teacher can sign up via magic link, claim a stable room URL, and admit one student from a live lobby into a peer-to-peer data channel.

**Deliverables:**
- Rust server (axum) with WebSocket signalling and static-asset serving
- Teacher auth: magic-link email flow; SQLite for accounts, tokens, and room slugs (dev-mode SMTP sink acceptable this sprint)
- Teacher-chosen room slug at signup, validated against a reserved-word list; auto-generated fallback suggested on conflict
- Minimal browser client (HTML/JS, no bundler yet): requests mic/cam permissions, opens WebSocket, exchanges SDP + ICE
- Lobby: student visits `/teach/<slug>`, enters email, appears live in teacher's lobby; teacher manually admits one at a time
- Active session signalling runs alongside live lobby updates without interference

**Exit criteria:**
- Teacher on machine A completes magic-link signup, lands on `/teach/<slug>`
- Student on machine B visits URL, enters email; teacher sees them in lobby; teacher admits; data channel opens end-to-end and round-trips a "hello" message
- Disconnect on either side cleans up lobby and session state correctly

**Status:** COMPLETE — 2026-04-17, commit `b91a8c1` (code review APPROVED R2)

---

## Sprint 2: High-fidelity bidirectional audio

**Goal:** Full-fidelity bidirectional Opus audio with browser DSP disabled and music-mode codec settings.

**Deliverables:**
- `getUserMedia` constraints: `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `sampleRate: 48000`, `channelCount: 2`
- Opus music mode via SDP munging: `stereo=1; maxaveragebitrate=128000; useinbandfec=1; cbr=0`
- `playoutDelayHint: 0` on remote audio tracks
- Join page shows one setup note: *"Please wear headphones"* with a brief "why" tooltip
- Debug overlay (dev builds only) reporting one-way audio latency estimate, codec params, packet loss
- Loopback latency harness: mic→speaker round-trip measurement reported in a log

**Exit criteria:**
- Subjective listening test: both sides report high-fidelity audio (no pumping, no pitch modulation, clear sibilants and low fundamentals)
- SDP inspection confirms Opus at 128 kbps, stereo, music mode, FEC on
- One-way audio latency on LAN is measurably lower than WebRTC default configuration; exact number is recorded, not gated against

**Status:** COMPLETE — 2026-04-17, commit `ea612cf` (code review APPROVED R2)

---

## Sprint 3: Video track + two-tile UI + browser compatibility gating

**Goal:** Add bidirectional video, deliver a clean two-tile interface, and handle browser compatibility at the landing page.

**Deliverables:**
- Video track (VP8 default; H.264 fallback where hardware encoding matters, notably mobile)
- Browser UI:
  - Student view: large teacher tile, small self-preview, mute / video-off / end-call
  - Teacher view: large student tile, small self-preview, live lobby panel alongside
- Browser detection at landing page with three-tier response:
  - **Supported** (Chrome / Edge last 2, Firefox last 2, Safari desktop ≥ 16) → proceed silently
  - **Degraded** (iOS Safari, Android Firefox) → warn clearly with specifics ("reduced audio quality — iOS forces voice processing we cannot disable"); proceed; flag visible to teacher in lobby
  - **Unworkable** (in-app browsers — Facebook, Instagram, TikTok; pre-WebRTC browsers) → block with clear instructions to open the link in a proper browser
- Teacher lobby entry per student shows: email, browser name + version, device class (desktop / tablet / phone), degradation flag
- Mute / video-off / end-call work without renegotiating the peer connection

**Exit criteria:**
- Full bidirectional A/V session works on all supported browser pairs
- iOS Safari student joins with a visible warning; teacher sees "iOS Safari" flag in lobby
- In-app WebView join attempts are blocked with actionable guidance
- End-call cleans up all tracks and returns teacher to an empty room with lobby still live

**Status:** COMPLETE — 2026-04-17, commit `07800f4` (code review APPROVED R2, 95% convergence)

---

## Sprint 4: Bandwidth adaptation + quality hardening

**Goal:** Degrade gracefully under constrained bandwidth in a defined priority order, protecting audio-to-teacher as the last thing dropped.

**Deliverables:**
- RTCP-feedback-driven adaptive bitrate following this order (first to be dropped first):
  1. Student→teacher video resolution / bitrate
  2. Teacher→student video resolution / bitrate
  3. Teacher→student audio bitrate (floor: 48 kbps)
  4. Student→teacher audio bitrate (floor: 96 kbps — never drop below; this is the teacher's diagnostic signal)
- Opus FEC tuning; video NACK / RED
- Connection quality indicator in both UIs: packet loss %, estimated latency, bandwidth headroom
- "Your connection can't support this lesson" surface when student→teacher audio can't hold the 96 kbps floor
- Network-impairment test harness (`tc netem` or equivalent): behaviour verified at 2% loss / 20 ms added jitter
- Automatic reconnect on transient network drop (target: session restored within 5 s without user action)

**Exit criteria:**
- Subjective audio quality rated "good" at 2% simulated loss
- Degradation order empirically matches spec when bandwidth is squeezed in the harness
- Audio-to-teacher floor is respected; floor-violation surface fires correctly
- Transient 2–3 s network drop is auto-recovered

**Status:** COMPLETE — 2026-04-17, commit `22a46bf` (code review APPROVED R3)

---

## Sprint 5: Azure + Cloudflare deployment + TURN + session log

**Goal:** Ship to production at `singing.rcnx.io`, on Azure behind Cloudflare, with TURN for NAT traversal and a minimal session log.

**Deliverables:**
- Infrastructure-as-code (Bicep preferred, Terraform acceptable) covering:
  - Rust signalling server on Azure Container Apps
  - SQLite on attached persistent volume (defer Azure SQL until actually needed)
  - coturn on Azure VM with static public IP — note: TURN (UDP) cannot be proxied through Cloudflare and must route direct
  - Cloudflare DNS, TLS edge, static-asset CDN in front of the signalling server
- Magic-link email delivery via Cloudflare, matching the pattern used on prior rcnx.io projects
- `singing.rcnx.io` DNS + TLS provisioned via Cloudflare, pointing at the Azure Container App
- Session log (server-side, no PII beyond hashed email + session id): start time, duration, peak packet loss, browser / device class
- Abuse mitigation: per-room lobby cap (default 10 waiting), per-IP join rate limit, teacher-initiated block of a lobby entry
- Deployment runbook added to `knowledge/runbook/`

**Exit criteria:**
- Teacher on home broadband + student on a different ISP complete a 10-minute A/V session via the production URL
- TURN relay is used when direct P2P fails; verified via a forced TURN-only test
- Rate limit and lobby cap enforced under synthetic load
- Session log entries reconcile with observed sessions; no raw PII on disk

**Status:** COMPLETE

---

## Sprint 6: Session recording

**Goal:** Teacher can record a lesson, send the recording link to the student by email after the session, and manage their recording library from a dedicated page.

**Deliverables:**

_Recording mechanism_
- Teacher initiates recording via a "Record" button in the session UI
- Both teacher and student see a consent banner; recording begins only when student accepts; if student declines or does not respond within 30 s the button resets
- A prominent "REC" indicator is visible on both sides throughout the recording
- Client-side `MediaRecorder` on the teacher's browser captures a composite stream: Web Audio API mixes teacher mic + student remote audio; teacher video track is included; output is WebM
- On session end, or when teacher stops recording, the completed file is uploaded to Azure Blob Storage; upload progress is shown; teacher is not forced to wait (upload can continue in background after session tears down)

_Post-session send flow_
- Immediately after the session ends, teacher sees a modal: **"Send recording to [student@email.com]"** — pre-filled with the student's lobby email but editable; teacher can dismiss without sending
- On send: server stores the recording metadata (recipient email as SHA-256 hash, plus an encrypted copy for display), generates a random 256-bit access token (stored as SHA-256 hash), and delivers an email via Cloudflare containing a link to `/recording/<token>`

_Student access_
- `/recording/<token>` presents an email gate: *"Enter the email address this link was sent to"*
- Server checks SHA-256(lowercase(input)) == stored hash; on match, streams the recording from Azure Blob Storage
- No account, no password; three failed attempts per token disables the token and notifies the teacher by email
- Successful access is logged (timestamp, no IP stored)

_Teacher recording library_
- New page at `/teach/<slug>/recordings`, behind the existing teacher magic-link auth
- Lists all recordings with: date, student email (displayable), duration
- Sortable by date (default: newest first) or by student email
- Per-row actions: **Send link** (re-sends email; address is editable in a small inline field before confirming), **Delete** (soft-delete with 24 h grace before blob is permanently purged)
- Disabled/expired recordings shown with a "link disabled — resend to reactivate" status

_Infrastructure_
- New SQLite table `recordings`: id, room\_id, teacher\_id, student\_email\_hash, student\_email\_encrypted, created\_at, duration\_s, blob\_key, token\_hash, failed\_attempts, deleted\_at
- Azure Blob Storage container for recording files (private, no public URL); access via server-proxied stream
- Background cleanup task: purge blobs where `deleted_at < now() - 24h`
- No new infra beyond Blob Storage (no SFU, no transcoding service)

**Exit criteria:**
- Teacher starts recording mid-session; student sees and accepts consent prompt; "REC" indicator appears on both sides
- Session ends; teacher modal appears pre-filled with student email; teacher sends the link; email arrives in the dev SMTP sink
- Student opens the link, enters the correct email, plays back the recording in-browser
- Wrong email is rejected; three wrong attempts disable the token
- Teacher recording library shows the recording; sort by date and by student each work; delete removes the entry from the list; blob is gone after the grace period
- Re-sending the link from the library delivers a fresh email with the same token (or a new one if the old one was disabled)

**Status:** COMPLETE — 2026-04-18, commit `8b57461` (code review APPROVED R4)

---

## Sprint 7: In-session chat + lobby messaging

**Goal:** Teacher and admitted student can exchange text messages during a session; teacher can also send a one-way message to a student waiting in the lobby.

**Deliverables:**

_In-session chat (bidirectional)_
- A chat panel is visible on both teacher and student session pages
- Either party can type and send a message; it appears on both sides in real time
- Messages are ephemeral — no persistence, lost on disconnect
- Text capped at 500 characters; server rejects oversized messages with `PayloadTooLarge`

_Lobby messaging (one-way, teacher → waiting student)_
- Each lobby entry in the teacher UI gains a "Message" inline action
- Teacher types a short message and sends; it is delivered to that student's WebSocket connection before admission
- Student receives it as a banner/toast ("Message from your teacher: …")
- Student cannot reply until admitted

_Protocol_
- New `ClientMsg::Chat { text: String }` — relayed between teacher and admitted student
- New `ClientMsg::LobbyMessage { entry_id: EntryId, text: String }` — teacher sends to a specific lobby entry
- New `ServerMsg::Chat { from: Role, text: String }` — delivered to the other party in session
- New `ServerMsg::LobbyMessage { text: String }` — delivered to the waiting student
- New `ErrorCode::ChatNotInSession` — teacher/student sends Chat with no active session

**Exit criteria:**
- Teacher sends a chat message during a session; student sees it immediately, and vice versa
- Teacher sends a lobby message to a waiting student; student sees the banner before admission
- Message over 500 chars is rejected with `PayloadTooLarge` error
- Chat with no active session returns `ChatNotInSession` error
- LobbyMessage to unknown entry_id returns `EntryNotFound` error

**Status:** COMPLETE — 2026-04-18, commit `2de1433` (code review APPROVED R4)

---

## Sprint 8: Variation A "The Warm Room" Session UI

**Goal:** Implement the Claude Design "Warm Room" brief — breath ring, audio meters, muted banner, control cluster, and self-preview — wired to real WebRTC audio/video.

**Deliverables:**
- `web/assets/session-ui.js` — Variation A session UI component; `mount(container, opts)` → `{ teardown, setRemoteStream }`
- `web/assets/theme.css` — design tokens + session layout CSS; self-hosted Fraunces + Poppins WOFF2 fonts
- `web/assets/fonts/` — WOFF2 assets + `CHECKSUMS.txt` for provenance
- `deriveToggleView` relocated from deleted `controls.js` to `session-ui.js`
- `teacher.html` / `student.html` — replaced static tiles/controls with `#session-root`; added `theme.css` and `session-ui.js`; `student.html` gains viewport meta
- `teacher.js` / `student.js` — replaced `wireControls` with `sbSessionUI.mount`
- `signalling.js` — `playoutDelayHint = 0` moved into `dispatchRemoteTrack` (now testable)
- `server/tests/http_teach_debug_marker.rs` — updated assertions for new DOM structure + no-Google-Fonts guard
- `web/assets/tests/session-ui.test.js` — 27 tests covering fmtTime, deriveToggleView, buildBaselineStrip, buildMutedBanner, runAudioLoop, mount lifecycle, XSS
- `web/assets/tests/signalling.test.js` — playoutDelayHint regression guard added
- 185 total JS tests, all Rust tests pass

**Exit criteria:**
- Session UI mounts into `#session-root` with breath ring driven by remote audio RMS
- `teardown()` is idempotent; calls `audioCtx.close()` once
- `localStream: null` mounts without error; no muted banner fires
- No Google Fonts referenced; fonts are self-hosted with checksums
- All tests pass

**Status:** COMPLETE — 2026-04-19, commit `644063e` (code review APPROVED R3)

---

## Sprint 9: Lobby completion + Warm Room chat

**Goal:** Complete the pre-session experience for both parties and deliver Warm Room–styled chat — during the session and as one-way messaging while the student waits in lobby.

**Deliverables:**
- Pre-session self-check screen for teacher and student: camera self-preview, mic level indicator, headphones confirmation toggle
- `HeadphonesConfirmed` message flows server-side; teacher lobby entry shows live headphones chip
- `headphonesConfirmed` in session-ui mount opts reflects actual confirmed state (not hardcoded `false`)
- Warm Room chat drawer (in `session-ui.js`): slide-up panel, Fraunces italic header, unread dot on Say button
- Warm Room lobby message toast (`lobby-toast.js`): dark navy pill, Fraunces italic, auto-dismiss with fade
- `#chat-panel` and `#lobby-message-banner` static HTML elements removed; replaced by JS-owned components
- New test files: `self-check.test.js`, `lobby-toast.test.js`; extended `session-ui.test.js`; new Rust integration test `ws_headphones.rs`

**Exit criteria:**
- Student completes self-check and confirms headphones; teacher sees chip update live in lobby before admitting
- Session UI chip reflects actual headphones state
- Say button opens Warm Room chat drawer; messages send and receive in real time; unread dot fires on new message
- Teacher sends lobby message; student sees styled toast; it auto-dismisses after 8 s
- Teacher self-check overlay appears once per browser session; doesn't re-appear on reload
- All existing tests pass; new tests cover the headphones protocol, chat drawer, and toast

**Status:** COMPLETE

---

## Sprint 10: Password auth — replace magic link

**Goal:** Replace the one-shot magic-link flow with a conventional email + password account, giving teachers a stable, always-accessible login without depending on email delivery at session time.

**Deliverables:**
- New DB migration: add `password_hash` (Argon2id) column to `teachers`; magic-link tables remain but are no longer the primary auth path
- `/auth/register` route: accepts email + password + slug; validates; stores hashed password; issues session cookie
- `/auth/login` POST route: verifies password with constant-time compare; issues session cookie on success
- `/auth/logout` route: invalidates session cookie
- Session cookie: `HttpOnly; Secure; SameSite=Strict`; backed by a `sessions` table (id, teacher_id, expires_at)
- Update `/signup` and `/teach/<slug>` pages to use the new login form instead of the magic-link form
- Rate-limit login attempts per IP (reuse `auth::rate_limit`); lock account for 15 min after 10 consecutive failures
- Remove magic-link email dispatch from the hot path (retain `magic_link.rs` as a password-reset fallback, disabled by default)
- All existing session/recording/WS flows unchanged; only the auth layer is replaced

**Exit criteria:**
- Teacher registers with email + password; lands on `/teach/<slug>` without any email step
- Teacher logs out and back in with correct password; rejected with wrong password
- 10 bad attempts from the same IP triggers a 429 / lockout response
- Existing integration tests pass; new tests cover register, login, logout, lockout, and session expiry

**Status:** COMPLETE

---

## Sprint 11: Persistent student records + session history

**Goal:** Persist enough session data to give the teacher a useful history view — who they taught, when, and how long — without requiring a database migration off SQLite.

**Deliverables:**
- New migration: `students` table (id, email, first_seen_at, teacher_id); `sessions` table extended or new `session_events` table (teacher_id, student_email, started_at, ended_at, duration_s, recording_id nullable)
- Student record upserted on `LobbyJoin` admission; session event written on clean hangup and on peer-disconnected cleanup
- `/teach/<slug>/history` page: lists past sessions in reverse-chronological order (date, student email, duration, recording link if present)
- Recordings list page (`/teach/<slug>/recordings`) updated to link back to the session event
- Background cleanup job extended to archive sessions older than 90 days rather than delete them (soft-delete via `archived_at`)
- No new external dependencies; SQLite + sqlx only

**Exit criteria:**
- After a session ends, teacher can visit `/teach/<slug>/history` and see the completed session with student email, start time, and duration
- Sessions with a recording show a link to the recording
- Cleanup job does not hard-delete sessions; sets `archived_at` instead
- All existing tests pass; new tests cover the upsert path, session-event write, and history endpoint

**Status:** COMPLETE

---

## Sprint 11A: Sprint 11 findings remediation

**Goal:** Close all remaining open findings from Sprint 11 — one security fix, two WONTFIX disposals, and targeted code-quality and test improvements with no new features or migrations.

**Deliverables:**
- Add `Cache-Control: no-store` to the `/teach/<slug>/history` response (#3, #26)
- Make `StudentId` and `SessionEventId` opaque newtypes (`#[sqlx(transparent)]`) so the compiler rejects cross-type misuse (#9, #15, #25)
- Extract the session-history block in `admit()` to a private helper; remove the redundant inner `teacher_id` unwrap (#22, #27, #28)
- Rename `duration_s` → `duration_display` in `history.rs`; rename `ActiveSession::student_id` → `session_student_id` (#11, #29, #30)
- Replace the 100 ms real sleep in `session_event_row_has_ended_at_after_disconnect` with a polling loop (#24)
- Mark #12 (student erasure path) and #14 (slot overwrite) as WONTFIX in the findings tracker with rationale

**Exit criteria:**
- `GET /teach/<slug>/history` response carries `Cache-Control: no-store`
- The Rust compiler rejects any attempt to bind a `StudentId` where a `SessionEventId` is expected and vice versa
- `admit()` body is ≤ 4 levels of nesting for the session-history path
- `cargo test` passes; `session_event_row_has_ended_at_after_disconnect` contains no `tokio::time::sleep`
- All Sprint 11 findings are in a non-OPEN state

**Status:** COMPLETE

---

## Sprint 12: Accompaniment pipeline + library backend

**Goal:** Promote the PDF-to-audio pipeline from spike to a production sidecar, build the DB schema and all REST API routes for the accompaniment library, and establish authenticated media delivery — giving the teacher a fully functional JSON API for managing backing tracks.

**Deliverables:**

_Python sidecar (`sidecar/`)_
- Promoted and hardened from `spike/pdf_to_piano_audio/pipeline/`; stateless Flask service
- Bearer-auth (`SIDECAR_SECRET`, min 32 bytes) on every request; sidecar rejects without valid token
- Endpoints: `/omr`, `/list-parts`, `/extract-midi`, `/bar-timings`, `/bar-coords`, `/rasterise`, `/synthesise`, `/healthz`
- Bounded inputs: max 50 MB upload, 40 pages, DPI ≤ 300, `tempo_pct` 25–300, `transpose_semitones` −12–12
- Defined error-code enum (`INVALID_PARAMS`, `OMR_FAILED`, `AUDIVERIS_MISSING`, `FLUIDSYNTH_MISSING`, etc.)
- `sidecar/Dockerfile`: Python 3.12 + FluidSynth + FluidR3_GM SoundFont + Java 17 JRE for Audiveris
- `docker-compose.yml` dev: sidecar alongside server, shared `SIDECAR_SECRET` via `.env`

_DB migrations_
- `0006_accompaniments.sql`: `accompaniments` and `accompaniment_variants` tables with `CHECK` constraints enforcing `tempo_pct` (25–300) and `transpose_semitones` (−12–12)

_Rust sidecar client (`server/src/sidecar.rs`)_
- SSRF-validated `SIDECAR_URL` (loopback or explicit `SIDECAR_HOST_ALLOWLIST`; private IPs blocked unless allowlisted)
- `Authorization: Bearer` sent on every request; error-code enum mapped to `AppError` variants

_Rust library routes (`server/src/http/library.rs`)_
- All routes require teacher session cookie; ownership join (`teacher_id`) on all asset/variant lookups
- Upload (PDF/MIDI/WAV) with magic-byte-first detection; POST parts/MIDI/rasterise/synthesise/delete
- Bounded JSON persistence: `bar_coords_json` ≤ 500 KB, `bar_timings_json` ≤ 100 KB, `page_blob_keys_json` ≤ 10 KB
- `Cache-Control: no-store` on the library HTML page

_Media token delivery_
- In-memory `MediaTokenStore` (cap 1000, expiry sweep on insert and access, teardown cleanup)
- `GET /api/media/<token>`: 404 for both unknown and expired tokens (no oracle); WAV tokens multi-use
- Prod: Azure SAS URL with 5-min TTL, read-only (`sp=r`)

**Exit criteria:**
- `POST /teach/<slug>/library/assets` with a PDF → asset row created; OMR returns parts list; part selection extracts MIDI; synthesis creates a WAV variant — all verifiable via JSON API
- Two WAV variants at different `tempo_pct` values appear under the same asset
- Sidecar unavailable → library endpoints return 503; existing session and WS flows unaffected
- Teacher A cannot access or mutate Teacher B's assets via any route or WS message
- `SIDECAR_URL` pointing at a non-loopback, non-allowlisted host → server fails to start
- `SIDECAR_SECRET` shorter than 32 bytes in prod → server fails to start
- All new Rust and Python tests pass; no real Audiveris/FluidSynth calls in CI

**Status:** COMPLETE — 2026-04-21, commit `e362ed5` (Sprint 12A closed all remaining gaps)

---

## Sprint 12A: Accompaniment backend — gap closure

**Goal:** Close the eleven gaps between the approved Sprint 12 plan and what was delivered — WAV upload, 413 enforcement, sidecar AppError variants, structured upload error codes, missing integration tests, docker-compose, and E2E test foundation.

**Deliverables:**
- WAV direct upload → auto-creates `accompaniment_variants` row (`tempo_pct=100`)
- `Content-Length` > 50 MB → 413 before body read
- `AppError::SidecarUnavailable` (→ 503) and `AppError::SidecarBadInput` (→ 422) added to `error.rs`; `sidecar.rs` updated
- Structured upload error codes: `CONTENT_TYPE_MISMATCH` (422), `UNSUPPORTED_FILE_TYPE` (422)
- Missing integration tests #2–5, #8–10, #12 from Sprint 12 test strategy
- `docker-compose.yml` + `.env.example` at repo root
- `tests/e2e/sidecar_stub/app.py` — minimal stub returning fixture responses
- `tests/e2e/library.spec.ts` — E2E: library page loads with correct title
- Plan correction documented: `bar_coords` takes `pdf` only (no `musicxml`); plan had an error

**Exit criteria:**
- WAV upload → `GET /assets/:id` shows `variants` array with one entry at `tempo_pct=100`
- `Content-Length: 52428801` → 413 before any pipeline work
- `Content-Type: application/pdf` + MIDI bytes → 422 with `code: CONTENT_TYPE_MISMATCH`
- `POST /parts` when sidecar is down → 503; `GET /healthz` still 200
- All 17 existing + 8 new Rust library tests pass
- E2E `library.spec.ts` passes against sidecar stub
- `docker-compose up` starts both server and sidecar

**Status:** COMPLETE — 2026-04-21, commit `e362ed5` (plan approved R6, all deliverables verified)

---

## Sprint 13: Library management UI — COMPLETE (2026-04-23)

**Goal:** Give the teacher a browser-based interface for building and managing their accompaniment library, wired entirely to the Sprint 12 JSON API.

**Deliverables:**
- `web/templates/library.html` + `web/assets/library.js` — full library management page
- Asset list: title, variant count, upload date, delete button
- Upload panel: drag-and-drop or file picker; auto-detects PDF / MIDI / WAV
- Per-asset OMR flow: "Run OMR" → part picker → "Extract MIDI" → "Rasterise pages" with progress indication
- Per-asset synthesise form: label, tempo % (25–300), transpose (−12–12), respect repeats toggle
- Per-variant: re-synthesise and delete actions
- Sidecar 503 → "Sheet music tools unavailable" banner; other operations unaffected
- `web/assets/tests/library.test.js`: upload flow, OMR multi-step, synthesise form validation, delete confirmation, 503 banner

**Exit criteria:**
- Teacher can upload a two-page PDF, run OMR, select parts, extract MIDI, synthesise two variants at different tempos — all via the browser UI
- Deleting an asset removes it from the list
- Sidecar 503 shows the banner without breaking upload or delete
- All JS tests pass; no regression in existing test suite

**Status:** COMPLETE — 2026-04-23, commit `e116b95` (plan approved R5)

---

## Sprint 14: In-session accompaniment playback + score view

**Goal:** Teacher selects a backing track during a lesson; both parties hear it and see a synchronised bar-by-bar score walkthrough.

**Deliverables:**

_WebSocket protocol additions_
- `ClientMsg::AccompanimentPlay { asset_id, variant_id, position_ms }` (teacher only)
- `ClientMsg::AccompanimentPause { position_ms }` (teacher only)
- `ClientMsg::AccompanimentStop` (teacher only; also sent by client on audio `ended` event)
- `ServerMsg::AccompanimentState { asset_id?, variant_id?, is_playing, position_ms, tempo_pct?, wav_url?, page_urls?, bar_coords?, bar_timings?, server_time_ms }`
- Student sending any accompaniment message → `ErrorCode::Forbidden`

_In-session frontend_
- `web/assets/accompaniment-drawer.js`: `mount(container, opts)` → `{ teardown, updateState }`; teacher controls (play/pause/stop/scrub); student read-only view; local clock with `tempo_pct / 100` bar-lookup formula; `ended` event → `AccompanimentStop`
- `web/assets/score-view.js`: `mount(container, opts)` → `{ teardown, seekToBar }`; rasterised page display with bar-highlight overlay; degrades gracefully to audio-only if no coords/pages
- `teacher.html` / `student.html` — `#accompaniment-drawer-root` + `#score-view-root` containers wired up

**Exit criteria:**
- Teacher opens the in-session drawer, picks an asset and variant; both parties hear the audio begin at the same moment
- Teacher pauses; student's audio pauses. Teacher scrubs to bar 4 and resumes; student resumes from bar 4
- Score walkthrough highlights the correct bar on both sides throughout playback
- Audio ends naturally → both sides stop; playback state cleared
- Student cannot send play/pause/stop (no controls rendered; WS rejects if sent directly)
- WAV-only asset → audio plays with no score panel; no error
- All existing A/V, chat, and recording flows unaffected
- All new JS and Rust WS tests pass

**Status:** COMPLETE — 2026-04-23, code review APPROVED R3 (38% convergence, 84 findings closed)

---

## Sprint 15: Web MIDI keyboard recording

**Goal:** Teacher can record a live performance from an attached MIDI keyboard directly into the accompaniment library, bypassing the PDF/OMR upload flow.

**Deliverables:**
- Web MIDI API integration in `library.js`: enumerate available MIDI input devices on page load; show a "Record from keyboard" button when at least one device is detected
- Recording UI: device picker (if multiple keyboards present), record/stop controls, real-time note visualisation (simple piano roll or note name display) during recording
- MIDI capture: collect `note_on` / `note_off` / `control_change` events with accurate timestamps; on stop, serialise to a standard Type-1 MIDI file in the browser (no server round-trip for capture)
- Upload the captured MIDI file to the existing `POST /api/accompaniments/:id/midi` endpoint, creating or updating the MIDI component of an asset
- New asset flow: "Record keyboard" creates a new accompaniment asset (teacher names it before or after recording), then drops straight into the synthesise step
- Graceful degradation: if `navigator.requestMIDIAccess` is unavailable (Firefox without flag, iOS), hide the button with a tooltip explaining the browser requirement
- New JS tests: device enumeration mock, note capture timing, MIDI serialisation round-trip, unavailable-API degradation path

**Exit criteria:**
- Teacher connects a MIDI keyboard; "Record from keyboard" button appears in the library UI
- Teacher records a short phrase; stops recording; a MIDI file is created and attached to a new or existing asset
- The captured MIDI can be synthesised into a WAV using the existing synthesise flow
- No MIDI device connected → button hidden; no error
- Web MIDI unavailable (mocked) → graceful degradation with tooltip
- All existing library tests pass; new MIDI recording tests pass

**Status:** COMPLETE — 2026-04-23, commit `f13e8b8` (code review APPROVED R3)

---

## Sprint 16: Persistent database

**Goal:** Replace the ephemeral SQLite-on-`/tmp` workaround with a durable database, so teacher accounts, sessions, recordings, and accompaniment metadata survive deploys and restarts.

**Background:**
Azure Container Apps mount Azure Files over SMB, which does not support the POSIX advisory locks SQLite WAL mode requires. The current workaround is `SB_DATA_DIR=/tmp`, meaning the database is wiped on every redeploy. All teacher data — accounts, session history, recordings, accompaniment library — is lost.

**Options analysis (first deliverable in the plan):**

Evaluate each option against three axes for a small system (handful of teachers, ~100 sessions/month):

| Option | Operational complexity | Robustness | Est. monthly cost |
|--------|----------------------|-----------|-----------------|
| **A. SQLite on Azure Disk (Premium SSD P2, block storage)** | Low — no code changes; WAL re-enabled; single-connection limit lifted | Medium — block storage is durable; no HA; single-replica constraint stays | ~$2–3 (32 GB P2 disk attached to Container App) |
| **B. Turso (libSQL cloud)** | Low-medium — `libsql` Rust client replaces `sqlx sqlite`; SQL dialect identical; multi-connection pool | Medium-high — managed, replicated, automatic backups; no infra to operate | Free tier (9 GB, 500 DBs) → $29/month Scaler |
| **C. Neon (serverless PostgreSQL)** | Medium — sqlx dialect change (`sqlite` → `postgres`); SQL rewrites for `RETURNING`, `SERIAL`, JSON ops | High — fully managed, HA, PITR backups, scales to zero | Free tier (0.5 vCPU, 3 GB) → $19/month Launch |
| **D. Azure Database for PostgreSQL Flexible Server (burstable B1ms)** | Medium — same sqlx dialect change as C | High — managed, HA option, Azure-native (same region, VNet-peerable) | ~$13–17/month always-on |

Recommendation to evaluate during planning: **Option B (Turso)** for lowest migration effort at zero cost for current scale, with **Option C (Neon)** as the upgrade path if PostgreSQL features are needed. Option A is viable if we want to stay on Azure infra only. Option D is over-provisioned at this scale.

**Deliverables:**
- Options analysis in `PLAN_Sprint16.md` with a final recommendation and rationale
- Chosen backend provisioned and accessible from Container App (credentials in Azure Key Vault / env)
- `server/src/db.rs` updated: connection string, pool size, dialect (if switching from SQLite)
- All SQL migrations ported to the new dialect (if PostgreSQL); SQLite-specific pragmas removed
- Schema-only data migration script: creates tables in new DB; existing ephemeral data is accepted as lost (no row migration needed — no production data exists)
- `server/src/config.rs`: `db_url` env var points at new backend; `SB_DATA_DIR` no longer required for DB
- `knowledge/` updated: deployment target section, runbook updated for new DB provisioning/backup steps
- All existing Rust integration tests pass against the new backend (test harness updated if dialect changes)

**Exit criteria:**
- Deploy the server to Azure Container Apps; restart the container; teacher account created before restart is still present after restart
- `cargo test` passes with the new DB backend
- No reference to `/tmp` SQLite path in production config
- Runbook documents how to take a backup and how to restore from backup
- Connection pool is no longer capped at 1

**Status:** COMPLETE — 2026-04-23, commit `a57792a` (code review APPROVED R6, 81% convergence)

---

## Sprint 17: Teacher dashboard + session UI redesign

**Goal:** Replace the confusing single-page teacher UI with a clear dashboard hub and a properly laid-out session view, so the teacher can access all their assets at a glance and run a lesson without UI friction.

**Deliverables:**

_Teacher dashboard (`GET /teach/<slug>/dashboard`)_
- New server route and `dashboard.html` page served only to the authenticated room owner
- Dashboard shows three asset panels: **Lobby** (students waiting, with admit/reject/message), **Recordings** (list of past recordings, send/delete), **Library** (accompaniment assets, upload/synthesise shortcuts)
- Prominent **"Go Live"** button that navigates to the session room
- Lobby panel is live (WebSocket-backed) — shows waiting students in real time with admit/reject actions
- Dashboard is the new default landing for the teacher (teacher arriving at `/teach/<slug>` while authenticated is redirected to `/teach/<slug>/dashboard`)
- Unauthenticated visitors at `/teach/<slug>` continue to see `student.html` (no change)

_Session UI layout (laptop-first)_
- **Three-zone layout:** other-view (large, left ~65% width, full height), accompaniment panel (right ~30%, collapsible), self-view PiP overlay (small, bottom-left of other-view, ~20% of that panel width)
- **Icon-only control bar** at the bottom of the session: mic mute, camera mute, leave call, accompaniment toggle; teacher-only icons shown only for the teacher role; all icons use SVG with `aria-label`
- Accompaniment panel slides in from the right when toggled; when closed, other-view expands to fill
- Self-view is a fixed-position PiP overlay within the other-view panel, not a separate tile

_Accompaniment panel (teacher-only)_
- Position slider (seek within track)
- Pause / Resume button
- Toggle score viewer (show/hide the sheet music pane)
- Current track name displayed
- Panel state (open/closed) persisted in `sessionStorage` so it survives soft reloads

**Exit criteria:**
- Teacher at `/teach/<slug>` is redirected to dashboard; unauthenticated visitor sees student join form (no regression)
- Dashboard lobby updates in real time when a student joins or leaves
- Teacher can admit a student from the dashboard lobby; session view opens
- Session view: other-view fills the majority of the screen, self-view is a small PiP overlay, accompaniment panel opens/closes via icon
- Accompaniment panel: seek slider, pause/resume, score-viewer toggle all functional
- Layout tested at 1280×800 and 1440×900 (typical laptop); no horizontal scroll; no overlapping elements
- All existing lobby admit/reject/message actions still work

**Status:** COMPLETE — 2026-04-23, commit `a39a5be` (code review APPROVED R4, 87% convergence)

---

## Sprint 18: No-headphones support + chatting mode + iOS path

**Goal:** Support a singing lesson when the student cannot wear headphones — play the accompaniment on the student's machine only, keep the teacher muted from the backing track, and provide a push-to-talk "chatting" mode that enables AEC on the student's mic only while the teacher is actually speaking. Make iOS students (where AEC cannot be turned off) a first-class supported configuration rather than a degraded-tier warning.

**Background:**
ADR-0001 §Echo states that echo is avoided by a single "Please wear headphones" setup note rather than software. Sprint 9 added a self-check checkbox that records the student's confirmation and surfaces it to the teacher as a chip. Today the session still assumes headphones: AEC is off on both sides, the accompaniment plays on both peers, and a student on open speakers causes the teacher's voice to return via the student's mic (classic echo loop), while the accompaniment bleeds back and doubles with the teacher's local copy.

This sprint acknowledges that not every student can wear headphones (young kids, chromebook-in-a-classroom, iOS Safari where the OS forces AEC regardless) and builds a coherent acoustic mode for that case:

- Backing track plays **only on the student's machine**, so the teacher hears the student's voice blended with the natural room mix rather than a time-shifted double.
- AEC stays **off by default** during singing (preserving music-mode fidelity), but flips **on automatically** when the teacher starts talking — "chatting mode." Detection is VAD-driven on the teacher's outbound voice, with a minimum 3 s hangover after the teacher falls silent so quick back-and-forth doesn't thrash the DSP. Chatting mode is **suppressed while accompaniment is playing** — the whole point of the accompaniment is clean musical reproduction on the teacher's ear, so we never engage AEC in that window regardless of what VAD says.
- iOS students get the same acoustic model automatically, because `echoCancellation: false` is unenforceable on iOS Safari and treating them identically to speakers-only desktops is correct.

**Deliverables:**

_Acoustic profile model_
- New enum `AcousticProfile` = `headphones` | `speakers` | `ios_forced`, stored on the lobby entry and propagated to the active session
- Auto-detect at the student end during self-check:
  - iOS Safari (any browser on iOS, per existing `browser.js` detection) → `ios_forced`, self-check headphones checkbox hidden with an explanatory note
  - Desktop student who un-checks "I'm wearing headphones" → `speakers`
  - Desktop student who checks the box → `headphones` (current default)
- `sbSelfCheck.show` gains `onConfirm(profile)` (replacing the boolean `headphonesConfirmed`); teacher call-sites adjusted

_Protocol additions (`server/src/ws/protocol.rs`)_
- `ClientMsg::StudentAcousticProfile { profile }` — sent by the student after self-check; replaces (alongside) `HeadphonesConfirmed` which is kept for backward compat and mapped to `profile = headphones` when received
- `ClientMsg::AcousticProfileOverride { profile }` (teacher only) — manual override if the teacher can see the student doesn't have earphones even though the student didn't un-check the box; student sending → `ErrorCode::Forbidden`
- `ClientMsg::ChattingMode { enabled }` (teacher only, in-session) — emitted by the teacher's VAD edge detector (rising edge on voice onset; falling edge 3 s after silence, suppressed while accompaniment is playing); student sending → `ErrorCode::Forbidden`
- `ServerMsg::AcousticProfile { profile, source: "student" | "teacher_override" }` — delivered to the student so the client can adjust local behaviour
- `ServerMsg::ChattingMode { enabled }` — delivered to the student
- `LobbyEntryView.profile` added; `headphones_confirmed` retained as a derived boolean for existing UI until fully migrated

_Student client behaviour (`web/assets/audio.js`, `signalling.js`, `student.js`)_
- On receiving `AcousticProfile { profile: speakers | ios_forced }` the client keeps AEC off but records the profile locally (for UI) and accepts `ChattingMode` toggles
- On receiving `ChattingMode { enabled: true }`, student calls `micTrack.applyConstraints({ echoCancellation: true, noiseSuppression: true })`; on `enabled: false`, reverts to `{ echoCancellation: false, noiseSuppression: false }`
- iOS: `applyConstraints` is best-effort; UI reflects "chat mode always on (iOS)"; no console error path when constraints are ignored by the OS
- No SDP renegotiation — Opus stays in music mode throughout; only the browser-side DSP flags flip

_Teacher client behaviour (`web/assets/session-ui.js`, `accompaniment-drawer.js`, `teacher.js`, new `teacher-vad.js`)_
- Accompaniment drawer: when the active session's profile is `speakers` or `ios_forced`, the teacher's local `<audio>` element for the backing track is muted (`el.muted = true`); the track still loads so scrub/tempo/score-viewer work unchanged; a small banner reads "Playing on student side only — muted for you"
- New `teacher-vad.js` module: tap the teacher's mic track via a Web Audio `AnalyserNode`; simple energy-based VAD (RMS over 20 ms frames, hysteresis thresholds to avoid flicker); emits `onSpeechStart` and `onSpeechEnd` callbacks
- `ChattingMode` state machine: `enabled` rises on `onSpeechStart`, falls 3 s (configurable; 3000 ms default) after `onSpeechEnd`; rising-edge transitions are **gated** — if accompaniment is currently playing (per `AccompanimentState.is_playing`), the machine stays in `disabled` until playback stops. Edge transitions are debounced so a brief pause within a sentence doesn't emit an off/on pair
- A small status chip in the session UI reflects live state ("Chat: auto (listening)" / "Chat: on" / "Chat: suppressed — accompaniment playing"), so the teacher can see and trust the automation; clicking the chip offers a "force on" / "force off" manual override for edge cases
- Manual override for acoustic profile: in the lobby row and session panel, a small three-state switch lets the teacher set the profile explicitly (useful when the student forgot to un-check the box)

_UI surfaces_
- Session-panel headphones chip generalised to an "Acoustic" chip with three states: 🎧 Headphones / 🔊 Speakers / 📱 iOS (AEC locked)
- Lobby entry chip matches the same three states
- Teacher session view gains a live "Chat" status chip alongside existing mic/camera icons with three states: Auto-listening / On / Suppressed (accompaniment playing); chip is clickable for manual override; for `ios_forced` the chip shows "Always on — iOS forces voice processing" and is disabled

_Tests_
- Rust WS tests: `StudentAcousticProfile` round-trip; `AcousticProfileOverride` teacher-only (student sends → Forbidden); `ChattingMode` teacher-only (student sends → Forbidden); backward compat — a client that still sends `HeadphonesConfirmed` yields `profile = headphones`
- JS tests (`self-check.test.js`): iOS UA yields `ios_forced` and hides the checkbox; desktop un-checked yields `speakers`; desktop checked yields `headphones`
- JS tests (`signalling.test.js` / new `acoustic.test.js`): `AcousticProfile` server message triggers the right local state; `ChattingMode` server message calls `applyConstraints` with the expected shape; `ChattingMode` off reverts
- JS tests (new `teacher-vad.test.js`): fake-timer driven — energy above threshold for ≥ 40 ms raises `onSpeechStart`; silence for 3 s raises `onSpeechEnd`; brief 200 ms dip does not flip off; `is_playing = true` gates rising edges (no `ChattingMode { enabled: true }` emitted); `is_playing` transition true → false with voice already active fires `enabled: true` with no artificial delay; hangover timer is cancelled cleanly on teardown
- JS tests (`accompaniment-drawer.test.js`): profile = speakers mutes teacher element; profile = headphones leaves it unmuted; banner text appears/disappears
- Regression: when profile = `headphones`, zero behaviour change versus Sprint 17 (default path untouched)

**Exit criteria:**
- Student on desktop Chrome un-checks "I'm wearing headphones" in self-check → teacher lobby row shows 🔊 Speakers chip; teacher admits; accompaniment drawer shows the mute banner; teacher hears no backing track locally but student does
- Teacher starts speaking with the student on speakers and no accompaniment playing → chatting mode engages within ~100 ms (VAD latency + a single WS round-trip); teacher and student converse with no audible echo loop back to the teacher
- Teacher stops speaking → chatting mode stays on for 3 s after VAD detects silence, then AEC flips off and music-mode fidelity returns; rapid back-and-forth in a coaching exchange does not cause audible DSP on/off thrash
- Accompaniment playing → chatting mode is suppressed regardless of whether the teacher is talking over the track (the teacher's bleed into the student's mic is tolerated as natural room mix for the duration of the take); when playback stops, the normal VAD-driven behaviour resumes
- Manual "force on" / "force off" override on the chat chip wins over VAD until cleared
- iOS Safari student joins → lobby chip automatically reads 📱 iOS (AEC locked); Chat toggle in session view renders as permanently-on with tooltip; audio works end-to-end (teacher muted on accompaniment, student hears it locally)
- Teacher flips the manual override on a lobby entry whose student claimed headphones; student client receives the new profile, adopts speakers behaviour live; teacher accompaniment mute state updates without re-negotiation
- All existing sessions where profile = `headphones` behave identically to Sprint 17 (zero regression in the default path — subjective listening test and `mount` regression tests pass)
- All existing + new Rust and JS tests pass
- No Opus SDP renegotiation fires on any profile or chatting-mode transition

**Status:** NOT STARTED

---

- Persistent "my students" list for the teacher — deliberately out of MVP; addressed partially by Sprint 11 history
- Multi-participant sessions — MVP is strictly 2 peers
- Low-latency "try to match duet" mode — explicitly not a goal; this tool is coaching-focused
- **Web MIDI recording:** promoted to Sprint 15.
- **WAV recording:** allow the teacher to record a live audio performance directly in the browser (Web Audio / MediaRecorder) as a WAV accompaniment, without needing a separate recording app. Input paths summary: PDF = upload only; MIDI = upload or record (Sprint 15); WAV = upload only until this is implemented.

---

## Sprint 18: Shared PostgreSQL platform

**Goal:** Promote `vvp-postgres` to a governed, multi-project shared service so that singing-bridge (and future RCNX projects) can use persistent PostgreSQL without each owning a separate server.

**Deliverables:**
- `rcnx-shared-rg` resource group created; `vvp-postgres` moved into it
- Public access enabled on the shared server; `AllowAzureServices` firewall rule active
- Storage auto-grow enabled
- `singing_bridge` database and `sbapp` least-privilege role created; `citext` extension installed
- `rcnx-shared-kv` Key Vault in `rcnx-shared-rg` holding admin + per-project connection strings with RBAC grants
- `SB_DATABASE_URL` secret pre-positioned in singing-bridge Container App (Sprint 19 ready to go)
- VVP services verified healthy after resource group move
- `infra/bicep/shared-postgres.bicep` and `infra/bicep/shared-keyvault.bicep` committed and idempotent

**Exit criteria:**
- `sbapp` can connect to `singing_bridge`; cannot connect to VVP databases
- VVP health endpoints green after the server move
- Sprint 19 can begin with no further infra work

**Status:** COMPLETE — 2026-04-24, commit `856a4b7`, council APPROVED (plan R5, code R2)

---

## Sprint 19: PostgreSQL application migration

**Goal:** Migrate the singing-bridge server from SQLite to PostgreSQL so that teacher accounts, sessions, recordings, and library assets persist across deploys.

**Deliverables:**
- `sqlx` feature flag changed from `sqlite` to `postgres`; `SqlitePool` → `PgPool` throughout
- All 6 migration files rewritten for Postgres syntax (BIGSERIAL, BYTEA, CITEXT, `$N` placeholders)
- `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`
- `config.rs` reads `SB_DATABASE_URL`; `db_url` derived from `SB_DATA_DIR` removed
- `server/tests/common/mod.rs` uses per-test Postgres DB (unique name, dropped on shutdown); `DATABASE_TEST_URL` env var
- `infra/bicep/container-app.bicep` updated: `SB_DATABASE_URL` wired; `SB_DATA_DIR` removed
- All 14 existing Rust integration tests pass on Postgres backend
- Production deploy: `SB_DATA_DIR=/tmp` workaround removed; sessions persist across redeploys

**Exit criteria:**
- `cargo test` green with `DATABASE_TEST_URL` set
- Teacher logs in before a deploy; is still logged in after
- No `SqlitePool` symbol remaining in `server/src/`

**Status:** COMPLETE — 2026-04-25, commit `3bbfd38` (code review APPROVED R2, 92% convergence)

---

## Sprint 20: Lesson support for students without headphones (and iOS)

**Goal:** A complete singing lesson — including backing-track playback and bidirectional voice — works end-to-end for students on speakers or iOS, with no audible echo at the teacher and no subjective fidelity regression for headphone students.

**Deliverables:**

_Acoustic profile model_
- Three-state profile: `Headphones` / `Speakers` / `IosForced`, stored on the lobby entry, propagated to the active session via the existing WS signalling path
- Auto-detection at student join: iOS UA → `IosForced`; desktop self-check checked → `Headphones`; desktop self-check unchecked → `Speakers`
- Manual override: teacher can change the profile in the lobby row (pre-admit) and in the in-session panel (post-admit); override propagates live to the student client within 200 ms
- Default path (`Headphones`) behaves bit-identically to Sprint 17 — no SDP renegotiation, no perceived change

_Conditional accompaniment muting_
- When profile ≠ `Headphones`, the teacher's local audio element for the backing track is muted; controls (play / pause / scrub / tempo / score-viewer) remain fully functional; an in-drawer banner explains why
- Teacher's local audio element still loads (no src removal) so scrub and bar-advancement continue

_VAD-driven chat mode_
- Energy + hysteresis VAD on the teacher's outbound mic; emits `ChattingMode { enabled }` WS message to student on state change
- On `ChattingMode { enabled: true }`: student calls `applyConstraints({ echoCancellation: true, noiseSuppression: true })`
- On `ChattingMode { enabled: false }`: student calls `applyConstraints({ echoCancellation: false, noiseSuppression: false })`
- 3 s hangover: chat mode stays on for ≥ 3 s after VAD detects silence
- Hard gate: chat-mode rising edges suppressed while `AccompanimentState.is_playing = true`
- Manual override: teacher can force chat mode on or off via a live chip; wins over VAD until cleared
- Live chip in session UI shows state: `Auto-listening` / `On` / `Suppressed`

_iOS first-class support_
- iOS UA → `IosForced` profile; student sees "Supported" with a small label ("📱 iOS — AEC locked") instead of the current "degraded" warning
- Chat-mode chip shows "Always on — iOS forces voice processing" and is non-interactive for iOS students
- `browser.js` BROWSER_FLOORS + tier logic updated to reflect iOS as supported

_Backwards compatibility_
- No DB migration; all profile state is in-memory per session
- No SDP renegotiation on any transition
- `HeadphonesConfirmed` existing protocol field continues to work as before

**Exit criteria:**
- Full 30-minute lesson on desktop Chrome with speakers: teacher reports no audible echo or doubled backing track
- Full 30-minute lesson on iPad Safari (`IosForced`): teacher reports same
- Headphones regression test: subjective audio quality under `Headphones` profile rated equal to Sprint 17
- Teacher-initiated profile override mid-lesson takes effect immediately (< 200 ms)
- Chat-mode state machine verified across four inputs: VAD on/off × accompaniment playing/not × manual auto/force-on/force-off
- iOS student sees "Supported" (not "degraded") in the browser compatibility flow
- Council code review APPROVED

**Status:** COMPLETE

## Sprint 22: Azure Blob Storage

**Goal:** Replace the ephemeral `DevBlobStore` with persistent Azure Blob Storage so uploaded PDFs, MIDIs, WAVs, page images, and recordings survive container restarts.

**Deliverables:**
- `AzureBlobStore` implementing the `BlobStore` trait using the `object_store` crate (azure feature)
- `get_url` returns a short-lived SAS URL (TTL = `media_token_ttl_secs`) for Azure; dev behaviour unchanged
- Config: `SB_AZURE_STORAGE_CONNECTION_STRING` + `SB_AZURE_STORAGE_CONTAINER` env vars; when absent, `DevBlobStore` is used (local dev unchanged)
- `main.rs` selects backend at startup: Azure when connection string is set, dev otherwise
- Azure Storage Account + container created in `sb-prod-rg`; connection string stored as `sb-blob-connection-string` KV secret; Container App env wired
- Existing `DevBlobStore` and `/api/dev-blob/:key` route retained for local dev
- Integration test: put → get_bytes → get_url round-trip against a real `DevBlobStore` (existing test extended); Azure path covered by a feature-gated test using `AZURE_STORAGE_CONNECTION_STRING` env var

**Exit criteria:**
- PDF upload persists across a forced container revision restart (verified via `az containerapp revision restart`)
- `/healthz` blob probe passes against Azure store
- Recordings stored before the restart are still playable after
- `DevBlobStore` tests continue to pass with no env vars set
- Council code review APPROVED

**Status:** COMPLETE — 2026-04-26, infra provisioned + AzureBlobStore implemented

## Sprint 23: Single-pass OMR

**Goal:** Run Audiveris exactly once per PDF by caching MusicXML in blob storage and computing bar coords + parts list in the same sidecar call.

**Deliverables:**
- Migration `0008_musicxml_blob_key.sql` — adds `musicxml_blob_key TEXT` to `accompaniments`
- Sidecar `/omr` response gains `parts` (list-parts folded in) and `bar_coords` (measure coords extracted before tempdir closes)
- `post_parts` stores MusicXML to blob and bar_coords to DB; returns `omr.parts` directly
- `post_midi` reads MusicXML from blob; falls back to re-running OMR if blob missing
- `post_rasterise` skips `/bar_coords` sidecar call when bar_coords already in DB; only calls `/rasterise`
- `SidecarClient.list_parts()` removed (folded into `/omr`)

**Exit criteria:**
- OMR log shows Audiveris invoked once; subsequent MIDI extraction and rasterise produce no further Audiveris invocations
- Council code review APPROVED

**Status:** COMPLETE — 2026-04-26

---

## Sprint 24: Synthesis modal + variant management

**Goal:** After OMR succeeds, the teacher can create named synthesis variants via a modal dialog — selecting voices, tempo, transpose, and a name — giving them multiple backing tracks per PDF for use in lessons.

**Deliverables:**
- "Create Backing Track" modal in `library.js` / `library.html`: opens automatically after OMR polling completes (and via a button on any asset with PDF or MIDI)
- Modal contains: voice checkboxes (for PDF-sourced assets), label input, tempo % (25–300), transpose semitones (−12–12), respect-repeats toggle, Create / Cancel buttons
- Frontend orchestrates the two-step call sequence: POST `/midi` (if starting from PDF, silently) → POST `/variants`; modal shows a spinner during synthesis
- On success: modal closes, new variant row prepended to the asset's variant list
- On error: modal stays open, error message shown inline; teacher can correct and retry
- Variant list per asset: label, tempo/transpose badge, Delete button; "Use in lesson" affordance (visual indication that variants are the backing tracks available in-session)
- Existing inline synthesis form removed (replaced by modal)

**Exit criteria:**
- Teacher uploads PDF, runs OMR, modal opens automatically with detected voices; fills params; variant appears in list
- Teacher can create a second variant with different tempo without re-running OMR
- Empty label or out-of-range tempo blocked client-side with inline error in modal
- Council code review APPROVED

**Status:** COMPLETE

---

## Sprint 25: Bot Peer for Manual UX Testing

**Goal:** A single developer can invoke one HTTP endpoint to spawn a scripted bot that joins a live session as teacher or student, plays a real accompaniment, and speaks TTS phrases — letting them validate the full session experience from either role without a second human.

**Deliverables:**
- `SB_TEST_PEER` env flag gates two new dev-only routes: `GET /test-peer` and `GET /test-peer/session`
- One-time token store (30 s TTL, consumed on use) for teacher-bot auth bypass
- Per-slug concurrency guard (409 if bot already running for that slug)
- `scripts/test_peer.py`: Playwright headless Chromium bot; generates TTS WAVs with `gtts`; injects audio via `--use-file-for-fake-audio-capture`; teacher bot auto-admits human student and sends `AccompanimentPlay`; student bot joins and speaks scripted phrases; 3-minute hard timeout
- `window._sbSend` exposed on localhost in `teacher.js` for bot to send WS messages via `page.evaluate()`
- `data-testid="admit-btn"` and `data-testid="session-active"` added to lobby and session UI

**Exit criteria:**
- `GET /test-peer?slug=X&mode=student` → bot joins, human teacher admits, hears TTS within 10 s
- `GET /test-peer?slug=X&mode=teacher` → bot admits human student, plays accompaniment + TTS
- Bot exits cleanly after 3 min; no zombie Playwright processes
- Route absent (404) when `SB_TEST_PEER` unset
- 409 on duplicate bot for same slug
- All existing tests pass

**Status:** IN PROGRESS

---

## Sprint 26: Accompaniment Drawer Lobby Mode

**Goal:** The teacher can browse, select, and preview their accompaniment tracks while waiting in the lobby — before any student has connected.

**Deliverables:**
- `sbAccompanimentDrawer` mounts once at page load (not inside `onPeerConnected`) with a stub `sendWs`
- New handle methods: `setSendWs(fn)`, `setGetOneWayLatencyMs(fn)`, `enterLobbyMode()`, `exitLobbyMode()`
- Lobby preview mode: clicking Play/Preview plays audio locally (no WS) via `_lobbyAudio`; `_trackMap` stores tokens from `setTrackList` for URL construction
- `session-panels.js` `buildAccmpPanel` panel handle gains `setLobbyMode(bool)` for label and CSS class update
- `session-ui.js` accepts `opts.accmpPanel`; if provided, re-parents the node instead of calling `buildAccmpPanel()` internally
- `teacher.js` moves drawer mount and track fetch to `init()`; wires/unwires live functions in `onPeerConnected`/`onPeerDisconnected`; DOM re-parenting of panel node across lobby ↔ session
- `theme.css` `.sb-accmp-panel--lobby` modifier for visual distinction

**Exit criteria:**
- Teacher opens session page with no student waiting: accompaniment panel visible, track list populated, "Preview" button present
- Teacher selects a track and variant, clicks Preview: audio plays locally in the browser
- Student connects: panel transitions to live mode; previously selected track is pre-loaded; Play sends WS message; audio syncs with server state
- Student disconnects: panel reverts to lobby/preview mode; track selection is preserved
- No visible UI glitch when panel re-parents between lobby and session layout
- All existing Rust and JS tests pass

**Status:** COMPLETE
