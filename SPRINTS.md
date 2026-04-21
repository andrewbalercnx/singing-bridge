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

## Sprint 12: Accompaniment library

**Goal:** Teacher builds a persistent library of backing tracks (with optional sheet music), selects one during a lesson, and both parties hear the audio and see a synchronised bar-by-bar score walkthrough.

**Deliverables:**

_Library model_
- Each accompaniment asset holds: an optional PDF (sheet music), an optional MIDI, and zero or more WAV variants
- A WAV variant is generated from a MIDI with three parameters: tempo (% of original BPM), pitch transpose (semitones), respect repeats (bool/no)
- Multiple WAV variants per asset; teacher can name and manage them

_Authoring flow (offline, `/teach/<slug>/library`)_
- Upload a PDF → optional OMR (Audiveris via Python sidecar) to extract a MIDI of the accompaniment lines; teacher selects which parts to include
- Upload a MIDI directly
- Upload an audio file directly (stored as a WAV variant)
- Synthesise a WAV from a MIDI: teacher sets tempo, transpose, repeats; rendered via FluidSynth (Python sidecar); stored in Azure Blob Storage
- Rich library management UI: list assets, see variants per asset, delete variants, re-synthesise

_Pipeline architecture_
- Python sidecar (promoted from `spike/pdf_to_piano_audio/pipeline/`): internal HTTP service, never internet-facing; Rust server proxies all pipeline calls
- Sidecar provides: OMR, part listing, MIDI extraction, WAV synthesis, bar timing computation, PDF rasterisation
- Bar timings stored once per MIDI at tempo=100%; scaled by the variant's tempo factor at playback
- Bar coords (PDF bounding boxes) stored once per PDF in the DB

_In-lesson playback (minimal drawer in session UI)_
- Teacher picks an accompaniment and a WAV variant from a compact in-session drawer
- Audio plays independently at each client (served from Azure Blob, not over WebRTC)
- Server broadcasts playback state (is_playing, position_ms) over the existing WebSocket connection; both ends stay in sync
- Teacher controls: play, pause, stop, scrub to position — all mirrored to student in real time
- Student view is read-only (no controls)
- Score view (if available):
  - PDF + WAV → bar-by-bar walkthrough on the rasterised PDF pages, driven by playback position
  - MIDI + WAV (no PDF) → Music21-rendered sheet music with same walkthrough
  - WAV only → audio only, no score view
- Teacher can clear the active accompaniment; score panel hidden when none loaded

_New DB migrations_
- `accompaniments` (id, teacher_id, title, pdf_blob_key, midi_blob_key, bar_coords_json, bar_timings_json, created_at)
- `accompaniment_variants` (id, accompaniment_id, label, wav_blob_key, tempo_pct, transpose_semitones, respect_repeats, duration_s, created_at)

**Exit criteria:**
- Teacher uploads a two-page PDF; OMR runs; teacher selects parts; MIDI is saved to the asset
- Teacher synthesises two WAV variants at different tempos; both appear in the library under the same asset
- Teacher starts a session, opens the accompaniment drawer, picks an asset + variant; both parties hear the audio begin at the same moment
- Teacher pauses; student's audio pauses. Teacher scrubs to bar 4 and resumes; student resumes from bar 4
- Score walkthrough highlights the correct bar on both sides throughout playback
- Audiveris/FluidSynth unavailable → 503 with clear message; no crash; existing session flows unaffected
- All existing A/V, chat, and recording flows unaffected; new tests cover upload, OMR, synthesis, playback-state relay, and bar-sync

**Status:** PENDING

---

## Open items (noted, not blocking MVP)

- Persistent "my students" list for the teacher — deliberately out of MVP; addressed partially by Sprint 11 history
- Multi-participant sessions — MVP is strictly 2 peers
- Low-latency "try to match duet" mode — explicitly not a goal; this tool is coaching-focused
- Piano accompaniment audio playback (spike explored in `spike/pdf_to_piano_audio/`) — future sprint after Sprint 12
