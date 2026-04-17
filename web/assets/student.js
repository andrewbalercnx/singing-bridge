// File: web/assets/student.js
// Purpose: Student join form + lobby/session UI driver. Sprint 3:
//          runs the landing-page browser-compat gate on load, shows
//          block/degraded notices, wires local-video preview + the
//          mute/video-off/end-call controls.
// Last updated: Sprint 3 (2026-04-17) -- +browser gate +controls +local preview

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
    const handle = await window.signallingClient.connectStudent({
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
        if (videoTrack) {
          localVideo.srcObject = new MediaStream([videoTrack]);
        }
        controlsHandle = window.sbControls.wireControls({
          audioTrack,
          videoTrack,
          onHangup() { handle.hangup(); },
        });
        dataChannel.addEventListener('message', (ev) => {
          errEl.textContent = `Teacher says: ${ev.data}`;
        });
        dataChannel.send(JSON.stringify({ hello: true, from: 'student' }));
      },
      onPeerDisconnected() {
        if (controlsHandle) { controlsHandle.teardown(); controlsHandle = null; }
        sessionSection.hidden = true;
        localVideo.srcObject = null;
        errEl.textContent = 'Teacher disconnected.';
      },
    });
    window.addEventListener('beforeunload', () => handle.hangup());
  });
})();
