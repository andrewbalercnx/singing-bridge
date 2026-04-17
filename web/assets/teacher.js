// File: web/assets/teacher.js
// Purpose: Teacher UI wiring. Student-supplied strings rendered via
//          textContent only (R4 recommendation — no innerHTML to
//          prevent XSS). Sprint 4: threads onQuality /
//          onFloorViolation / onReconnectBanner callbacks through
//          to the signalling client; renders the quality badge and
//          mirrors the student-side floor-violation notice.
// Last updated: Sprint 4 (2026-04-17) -- +quality +floor +reconnect wiring

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  document.getElementById('room-heading').textContent = `Your room: ${slug}`;

  const listEl = document.getElementById('lobby-list');
  const emptyEl = document.getElementById('lobby-empty');
  const statusEl = document.getElementById('session-status');
  const localVideo = document.getElementById('local-video');
  const qualityBadge = document.getElementById('quality-badge');
  const reconnectBanner = document.getElementById('reconnect-banner');
  const floorNotice = document.getElementById('floor-violation');

  // Proxy so list-item click handlers can reach the handle before
  // connectTeacher resolves.
  const handleProxy = {
    admit(id) { if (window._handle) window._handle.admit(id); },
    reject(id) { if (window._handle) window._handle.reject(id); },
  };

  function renderEntry(entry) {
    const li = document.createElement('li');
    const meta = document.createElement('span');
    meta.textContent = `${entry.email} · ${entry.browser} · ${entry.device_class}`;
    const badge = document.createElement('span');
    badge.className = `tier-badge ${entry.tier || 'degraded'}`;
    badge.textContent = entry.tier || 'degraded';
    li.append(meta, document.createTextNode(' '), badge);
    if (entry.tier_reason) {
      const r = document.createElement('span');
      r.className = 'tier-reason';
      r.textContent = ` (${entry.tier_reason})`;
      li.append(r);
    }
    const admit = document.createElement('button');
    admit.type = 'button';
    admit.textContent = 'Admit';
    admit.addEventListener('click', () => handleProxy.admit(entry.id));
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => handleProxy.reject(entry.id));
    li.append(document.createTextNode(' '), admit, reject);
    return li;
  }

  let controlsHandle = null;

  window.signallingClient.connectTeacher({
    slug,
    onLobbyUpdate(entries) {
      listEl.replaceChildren();
      emptyEl.hidden = entries.length > 0;
      for (const entry of entries) listEl.append(renderEntry(entry));
    },
    onPeerConnected({ dataChannel, audioTrack, videoTrack }) {
      statusEl.textContent = 'Connected.';
      if (qualityBadge) qualityBadge.hidden = false;
      if (videoTrack) {
        localVideo.srcObject = new MediaStream([videoTrack]);
      }
      controlsHandle = window.sbControls.wireControls({
        audioTrack,
        videoTrack,
        onHangup() { if (window._handle) window._handle.hangup(); },
      });
      dataChannel.addEventListener('message', (e) => {
        statusEl.textContent = `Student says: ${e.data}`;
      });
      dataChannel.send(JSON.stringify({ hello: true, from: 'teacher' }));
    },
    onPeerDisconnected() {
      statusEl.textContent = 'Student disconnected.';
      if (controlsHandle) { controlsHandle.teardown(); controlsHandle = null; }
      if (qualityBadge) qualityBadge.hidden = true;
      if (reconnectBanner) reconnectBanner.hidden = true;
      if (floorNotice) floorNotice.hidden = true;
      localVideo.srcObject = null;
    },
    onQuality(summary) {
      if (qualityBadge && summary) {
        window.sbQuality.renderQualityBadge(qualityBadge, summary);
      }
    },
    onFloorViolation() {
      // Teacher side: show the mirror notice so the teacher understands
      // why the session ended. The session itself ends via onGiveUp
      // once the student hangs up.
      if (floorNotice) floorNotice.hidden = false;
    },
    onReconnectBanner(visible) {
      if (reconnectBanner) reconnectBanner.hidden = !visible;
    },
  }).then((h) => {
    window._handle = h;
  });
})();
