// File: web/assets/sdp.js
// Purpose: Pure SDP transform that upserts Opus music-mode fmtp
//          parameters into WebRTC offers/answers. Shared between
//          the browser (window.sbSdp) and Node tests (CommonJS
//          require) via a UMD factory.
// Role: The only place SDP munging logic lives. No DOM access.
// Exports: mungeSdpForOpusMusic, OPUS_MUSIC_FMTP, SDP_FIXTURES
// Depends: none
// Invariants: idempotent, upserts (never duplicates) the Opus fmtp
//             line, preserves per-line \r\n / \n endings, leaves
//             non-Opus media sections byte-identical.
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.sbSdp = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var OPUS_MUSIC_FMTP =
    'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;' +
    'useinbandfec=1;cbr=0;usedtx=0;maxplaybackrate=48000';

  // rtpmap matches `a=rtpmap:<PT> opus/48000/2` (case-insensitive on opus).
  var OPUS_RTPMAP_RE = /^a=rtpmap:(\d+)\s+opus\/48000\/2\b/i;
  // fmtp line for a given payload type: `a=fmtp:<PT> <params>`.
  var FMTP_RE = /^a=fmtp:(\d+)\s(.*)$/;

  // Split on newlines while retaining the trailing newline sequence
  // for each line. Returns an array of [content, terminator] pairs.
  // Terminator is '\r\n', '\n', or '' for a final line with no EOL.
  function splitLines(sdp) {
    var out = [];
    var i = 0;
    while (i < sdp.length) {
      var nl = sdp.indexOf('\n', i);
      if (nl === -1) {
        out.push([sdp.slice(i), '']);
        break;
      }
      var term = '\n';
      var end = nl;
      if (nl > i && sdp.charCodeAt(nl - 1) === 13) {
        term = '\r\n';
        end = nl - 1;
      }
      out.push([sdp.slice(i, end), term]);
      i = nl + 1;
    }
    return out;
  }

  function joinLines(pairs) {
    var parts = [];
    for (var i = 0; i < pairs.length; i++) {
      parts.push(pairs[i][0]);
      parts.push(pairs[i][1]);
    }
    return parts.join('');
  }

  // Tie-breaker for newly inserted lines when the anchor's
  // terminator is empty (i.e. rtpmap is the last line).
  function majorityTerminator(pairs) {
    var crlf = 0;
    var lf = 0;
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i][1] === '\r\n') crlf++;
      else if (pairs[i][1] === '\n') lf++;
    }
    if (lf > crlf) return '\n';
    return '\r\n';
  }

  function mungeSdpForOpusMusic(sdp) {
    if (typeof sdp !== 'string' || sdp.length === 0) return sdp;

    var lines = splitLines(sdp);

    // Phase 1: find every Opus PT via its rtpmap line.
    var opusPts = [];
    for (var i = 0; i < lines.length; i++) {
      var m = OPUS_RTPMAP_RE.exec(lines[i][0]);
      if (m) opusPts.push(m[1]);
    }
    if (opusPts.length === 0) return sdp;

    var majority = majorityTerminator(lines);
    var ptSet = {};
    for (var j = 0; j < opusPts.length; j++) ptSet[opusPts[j]] = true;

    // Phase 2: replace existing fmtp lines for Opus PTs.
    var handled = {};
    for (var k = 0; k < lines.length; k++) {
      var fm = FMTP_RE.exec(lines[k][0]);
      if (fm && ptSet[fm[1]]) {
        lines[k][0] = 'a=fmtp:' + fm[1] + ' ' + OPUS_MUSIC_FMTP;
        handled[fm[1]] = true;
      }
    }

    // Phase 3: insert fmtp for any Opus PT without an existing line.
    // Walk in reverse so insertion indices stay valid.
    for (var p = lines.length - 1; p >= 0; p--) {
      var rm = OPUS_RTPMAP_RE.exec(lines[p][0]);
      if (!rm) continue;
      var pt = rm[1];
      if (handled[pt]) continue;
      // Anchor's terminator: if empty (last line, no EOL), synthesise
      // one so the following fmtp line starts on its own line. Promote
      // the rtpmap to carry that terminator too.
      var term = lines[p][1] || majority;
      if (lines[p][1] === '') lines[p][1] = term;
      lines.splice(p + 1, 0, [
        'a=fmtp:' + pt + ' ' + OPUS_MUSIC_FMTP,
        term,
      ]);
      handled[pt] = true;
    }

    return joinLines(lines);
  }

  // Fixtures used by both the Node test suite and (via SDP_FIXTURES
  // access) the debug overlay. Real-browser captures are committed
  // during Sprint 2 manual verification and frozen here with dated
  // comments.
  // NOTE: the `chrome_121_offer` / `firefox_122_offer` / `safari_17_offer`
  // strings below are *representative placeholders* captured from
  // offline WebRTC samples; they will be overwritten with live
  // captures during the manual two-machine check before merge.
  var CRLF = '\r\n';

  var CHROME_121_OFFER = [
    'v=0',
    'o=- 123 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 103 104 9 0 8 106 105 13 110 112 113 126',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:abc1',
    'a=ice-pwd:pwd1',
    'a=fingerprint:sha-256 AA:BB',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    '',
  ].join(CRLF);

  var FIREFOX_122_OFFER = [
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-99.0 456 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 109 9 0 8 101',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=sendrecv',
    'a=mid:0',
    'a=rtpmap:109 opus/48000/2',
    'a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1',
    'a=rtpmap:9 G722/8000/1',
    '',
  ].join(CRLF);

  var SAFARI_17_OFFER = [
    'v=0',
    'o=- 789 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 103 9 0 8',
    'c=IN IP4 0.0.0.0',
    'a=sendrecv',
    'a=mid:0',
    'a=rtpmap:111 OPUS/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;cbr=1',
    '',
  ].join(CRLF);

  var NO_OPUS = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 0 8',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    '',
  ].join(CRLF);

  var TWO_OPUS_PTS = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 109',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 useinbandfec=0',
    'a=rtpmap:109 opus/48000/2',
    'a=fmtp:109 useinbandfec=0;stereo=0',
    '',
  ].join(CRLF);

  // fmtp line present but parameter list is empty (no space after PT).
  var EMPTY_FMTP = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 ',
    '',
  ].join(CRLF);

  // Opus rtpmap is the final line, no fmtp, no trailing EOL.
  var TRAILING_RTPMAP = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
  ].join(CRLF);

  // Alternating line endings: half CRLF, half LF.
  var MIXED_LINE_ENDINGS =
    'v=0\r\n' +
    'o=- 1 2 IN IP4 127.0.0.1\n' +
    's=-\r\n' +
    't=0 0\n' +
    'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
    'a=rtpmap:111 opus/48000/2\n' +
    'a=fmtp:111 useinbandfec=0\r\n';

  var SDP_FIXTURES = Object.freeze({
    chrome_121_offer: CHROME_121_OFFER,
    firefox_122_offer: FIREFOX_122_OFFER,
    safari_17_offer: SAFARI_17_OFFER,
    no_opus: NO_OPUS,
    already_munged: mungeSdpForOpusMusic(CHROME_121_OFFER),
    two_opus_pts: TWO_OPUS_PTS,
    empty_fmtp: EMPTY_FMTP,
    trailing_rtpmap: TRAILING_RTPMAP,
    mixed_line_endings: MIXED_LINE_ENDINGS,
  });

  return {
    mungeSdpForOpusMusic: mungeSdpForOpusMusic,
    OPUS_MUSIC_FMTP: OPUS_MUSIC_FMTP,
    SDP_FIXTURES: SDP_FIXTURES,
  };
});
