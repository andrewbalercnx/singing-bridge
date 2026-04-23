# ADR-0001: MVP architecture for singing.rcnx.io

**Status:** accepted
**Date:** 2026-04-17
**Deciders:** Andrew Bale

## Context

singing-bridge is a remote singing-lesson tool: a teacher coaches a
student over an A/V link. The product is NOT a real-time duet tool —
there is no expectation that teacher and student will sing
simultaneously in time with each other. The teacher occasionally
demonstrates, so the link is bidirectional and both directions need
fidelity.

Three constraints dominate the design:

1. **Student install must be trivial**: "go to a webpage, enter an
   email." No downloads, no device pickers, no quality settings, no
   account creation.
2. **Audio fidelity over latency**: singing carries information in
   harmonics, breath, sibilants, dynamic range, and vibrato. WebRTC's
   default speech-tuned DSP (AEC3, noise suppression, AGC) mangles
   all of these. Latency matters but only in the loose sense of "as
   low as we can reasonably get it" — we explicitly reject a hard
   latency SLA like 40 ms that would force us to compromise fidelity.
3. **Teacher must be able to triage who joins**: lessons are
   scheduled, the teacher needs to know who's arriving, and admit
   them deliberately.

Secondary constraints: deployment on Azure under a subdomain of the
`rcnx.io` apex, Cloudflare at the edge (matching the pattern used on
prior rcnx.io projects, including magic-link email delivery).

## Decision

### Client platform

**Browser-only on both sides.** No native Rust client. The install-
simplicity constraint eliminates native apps entirely; even the teacher
gets a browser client for parity. Rust lives exclusively on the server.

### Identity and addressing

- **Teacher**: email + password authentication (Argon2id, Sprint 10).
  Magic-link flow retained as a password-reset escape hatch behind
  `config.password_reset_enabled` (default `false`). Persistent account,
  stable room URL at `/teach/<slug>`. Slug is teacher-chosen at signup,
  validated against a reserved-word list, with an auto-generated
  fallback suggested on conflict. One room per teacher.
- **Student**: stateless. No account, no student record, no persistent
  state between visits. Email is a per-session lobby label only. This
  deliberately sidesteps GDPR/retention for MVP.

### Lobby model

Students arrive at `/teach/<slug>`, enter their email, and appear in a
live lobby visible to the teacher. The teacher sees each waiting entry
with: email, browser name and version, device class (desktop / tablet /
phone), and a compatibility flag if the browser is degraded or
unsupported.

**Manual admission only.** Teacher explicitly admits one student at a
time. No auto-promote on session end. The teacher may be mid-session
with student A while students B and C are waiting — the lobby updates
live in parallel with the active media session. Waiting students see
a simple "waiting to be admitted" message with no queue position (less
social pressure; no fairness semantics to define).

### Media pipeline

- **Codec**: Opus in music mode, `stereo=1; maxaveragebitrate=128000;
  useinbandfec=1; cbr=0`
- **Capture**: `getUserMedia` with `echoCancellation: false`,
  `noiseSuppression: false`, `autoGainControl: false`, `sampleRate:
  48000`, `channelCount: 2`
- **Playout**: `playoutDelayHint: 0` on remote tracks
- **Echo**: browser AEC is off. Echo is avoided by a single
  instruction on the join page ("Please wear headphones") rather than
  a UI option. This is not considered a "setting" — it is a setup
  note, like plugging in power.
- **Transport**: WebRTC P2P, with TURN (coturn) as fallback when
  direct connection fails.

### Bandwidth degradation order

When bandwidth is constrained, drop in this order (highest dropped
first, lowest last):

1. Student→teacher video resolution / bitrate
2. Teacher→student video resolution / bitrate
3. Teacher→student audio bitrate (floor: 48 kbps)
4. Student→teacher audio bitrate (floor: 96 kbps — never drop below)

Rationale: the teacher's diagnostic signal is the student's voice.
Everything else can degrade. If the student→teacher audio cannot hold
96 kbps, the session surfaces a "your connection can't support this
lesson" message rather than silently degrading below the fidelity
floor.

### Browser compatibility

Three tiers, evaluated at the landing page:

- **Supported** — Chrome / Edge (last 2 major versions), Firefox (last
  2), Safari desktop ≥ 16. Proceed silently.
- **Degraded** — iOS Safari (forced voice DSP and sample-rate
  resampling we cannot disable), Android Firefox (WebRTC quirks).
  Proceed with a clear warning explaining the specific limitation.
  Flag visible to the teacher in the lobby.
- **Unworkable** — in-app browsers (Facebook / Instagram / TikTok
  WebViews, which strip or break WebRTC), pre-WebRTC browsers. Block
  with actionable guidance to reopen the link in a proper browser.

### Infrastructure

- **Compute**: Rust signalling + static-asset server on Azure
  Container Apps.
