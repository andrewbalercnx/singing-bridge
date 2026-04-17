# singing-bridge — Sprint Roadmap

## Sprint 1: Peer-to-Peer Signalling Foundation
**Goal:** Establish a working WebRTC signalling layer so two peers can negotiate and open a data channel.

**Deliverables:**
- Rust signalling server (WebSocket-based) that brokers SDP offer/answer and ICE candidates
- Minimal browser-side JS client (or native Rust via `webrtc-rs`) that connects to signalling server
- Two peers can open a reliable data channel and exchange text messages end-to-end

**Exit criteria:**
- Two browser tabs on different machines complete ICE negotiation and exchange a "hello" message via data channel
- Signalling server handles peer disconnect and cleans up session state

**Status:** PENDING

---

## Sprint 2: Low-Latency Audio Pipeline
**Goal:** Transmit microphone audio between peers with latency ≤ 40 ms and full 48 kHz / Opus quality.

**Deliverables:**
- Audio capture via `cpal` (or browser `getUserMedia`) feeding an Opus encoder
- RTP/SRTP packetisation and transport over the established WebRTC peer connection
- Receiver-side jitter buffer tuned for minimum latency (target: 20 ms buffer, 40 ms worst-case)
- Loopback test harness that measures round-trip latency and reports it

**Exit criteria:**
- Singer and teacher can hear each other in real time; measured RTT audio latency ≤ 40 ms on LAN
- Opus bitrate configurable (64/96/128 kbps); 48 kHz sample rate confirmed in packet headers

**Status:** PENDING

---

## Sprint 3: Video Track and Basic UI
**Goal:** Add a video track to the session and provide a minimal but usable dual-pane interface.

**Deliverables:**
- Camera capture (V4L2 / AVFoundation / DirectShow via `nokhwa` or native) encoded with VP8/VP9 or H.264
- Video track multiplexed alongside audio in the same peer connection
- Simple web UI: two video tiles (local + remote), mute/unmute button, end-call button
- Role selection screen ("Singer" / "Teacher") that sets displayed name

**Exit criteria:**
- Both participants see each other's video and hear each other's audio in the same session
- Mute/unmute works without restarting the connection; end-call cleans up all media tracks

**Status:** PENDING

---

## Sprint 4: Audio Quality and Reliability Hardening
**Goal:** Harden the audio path for real singing use: handle packet loss, echo cancellation, and network variability.

**Deliverables:**
- Acoustic echo cancellation (AEC) integrated on the capture path (WebRTC AEC3 via `webrtc-audio-processing` crate or browser built-in)
- Forward error correction (FEC) enabled in Opus; NACK/RED for video
- Adaptive jitter buffer that tightens under good network conditions and relaxes under loss
- Connection quality indicator in UI (packet loss %, estimated latency)
- Automated network impairment test (tc netem) confirming graceful degradation at 2% loss / 20 ms added jitter

**Exit criteria:**
- Subjective audio quality rated "good" by both users at 2% simulated packet loss
- No echo artefacts audible during loopback test with speakers + microphone on same machine

**Status:** PENDING

---

## Sprint 5: Session Management and MVP Polish
**Goal:** Make the application self-contained and shareable so a singer can send a link to their teacher and start a session without technical setup.

**Deliverables:**
- Room-code–based join flow: creator gets a 6-character room code; joiner enters it
- TURN server integration (coturn or a hosted relay) so sessions work across NAT/firewalls
- HTTPS + WSS in production (Let's Encrypt via `rustls` / `acme2` or reverse proxy config)
- Basic session log: start time, duration, peak packet loss (stored server-side, no PII)
- One-page deployment guide (Docker Compose: signalling server + TURN + static assets)

**Exit criteria:**
- Singer on home broadband and teacher on a separate network complete a 10-minute audio/video session without manual network configuration
- Room code expires after 24 hours; second joiner after capacity (2 peers) is rejected gracefully

**Status:** PENDING
```