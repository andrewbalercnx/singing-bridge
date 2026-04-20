// File: web/assets/teacher.js
// Purpose: Teacher UI wiring. Student-supplied strings rendered via
//          textContent only (no innerHTML — XSS prevention). Sprint 8:
//          replaced wireControls with sbSessionUI.mount into #session-root.
// Last updated: Sprint 9 (2026-04-19) -- chat drawer via session-ui, teacher self-check, headphones chip

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  document.getElementById('room-heading').textContent = `Your room: ${slug}`;
  const recordingsLink = document.getElementById('recordings-link');
  if (recordingsLink) recordingsLink.href = `/teach/${slug}/recordings`;

  const listEl = document.getElementById('lobby-list');
  const emptyEl = document.getElementById('lobby-empty');
  const statusEl = document.getElementById('session-status');
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

  // Self-check: show once per session before first student interaction.
  // Always call show — pass null if capture fails so overlay degrades gracefully.
  if (window.sbSelfCheck) {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(function (stream) {
      window.sbSelfCheck.show(stream, { role: 'teacher', onConfirm: function () {} });
    }).catch(function () {
      window.sbSelfCheck.show(null, { role: 'teacher', onConfirm: function () {} });
    });
  }

  // Recording state
  let recorderHandle = null;
  let recordStartTime = null;
  let lastStudentEmail = '';
  let lastStudentHeadphones = false;
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
    const hpChip = document.createElement('span');
    hpChip.className = 'headphones-chip' + (entry.headphones_confirmed ? ' confirmed' : '');
    hpChip.textContent = entry.headphones_confirmed ? '🎧 Headphones' : 'No headphones confirmed';
    li.append(meta, document.createTextNode(' '), badge, document.createTextNode(' '), hpChip);
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
      lastStudentHeadphones = !!entry.headphones_confirmed;
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

    // Lobby message inline form.
    const msgForm = document.createElement('form');
    msgForm.className = 'lobby-msg-form';
    const msgInput = document.createElement('input');
    msgInput.type = 'text';
    msgInput.maxLength = 500;
    msgInput.placeholder = 'Send a message…';
    msgInput.autocomplete = 'off';
    const msgBtn = document.createElement('button');
    msgBtn.type = 'submit';
    msgBtn.textContent = 'Send';
    const msgStatus = document.createElement('span');
    msgStatus.className = 'lobby-msg-status';
    msgStatus.hidden = true;
    msgForm.append(msgInput, msgBtn, msgStatus);
    msgForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = msgInput.value.trim();
      if (!text || !sessionHandle) return;
      sessionHandle.sendLobbyMessage(entry.id, text);
      msgInput.value = '';
      msgStatus.textContent = 'Sent ✓';
      msgStatus.hidden = false;
      setTimeout(() => { msgStatus.hidden = true; }, 2000);
    });
    li.append(msgForm);
    return li;
  }

  let sessionUiHandle = null;
  let sessionHandle = null;

  window.signallingClient.connectTeacher({
    slug,
    onLobbyUpdate(entries) {
      listEl.replaceChildren();
      emptyEl.hidden = entries.length > 0;
      for (const entry of entries) listEl.append(renderEntry(entry));
    },
    onChat({ from, text }) {
      if (sessionUiHandle) sessionUiHandle.appendChatMsg(from, text);
    },
    onRemoteStream(stream) {
      if (sessionUiHandle) sessionUiHandle.setRemoteStream(stream);
    },
    onPeerConnected({ dataChannel, audioTrack, videoTrack, localStream, remoteStream }) {
      statusEl.textContent = 'Connected.';
      localAudioTrack = audioTrack;
      if (qualityBadge) qualityBadge.hidden = false;
      setRecordState('idle');
      const sessionRoot = document.getElementById('session-root');
      sessionUiHandle = window.sbSessionUI.mount(sessionRoot, {
        role: 'teacher',
        remoteName: lastStudentEmail,
        remoteRoleLabel: 'Student',
        localStream: localStream || null,
        remoteStream: remoteStream && remoteStream.getTracks().length > 0 ? remoteStream : null,
        headphonesConfirmed: lastStudentHeadphones,
        micEnabled: true,
        videoEnabled: true,
        onMicToggle() {
          const track = localStream && localStream.getAudioTracks()[0];
          if (track) track.enabled = !track.enabled;
        },
        onVideoToggle() {
          const track = localStream && localStream.getVideoTracks()[0];
          if (track) track.enabled = !track.enabled;
        },
        onEnd() { if (sessionHandle) sessionHandle.hangup(); },
        onNote() { console.log('[sprint9] note panel'); },
        onSendChat(text) { if (sessionHandle) sessionHandle.sendChat(text); },
      });
      dataChannel.addEventListener('message', (e) => {
        statusEl.textContent = `Student says: ${e.data}`;
      });
      dataChannel.send(JSON.stringify({ hello: true, from: 'teacher' }));
    },
    onPeerDisconnected() {
      statusEl.textContent = 'Student disconnected.';
      localAudioTrack = null;
      if (sessionUiHandle) { sessionUiHandle.teardown(); sessionUiHandle = null; }
      if (qualityBadge) qualityBadge.hidden = true;
      if (reconnectBanner) reconnectBanner.hidden = true;
      if (floorNotice) floorNotice.hidden = true;
      if (recorderHandle) stopRecorder();
      setRecordState('idle');
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
    onRecordConsentResult(granted, remoteStream) {
      if (granted) {
        setRecordState('recording');
        recordStartTime = Date.now();
        if (window.sbRecorder) {
          recorderHandle = window.sbRecorder.start({
            localAudioTrack,
            localVideoStream: null,
            remoteStream: remoteStream || null,
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
    onWsClose() {
      if (reconnectBanner) {
        reconnectBanner.hidden = false;
        reconnectBanner.textContent = 'Connection lost — please refresh the page.';
      }
    },
  }).then((h) => {
    sessionHandle = h;
  });
})();