- **Persistence**: SQLite on Azure Files NFS v4.1 (Sprint 16). NFS
  is mounted over the Azure backbone (region-internal); traffic is
  not TLS-encrypted at the NFS layer. **Accepted risk:** the DB
  contains Argon2id hashes and HMAC session tokens, not plaintext
  credentials. Azure network isolation and short session TTLs
  (30 days) are the mitigations. Revisit before multi-region expansion
  or if regulatory requirements change.
- **TURN**: coturn on an Azure VM with a static public IP. TURN (UDP)
  cannot be proxied through Cloudflare and must be directly routable.
- **Edge**: Cloudflare for DNS, TLS termination, static-asset CDN, and
  magic-link email delivery (reusing the pattern from prior rcnx.io
  projects).
- **Domain**: `singing.rcnx.io`.

## Consequences

### Easier

- The browser handles WebRTC, TLS for signalling, codec, and media
  capture. We don't maintain any of that code.
- Student onboarding has genuinely zero friction — this is a material
  product advantage over Zoom / Google Meet for casual users.
- Stateless students minimise attack surface, storage, and compliance
  load.
- The teacher-room-URL-plus-lobby model maps cleanly onto the actual
  workflow of a music teacher running back-to-back lessons.

### Harder / accepted trade-offs

- **iOS audio is capped by the OS.** Students on iPhones will sound
  worse than students on a laptop. We make this visible to the
  teacher rather than trying to hide it.
- **Echo risk when the student does not wear headphones.** With AEC
  off, laptop-speaker output will bounce back into the mic and the
  teacher hears their own voice delayed. Mitigation is a clear setup
  note, not a software safeguard. If this becomes a real operational
  problem, we revisit — options are (a) opt-in AEC for students who
  refuse headphones, or (b) output-route detection where browsers
  expose it.
- **Bidirectional high fidelity doubles upstream load.** Not usually
  an issue on home broadband, but a student on a weak mobile hotspot
  will hit the degradation order quickly. We accept this; the floor
  message explains failure honestly.
- **TURN bypasses Cloudflare.** The TURN VM has a direct public IP,
  which is a small additional attack surface compared to an
  all-Cloudflare-fronted setup. coturn's own auth (time-limited
  credentials issued by the signalling server) is the mitigation.
- **No native client means no sub-frame audio control.** If we ever
  wanted true low-latency duet mode, we would have to revisit the
  browser-only decision. This is an accepted cost of the
  install-simplicity constraint.

### What we will monitor

- Proportion of sessions hitting the 96 kbps student→teacher audio
  floor (session log). Persistent floor violations would indicate the
  fidelity-first model is failing in the real world.
- Proportion of students on iOS Safari vs desktop. If iOS dominates,
  the degraded-tier UX needs more investment.
- Lobby-abuse incidents (random entries on a leaked URL). If this
  becomes real, we add per-teacher invite codes or domain-locked
  magic links.

## Alternatives considered

- **Native Rust client (webrtc-rs) on one or both sides** — Rejected.
  Installing anything violates the core student-onboarding constraint.
  Worth revisiting only if we ever add a real-time duet mode.
- **WebRTC defaults (speech-tuned DSP on)** — Rejected. Default AEC /
  NS / AGC audibly destroy singing. Turning them off with a headphones
  instruction is the only path that preserves fidelity without
  exposing a device picker.
- **Hard 40 ms latency SLA** — Rejected. Originally in the sprint
  plan, removed as a derived (not stated) requirement. Chasing it
  forces trade-offs against fidelity and against using WebRTC at all
  on the public internet. "Low as reasonably achievable within the
  browser-only, WiFi-tolerant constraint" is the honest target.
- **Symmetric room-code pairing (6-character codes, as in the
  original SPRINTS.md)** — Rejected. Does not support the real
  workflow of a teacher running scheduled lessons with multiple
  students arriving at different times. Replaced by persistent
  teacher room + lobby.
- **Auto-admit-next on session end** — Rejected in favour of manual
  admission. Teachers need buffer time between lessons (notes,
  bathroom breaks, overruns); auto-admit removes a necessary control.
- **Single-VM Docker Compose deployment (as in the original
  SPRINTS.md)** — Rejected in favour of Azure Container Apps +
  Cloudflare, matching existing rcnx.io patterns.
- **Auto-generated opaque room slugs** (`/teach/k7m2q9`) — Rejected in
  favour of teacher-chosen slugs. Memorability matters for teachers
  sharing the URL verbally with students; leak risk is mitigated by
  the fact that entry requires the teacher to manually admit.
- **Server-side SFU from day one** — Rejected. Two-peer sessions are
  strictly P2P; an SFU adds a forwarding hop (latency + infra cost)
  with no benefit at this scale. Revisit only if / when multi-party
  sessions or server-side recording (Sprint 6) require it.
