// File: web/assets/signalling.js
// Purpose: Browser-side WebSocket + RTCPeerConnection glue. Two entry
//          points — connectTeacher and connectStudent — sharing the
//          framing logic. Sprint 4: delegates adapt loop + quality
//          monitor + reconnect watcher to session-core.js; sets
//          priority hints at transceiver creation; handles student-
//          side ICE-restart re-offer on call_restart_ice effect.
// Role: Only place that speaks the signalling wire protocol on the
//       client side.
// Exports: window.signallingClient.{connectTeacher, connectStudent}
//          (browser);
//          dispatchRemoteTrack, acquireMedia, teardownMedia (UMD
//          pure helpers, Node-testable).
// Depends: window.sbSdp, window.sbAudio, window.sbVideo,
//          window.sbBrowser, window.sbDebug, window.sbSessionCore
//          (adapt loop + applyActions), window.sbReconnect (fixtures).
// Invariants: every setLocalDescription is preceded by
//             mungeSdpForOpusMusic; every teardown path stops the
//             debug overlay, session subsystems, and releases local
//             audio + video tracks; applyActions — never this module —
//             is the sole sender.setParameters mutation site AFTER
//             session subsystems start; priority hints at transceiver
//             creation are the only pre-session setParameters calls.
// Last updated: Sprint 6 (2026-04-18) -- recording message handlers (RecordStart/Consent/Stop)

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.signallingClient = {
      connectTeacher: connectTeacher,
      connectStudent: connectStudent,
      // Expose pure helpers on the namespace too for debugging.
      dispatchRemoteTrack: mod.dispatchRemoteTrack,
      acquireMedia: mod.acquireMedia,
      teardownMedia: mod.teardownMedia,
      makeTeardown: mod.makeTeardown,
    };
  }

  // --- Browser-only implementation (defined here so Node never
  //     evaluates DOM/WebSocket references) -----------------------------

  var WS_PATH = '/ws';

  function openWs() {
    var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return new WebSocket(scheme + '://' + location.host + WS_PATH);
  }

  function Signalling(sock) {
    this.sock = sock;
    this.handlers = new Map();
    this.queue = [];
    var self = this;
    sock.addEventListener('open', function () {
      for (var i = 0; i < self.queue.length; i++) sock.send(JSON.stringify(self.queue[i]));
      self.queue = [];
    });
    sock.addEventListener('message', function (e) { self._onMessage(e); });
  }
  Signalling.prototype._onMessage = function (e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    var list = this.handlers.get(msg.type) || [];
    for (var i = 0; i < list.length; i++) list[i](msg);
  };
  Signalling.prototype.on = function (type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  };
  Signalling.prototype.send = function (msg) {
    if (this.sock.readyState === 1) this.sock.send(JSON.stringify(msg));
    else this.queue.push(msg);
  };
  Signalling.prototype.close = function () { try { this.sock.close(); } catch (_) {} };

  async function makePeerConnection(preloadedIceServers) {
    var iceServers;
    if (preloadedIceServers) {
      // Use credentials delivered via WS (ServerMsg::Admitted for students,
      // or explicitly pre-populated for teachers).
      iceServers = preloadedIceServers;
    } else {
      try {
        // Teacher fetches via /turn-credentials (session-cookie auth).
        iceServers = await window.sbIce.fetchIceServers();
      } catch (_) {
        // Fall back to Google STUN if the credential fetch fails.
        iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      }
    }
    return new RTCPeerConnection({ iceServers: iceServers });
  }

  async function setMungedLocalDescription(pc, desc) {
    desc.sdp = window.sbSdp.mungeSdpForOpusMusic(desc.sdp);
    await pc.setLocalDescription(desc);
  }

  function detectTier() {
    return window.sbBrowser.detectBrowser(navigator.userAgent, {
      hasRTCPeerConnection: typeof RTCPeerConnection !== 'undefined',
      hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    });
  }

  async function wireBidirectionalMedia(pc, detect) {
    var acq = await mod.acquireMedia(window.sbAudio, window.sbVideo);
    var audio = acq.audio;
    var video = acq.video;

    var audioTransceiver = pc.addTransceiver(audio.track, {
      streams: [audio.stream], direction: 'sendrecv',
    });
    var videoTransceiver = pc.addTransceiver(video.track, {
      streams: [video.stream], direction: 'sendrecv',
    });
    // Mobile UAs benefit from hardware H.264; desktop prefers VP8.
    // `detect` is the full browser-detection result from sbBrowser.
    var preferH264 = detect && detect.device !== 'desktop';
    window.sbVideo.applyCodecPreferences(
      videoTransceiver, preferH264 ? 'h264' : 'vp8'
    );

    // Sprint 4: priority hints at creation time. Audio = high priority so
    // browser BWE protects it; video = low priority. minBitrate is NOT set
    // here — per §4.1.4 it is only written at the studentAudio floor rung.
    try {
      var aParams = audioTransceiver.sender.getParameters();
      if (!aParams.encodings || aParams.encodings.length === 0) {
        aParams.encodings = [{}];
      }
      aParams.encodings[0].priority = 'high';
      aParams.encodings[0].networkPriority = 'high';
      await audioTransceiver.sender.setParameters(aParams);
    } catch (_) { /* older UAs: fall through to browser BWE */ }
    try {
      var vParams = videoTransceiver.sender.getParameters();
      if (!vParams.encodings || vParams.encodings.length === 0) {
        vParams.encodings = [{}];
      }
      vParams.encodings[0].priority = 'low';
      vParams.encodings[0].networkPriority = 'low';
      await videoTransceiver.sender.setParameters(vParams);
    } catch (_) { /* older UAs */ }

    pc.ontrack = function (ev) {
      mod.dispatchRemoteTrack(ev, {
        onAudio: window.sbAudio.attachRemoteAudio,
        onVideo: window.sbVideo.attachRemoteVideo,
      });
    };

    return {
      audio: audio,
      video: video,
      audioTransceiver: audioTransceiver,
      videoTransceiver: videoTransceiver,
      audioSender: audioTransceiver.sender,
      videoSender: videoTransceiver.sender,
      teardown: function () {
        mod.teardownMedia({ audio: audio, video: video }, window.sbAudio, window.sbVideo);
      },
    };
  }

  // makeTeardown is defined in the pure factory (mod.makeTeardown) so it
  // can be exercised by Node tests against the REAL function. The browser
  // wrapper just uses it directly.
  var makeTeardown = mod.makeTeardown;

  // Starts adapt/quality/reconnect via session-core.js and wires the
  // student-side ICE-restart re-offer into the existing signalling flow.
  function startSession(refs, role, sig, peerName, callbacks) {
    var sessionCallbacks = {
      onQuality: callbacks.onQuality,
      onFloorViolation: callbacks.onFloorViolation,
      metricsSink: function (metrics) {
        sig.send({ type: 'session_metrics', loss_bp: metrics.loss_bp, rtt_ms: metrics.rtt_ms });
      },
      onReconnectEffect: function (effect) {
        if (effect === 'schedule_watch') {
          if (callbacks.onReconnectBanner) callbacks.onReconnectBanner(true);
        } else if (effect === 'cancel_timer') {
          if (callbacks.onReconnectBanner) callbacks.onReconnectBanner(false);
        } else if (effect === 'call_restart_ice') {
          if (callbacks.onReconnectBanner) callbacks.onReconnectBanner(true);
          if (role === 'student' && refs.pc && typeof refs.pc.restartIce === 'function') {
            try { refs.pc.restartIce(); } catch (_) {}
            // Explicit re-offer — doesn't rely on negotiationneeded.
            (async function () {
              try {
                var offer = await refs.pc.createOffer({ iceRestart: true });
                await setMungedLocalDescription(refs.pc, offer);
                sig.send({ type: 'signal', to: peerName, payload: { sdp: refs.pc.localDescription } });
              } catch (_) { /* teardown path will pick up failures */ }
            })();
          }
        } else if (effect === 'give_up') {
          if (callbacks.onReconnectBanner) callbacks.onReconnectBanner(false);
          if (callbacks.onGiveUp) callbacks.onGiveUp();
        }
      },
    };
    refs.session = window.sbSessionCore.startSessionSubsystems(
      refs.pc,
      { audio: refs.media.audioSender, video: refs.media.videoSender },
      role,
      sessionCallbacks
    );
  }

  async function connectTeacher(args) {
    var slug = args.slug;
    var onLobbyUpdate = args.onLobbyUpdate;
    var onPeerConnected = args.onPeerConnected;
    var onPeerDisconnected = args.onPeerDisconnected;
    var onQuality = args.onQuality;
    var onFloorViolation = args.onFloorViolation;
    var onReconnectBanner = args.onReconnectBanner;
    var onRecordConsentResult = args.onRecordConsentResult;
    var onRecordingStopped = args.onRecordingStopped;

    var sig = new Signalling(openWs());
    sig.send({ type: 'lobby_watch', slug: slug });
    sig.on('lobby_state', function (m) {
      if (onLobbyUpdate) onLobbyUpdate(m.entries);
    });

    var refs = { pc: null, media: null, overlay: null, dataChannel: null, session: null };
    var teardownSession = makeTeardown(refs);
    var detect = detectTier();

    sig.on('peer_connected', async function () {
      refs.pc = await makePeerConnection();
      refs.media = await wireBidirectionalMedia(refs.pc, detect);
      refs.overlay = window.sbDebug.startDebugOverlay(refs.pc, { localTrack: refs.media.audio.track });
      refs.pc.onicecandidate = function (ev) {
        if (ev.candidate) sig.send({ type: 'signal', to: 'student', payload: { candidate: ev.candidate } });
      };
      refs.pc.ondatachannel = function (ev) {
        refs.dataChannel = ev.channel;
        refs.dataChannel.onopen = function () {
          startSession(refs, 'teacher', sig, 'student', {
            onQuality: onQuality,
            onFloorViolation: onFloorViolation,
            onReconnectBanner: onReconnectBanner,
            onGiveUp: function () {
              teardownSession();
              if (onPeerDisconnected) onPeerDisconnected();
            },
          });
          if (onPeerConnected) onPeerConnected({
            dataChannel: refs.dataChannel,
            audioTrack: refs.media.audio.track,
            videoTrack: refs.media.video.track,
          });
        };
      };
    });
    sig.on('signal', async function (m) {
      if (!refs.pc) return;
      var p = m.payload;
      if (p.sdp) {
        await refs.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        if (p.sdp.type === 'offer') {
          var answer = await refs.pc.createAnswer();
          await setMungedLocalDescription(refs.pc, answer);
          sig.send({ type: 'signal', to: 'student', payload: { sdp: refs.pc.localDescription } });
        }
      } else if (p.candidate) {
        try { await refs.pc.addIceCandidate(p.candidate); } catch (_) {}
      }
    });
    sig.on('peer_disconnected', function () {
      teardownSession();
      if (onPeerDisconnected) onPeerDisconnected();
    });
    sig.on('record_consent_result', function (m) {
      if (onRecordConsentResult) onRecordConsentResult(m.granted);
    });
    sig.on('recording_active', function () {
      // Teacher side: recording_active confirms student consented (also triggers onRecordConsentResult).
    });
    sig.on('recording_stopped', function () {
      if (onRecordingStopped) onRecordingStopped();
    });

    return {
      admit: function (entryId) { sig.send({ type: 'lobby_admit', slug: slug, entry_id: entryId }); },
      reject: function (entryId) { sig.send({ type: 'lobby_reject', slug: slug, entry_id: entryId }); },
      rejectAndBlock: function (entryId, ttlSecs) {
        sig.send({ type: 'lobby_reject', slug: slug, entry_id: entryId, block_ttl_secs: ttlSecs || 600 });
      },
      startRecording: function (s) { sig.send({ type: 'record_start', slug: s }); },
      stopRecording: function (s) { sig.send({ type: 'record_stop', slug: s }); },
      hangup: function () { teardownSession(); sig.close(); },
    };
  }

  async function connectStudent(args) {
    var slug = args.slug;
    var email = args.email;
    var onAdmitted = args.onAdmitted;
    var onRejected = args.onRejected;
    var onBlocked = args.onBlocked;
    var onPeerDisconnected = args.onPeerDisconnected;
    var onPeerConnected = args.onPeerConnected;
    var onQuality = args.onQuality;
    var onFloorViolation = args.onFloorViolation;
    var onReconnectBanner = args.onReconnectBanner;
    var onRecordConsentRequest = args.onRecordConsentRequest;
    var onRecordingActive = args.onRecordingActive;
    var onRecordingStopped = args.onRecordingStopped;

    var detect = detectTier();
    var sig = new Signalling(openWs());
    sig.send({
      type: 'lobby_join',
      slug: slug,
      email: email,
      browser: detect.name + (detect.version != null ? '/' + detect.version : ''),
      device_class: detect.device,
      tier: detect.tier,
      tier_reason: detect.reasons[0] || null,
    });

    var refs = { pc: null, media: null, overlay: null, dataChannel: null, session: null };
    var teardownSession = makeTeardown(refs);
    var admittedIceServers = null;

    sig.on('admitted', function (m) {
      // Store TURN credentials delivered in the WS handshake so that
      // makePeerConnection can use them without an unauthenticated HTTP fetch.
      if (m.ice_servers) admittedIceServers = m.ice_servers;
      if (onAdmitted) onAdmitted();
    });
    sig.on('rejected', function (m) {
      if (onRejected) onRejected(m.reason);
      sig.close();
    });
    sig.on('error', function (m) {
      if (m.code === 'blocked' && onBlocked) onBlocked(m.message);
    });
    sig.on('peer_connected', async function () {
      refs.pc = await makePeerConnection(admittedIceServers);
      refs.media = await wireBidirectionalMedia(refs.pc, detect);
      refs.overlay = window.sbDebug.startDebugOverlay(refs.pc, { localTrack: refs.media.audio.track });
      refs.pc.onicecandidate = function (ev) {
        if (ev.candidate) sig.send({ type: 'signal', to: 'teacher', payload: { candidate: ev.candidate } });
      };
      refs.dataChannel = refs.pc.createDataChannel('hello');
      refs.dataChannel.onopen = function () {
        startSession(refs, 'student', sig, 'teacher', {
          onQuality: onQuality,
          onFloorViolation: onFloorViolation,
          onReconnectBanner: onReconnectBanner,
          onGiveUp: function () {
            teardownSession();
            if (onPeerDisconnected) onPeerDisconnected();
          },
        });
        if (onPeerConnected) onPeerConnected({
          dataChannel: refs.dataChannel,
          audioTrack: refs.media.audio.track,
          videoTrack: refs.media.video.track,
        });
      };
      var offer = await refs.pc.createOffer();
      await setMungedLocalDescription(refs.pc, offer);
      sig.send({ type: 'signal', to: 'teacher', payload: { sdp: refs.pc.localDescription } });
    });
    sig.on('signal', async function (m) {
      if (!refs.pc) return;
      var p = m.payload;
      if (p.sdp) {
        await refs.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      } else if (p.candidate) {
        try { await refs.pc.addIceCandidate(p.candidate); } catch (_) {}
      }
    });
    sig.on('peer_disconnected', function () {
      teardownSession();
      if (onPeerDisconnected) onPeerDisconnected();
    });
    sig.on('record_consent_request', function () {
      if (onRecordConsentRequest) onRecordConsentRequest();
    });
    sig.on('recording_active', function () {
      if (onRecordingActive) onRecordingActive();
    });
    sig.on('recording_stopped', function () {
      if (onRecordingStopped) onRecordingStopped();
    });

    return {
      hangup: function () { teardownSession(); sig.close(); },
      sendRecordConsent: function (s, granted) {
        sig.send({ type: 'record_consent', slug: s, granted: granted });
      },
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- Pure helpers (Node-testable) --------------------------------------

  // Routes a remote-track event to the audio or video handler. Silent
  // on unknown kinds or missing handlers — never throws.
  function dispatchRemoteTrack(ev, handlers) {
    if (!ev || !ev.track || !handlers) return;
    if (ev.track.kind === 'audio' && typeof handlers.onAudio === 'function') {
      handlers.onAudio(ev);
    } else if (ev.track.kind === 'video' && typeof handlers.onVideo === 'function') {
      handlers.onVideo(ev);
    }
  }

  // Acquire audio, then video. If video throws, stop every audio
  // track before re-throwing so no orphan mic stays open.
  async function acquireMedia(audioImpl, videoImpl) {
    var audio = await audioImpl.startLocalAudio();
    try {
      var video = await videoImpl.startLocalVideo();
      return { audio: audio, video: video };
    } catch (err) {
      try { audio.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
      throw err;
    }
  }

  // Release both detach handlers and stop every local track on
  // audio and video streams.
  function teardownMedia(media, audioImpl, videoImpl) {
    if (!media) return;
    try { audioImpl.detachRemoteAudio(); } catch (_) {}
    try { videoImpl.detachRemoteVideo(); } catch (_) {}
    if (media.audio && media.audio.stream) {
      try { media.audio.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    }
    if (media.video && media.video.stream) {
      try { media.video.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    }
  }

  // Pure: makeTeardown closes over the caller-supplied refs bag. Every
  // method it calls is a plain invocation on whatever object is stored on
  // the ref; it doesn't touch window, document, or RTCPeerConnection. The
  // contract is strict: calls session.stopAll() first, nulls the ref, then
  // overlay → media → pc; the dataChannel ref is cleared last. Idempotent —
  // a second invocation is a no-op because every ref is now null.
  function makeTeardown(refs) {
    return function () {
      if (refs.session) { try { refs.session.stopAll(); } catch (_) {} refs.session = null; }
      if (refs.overlay) { try { refs.overlay.stop(); } catch (_) {} refs.overlay = null; }
      if (refs.media) { try { refs.media.teardown(); } catch (_) {} refs.media = null; }
      if (refs.pc) { try { refs.pc.close(); } catch (_) {} refs.pc = null; }
      refs.dataChannel = null;
    };
  }

  return {
    dispatchRemoteTrack: dispatchRemoteTrack,
    acquireMedia: acquireMedia,
    teardownMedia: teardownMedia,
    makeTeardown: makeTeardown,
  };
});
