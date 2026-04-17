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

**Status:** PENDING

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

**Status:** PENDING

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

**Status:** PENDING

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

**Status:** PENDING

---

## Sprint 6 (post-MVP): Session recording

**Goal:** Teacher can record a lesson and share it with the student afterwards.

**Deliverables (provisional):**
- Recording mechanism (client-side `MediaRecorder` on teacher side as a starting point; server-side SFU-assisted recording if quality requires)
- Storage in Azure Blob with time-limited signed share URLs
- Explicit per-session consent from both parties before recording starts; recording blocked if either declines

**Exit criteria:**
- Teacher-initiated recording persists a playable file
- Student receives a time-limited link within 1 hour of session end
- Consent flow is unambiguous and enforced

**Status:** DEFERRED

---

## Open items (noted, not blocking MVP)

- Persistent "my students" list for the teacher — deliberately out of MVP
- Teacher accompaniment / backing-track sharing — future sprint
- Multi-participant sessions — MVP is strictly 2 peers
- Low-latency "try to match duet" mode — explicitly not a goal; this tool is coaching-focused
