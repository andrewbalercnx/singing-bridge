// File: web/assets/student.js
// Purpose: Student join form + lobby/session UI driver. Sprint 8:
//          replaced wireControls with sbSessionUI.mount into #session-root.
// Last updated: Sprint 8 (2026-04-19) -- session-ui mount replaces wireControls

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  const joinSection = document.getElementById('join');
  const form = document.getElementById('join-form');
  const lobbyStatus = document.getElementById('lobby-status');
  const sessionSection = document.getElementById('session');
  const errEl = document.getElementById('error');
  const blockNotice = document.getElementById('block-notice');
  const blockReason = document.getElementById('block-reason');
  const degradedNotice = document.getElementById('degraded-notice');
  const degradedReason = document.getElementById('degraded-reason');
  const qualityBadge = document.getElementById('quality-badge');
  const reconnectBanner = document.getElementById('reconnect-banner');
  const floorNotice = document.getElementById('floor-violation');
  const blockedNotice = document.getElementById('blocked-notice');
  const consentBanner = document.getElementById('consent-banner');
  const consentAccept = document.getElementById('consent-accept');
  const consentDecline = document.getElementById('consent-decline');
  const consentCountdown = document.getElementById('consent-countdown');
  const recIndicator = document.getElementById('rec-indicator');
  const lobbyMsgBanner = document.getElementById('lobby-message-banner');
  const lobbyMsgText = document.getElementById('lobby-message-text');
  const chatPanel = document.getElementById('chat-panel');
  const chatLog = document.getElementById('chat-log');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  let consentTimer = null;
  let lobbyMsgTimer = null;

  function appendChat(from, text) {
    if (!chatLog) return;
    const li = document.createElement('li');
    li.className = 'chat-msg from-' + from;
    const label = document.createElement('span');
    label.className = 'chat-label';
    label.textContent = from === 'teacher' ? 'Teacher' : 'You';
    const body = document.createElement('span');
    body.className = 'chat-body';
    body.textContent = text;
    li.append(label, document.createTextNode(': '), body);
    chatLog.appendChild(li);
    chatLog.scrollTop = chatLog.scrollHeight;
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(form).get('email');
    joinSection.hidden = true;
    lobbyStatus.hidden = false;

    let sessionUiHandle = null;
    let handle = null;
    if (chatForm) {
      chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = chatInput ? chatInput.value.trim() : '';
        if (!text || !handle) return;
        handle.sendChat(text);
        if (chatInput) chatInput.value = '';
      });
    }

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
      onBlocked(_reason) {
        lobbyStatus.hidden = true;
        if (blockedNotice) blockedNotice.hidden = false;
      },
      onChat({ from, text }) {
        appendChat(from, text);
      },
      onLobbyMessage({ text }) {
        if (!lobbyMsgText || !lobbyMsgBanner) return;
        lobbyMsgText.textContent = text;
        lobbyMsgBanner.hidden = false;
        if (lobbyMsgTimer) clearTimeout(lobbyMsgTimer);
        lobbyMsgTimer = setTimeout(() => { lobbyMsgBanner.hidden = true; }, 8000);
      },
      onPeerConnected({ dataChannel, audioTrack, videoTrack, localStream }) {
        sessionSection.hidden = false;
        if (qualityBadge) qualityBadge.hidden = false;
        const sessionRoot = document.getElementById('session-root');
        sessionUiHandle = window.sbSessionUI.mount(sessionRoot, {
          role: 'student',
          remoteName: 'Teacher',
          remoteRoleLabel: 'Your teacher',
          localStream: localStream || null,
          remoteStream: null,
          headphonesConfirmed: false,
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
          onEnd() { if (handle) handle.hangup(); },
          onNote() { console.log('[sprint9] note panel'); },
          onSay() { if (chatPanel) chatPanel.hidden = false; },
        });
        dataChannel.addEventListener('message', (ev) => {
          errEl.textContent = `Teacher says: ${ev.data}`;
        });
        dataChannel.send(JSON.stringify({ hello: true, from: 'student' }));
      },
      onPeerDisconnected() {
        if (sessionUiHandle) { sessionUiHandle.teardown(); sessionUiHandle = null; }
        sessionSection.hidden = true;
        if (chatPanel) chatPanel.hidden = true;
        if (chatLog) chatLog.replaceChildren();
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
    window.addEventListener('beforeunload', () => { if (handle) handle.hangup(); });
  });
})();
