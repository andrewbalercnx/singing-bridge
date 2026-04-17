// File: web/assets/tests/video.test.js
// Purpose: Node tests for the pure video helpers (hasVideoTrack,
//          orderCodecs). Browser wrappers are DOM-only and covered
//          by the manual two-machine check.
// Last updated: Sprint 4 (2026-04-17) -- +verifyVideoFeedback tests

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasVideoTrack, orderCodecs, verifyVideoFeedback,
  SDP_WITH_VIDEO, SDP_WITH_VIDEO_SAFARI, SDP_NO_VIDEO,
} = require('../video.js');

// --- hasVideoTrack (6 tests) ------------------------------------------------

test('hasVideoTrack: returns true when matching track id is present', () => {
  const stream = { getVideoTracks: () => [{ id: 'v1' }, { id: 'v2' }] };
  assert.equal(hasVideoTrack(stream, 'v1'), true);
  assert.equal(hasVideoTrack(stream, 'v2'), true);
});

test('hasVideoTrack: returns false when id is absent', () => {
  const stream = { getVideoTracks: () => [{ id: 'v1' }] };
  assert.equal(hasVideoTrack(stream, 'v99'), false);
});

test('hasVideoTrack: returns false for empty stream', () => {
  const stream = { getVideoTracks: () => [] };
  assert.equal(hasVideoTrack(stream, 'v1'), false);
});

test('hasVideoTrack: returns false for null / invalid stream', () => {
  assert.equal(hasVideoTrack(null, 'v1'), false);
  assert.equal(hasVideoTrack(undefined, 'v1'), false);
  assert.equal(hasVideoTrack({}, 'v1'), false);
  assert.equal(hasVideoTrack({ getVideoTracks: 'not-fn' }, 'v1'), false);
});

test('hasVideoTrack: returns false for invalid id', () => {
  const stream = { getVideoTracks: () => [{ id: 'v1' }] };
  assert.equal(hasVideoTrack(stream, ''), false);
  assert.equal(hasVideoTrack(stream, null), false);
  assert.equal(hasVideoTrack(stream, 42), false);
});

test('hasVideoTrack: tolerates null entries inside the tracks array', () => {
  const stream = { getVideoTracks: () => [null, { id: 'v1' }, undefined] };
  assert.equal(hasVideoTrack(stream, 'v1'), true);
  assert.equal(hasVideoTrack(stream, 'v99'), false);
});

// --- orderCodecs (6 tests) --------------------------------------------------

test('orderCodecs: prefer h264 puts H264 codecs first; rest keep relative order', () => {
  const input = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/H264' },
    { mimeType: 'video/VP9' },
    { mimeType: 'video/H264' },
  ];
  const out = orderCodecs(input, 'h264');
  assert.deepEqual(out.map((c) => c.mimeType), ['video/H264', 'video/H264', 'video/VP8', 'video/VP9']);
});

test('orderCodecs: prefer vp8 puts VP8 codecs first', () => {
  const input = [
    { mimeType: 'video/H264' },
    { mimeType: 'video/VP8' },
    { mimeType: 'video/VP9' },
  ];
  const out = orderCodecs(input, 'vp8');
  assert.deepEqual(out.map((c) => c.mimeType), ['video/VP8', 'video/H264', 'video/VP9']);
});

test('orderCodecs: empty codec list returns empty', () => {
  assert.deepEqual(orderCodecs([], 'h264'), []);
  assert.deepEqual(orderCodecs([], 'vp8'), []);
});

test('orderCodecs: unknown prefer value returns shallow copy of input', () => {
  const input = [{ mimeType: 'video/H264' }, { mimeType: 'video/VP8' }];
  const out = orderCodecs(input, 'av1');
  assert.deepEqual(out, input);
  assert.notEqual(out, input, 'must be a copy, not the same reference');
});

test('orderCodecs: stable ordering — two VP8 codecs retain input order under H264 preference', () => {
  const input = [
    { mimeType: 'video/VP8', clockRate: 90000, channels: 1 },
    { mimeType: 'video/VP8', clockRate: 90000, channels: 2 },
    { mimeType: 'video/H264' },
  ];
  const out = orderCodecs(input, 'h264');
  assert.equal(out[0].mimeType, 'video/H264');
  assert.equal(out[1].channels, 1);
  assert.equal(out[2].channels, 2);
});

test('orderCodecs: null/undefined entries are preserved into the non-preferred partition', () => {
  const input = [
    null,
    { mimeType: 'video/H264' },
    undefined,
    { mimeType: 'video/VP8' },
  ];
  const out = orderCodecs(input, 'h264');
  assert.deepEqual(out, [
    { mimeType: 'video/H264' },
    null,
    undefined,
    { mimeType: 'video/VP8' },
  ]);
});

test('orderCodecs: non-array input returns empty array', () => {
  assert.deepEqual(orderCodecs(null, 'h264'), []);
  assert.deepEqual(orderCodecs(undefined, 'vp8'), []);
  assert.deepEqual(orderCodecs('not-an-array', 'h264'), []);
});

// --- Sprint 4 §5.1 #36-#38: verifyVideoFeedback ---------------------------

test('#36 verifyVideoFeedback Chrome-like SDP: nack + pli + transport-cc all true', () => {
  const r = verifyVideoFeedback(SDP_WITH_VIDEO);
  assert.equal(r.nack, true);
  assert.equal(r.nackPli, true);
  assert.equal(r.transportCc, true);
  assert.equal(r.red, true);
  assert.equal(r.ulpfec, true);
});

test('#37 verifyVideoFeedback audio-only SDP: all false, no throw', () => {
  const r = verifyVideoFeedback(SDP_NO_VIDEO);
  assert.deepEqual(r, { nack: false, nackPli: false, transportCc: false, red: false, ulpfec: false });
});

test('#38 verifyVideoFeedback Safari 16-like SDP: nack + pli, no transport-cc, no RED/ULPFEC', () => {
  const r = verifyVideoFeedback(SDP_WITH_VIDEO_SAFARI);
  assert.equal(r.nack, true);
  assert.equal(r.nackPli, true);
  assert.equal(r.transportCc, false);
  assert.equal(r.red, false);
  assert.equal(r.ulpfec, false);
});

test('verifyVideoFeedback handles null / empty input safely', () => {
  assert.deepEqual(verifyVideoFeedback(null),
    { nack: false, nackPli: false, transportCc: false, red: false, ulpfec: false });
  assert.deepEqual(verifyVideoFeedback(''),
    { nack: false, nackPli: false, transportCc: false, red: false, ulpfec: false });
});
