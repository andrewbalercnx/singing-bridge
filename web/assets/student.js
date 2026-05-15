// File: web/assets/student.js
// Purpose: Student join form + lobby/session UI driver. Sprint 8:
//          replaced wireControls with sbSessionUI.mount into #session-root.
// Last updated: Sprint 30 (2026-05-15) -- full-viewport session takeover

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  const pitchDisplayRoot = document.getElementById('pitch-display-root');
  if (window.sbPitchDisplay && pitchDisplayRoot) window.sbPitchDisplay.mount(pitchDisplayRoot);
  const eyebrow = document.getElementById('room-eyebrow');
  if (eyebrow) eyebrow.textContent = slug;
  document.title = slug + ' — singing-bridge';
  const wrongRoomLink = document.getElementById('wrong-room-link');
  if (wrongRoomLink) wrongRoomLink.href = '/';
  if (window.sbDevicePicker) window.sbDevicePicker.mount('audio-device-picker');
  const joinSection = document.getElementById('join');
  const form = document.getElementById('join-form');
  const lobbyStatus = document.getElementById('lobby-status');
  const sessionSection = document.getElementById('session');
  const errEl = document.getElementById('error');
  const blockNotice = document.getElementById('block-notice');
  const blockReason = document.getElementById('block-reason');
  const degradedNotice = document.getElementById('degraded-notice');
  const degradedReason = document.getElementById('degraded-reason');
  const iosNote = document.getElementById('ios-note');
  const qualityBadge = document.getElementById('quality-badge');
  const reconnectBanner = document.getElementById('reconnect-banner');
  const floorNotice = document.getElementById('floor-violation');
  const blockedNotice = document.getElementById('blocked-notice');
  const consentBanner = document.getElementById('consent-banner');
  const consentAccept = document.getElementById('consent-accept');
  const consentDecline = document.getElementById('consent-decline');
  const consentCountdown = document.getElementById('consent-countdown');
  const recIndicator = document.getElementById('rec-indicator');

  let consentTimer = null;
  let headphonesConfirmedState = false;
  let localAudioTrack = null;
  let localAudioTrackAec = null;
  let audioSender = null;
  let micEnabled = true;
  let lastChatModeApplied = null;
  let pitchDataChannel = null;

  function startPitch() {
    if (!window.sbPitchEngine || !window.sbPitchDisplay || !localAudioTrack) return;
    window.sbPitchDisplay.setActive(true);
    const stream = new MediaStream([localAudioTrack]);
    window.sbPitchEngine.start(stream, function (name, cents) {
      if (window.sbPitchDisplay) window.sbPitchDisplay.setNote(name, cents);
      if (pitchDataChannel && pitchDataChannel.readyState === 'open') {
        pitchDataChannel.send(JSON.stringify({ type: 'pitch_data', name: name, cents: cents }));
      }
    });
  }

  function stopPitch() {
    if (window.sbPitchEngine) window.sbPitchEngine.stop();
    if (window.sbPitchDisplay) window.sbPitchDisplay.setActive(false);
  }

  function deriveAcousticProfile(det) {
    return det.iosAecForced ? 'ios_forced' : null;
  }

  async function applyChatMode(enabled) {
    if (enabled === lastChatModeApplied) return;
    lastChatModeApplied = enabled;
    if (detect.iosAecForced) return; // iOS: AEC is fixed by OS; no-op
    if (!audioSender) return;
    const track = enabled ? localAudioTrackAec : localAudioTrack;
    if (!track) return;
    track.enabled = micEnabled;
    try {
      await audioSender.replaceTrack(track);
    } catch (_) {
      console.warn('[student] replaceTrack for chat mode failed');
    }
  }

  function showConsentBanner(onResponse) {
    if (!consentBanner) return;
    consentBanner.hidden = false;
    let remaining = 30;
    if (consentCountdown) consentCountdown.textContent = `(${remaining}s)`;
    consentTimer = setInterval(() => {
      remaining--;
      if (consentCountdown) consentCountdown.textContent = `(${remaining}s)`;
      if (remaining <= 0) {
        clearInterval(consentTimer);
        consentTimer = null;
        hideConsentBanner();
        onResponse(false);
      }
    }, 1000);

    function respond(granted) {
      clearInterval(consentTimer);
      consentTimer = null;
      hideConsentBanner();
      onResponse(granted);
    }

    consentAccept.onclick = () => respond(true);
    consentDecline.onclick = () => respond(false);
  }

  function hideConsentBanner() {
    if (consentBanner) consentBanner.hidden = true;
  }

  function setRecIndicator(active) {
    if (recIndicator) recIndicator.hidden = !active;
  }

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
  if (detect.iosAecForced && iosNote) {
    iosNote.hidden = false;
  }

  const emailInput = document.getElementById('join-email');
  const emailError = document.getElementById('join-email-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(form).get('email');
    if (!email || !emailInput.validity.valid) {
      emailError.textContent = email ? 'Please enter a valid email address.' : 'Please enter your email address.';
      emailError.hidden = false;
      emailInput.focus();
      return;
    }
    emailError.hidden = true;
    joinSection.hidden = true;
    lobbyStatus.hidden = false;

    let sessionUiHandle = null;
    let accompanimentHandle = null;
    let scoreViewHandle = null;
    let handle = null;

    // Self-check while waiting in lobby.
    // Always show — pass null if capture fails so the overlay degrades gracefully.
    let selfCheckStream = null;
    try {
      selfCheckStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (_) {}
    if (window.sbSelfCheck) {
      window.sbSelfCheck.show(selfCheckStream, {
        role: 'student',
        iosAecForced: detect.iosAecForced,
        onConfirm(hp) {
          headphonesConfirmedState = hp;
          if (hp && handle) handle.sendHeadphonesConfirmed();
        },
      });
    }

    handle = await window.signallingClient.connectStudent({
      slug,
      email,
      acoustic_profile: deriveAcousticProfile(detect),
      onAdmitted() {
        lobbyStatus.hidden = true;
      },
      onRejected(reason) {
        lobbyStatus.hidden = true;
        errEl.textContent = `Rejected: ${reason}`;
      },
      onWsClose() {
        lobbyStatus.hidden = true;
        errEl.textContent = 'Connection lost — please refresh the page and try again.';
      },
      onBlocked(_reason) {
        lobbyStatus.hidden = true;
        if (blockedNotice) blockedNotice.hidden = false;
      },
      onChat({ from, text }) {
        if (sessionUiHandle) sessionUiHandle.appendChatMsg(from, text);
      },
      onLobbyMessage({ text }) {
        if (window.sbLobbyToast) window.sbLobbyToast.show(text, 8000);
      },
      onRemoteStream(stream) {
        if (sessionUiHandle) sessionUiHandle.setRemoteStream(stream);
      },
      onAccompanimentState(state) {
        if (accompanimentHandle) accompanimentHandle.updateState(state);
        if (scoreViewHandle) scoreViewHandle.updatePages(state.page_urls || null, state.bar_coords || null);
      },
      onChattingMode({ enabled }) {
        applyChatMode(enabled);
      },
      onPeerConnected({ dataChannel, audioTrack, videoTrack, localStream, remoteStream, audioSender: sndr }) {
        localAudioTrack = localStream && localStream.getAudioTracks()[0] || null;
        audioSender = sndr || null;
        document.documentElement.classList.add('sb-in-session');
        if (window.sbAudio.startLocalAudioAec && localAudioTrack) {
          const deviceId = localAudioTrack.getSettings && localAudioTrack.getSettings().deviceId;
          window.sbAudio.startLocalAudioAec(deviceId).then(function (acq) {
            localAudioTrackAec = acq.track;
            localAudioTrackAec.enabled = micEnabled;
          }).catch(function () {
            console.warn('[student] AEC track acquisition failed — chat mode will not cancel echo');
          });
        }
        sessionSection.hidden = false;
        if (qualityBadge) qualityBadge.hidden = false;
        const sessionRoot = document.getElementById('session-root');
        const drawerRoot = document.getElementById('accompaniment-drawer-root');
        const scoreRoot = document.getElementById('score-view-root');
        if (window.sbAccompanimentDrawer && drawerRoot) {
          accompanimentHandle = window.sbAccompanimentDrawer.mount(drawerRoot, {
            role: 'student',
            slug,
            sendWs() {}, // students cannot send accompaniment messages
          });
          if (window.sbScoreView && scoreRoot) {
            scoreViewHandle = window.sbScoreView.mount(scoreRoot);
            accompanimentHandle.setScoreView(scoreViewHandle);
          }
        }
        sessionUiHandle = window.sbSessionUI.mount(sessionRoot, {
          role: 'student',
          remoteName: 'Teacher',
          remoteRoleLabel: 'Your teacher',
          localStream: localStream || null,
          remoteStream: remoteStream && remoteStream.getTracks().length > 0 ? remoteStream : null,
          headphonesConfirmed: false,
          micEnabled: true,
          videoEnabled: true,
          onMicToggle() {
            micEnabled = !micEnabled;
            if (localAudioTrack) localAudioTrack.enabled = micEnabled;
            if (localAudioTrackAec) localAudioTrackAec.enabled = micEnabled;
          },
          onVideoToggle() {
            const track = localStream && localStream.getVideoTracks()[0];
            if (track) track.enabled = !track.enabled;
          },
          onEnd() { if (handle) handle.hangup(); },
          onNote() { console.log('[sprint9] note panel'); },
          onSendChat(text) { if (handle) handle.sendChat(text); },
        });
        pitchDataChannel = dataChannel;
        dataChannel.addEventListener('message', (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'pitch_on')  { startPitch(); return; }
            if (msg.type === 'pitch_off') { stopPitch();  return; }
          } catch (_) {}
          errEl.textContent = `Teacher says: ${ev.data}`;
        });
        dataChannel.send(JSON.stringify({ hello: true, from: 'student' }));
      },
      onPeerDisconnected() {
        stopPitch();
        pitchDataChannel = null;
        document.documentElement.classList.remove('sb-in-session');
        if (sessionUiHandle) { sessionUiHandle.teardown(); sessionUiHandle = null; }
        if (accompanimentHandle) { accompanimentHandle.teardown(); accompanimentHandle = null; }
        if (scoreViewHandle) { scoreViewHandle.teardown(); scoreViewHandle = null; }
        if (localAudioTrackAec) { localAudioTrackAec.stop(); localAudioTrackAec = null; }
        audioSender = null;
        micEnabled = true;
        localAudioTrack = null;
        lastChatModeApplied = null;
        sessionSection.hidden = true;
        if (qualityBadge) qualityBadge.hidden = true;
        if (reconnectBanner) reconnectBanner.hidden = true;
        hideConsentBanner();
        setRecIndicator(false);
        errEl.textContent = 'Teacher disconnected.';
      },
      onQuality(summary) {
        if (qualityBadge && summary) {
          window.sbQuality.renderQualityBadge(qualityBadge, summary);
        }
      },
      onFloorViolation() {
        sessionSection.hidden = true;
        if (floorNotice) floorNotice.hidden = false;
        if (handle) handle.hangup();
      },
      onReconnectBanner(visible) {
        if (reconnectBanner) reconnectBanner.hidden = !visible;
      },
      onRecordConsentRequest() {
        showConsentBanner((granted) => {
          if (handle) handle.sendRecordConsent(slug, granted);
        });
      },
      onRecordingActive() {
        setRecIndicator(true);
      },
      onRecordingStopped() {
        setRecIndicator(false);
        hideConsentBanner();
      },
    });
    // Flush pending headphones confirmation: if the user confirmed before the
    // WS handle was ready, the earlier sendHeadphonesConfirmed() was skipped.
    if (headphonesConfirmedState && handle) handle.sendHeadphonesConfirmed();
    window.addEventListener('beforeunload', () => { if (handle) handle.hangup(); });
  });
})();
