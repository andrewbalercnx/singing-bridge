// File: web/assets/tests/quality.test.js
// Purpose: Node tests for the pure helpers in quality.js — summariseStats,
//          qualityTierFromSummary — and the shared STATS_FIXTURES set.
//          Covers §5.1 #19–#24 + §5.2 quality failure paths.
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summariseStats,
  qualityTierFromSummary,
  STATS_FIXTURES,
} = require('../quality.js');

// --- §5.1 #19 summariseStats deltas ---------------------------------------

test('#19 summariseStats computes outBitrate and inBitrate as (Δbytes * 8 / 2)', () => {
  const samples = summariseStats(STATS_FIXTURES.healthy_t1, STATS_FIXTURES.healthy_t0);
  const out = samples.find((s) => s.dir === 'outbound' && s.kind === 'audio');
  const inb = samples.find((s) => s.dir === 'inbound' && s.kind === 'audio');
  // outbound: bytesSent delta = 282000 - 250000 = 32000 → 128 kbps
  assert.equal(out.outBitrate, 128000);
  // inbound: bytesReceived delta = 270000 - 240000 = 30000 → 120 kbps
  assert.equal(inb.inBitrate, 120000);
});

// --- §5.1 #20 First tick (prevStats = null) -------------------------------

test('#20 summariseStats(stats, null) returns samples with bitrate fields = 0', () => {
  const samples = summariseStats(STATS_FIXTURES.healthy_t0, null);
  for (const s of samples) {
    if (s.dir === 'outbound') assert.equal(s.outBitrate, 0);
    if (s.dir === 'inbound') assert.equal(s.inBitrate, 0);
  }
});

// --- §5.1 #21 Multi-SSRC tiebreak (HIGHER packetsSent wins) ---------------

test('#21 multi-SSRC tiebreak: higher packetsSent wins, outBitrate reflects that SSRC', () => {
  const samples = summariseStats(
    STATS_FIXTURES.stats_multi_ssrc_audio_t1,
    STATS_FIXTURES.stats_multi_ssrc_audio_t0
  );
  const outs = samples.filter((s) => s.kind === 'audio' && s.dir === 'outbound');
  assert.equal(outs.length, 1, 'exactly one outbound audio sample');
  // SSRC B: delta 150_000 - 50_000 = 100_000 bytes → 400 kbps
  // SSRC A: delta 110_000 - 100_000 =  10_000 bytes →  40 kbps
  assert.equal(outs[0].outBitrate, 400000);
});

// --- §5.1 #22 qualityTierFromSummary thresholds ---------------------------

test('#22 qualityTierFromSummary: loss thresholds', () => {
  const mk = (loss) => [
    { kind: 'audio', dir: 'outbound', lossFraction: loss, rttMs: 50, outBitrate: 128000 },
  ];
  assert.equal(qualityTierFromSummary(mk(0.01)).tier, 'good');
  assert.equal(qualityTierFromSummary(mk(0.03)).tier, 'fair');
  assert.equal(qualityTierFromSummary(mk(0.06)).tier, 'poor');
});

// --- §5.1 #22a Boundary equality points ------------------------------------

test('#22a qualityTierFromSummary: boundary equality points use strict > semantics', () => {
  const mk = (loss, rtt) => [
    { kind: 'audio', dir: 'outbound', lossFraction: loss, rttMs: rtt, outBitrate: 0 },
  ];
  // loss == 0.02 → good (rule is strictly greater)
  assert.equal(qualityTierFromSummary(mk(0.02, 50)).tier, 'good');
  assert.equal(qualityTierFromSummary(mk(0.0200001, 50)).tier, 'fair');
  assert.equal(qualityTierFromSummary(mk(0.05, 50)).tier, 'fair');
  assert.equal(qualityTierFromSummary(mk(0.0500001, 50)).tier, 'poor');
  // rtt boundaries
  assert.equal(qualityTierFromSummary(mk(0, 200)).tier, 'good');
  assert.equal(qualityTierFromSummary(mk(0, 200.001)).tier, 'fair');
  assert.equal(qualityTierFromSummary(mk(0, 400)).tier, 'fair');
  assert.equal(qualityTierFromSummary(mk(0, 400.001)).tier, 'poor');
});

// --- §5.1 #23 Empty sample array ------------------------------------------

test('#23 qualityTierFromSummary([]) returns safe defaults', () => {
  const r = qualityTierFromSummary([]);
  assert.deepEqual(r, { tier: 'good', loss: 0, rttMs: 0, outBitrate: 0 });
});

// --- §5.1 #24 renderQualityBadge is textContent-only (regression guard) ---

test('#24 renderQualityBadge writes textContent and className only (no innerHTML injection)', () => {
  // Load the browser-side wrapper with a minimal window+document stand-in.
  global.window = {};
  global.document = {};
  // Re-require the module to exercise the browser branch.
  delete require.cache[require.resolve('../quality.js')];
  require('../quality.js');
  const renderBadge = global.window.sbQuality.renderQualityBadge;
  const el = {
    textContent: '',
    className: '',
    title: '',
    innerHTML: '<!-- initial marker -->',
  };
  renderBadge(el, { tier: 'fair', loss: 0.03, rttMs: 150, outBitrate: 800000 });
  assert.equal(el.textContent, 'fair');
  assert.ok(el.className.includes('quality-badge'));
  assert.ok(el.className.includes('fair'));
  // textContent path never rewrites innerHTML with angle-bracket content
  assert.equal(el.innerHTML, '<!-- initial marker -->');
  delete global.window;
  delete global.document;
});

// --- §5.2 Failure paths ---------------------------------------------------

test('§5.2 summariseStats(empty, null) returns [] (no partial samples)', () => {
  const samples = summariseStats(STATS_FIXTURES.empty_stats, null);
  assert.equal(samples.length, 0);
});

test('§5.2 summariseStats without remote-inbound: rttMs is null', () => {
  const samples = summariseStats(STATS_FIXTURES.stats_without_remote_inbound, null);
  const out = samples.find((s) => s.dir === 'outbound' && s.kind === 'audio');
  assert.equal(out.rttMs, null);
  assert.equal(out.lossFraction, null);
});

test('§5.2 qualityTierFromSummary handles null lossFraction samples', () => {
  const samples = [
    { kind: 'audio', dir: 'outbound', lossFraction: null, rttMs: null, outBitrate: 0 },
  ];
  const r = qualityTierFromSummary(samples);
  assert.equal(r.tier, 'good');
});
