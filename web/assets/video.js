// File: web/assets/video.js
// Purpose: Local/remote video track helpers, paralleling audio.js.
//          Pure helpers (hasVideoTrack, orderCodecs, verifyVideoFeedback)
//          exported to Node via UMD; DOM + WebRTC wrappers browser-only
//          under window.sbVideo.
// Role: Only place video media-stream glue + codec preferencing
//       lives on the client.
// Exports: hasVideoTrack, orderCodecs, verifyVideoFeedback,
//          SDP_WITH_VIDEO, SDP_WITH_VIDEO_SAFARI, SDP_NO_VIDEO
//          (pure, Node);
//          startLocalVideo, attachRemoteVideo, detachRemoteVideo,
//          applyCodecPreferences (browser-only).
// Depends: audio.js (parallel hasTrack helper — semantics must match).
// Invariants: no SDP munging; codec preference is applied via
//             RTCRtpTransceiver.setCodecPreferences and degrades
//             silently on UAs that don't support it.
// Last updated: Sprint 4 (2026-04-17) -- +verifyVideoFeedback

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
      verifyVideoFeedback: mod.verifyVideoFeedback,
      SDP_WITH_VIDEO: mod.SDP_WITH_VIDEO,
      SDP_WITH_VIDEO_SAFARI: mod.SDP_WITH_VIDEO_SAFARI,
      SDP_NO_VIDEO: mod.SDP_NO_VIDEO,
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

  // Scan a full SDP blob for video-track RTCP feedback support.
  // Returns booleans for each known feedback mechanism — nack, nackPli,
  // transportCc — plus presence of RED/ULPFEC payload formats.
  // Works on an SDP that already contains a video m= section; returns
  // all-false on SDPs with no video section (audio-only).
  function verifyVideoFeedback(sdp) {
    var out = { nack: false, nackPli: false, transportCc: false, red: false, ulpfec: false };
    if (typeof sdp !== 'string' || sdp.length === 0) return out;

    // Find the video m= section span.
    var vIdx = sdp.indexOf('m=video');
    if (vIdx === -1) return out;
    // Section ends at the next m= line or end of SDP.
    var nextM = sdp.indexOf('m=', vIdx + 1);
    var vSection = nextM === -1 ? sdp.slice(vIdx) : sdp.slice(vIdx, nextM);

    // Each rtcp-fb line: a=rtcp-fb:<PT> <mechanism> [param...]
    var lines = vSection.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var fbMatch = /^a=rtcp-fb:\S+\s+(.+)$/.exec(ln);
      if (fbMatch) {
        var mech = fbMatch[1].trim();
        if (mech === 'nack') out.nack = true;
        else if (mech === 'nack pli') out.nackPli = true;
        else if (mech === 'transport-cc') out.transportCc = true;
      }
      // RED: a=rtpmap:<PT> red/...
      if (/^a=rtpmap:\d+\s+red\b/i.test(ln)) out.red = true;
      // ULPFEC: a=rtpmap:<PT> ulpfec/...
      if (/^a=rtpmap:\d+\s+ulpfec\b/i.test(ln)) out.ulpfec = true;
    }
    return out;
  }

  // --- SDP fixtures for §5.1 #34–#38 ---------------------------------------
  var CRLF = '\r\n';

  // Chrome-like: video m-section with VP8 + H264, nack, nack pli, transport-cc.
  var SDP_WITH_VIDEO = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=sendrecv',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 nack pli',
    'a=rtcp-fb:96 transport-cc',
    'a=rtpmap:97 H264/90000',
    'a=rtcp-fb:97 nack',
    'a=rtcp-fb:97 nack pli',
    'a=rtcp-fb:97 transport-cc',
    'a=rtpmap:98 red/90000',
    'a=rtpmap:99 ulpfec/90000',
    '',
  ].join(CRLF);

  // Safari 16-like: nack + nack pli only, no transport-cc, no RED/ULPFEC.
  var SDP_WITH_VIDEO_SAFARI = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=sendrecv',
    'a=rtpmap:96 H264/90000',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 nack pli',
    '',
  ].join(CRLF);

  // Audio-only SDP — verifyVideoFeedback should return all-false.
  var SDP_NO_VIDEO = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join(CRLF);

  return {
    hasVideoTrack: hasVideoTrack,
    orderCodecs: orderCodecs,
    verifyVideoFeedback: verifyVideoFeedback,
    SDP_WITH_VIDEO: SDP_WITH_VIDEO,
    SDP_WITH_VIDEO_SAFARI: SDP_WITH_VIDEO_SAFARI,
    SDP_NO_VIDEO: SDP_NO_VIDEO,
  };
});
