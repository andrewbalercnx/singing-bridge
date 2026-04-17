// File: web/assets/tests/sdp.test.js
// Purpose: Node-run property + failure-case suite for the SDP munger.
//          Runs under `node --test` in CI (ubuntu-latest ships
//          Node 18+, no install step required).
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mungeSdpForOpusMusic, OPUS_MUSIC_FMTP, SDP_FIXTURES } =
  require('../sdp.js');

// --- Property tests ---------------------------------------------------------

test('idempotent across all fixtures', () => {
  for (const [name, sdp] of Object.entries(SDP_FIXTURES)) {
    const once = mungeSdpForOpusMusic(sdp);
    const twice = mungeSdpForOpusMusic(once);
    assert.equal(twice, once, `fixture ${name} is not idempotent`);
  }
});

test('no-opus SDP returned byte-identical', () => {
  assert.equal(mungeSdpForOpusMusic(SDP_FIXTURES.no_opus), SDP_FIXTURES.no_opus);
});

test('fmtp count is upserted, not appended', () => {
  // chrome_121 has one existing opus fmtp; munge must keep exactly one.
  const before = (SDP_FIXTURES.chrome_121_offer.match(/^a=fmtp:111 /gm) || []).length;
  const after = (mungeSdpForOpusMusic(SDP_FIXTURES.chrome_121_offer)
    .match(/^a=fmtp:111 /gm) || []).length;
  assert.equal(before, 1);
  assert.equal(after, 1);
});

test('rtpmap appears before matching fmtp', () => {
  for (const [name, sdp] of Object.entries(SDP_FIXTURES)) {
    const out = mungeSdpForOpusMusic(sdp);
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/48000\/2/gim;
    let m;
    while ((m = rtpmap.exec(out)) !== null) {
      const pt = m[1];
      const rtpIdx = m.index;
      const fmtpIdx = out.indexOf(`a=fmtp:${pt} `);
      assert.ok(fmtpIdx > rtpIdx,
        `fixture ${name}: fmtp for PT ${pt} missing or precedes rtpmap`);
    }
  }
});

test('multiple Opus PTs both get canonical fmtp', () => {
  const out = mungeSdpForOpusMusic(SDP_FIXTURES.two_opus_pts);
  assert.match(out, new RegExp('^a=fmtp:111 ' + escapeRe(OPUS_MUSIC_FMTP) + '$', 'm'));
  assert.match(out, new RegExp('^a=fmtp:109 ' + escapeRe(OPUS_MUSIC_FMTP) + '$', 'm'));
});

test('already-munged input is fixed point', () => {
  const fp = SDP_FIXTURES.already_munged;
  assert.equal(mungeSdpForOpusMusic(fp), fp);
});

// --- Boundary tests ---------------------------------------------------------

test('empty fmtp parameter list is replaced with canonical', () => {
  const out = mungeSdpForOpusMusic(SDP_FIXTURES.empty_fmtp);
  const match = out.match(/^a=fmtp:111 (.+)$/m);
  assert.ok(match, 'no fmtp for PT 111 in output');
  assert.equal(match[1], OPUS_MUSIC_FMTP);
  // And exactly one fmtp line for 111.
  const count = (out.match(/^a=fmtp:111 /gm) || []).length;
  assert.equal(count, 1);
});

test('trailing rtpmap (final line, no EOL) gets a terminated fmtp line', () => {
  const out = mungeSdpForOpusMusic(SDP_FIXTURES.trailing_rtpmap);
  assert.match(out, /a=rtpmap:111 opus\/48000\/2\r?\n/);
  const m = out.match(/a=fmtp:111 (.+?)(\r?\n)?$/);
  assert.ok(m, 'no fmtp line at tail');
  assert.equal(m[1], OPUS_MUSIC_FMTP);
});

test('mixed line endings preserved per line, inserted line matches anchor', () => {
  const input = SDP_FIXTURES.mixed_line_endings;
  const out = mungeSdpForOpusMusic(input);
  // Input's original \r\n-terminated lines stay \r\n in output.
  assert.match(out, /^v=0\r\n/);
  assert.match(out, /^s=-\r\n/m);
  // Input's \n-only lines stay \n-only.
  assert.match(out, /^o=- 1 2 IN IP4 127\.0\.0\.1\n/m);
  assert.match(out, /^t=0 0\n/m);
  // The replaced fmtp line keeps its original terminator (input had
  // \r\n for a=fmtp:111).
  assert.match(out, new RegExp('^a=fmtp:111 ' + escapeRe(OPUS_MUSIC_FMTP) + '\r\n', 'm'));
});

// --- Failure-case fixtures --------------------------------------------------

test('safari fixture (PT 109 or 111, uppercase OPUS) is munged', () => {
  const out = mungeSdpForOpusMusic(SDP_FIXTURES.safari_17_offer);
  // Safari fixture uses PT 111 with uppercase OPUS; regex is case-
  // insensitive so munging applies.
  assert.match(out, new RegExp('^a=fmtp:111 ' + escapeRe(OPUS_MUSIC_FMTP) + '$', 'm'));
});

test('third-party Opus fmtp params are replaced (canonical set wins)', () => {
  // Construct a fixture with x-google-min-bitrate alongside opus.
  const input =
    'v=0\r\n' +
    'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
    'a=rtpmap:111 opus/48000/2\r\n' +
    'a=fmtp:111 minptime=10;useinbandfec=1;x-google-min-bitrate=96\r\n';
  const out = mungeSdpForOpusMusic(input);
  assert.ok(!out.includes('x-google-min-bitrate'),
    'third-party param was not replaced');
  assert.match(out, new RegExp('^a=fmtp:111 ' + escapeRe(OPUS_MUSIC_FMTP) + '\r\n', 'm'));
});

test('empty string input returns empty string', () => {
  assert.equal(mungeSdpForOpusMusic(''), '');
});

test('non-string input passes through', () => {
  assert.equal(mungeSdpForOpusMusic(null), null);
  assert.equal(mungeSdpForOpusMusic(undefined), undefined);
});

// --- Sprint 4 §5.1 #34: FEC survives the munger across every fixture ------

test('#34 useinbandfec=1 appears in the munged output for every Opus fixture', () => {
  for (const [name, sdp] of Object.entries(SDP_FIXTURES)) {
    if (typeof sdp !== 'string') continue;
    if (!/\bopus\/48000\/2\b/i.test(sdp)) continue; // non-opus fixtures skip
    const out = mungeSdpForOpusMusic(sdp);
    assert.ok(
      /useinbandfec=1/.test(out),
      `fixture ${name} lost useinbandfec=1 after munging`
    );
  }
});

// --- Sprint 4 §5.1 #35: video m-section byte-identical after munger -------

test('#35 video m-section passes through the munger unchanged', () => {
  const { SDP_WITH_VIDEO } = require('../video.js');
  const out = mungeSdpForOpusMusic(SDP_WITH_VIDEO);
  function videoSection(s) {
    const i = s.indexOf('m=video');
    if (i === -1) return '';
    const j = s.indexOf('m=', i + 1);
    return j === -1 ? s.slice(i) : s.slice(i, j);
  }
  assert.equal(videoSection(out), videoSection(SDP_WITH_VIDEO));
});

// --- Helper -----------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
