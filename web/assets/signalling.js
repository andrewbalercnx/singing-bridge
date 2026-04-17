// File: web/assets/signalling.js
// Purpose: Browser-side WebSocket + RTCPeerConnection glue. Two entry points —
//          connectTeacher and connectStudent — sharing the framing logic.
// Role: Only place that speaks the wire protocol on the client side.
// Exports: window.signallingClient.{connectTeacher, connectStudent}
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

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

async function connectTeacher({ slug, onLobbyUpdate, onPeerConnected, onPeerDisconnected }) {
  const sig = new Signalling(openWs());
  sig.send({ type: 'lobby_watch', slug });
  sig.on('lobby_state', (m) => onLobbyUpdate && onLobbyUpdate(m.entries));

  let pc = null;
  let dataChannel = null;

  sig.on('peer_connected', async () => {
    pc = makePeerConnection();
    pc.onicecandidate = (ev) => {
      if (ev.candidate) sig.send({ type: 'signal', to: 'student', payload: { candidate: ev.candidate } });
    };
    pc.ondatachannel = (ev) => {
      dataChannel = ev.channel;
      dataChannel.onopen = () => onPeerConnected && onPeerConnected({ dataChannel });
    };
  });
  sig.on('signal', async (m) => {
    if (!pc) return;
    const p = m.payload;
    if (p.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      if (p.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sig.send({ type: 'signal', to: 'student', payload: { sdp: pc.localDescription } });
      }
    } else if (p.candidate) {
      try { await pc.addIceCandidate(p.candidate); } catch (_) {}
    }
  });
  sig.on('peer_disconnected', () => {
    if (pc) { pc.close(); pc = null; }
    onPeerDisconnected && onPeerDisconnected();
  });

  return {
    admit(entryId) { sig.send({ type: 'lobby_admit', slug, entry_id: entryId }); },
    reject(entryId) { sig.send({ type: 'lobby_reject', slug, entry_id: entryId }); },
    hangup() { if (pc) pc.close(); sig.close(); },
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

  let pc = null;
  let dataChannel = null;

  sig.on('admitted', () => onAdmitted && onAdmitted());
  sig.on('rejected', (m) => { onRejected && onRejected(m.reason); sig.close(); });
  sig.on('peer_connected', async () => {
    pc = makePeerConnection();
    pc.onicecandidate = (ev) => {
      if (ev.candidate) sig.send({ type: 'signal', to: 'teacher', payload: { candidate: ev.candidate } });
    };
    dataChannel = pc.createDataChannel('hello');
    dataChannel.onopen = () => onPeerConnected && onPeerConnected({ dataChannel });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send({ type: 'signal', to: 'teacher', payload: { sdp: pc.localDescription } });
  });
  sig.on('signal', async (m) => {
    if (!pc) return;
    const p = m.payload;
    if (p.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
    } else if (p.candidate) {
      try { await pc.addIceCandidate(p.candidate); } catch (_) {}
    }
  });
  sig.on('peer_disconnected', () => {
    if (pc) { pc.close(); pc = null; }
    onPeerDisconnected && onPeerDisconnected();
  });

  return {
    hangup() { if (pc) pc.close(); sig.close(); },
  };
}

window.signallingClient = { connectTeacher, connectStudent };
