// File: web/assets/teacher.js
// Purpose: Teacher UI wiring. Student-supplied strings rendered via
//          textContent only (R4 recommendation — no innerHTML to
//          prevent XSS). Sprint 4: threads onQuality /
//          onFloorViolation / onReconnectBanner callbacks through
//          to the signalling client; renders the quality badge and
//          mirrors the student-side floor-violation notice.
// Last updated: Sprint 6 (2026-04-18) -- recording button, consent, post-session send modal

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  document.getElementById('room-heading').textContent = `Your room: ${slug}`;
  const recordingsLink = document.getElementById('recordings-link');
  if (recordingsLink) recordingsLink.href = `/teach/${slug}/recordings`;

  const listEl = document.getElementById('lobby-list');
  const emptyEl = document.getElementById('lobby-empty');
  const statusEl = document.getElementById('session-status');
  const localVideo = document.getElementById('local-video');
  const qualityBadge = document.getElementById('quality-badge');
  const reconnectBanner = document.getElementById('reconnect-banner');
  const floorNotice = document.getElementById('floor-violation');
  const recordBtn = document.getElementById('record');
  const recIndicator = document.getElementById('rec-indicator');
  const sendModal = document.getElementById('send-recording-modal');
  const sendForm = document.getElementById('send-recording-form');
  const sendEmailEl = document.getElementById('send-recording-email');
  const sendStatus = document.getElementById('send-recording-status');
  const sendDismiss = document.getElementById('send-recording-dismiss');

  // Recording state
  let recorderHandle = null;
  let recordStartTime = null;
  let lastStudentEmail = '';
  let localAudioTrack = null;

  function setRecordState(state) {
    if (!recordBtn) return;
    recordBtn.dataset.state = state;
    const labels = { idle: 'Record', 'waiting-consent': 'Waiting…', recording: 'Stop recording', stopped: 'Record' };
    recordBtn.textContent = labels[state] || 'Record';
    recordBtn.disabled = state === 'waiting-consent';
    if (recIndicator) recIndicator.hidden = state !== 'recording';
  }

  if (recordBtn) {
    recordBtn.addEventListener('click', () => {
      const state = recordBtn.dataset.state;
      if (state === 'idle' || state === 'stopped') {
        if (sessionHandle) sessionHandle.startRecording(slug);
        setRecordState('waiting-consent');
      } else if (state === 'recording') {
        if (sessionHandle) sessionHandle.stopRecording(slug);
        stopRecorder();
      }
    });
  }

  if (sendDismiss) {
    sendDismiss.addEventListener('click', () => {
      if (sendModal) sendModal.close();
    });
  }

  if (sendForm) {
    sendForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const pendingId = sendForm.dataset.recordingId;
      if (!pendingId) return;
      const email = sendEmailEl.value.trim();
      sendStatus.hidden = false;
      sendStatus.textContent = 'Sending…';
      fetch('/api/recordings/' + pendingId + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override_email: email }),
      }).then(r => {
        if (!r.ok) throw new Error('send failed ' + r.status);
        sendStatus.textContent = 'Sent!';
        setTimeout(() => { if (sendModal) sendModal.close(); }, 1500);
      }).catch(err => {
        sendStatus.textContent = 'Error: ' + err.message;
      });
    });
  }

  function stopRecorder() {
    if (!recorderHandle) return;
    const startTime = recordStartTime;
    recorderHandle.stop().then(blob => {
      recorderHandle = null;
      recordStartTime = null;
      setRecordState('stopped');
      const durationS = startTime ? Math.round((Date.now() - startTime) / 1000) : undefined;
      return window.sbRecorder.uploadRecording({
        blob,
        studentEmail: lastStudentEmail,
        durationS,
      });
    }).then(result => {
      if (sendModal && sendEmailEl) {
        sendEmailEl.value = lastStudentEmail;
        sendForm.dataset.recordingId = result.id;
        if (sendStatus) sendStatus.hidden = true;
        sendModal.showModal();
      }
    }).catch(err => {
      console.error('recording upload failed', err);
    });
  }

  // Proxy so list-item click handlers can reach the handle before
  // connectTeacher resolves. Reads the closure-scoped sessionHandle
  // (NOT a global) — the handle is never exposed on window.
  const handleProxy = {
    admit(id) { if (sessionHandle) sessionHandle.admit(id); },
    reject(id) { if (sessionHandle) sessionHandle.reject(id); },
    rejectAndBlock(id) { if (sessionHandle) sessionHandle.rejectAndBlock(id, 600); },
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
    admit.addEventListener('click', () => {
      lastStudentEmail = entry.email;
      handleProxy.admit(entry.id);
    });
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => handleProxy.reject(entry.id));
    const rejectAndBlock = document.createElement('button');
    rejectAndBlock.type = 'button';
    rejectAndBlock.textContent = 'Reject & block (10 min)';
    rejectAndBlock.addEventListener('click', () => handleProxy.rejectAndBlock(entry.id));
    li.append(document.createTextNode(' '), admit, reject, rejectAndBlock);
    return li;
  }

  let controlsHandle = null;
  // Session handle is closure-scoped (not on window). renderEntry's
  // Admit/Reject buttons read it via handleProxy, which is also
  // closure-scoped below.
  let sessionHandle = null;

  window.signallingClient.connectTeacher({
    slug,
    onLobbyUpdate(entries) {
      listEl.replaceChildren();
      emptyEl.hidden = entries.length > 0;
      for (const entry of entries) listEl.append(renderEntry(entry));
    },
    onPeerConnected({ dataChannel, audioTrack, videoTrack }) {
      statusEl.textContent = 'Connected.';
      localAudioTrack = audioTrack;
      if (qualityBadge) qualityBadge.hidden = false;
      setRecordState('idle');
      if (videoTrack) {
        localVideo.srcObject = new MediaStream([videoTrack]);
      }
      controlsHandle = window.sbControls.wireControls({
        audioTrack,
        videoTrack,
        onHangup() { if (sessionHandle) sessionHandle.hangup(); },
      });
      dataChannel.addEventListener('message', (e) => {
        statusEl.textContent = `Student says: ${e.data}`;
      });
      dataChannel.send(JSON.stringify({ hello: true, from: 'teacher' }));
    },
    onPeerDisconnected() {
      statusEl.textContent = 'Student disconnected.';
      localAudioTrack = null;
      if (controlsHandle) { controlsHandle.teardown(); controlsHandle = null; }
      if (qualityBadge) qualityBadge.hidden = true;
      if (reconnectBanner) reconnectBanner.hidden = true;
      if (floorNotice) floorNotice.hidden = true;
      // If recording was active, stop it.
      if (recorderHandle) stopRecorder();
      setRecordState('idle');
      localVideo.srcObject = null;
    },
    onQuality(summary) {
      if (qualityBadge && summary) {
        window.sbQuality.renderQualityBadge(qualityBadge, summary);
      }
    },
    onFloorViolation() {
      if (floorNotice) floorNotice.hidden = false;
    },
    onReconnectBanner(visible) {
      if (reconnectBanner) reconnectBanner.hidden = !visible;
    },
    onRecordConsentResult(granted) {
      if (granted) {
        // Student consented — start the actual MediaRecorder.
        setRecordState('recording');
        recordStartTime = Date.now();
        if (window.sbRecorder && controlsHandle) {
          const remoteAudio = document.getElementById('remote-audio');
          const remoteStream = remoteAudio && remoteAudio.srcObject;
          recorderHandle = window.sbRecorder.start({
            localAudioTrack,
            localVideoStream: localVideo.srcObject,
            remoteStream,
          });
        }
      } else {
        setRecordState('idle');
      }
    },
    onRecordingStopped() {
      if (recorderHandle) stopRecorder();
      else setRecordState('idle');
    },
  }).then((h) => {
    sessionHandle = h;
  });
})();
