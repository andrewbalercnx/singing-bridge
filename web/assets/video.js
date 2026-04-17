// File: web/assets/video.js
// Purpose: Local/remote video track helpers, paralleling audio.js.
//          Pure helpers (hasVideoTrack, orderCodecs) exported to
//          Node via UMD; DOM + WebRTC wrappers browser-only under
//          window.sbVideo.
// Role: Only place video media-stream glue + codec preferencing
//       lives on the client.
// Exports: hasVideoTrack, orderCodecs (pure, Node);
//          startLocalVideo, attachRemoteVideo, detachRemoteVideo,
//          applyCodecPreferences (browser-only).
// Depends: audio.js (parallel hasTrack helper — semantics must match).
// Invariants: no SDP munging; codec preference is applied via
//             RTCRtpTransceiver.setCodecPreferences and degrades
//             silently on UAs that don't support it.
// Last updated: Sprint 3 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    // Browser-only wrappers attached to window.sbVideo. Pure helpers
    // are also exposed on window.sbVideo for convenience.
    window.sbVideo = {
      hasVideoTrack: mod.hasVideoTrack,
      orderCodecs: mod.orderCodecs,
      startLocalVideo: startLocalVideo,
      attachRemoteVideo: attachRemoteVideo,
      detachRemoteVideo: detachRemoteVideo,
      applyCodecPreferences: function (transceiver, prefer) {
        return applyCodecPreferences(transceiver, prefer, mod.orderCodecs);
      },
    };
  }

  // Browser-only wrappers — referenced above but defined here so the
  // Node path (no window) never evaluates them.
  async function startLocalVideo() {
    var stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: 'user',
      },
      audio: false,
    });
    var track = stream.getVideoTracks()[0];
    return { stream: stream, track: track, settings: track.getSettings() };
  }

  function attachRemoteVideo(ev) {
    var el = document.getElementById('remote-video');
    if (!el) return;
    if (!el.srcObject) el.srcObject = new MediaStream();
    if (mod.hasVideoTrack(el.srcObject, ev.track.id)) return; // idempotent
    el.srcObject.addTrack(ev.track);
    try { ev.receiver.playoutDelayHint = 0; } catch (_) {}
  }

  function detachRemoteVideo() {
    var el = document.getElementById('remote-video');
    if (el && el.srcObject) {
      var tracks = el.srcObject.getTracks();
      for (var i = 0; i < tracks.length; i++) el.srcObject.removeTrack(tracks[i]);
      el.srcObject = null;
    }
  }

  function applyCodecPreferences(transceiver, prefer, orderFn) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    if (typeof RTCRtpSender === 'undefined' ||
        typeof RTCRtpSender.getCapabilities !== 'function') return;
    var caps = RTCRtpSender.getCapabilities('video');
    if (!caps) return;
    var ordered = orderFn(caps.codecs, prefer);
    try { transceiver.setCodecPreferences(ordered); } catch (_) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Guard semantics intentionally mirror audio.js::hasTrack exactly
  // (Sprint 3 R1 Low #17: parallel helpers must agree).
  function hasVideoTrack(stream, id) {
    if (!stream || typeof stream.getVideoTracks !== 'function') return false;
    if (!id || typeof id !== 'string') return false;
    return stream.getVideoTracks().some(function (t) { return t && t.id === id; });
  }

  // Stable partition: preferred codec family first, all others keep
  // their input order. `prefer` ∈ {'h264', 'vp8'}. Unknown prefer
  // returns a shallow copy of the input.
  function orderCodecs(codecs, prefer) {
    if (!Array.isArray(codecs)) return [];
    if (prefer !== 'h264' && prefer !== 'vp8') return codecs.slice();
    var rx = prefer === 'h264' ? /h264/i : /vp8/i;
    function isPref(c) {
      return c && typeof c.mimeType === 'string' && rx.test(c.mimeType);
    }
    var preferred = [];
    var rest = [];
    for (var i = 0; i < codecs.length; i++) {
      var c = codecs[i];
      if (isPref(c)) preferred.push(c);
      else rest.push(c);
    }
    return preferred.concat(rest);
  }

  return {
    hasVideoTrack: hasVideoTrack,
    orderCodecs: orderCodecs,
  };
});
