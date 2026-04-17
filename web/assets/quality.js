// File: web/assets/quality.js
// Purpose: Pure stats summariser + connection-quality tier classifier,
//          plus a textContent-only DOM renderer for the quality badge.
//          Consumes RTCStatsReport snapshots; produces Sample[] and
//          a single {tier, loss, rttMs, outBitrate} summary object.
// Role: Only place that parses getStats() for production quality
//       signalling (debug-overlay.js parses independently for dev).
// Exports: summariseStats, qualityTierFromSummary, STATS_FIXTURES
//          (pure, Node);
//          renderQualityBadge (browser-only, via window.sbQuality).
// Depends: none (pure logic); DOM for the badge renderer only.
// Invariants: summariseStats is pure (deterministic across two calls
//             with the same stats); qualityTierFromSummary uses
//             strictly-greater threshold semantics (`> 0.02` etc.);
//             renderQualityBadge sets textContent + className only —
//             never innerHTML.
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbQuality = {
      summariseStats: mod.summariseStats,
      qualityTierFromSummary: mod.qualityTierFromSummary,
      STATS_FIXTURES: mod.STATS_FIXTURES,
      renderQualityBadge: renderQualityBadge,
    };
  }

  function renderQualityBadge(el, summary) {
    if (!el || !summary) return;
    el.textContent = summary.tier;
    el.className = 'quality-badge ' + summary.tier;
    var lossPct = (summary.loss * 100).toFixed(1);
    var rttStr = Math.round(summary.rttMs);
    var outKbps = Math.round(summary.outBitrate / 1000);
    el.title = 'loss: ' + lossPct + ' % / rtt: ' + rttStr + ' ms / out: ' + outKbps + ' kbps';
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEGRADE_LOSS = 0.05;
  var DEGRADE_RTT_MS = 400;
  var FAIR_LOSS = 0.02;
  var FAIR_RTT_MS = 200;

  // --- Helpers -------------------------------------------------------------

  function mapGet(stats, key) {
    if (!stats) return undefined;
    if (typeof stats.get === 'function') return stats.get(key);
    return stats[key];
  }

  function forEachReport(stats, fn) {
    if (!stats) return;
    if (typeof stats.forEach === 'function') {
      stats.forEach(function (report) { fn(report); });
      return;
    }
    for (var k in stats) {
      if (Object.prototype.hasOwnProperty.call(stats, k)) fn(stats[k]);
    }
  }

  // Delta in bytes between two reports for a given RTP ssrc, converted
  // to bits-per-second over a 2-second window (matches adapt loop cadence).
  function bitrateDelta(curr, prev, bytesField) {
    if (!curr || !prev) return 0;
    var b1 = curr[bytesField];
    var b0 = prev[bytesField];
    if (typeof b1 !== 'number' || typeof b0 !== 'number') return 0;
    if (b1 < b0) return 0; // counter reset
    return Math.max(0, (b1 - b0) * 8 / 2);
  }

  // Pick the SSRC with the highest packetsSent/Received for deterministic
  // tiebreak when multiple outbound/inbound streams of the same kind exist.
  function pickReport(candidates, counterField) {
    if (candidates.length === 0) return null;
    var best = candidates[0];
    for (var i = 1; i < candidates.length; i++) {
      var c = candidates[i];
      if ((c[counterField] || 0) > (best[counterField] || 0)) best = c;
    }
    return best;
  }

  function collectOutbound(stats, kind) {
    var out = [];
    forEachReport(stats, function (r) {
      if (r && r.type === 'outbound-rtp' && r.kind === kind) out.push(r);
    });
    return out;
  }

  function collectInbound(stats, kind) {
    var out = [];
    forEachReport(stats, function (r) {
      if (r && r.type === 'inbound-rtp' && r.kind === kind) out.push(r);
    });
    return out;
  }

  function collectRemoteInbound(stats, kind) {
    var out = [];
    forEachReport(stats, function (r) {
      if (r && r.type === 'remote-inbound-rtp' && r.kind === kind) out.push(r);
    });
    return out;
  }

  function findByIdInPrev(prev, id) {
    return mapGet(prev, id) || null;
  }

  // --- Pure API -----------------------------------------------------------

  function summariseStats(stats, prevStats) {
    var samples = [];
    if (!stats) return samples;

    ['audio', 'video'].forEach(function (kind) {
      // Outbound sample: pick by highest packetsSent.
      var outCandidates = collectOutbound(stats, kind);
      if (outCandidates.length > 0) {
        var outR = pickReport(outCandidates, 'packetsSent');
        // Find matching remote-inbound report by localId or by ssrc.
        var remoteInbound = null;
        var remotes = collectRemoteInbound(stats, kind);
        for (var i = 0; i < remotes.length; i++) {
          var ri = remotes[i];
          if (ri.localId === outR.id || ri.ssrc === outR.ssrc) {
            remoteInbound = ri;
            break;
          }
        }
        var prevOut = prevStats ? findByIdInPrev(prevStats, outR.id) : null;
        var outBitrate = bitrateDelta(outR, prevOut, 'bytesSent');
        var lossFraction = null;
        var rttMs = null;
        if (remoteInbound) {
          if (typeof remoteInbound.fractionLost === 'number') {
            lossFraction = remoteInbound.fractionLost;
          } else if (
            typeof remoteInbound.packetsLost === 'number' &&
            typeof outR.packetsSent === 'number' &&
            outR.packetsSent > 0
          ) {
            lossFraction = remoteInbound.packetsLost / outR.packetsSent;
          }
          if (typeof remoteInbound.roundTripTime === 'number') {
            rttMs = remoteInbound.roundTripTime * 1000;
          }
        }
        samples.push({
          kind: kind,
          dir: 'outbound',
          lossFraction: lossFraction,
          rttMs: rttMs,
          outBitrate: outBitrate,
          inBitrate: 0,
        });
      }

      // Inbound sample: pick by highest packetsReceived.
      var inCandidates = collectInbound(stats, kind);
      if (inCandidates.length > 0) {
        var inR = pickReport(inCandidates, 'packetsReceived');
        var prevIn = prevStats ? findByIdInPrev(prevStats, inR.id) : null;
        var inBitrate = bitrateDelta(inR, prevIn, 'bytesReceived');
        var inLoss = null;
        if (
          typeof inR.packetsLost === 'number' &&
          typeof inR.packetsReceived === 'number' &&
          inR.packetsReceived > 0
        ) {
          inLoss = inR.packetsLost / (inR.packetsLost + inR.packetsReceived);
        }
        samples.push({
          kind: kind,
          dir: 'inbound',
          lossFraction: inLoss,
          rttMs: null,
          outBitrate: 0,
          inBitrate: inBitrate,
        });
      }
    });

    return samples;
  }

  function qualityTierFromSummary(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return { tier: 'good', loss: 0, rttMs: 0, outBitrate: 0 };
    }
    var worstLoss = 0;
    var worstRtt = 0;
    var bestOut = 0;
    var outbound = samples.filter(function (s) { return s.dir === 'outbound'; });
    for (var i = 0; i < outbound.length; i++) {
      var s = outbound[i];
      if (typeof s.lossFraction === 'number' && s.lossFraction > worstLoss) worstLoss = s.lossFraction;
      if (typeof s.rttMs === 'number' && s.rttMs > worstRtt) worstRtt = s.rttMs;
      if (typeof s.outBitrate === 'number' && s.outBitrate > bestOut) bestOut = s.outBitrate;
    }
    var tier;
    if (worstLoss > DEGRADE_LOSS || worstRtt > DEGRADE_RTT_MS) tier = 'poor';
    else if (worstLoss > FAIR_LOSS || worstRtt > FAIR_RTT_MS) tier = 'fair';
    else tier = 'good';
    return { tier: tier, loss: worstLoss, rttMs: worstRtt, outBitrate: bestOut };
  }

  // --- Fixtures (Node-testable stand-ins for RTCStatsReport) ---------------

  function makeStats(reports) {
    var m = new Map();
    reports.forEach(function (r) { m.set(r.id, r); });
    return m;
  }

  var HEALTHY_OUTBOUND_AUDIO = {
    id: 'OT1', type: 'outbound-rtp', kind: 'audio',
    ssrc: 1001, bytesSent: 250000, packetsSent: 10000,
  };
  var HEALTHY_REMOTE_INBOUND_AUDIO = {
    id: 'RI1', type: 'remote-inbound-rtp', kind: 'audio',
    localId: 'OT1', ssrc: 1001, fractionLost: 0.005, roundTripTime: 0.080,
  };
  var HEALTHY_INBOUND_AUDIO = {
    id: 'IN1', type: 'inbound-rtp', kind: 'audio',
    ssrc: 2001, bytesReceived: 240000, packetsReceived: 9800, packetsLost: 5,
  };

  var HEALTHY_T0 = makeStats([
    HEALTHY_OUTBOUND_AUDIO, HEALTHY_REMOTE_INBOUND_AUDIO, HEALTHY_INBOUND_AUDIO,
  ]);
  var HEALTHY_T1 = makeStats([
    { id: 'OT1', type: 'outbound-rtp', kind: 'audio', ssrc: 1001, bytesSent: 282000, packetsSent: 11000 },
    { id: 'RI1', type: 'remote-inbound-rtp', kind: 'audio', localId: 'OT1', ssrc: 1001, fractionLost: 0.005, roundTripTime: 0.080 },
    { id: 'IN1', type: 'inbound-rtp', kind: 'audio', ssrc: 2001, bytesReceived: 270000, packetsReceived: 10800, packetsLost: 5 },
  ]);

  var EMPTY_STATS = makeStats([]);

  // Multi-SSRC fixture pair: SSRC A low delta, SSRC B high delta. Tiebreak
  // must pick SSRC B (higher packetsSent). §5.1 #21.
  var STATS_MULTI_SSRC_AUDIO_T0 = makeStats([
    { id: 'A', type: 'outbound-rtp', kind: 'audio', ssrc: 1, bytesSent: 100000, packetsSent: 500 },
    { id: 'B', type: 'outbound-rtp', kind: 'audio', ssrc: 2, bytesSent: 50000,  packetsSent: 1200 },
  ]);
  var STATS_MULTI_SSRC_AUDIO_T1 = makeStats([
    { id: 'A', type: 'outbound-rtp', kind: 'audio', ssrc: 1, bytesSent: 110000, packetsSent: 520 },
    { id: 'B', type: 'outbound-rtp', kind: 'audio', ssrc: 2, bytesSent: 150000, packetsSent: 1250 },
  ]);

  // Stats without remote-inbound (first ticks, or codec without RTCP).
  var STATS_WITHOUT_REMOTE_INBOUND = makeStats([
    { id: 'OT1', type: 'outbound-rtp', kind: 'audio', ssrc: 1001, bytesSent: 100000, packetsSent: 4000 },
  ]);

  var STATS_FIXTURES = Object.freeze({
    healthy_t0: HEALTHY_T0,
    healthy_t1: HEALTHY_T1,
    empty_stats: EMPTY_STATS,
    stats_multi_ssrc_audio_t0: STATS_MULTI_SSRC_AUDIO_T0,
    stats_multi_ssrc_audio_t1: STATS_MULTI_SSRC_AUDIO_T1,
    stats_without_remote_inbound: STATS_WITHOUT_REMOTE_INBOUND,
  });

  return {
    summariseStats: summariseStats,
    qualityTierFromSummary: qualityTierFromSummary,
    STATS_FIXTURES: STATS_FIXTURES,
  };
});
