// File: web/assets/student.js
// Purpose: Student join form + lobby/session UI driver. Sprint 4:
//          threads onQuality / onFloorViolation / onReconnectBanner
//          callbacks through to the signalling client; renders the
//          quality badge and floor-violation notice.
// Last updated: Sprint 4 (2026-04-17) -- +quality +floor +reconnect wiring

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  const joinSection = document.getElementById('join');
  const form = document.getElementById('join-form');
  const lobbyStatus = document.getElementById('lobby-status');
  const sessionSection = document.getElementById('session');
  const localVideo = document.getElementById('local-video');
  const errEl = document.getElementById('error');
  const blockNotice = document.getElementById('block-notice');
  const blockReason = document.getElementById('block-reason');
  const degradedNotice = document.getElementById('degraded-notice');
  const degradedReason = document.getElementById('degraded-reason');
  const qualityBadge = document.getElementById('quality-badge');
  const reconnectBanner = document.getElementById('reconnect-banner');
  const floorNotice = document.getElementById('floor-violation');

  // Landing-page browser-compat gate.
  const detect = window.sbBrowser.detectBrowser(navigator.userAgent, {
    hasRTCPeerConnection: typeof RTCPeerConnection !== 'undefined',
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  });
  if (detect.tier === 'unworkable') {
    joinSection.hidden = true;
    blockNotice.hidden = false;
    blockReason.textContent = detect.reasons[0] || '';
    return;
  }
  if (detect.tier === 'degraded') {
    degradedNotice.hidden = false;
    degradedReason.textContent = detect.reasons[0] || '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(form).get('email');
    joinSection.hidden = true;
    lobbyStatus.hidden = false;

    let controlsHandle = null;
    // `handle` is assigned by the await below; `onHangup` fires only
    // after the session has actually started (after onPeerConnected),
    // by which time `handle` is populated. Guarded explicitly so the
    // safety does not depend on an unstated sequencing invariant.
    let handle = null;
    handle = await window.signallingClient.connectStudent({
      slug,
      email,
      onAdmitted() {
        lobbyStatus.hidden = true;
      },
      onRejected(reason) {
        lobbyStatus.hidden = true;
        errEl.textContent = `Rejected: ${reason}`;
      },
      onPeerConnected({ dataChannel, audioTrack, videoTrack }) {
        sessionSection.hidden = false;
        if (qualityBadge) qualityBadge.hidden = false;
        if (videoTrack) {
          localVideo.srcObject = new MediaStream([videoTrack]);
        }
        controlsHandle = window.sbControls.wireControls({
          audioTrack,
          videoTrack,
          onHangup() { if (handle) handle.hangup(); },
        });
        dataChannel.addEventListener('message', (ev) => {
          errEl.textContent = `Teacher says: ${ev.data}`;
        });
        dataChannel.send(JSON.stringify({ hello: true, from: 'student' }));
      },
      onPeerDisconnected() {
        if (controlsHandle) { controlsHandle.teardown(); controlsHandle = null; }
        sessionSection.hidden = true;
        if (qualityBadge) qualityBadge.hidden = true;
        if (reconnectBanner) reconnectBanner.hidden = true;
        localVideo.srcObject = null;
        errEl.textContent = 'Teacher disconnected.';
      },
      onQuality(summary) {
        if (qualityBadge && summary) {
          window.sbQuality.renderQualityBadge(qualityBadge, summary);
        }
      },
      onFloorViolation() {
        // Student-side floor surface: hide the session, reveal the notice,
        // hang up the call so no further RTP flows.
        sessionSection.hidden = true;
        if (floorNotice) floorNotice.hidden = false;
        if (handle) handle.hangup();
      },
      onReconnectBanner(visible) {
        if (reconnectBanner) reconnectBanner.hidden = !visible;
      },
    });
    window.addEventListener('beforeunload', () => { if (handle) handle.hangup(); });
  });
})();
