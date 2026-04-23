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

**Status:** PENDING

---

## Open items (noted, not blocking MVP)

- Persistent "my students" list for the teacher — deliberately out of MVP; addressed partially by Sprint 11 history
- Multi-participant sessions — MVP is strictly 2 peers
- Low-latency "try to match duet" mode — explicitly not a goal; this tool is coaching-focused
- **Accompaniment latency compensation:** music played at the teacher's end should be delayed by the one-way audio latency from the student's microphone to the teacher's earpiece. Without this, the student hears the backing track in sync but the teacher hears it slightly ahead of the student's voice — making it harder for the teacher to evaluate timing. The latency estimate is already available from the debug overlay (Sprint 2); it needs to be wired into the accompaniment playback start offset.
- **Web MIDI recording:** promoted to Sprint 15.
- **WAV recording:** allow the teacher to record a live audio performance directly in the browser (Web Audio / MediaRecorder) as a WAV accompaniment, without needing a separate recording app. Input paths summary: PDF = upload only; MIDI = upload or record (Sprint 15); WAV = upload only until this is implemented.
