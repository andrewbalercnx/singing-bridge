// File: web/assets/signalling.js
// Purpose: Browser-side WebSocket + RTCPeerConnection glue. Two entry
//          points — connectTeacher and connectStudent — sharing the
//          framing logic. Sprint 2: wires local+remote audio tracks,
//          munges Opus SDP, and attaches the dev-only debug overlay.
// Role: Only place that speaks the signalling wire protocol on the
//       client side.
// Exports: window.signallingClient.{connectTeacher, connectStudent}
// Depends: window.sbSdp (from sdp.js), window.sbAudio (from audio.js),
//          window.sbDebug (from debug-overlay.js)
// Invariants: every setLocalDescription is preceded by
//             mungeSdpForOpusMusic; every teardown path stops the
//             debug overlay and releases the local audio track.
// Last updated: Sprint 2 (2026-04-17) -- Sprint 2 audio + overlay

'use strict';

const WS_PATH = '/ws';

function openWs() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}${WS_PATH}`;
  return new WebSocket(url);
}

function browserLabel() {
  const ua = navigator.userAgent;
  const m = ua.match(/(Firefox|Chrome|Safari|Edg)\/(\d+)/);
  return m ? `${m[1]}/${m[2]}` : 'unknown';
}
function deviceClass() {
  if (/iPad|Android/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent)) return 'tablet';
  if (/iPhone|Android.*Mobile/.test(navigator.userAgent)) return 'phone';
  return 'desktop';
}

class Signalling {
  constructor(sock) {
    this.sock = sock;
    this.handlers = new Map();
    this.queue = [];
    sock.addEventListener('open', () => {
      for (const msg of this.queue) sock.send(JSON.stringify(msg));
      this.queue = [];
    });
    sock.addEventListener('message', (e) => this._onMessage(e));
  }
  _onMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    const list = this.handlers.get(msg.type) || [];
    for (const h of list) h(msg);
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  send(msg) {
    if (this.sock.readyState === 1) this.sock.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }
  close() { try { this.sock.close(); } catch (_) {} }
}

function makePeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
}

// Applies the SDP munge before setLocalDescription. Pulled out so
// both paths are visibly identical and the invariant is easy to
// audit.
async function setMungedLocalDescription(pc, desc) {
  desc.sdp = window.sbSdp.mungeSdpForOpusMusic(desc.sdp);
  await pc.setLocalDescription(desc);
}

// Returns a teardown function that releases overlay, audio, peer
// connection, and data channel from the shared refs object. Used by
// both connectTeacher and connectStudent to avoid duplicating the
// four-step shutdown sequence.
function makeTeardown(refs) {
  return function () {
    if (refs.overlay) { try { refs.overlay.stop(); } catch (_) {} refs.overlay = null; }
    if (refs.audio) { try { refs.audio.teardown(); } catch (_) {} refs.audio = null; }
    if (refs.pc) { try { refs.pc.close(); } catch (_) {} refs.pc = null; }
    refs.dataChannel = null;
  };
}

// Adds a local audio track, wires ontrack for remote audio, and
// returns a handle with a teardown() that stops the track and
// detaches the remote element.
async function wireBidirectionalAudio(pc) {
  const local = await window.sbAudio.startLocalAudio();
  pc.addTrack(local.track, local.stream);
  pc.ontrack = (ev) => window.sbAudio.attachRemoteAudio(ev);
  return {
    local,
    teardown() {
      window.sbAudio.detachRemoteAudio();
      try { local.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    },
  };
}

async function connectTeacher({ slug, onLobbyUpdate, onPeerConnected, onPeerDisconnected }) {
  const sig = new Signalling(openWs());
  sig.send({ type: 'lobby_watch', slug });
  sig.on('lobby_state', (m) => onLobbyUpdate && onLobbyUpdate(m.entries));

  const refs = { pc: null, audio: null, overlay: null, dataChannel: null };
  const teardownSession = makeTeardown(refs);

  sig.on('peer_connected', async () => {
    refs.pc = makePeerConnection();
    refs.audio = await wireBidirectionalAudio(refs.pc);
    refs.overlay = window.sbDebug.startDebugOverlay(refs.pc, { localTrack: refs.audio.local.track });
    refs.pc.onicecandidate = (ev) => {
      if (ev.candidate) sig.send({ type: 'signal', to: 'student', payload: { candidate: ev.candidate } });
    };
    refs.pc.ondatachannel = (ev) => {
      refs.dataChannel = ev.channel;
      refs.dataChannel.onopen = () => onPeerConnected && onPeerConnected({ dataChannel: refs.dataChannel });
    };
  });
  sig.on('signal', async (m) => {
    if (!refs.pc) return;
    const p = m.payload;
    if (p.sdp) {
      await refs.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      if (p.sdp.type === 'offer') {
        const answer = await refs.pc.createAnswer();
        await setMungedLocalDescription(refs.pc, answer);
        sig.send({ type: 'signal', to: 'student', payload: { sdp: refs.pc.localDescription } });
      }
    } else if (p.candidate) {
      try { await refs.pc.addIceCandidate(p.candidate); } catch (_) {}
    }
  });
  sig.on('peer_disconnected', () => {
    teardownSession();
    onPeerDisconnected && onPeerDisconnected();
  });

  return {
    admit(entryId) { sig.send({ type: 'lobby_admit', slug, entry_id: entryId }); },
    reject(entryId) { sig.send({ type: 'lobby_reject', slug, entry_id: entryId }); },
    hangup() { teardownSession(); sig.close(); },
  };
}

async function connectStudent({ slug, email, onAdmitted, onRejected, onPeerDisconnected, onPeerConnected }) {
  const sig = new Signalling(openWs());
  sig.send({
    type: 'lobby_join',
    slug,
    email,
    browser: browserLabel(),
    device_class: deviceClass(),
  });

  const refs = { pc: null, audio: null, overlay: null, dataChannel: null };
  const teardownSession = makeTeardown(refs);

  sig.on('admitted', () => onAdmitted && onAdmitted());
  sig.on('rejected', (m) => { onRejected && onRejected(m.reason); sig.close(); });
  sig.on('peer_connected', async () => {
    refs.pc = makePeerConnection();
    refs.audio = await wireBidirectionalAudio(refs.pc);
    refs.overlay = window.sbDebug.startDebugOverlay(refs.pc, { localTrack: refs.audio.local.track });
    refs.pc.onicecandidate = (ev) => {
      if (ev.candidate) sig.send({ type: 'signal', to: 'teacher', payload: { candidate: ev.candidate } });
    };
    refs.dataChannel = refs.pc.createDataChannel('hello');
    refs.dataChannel.onopen = () => onPeerConnected && onPeerConnected({ dataChannel: refs.dataChannel });
    const offer = await refs.pc.createOffer();
    await setMungedLocalDescription(refs.pc, offer);
    sig.send({ type: 'signal', to: 'teacher', payload: { sdp: refs.pc.localDescription } });
  });
  sig.on('signal', async (m) => {
    if (!refs.pc) return;
    const p = m.payload;
    if (p.sdp) {
      await refs.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
    } else if (p.candidate) {
      try { await refs.pc.addIceCandidate(p.candidate); } catch (_) {}
    }
  });
  sig.on('peer_disconnected', () => {
    teardownSession();
    onPeerDisconnected && onPeerDisconnected();
  });

  return {
    hangup() { teardownSession(); sig.close(); },
  };
}

window.signallingClient = { connectTeacher, connectStudent };
