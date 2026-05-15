// File: web/assets/teacher.js
// Purpose: Teacher UI wiring. Student-supplied strings rendered via
//          textContent only (no innerHTML — XSS prevention). Sprint 8:
//          replaced wireControls with sbSessionUI.mount into #session-root.
// Last updated: Sprint 30 (2026-05-15) -- full-viewport session, record in icon bar, allSettled track fetch

'use strict';

(function () {
  // pathname is /teach/<slug>/session — extract the middle segment
  const slug = location.pathname.split('/')[2] || '';
  document.getElementById('room-heading').textContent = `Your room: ${slug}`;

  const roomNameNav = document.getElementById('room-name-nav');
  if (roomNameNav) roomNameNav.textContent = slug.toUpperCase();
  const dashboardLink = document.getElementById('dashboard-link');
  if (dashboardLink) dashboardLink.href = `/teach/${slug}/dashboard`;

  if (window.sbDevicePicker) window.sbDevicePicker.mount('audio-device-picker');
  const recordingsLink = document.getElementById('recordings-link');
  if (recordingsLink) recordingsLink.href = `/teach/${slug}/recordings`;

  const recordingControls = document.getElementById('recording-controls');
  const pitchControls = document.getElementById('pitch-controls');
  const pitchToggleBtn = document.getElementById('pitch-toggle');
  const pitchDisplayRoot = document.getElementById('pitch-display-root');
  if (window.sbPitchDisplay && pitchDisplayRoot) window.sbPitchDisplay.mount(pitchDisplayRoot);

  let pitchActive = false;
  let pitchDataChannel = null;

  if (pitchToggleBtn) {
    pitchToggleBtn.addEventListener('click', function () {
      pitchActive = !pitchActive;
      pitchToggleBtn.setAttribute('aria-pressed', String(pitchActive));
      pitchToggleBtn.classList.toggle('sb-btn--accent', pitchActive);
      if (window.sbPitchDisplay) window.sbPitchDisplay.setActive(pitchActive);
      if (pitchDataChannel && pitchDataChannel.readyState === 'open') {
        pitchDataChannel.send(JSON.stringify({ type: pitchActive ? 'pitch_on' : 'pitch_off' }));
      }
    });
  }

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

  // VAD + chat mode
  let vadHandle = null;
  let accompanimentIsPlaying = false;
  let lastStudentAcousticProfile = 'speakers'; // conservative default
  let chatChipEl = null;

  const CHAT_CHIP_MODES = ['auto', 'on', 'off']; // cycles on click

  function updateChatChip() {
    if (!chatChipEl || !vadHandle) return;
    if (lastStudentAcousticProfile === 'ios_forced') {
      chatChipEl.textContent = 'Always on (iOS forces voice processing)';
      chatChipEl.className = 'sb-chat-chip sb-chat-chip--ios';
      chatChipEl.disabled = true;
      return;
    }
    chatChipEl.disabled = false;
    if (accompanimentIsPlaying) {
      chatChipEl.textContent = 'Suppressed (track playing)';
      chatChipEl.className = 'sb-chat-chip sb-chat-chip--suppressed';
      return;
    }
    const mode = chatChipEl.dataset.forceMode || 'auto';
    if (mode === 'auto') {
      chatChipEl.textContent = 'Auto-listening';
      chatChipEl.className = 'sb-chat-chip sb-chat-chip--auto';
    } else if (mode === 'on') {
      chatChipEl.textContent = 'On';
      chatChipEl.className = 'sb-chat-chip sb-chat-chip--on';
    } else {
      chatChipEl.textContent = 'Demonstrating';
      chatChipEl.className = 'sb-chat-chip sb-chat-chip--demonstrating';
    }
  }

  function setRecordState(state) {
    if (recordBtn) {
      recordBtn.dataset.state = state;
      const labels = { idle: 'Record', 'waiting-consent': 'Waiting…', recording: 'Stop recording', stopped: 'Record' };
      recordBtn.textContent = labels[state] || 'Record';
      recordBtn.disabled = state === 'waiting-consent';
    }
    if (recIndicator) recIndicator.hidden = state !== 'recording';
    if (sessionUiHandle && sessionUiHandle.setRecordState) sessionUiHandle.setRecordState(state);
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
    const profile = entry.acoustic_profile || (entry.headphones_confirmed ? 'headphones' : null);
    const profileLabels = { headphones: '🎧 Headphones', speakers: '🔊 Speakers', ios_forced: '📱 iOS (AEC forced)' };
    const profileChip = document.createElement('span');
    profileChip.className = 'profile-chip profile-chip--' + (profile || 'unknown');
    profileChip.textContent = profileLabels[profile] || 'Audio setup unknown';
    const overrideBtn = document.createElement('button');
    overrideBtn.type = 'button';
    overrideBtn.className = 'sb-btn sb-btn--sm';
    if (profile === 'ios_forced') {
      // iOS AEC is OS-enforced — the profile cannot be meaningfully overridden.
      overrideBtn.hidden = true;
    } else {
      overrideBtn.textContent = profile === 'headphones' ? 'Mark: Speakers' : 'Mark: Headphones';
      overrideBtn.addEventListener('click', () => {
        const newProfile = profile === 'headphones' ? 'speakers' : 'headphones';
        if (sessionHandle) sessionHandle.sendSetAcousticProfile(entry.id, newProfile);
      });
    }
    li.append(meta, document.createTextNode(' '), badge, document.createTextNode(' '), profileChip, document.createTextNode(' '), overrideBtn);
    if (entry.tier_reason) {
      const r = document.createElement('span');
      r.className = 'tier-reason';
      r.textContent = ` (${entry.tier_reason})`;
      li.append(r);
    }
    const admit = document.createElement('button');
    admit.type = 'button';
    admit.setAttribute('data-testid', 'admit-btn');
    admit.textContent = 'Admit';
    admit.addEventListener('click', () => {
      lastStudentEmail = entry.email;
      lastStudentHeadphones = !!entry.headphones_confirmed;
      lastStudentAcousticProfile = entry.acoustic_profile || (entry.headphones_confirmed ? 'headphones' : 'speakers');
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
  let accompanimentHandle = null;
  let scoreViewHandle = null;
  let accmpPanel = null;

  const noOpSendWs = function () {};
  const BASE = '/teach/' + slug + '/library/assets';
  const drawerRoot = document.getElementById('accompaniment-drawer-root');

  // Lobby setup: build panel and mount accompaniment drawer at page load.
  if (window.sbSessionPanels) {
    accmpPanel = window.sbSessionPanels.buildAccmpPanel();
  } else {
    console.error('[teacher] sbSessionPanels not loaded');
  }
  if (drawerRoot && accmpPanel) drawerRoot.appendChild(accmpPanel.node);

  if (window.sbAccompanimentDrawer && accmpPanel) {
    accompanimentHandle = window.sbAccompanimentDrawer.mount(null, {
      role: 'teacher',
      panelEl: accmpPanel,
      sendWs: noOpSendWs,
      getOneWayLatencyMs: function () { return 0; },
      acousticProfile: 'headphones',
      lobbyMode: true,
      base: BASE,
    });
  }

  const scoreRoot = document.getElementById('score-view-root');
  if (window.sbScoreView && scoreRoot && accompanimentHandle) {
    scoreViewHandle = window.sbScoreView.mount(scoreRoot);
    accompanimentHandle.setScoreView(scoreViewHandle);
  }

  if (accmpPanel && accmpPanel.scoreToggleBtn && scoreRoot) {
    accmpPanel.scoreToggleBtn.addEventListener('click', function () {
      const pressed = accmpPanel.scoreToggleBtn.getAttribute('aria-pressed') === 'true';
      accmpPanel.scoreToggleBtn.setAttribute('aria-pressed', pressed ? 'false' : 'true');
      scoreRoot.hidden = pressed;
    });
  }

  // Fetch asset list only (no tokens issued at page load).
  fetch(BASE)
    .then(function (r) { return r.json(); })
    .then(function (assets) {
      if (accompanimentHandle) accompanimentHandle.setAssetList(assets);
    })
    .catch(function () {});

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
    onAccompanimentState(state) {
      if (accompanimentHandle) accompanimentHandle.updateState(state);
      const wasPlaying = accompanimentIsPlaying;
      accompanimentIsPlaying = !!state.is_playing;
      if (vadHandle && accompanimentIsPlaying !== wasPlaying) {
        vadHandle.suppress(accompanimentIsPlaying);
        updateChatChip();
      }
    },
    onAcousticProfileChanged(profile) {
      lastStudentAcousticProfile = profile;
      if (accompanimentHandle) accompanimentHandle.setAcousticProfile(profile);
      updateChatChip();
    },
    onPeerConnected({ dataChannel, audioTrack, videoTrack, localStream, remoteStream, getOneWayLatencyMs }) {
      statusEl.textContent = 'Connected.';
      localAudioTrack = audioTrack;
      document.documentElement.classList.add('sb-in-session');
      if (qualityBadge) qualityBadge.hidden = false;
      if (recordingControls) recordingControls.hidden = false;
      if (pitchControls) pitchControls.hidden = false;
      pitchDataChannel = dataChannel;
      setRecordState('idle');

      // Re-parent panel from lobby root into session layout before session UI mounts.
      if (drawerRoot && accmpPanel && drawerRoot.contains(accmpPanel.node)) {
        drawerRoot.removeChild(accmpPanel.node);
      }

      // Wire live functions into persistent drawer.
      if (accompanimentHandle) {
        accompanimentHandle.setSendWs(function (msg) { if (sessionHandle) sessionHandle.sendRaw(msg); });
        accompanimentHandle.setGetOneWayLatencyMs(getOneWayLatencyMs || function () { return 0; });
        accompanimentHandle.setAcousticProfile(lastStudentAcousticProfile);
        accompanimentHandle.exitLobbyMode();
      }

      const sessionRoot = document.getElementById('session-root');
      sessionUiHandle = window.sbSessionUI.mount(sessionRoot, {
        isTeacher: true,
        remoteName: lastStudentEmail,
        remoteRoleLabel: 'Student',
        localStream: localStream || null,
        remoteStream: remoteStream && remoteStream.getTracks().length > 0 ? remoteStream : null,
        headphonesConfirmed: lastStudentHeadphones,
        micEnabled: true,
        videoEnabled: true,
        accmpPanel: accmpPanel,
        onMicToggle() {
          const track = localStream && localStream.getAudioTracks()[0];
          if (track) track.enabled = !track.enabled;
        },
        onVideoToggle() {
          const track = localStream && localStream.getVideoTracks()[0];
          if (track) track.enabled = !track.enabled;
        },
        onEnd() { if (sessionHandle) sessionHandle.hangup(); },
        onSendChat(text) { if (sessionHandle) sessionHandle.sendChat(text); },
        onRecord() {
          const state = recordBtn ? recordBtn.dataset.state : 'idle';
          if (state === 'idle' || state === 'stopped') {
            if (sessionHandle) sessionHandle.startRecording(slug);
            setRecordState('waiting-consent');
          } else if (state === 'recording') {
            if (sessionHandle) sessionHandle.stopRecording(slug);
            stopRecorder();
          }
        },
      });

      // Create VAD on the teacher's local audio track.
      if (window.sbVad && audioTrack) {
        vadHandle = window.sbVad.create(audioTrack, {
          onVoiceStart() {
            if (!accompanimentIsPlaying && sessionHandle) sessionHandle.sendChattingMode(true);
          },
          onVoiceSilence() {
            if (sessionHandle) sessionHandle.sendChattingMode(false);
          },
        });
        // Add chat chip to session area.
        const sessionArea = document.querySelector('.session');
        if (sessionArea) {
          chatChipEl = document.createElement('button');
          chatChipEl.type = 'button';
          chatChipEl.dataset.forceMode = 'auto';
          chatChipEl.addEventListener('click', () => {
            if (!vadHandle) return;
            const cur = chatChipEl.dataset.forceMode || 'auto';
            const next = cur === 'auto' ? 'on' : cur === 'on' ? 'off' : 'auto';
            chatChipEl.dataset.forceMode = next;
            vadHandle.forceMode(next);
            updateChatChip();
            // forceMode emits onVoiceStart/Silence which call sendChattingMode.
          });
          updateChatChip();
          sessionArea.appendChild(chatChipEl);
        }
      }

      // Full variant detail fetch (with tokens) for live track selector.
      if (accompanimentHandle) {
        fetch(BASE)
          .then(function (r) { return r.json(); })
          .then(function (assets) {
            const useful = assets.filter(function (a) { return a.variant_count > 0; });
            return Promise.allSettled(useful.map(function (a) {
              return fetch(BASE + '/' + a.id)
                .then(function (r) { return r.json(); })
                .then(function (d) { return Object.assign({}, a, { variants: d.variants || [] }); });
            }));
          })
          .then(function (results) {
            const full = results
              .filter(function (r) { return r.status === 'fulfilled'; })
              .map(function (r) { return r.value; });
            if (full.length > 0 && accompanimentHandle) accompanimentHandle.setTrackList(full);
          })
          .catch(function () {});
      }

      dataChannel.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'pitch_data') {
            if (window.sbPitchDisplay) window.sbPitchDisplay.setNote(msg.name, msg.cents);
            return;
          }
        } catch (_) {}
        statusEl.textContent = `Student says: ${e.data}`;
      });
      dataChannel.send(JSON.stringify({ hello: true, from: 'teacher' }));
    },
    onPeerDisconnected() {
      statusEl.textContent = 'Student disconnected.';
      document.documentElement.classList.remove('sb-in-session');
      if (recordingControls) recordingControls.hidden = true;
      if (pitchControls) pitchControls.hidden = true;
      if (window.sbPitchDisplay) window.sbPitchDisplay.setActive(false);
      pitchActive = false;
      pitchDataChannel = null;
      if (pitchToggleBtn) { pitchToggleBtn.setAttribute('aria-pressed', 'false'); pitchToggleBtn.classList.remove('sb-btn--accent'); }
      localAudioTrack = null;
      accompanimentIsPlaying = false;
      if (vadHandle) { vadHandle.teardown(); vadHandle = null; }
      if (chatChipEl && chatChipEl.parentNode) { chatChipEl.parentNode.removeChild(chatChipEl); chatChipEl = null; }
      // Move panel back to lobby root before session UI teardown destroys accmpPanelWrap.
      if (drawerRoot && accmpPanel && !drawerRoot.contains(accmpPanel.node)) {
        drawerRoot.appendChild(accmpPanel.node);
      }
      if (sessionUiHandle) { sessionUiHandle.teardown(); sessionUiHandle = null; }
      // Revert drawer to lobby mode — handle stays alive for reconnect.
      if (accompanimentHandle) {
        accompanimentHandle.setSendWs(noOpSendWs);
        accompanimentHandle.setGetOneWayLatencyMs(function () { return 0; });
        accompanimentHandle.setAcousticProfile('headphones');
        accompanimentHandle.enterLobbyMode();
      }
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
    // Bot API: exposes WebSocket send for Playwright test-peer script (localhost only).
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      window._sbSend = function(obj) { h.sendRaw(obj); };
    }
  });
})();
