// File: web/assets/debug-overlay.js
// Purpose: Dev-only live overlay of audio codec parameters, DSP
//          flags, and getStats() metrics. Self-gated on the
//          <meta name="sb-debug"> tag that the server injects only
//          when config.dev is true.
// Role: Only place that polls pc.getStats() for dev diagnostics.
//       Every rendering function writes via textContent only — no
//       innerHTML, no inline HTML interpolation.
// Exports: window.sbDebug.startDebugOverlay(pc, {localTrack})
//          -> { stop() }
// Depends: none
// Invariants: returns a {stop()} handle on every path (including
//             the no-op prod branch); the caller always has a
//             handle to invoke.
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

'use strict';

(function () {
  var OPUS_FMTP_KEYS = ['stereo', 'maxaveragebitrate', 'useinbandfec', 'cbr'];
  var DSP_KEYS = [
    'echoCancellation',
    'noiseSuppression',
    'autoGainControl',
    'sampleRate',
    'channelCount',
  ];
  var DSP_EXPECTED = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 2,
  };

  function buildPanel() {
    var panel = document.createElement('div');
    panel.className = 'sb-debug-panel';
    var h = document.createElement('h3');
    h.textContent = 'Debug';
    panel.append(h);
    var body = document.createElement('dl');
    panel.append(body);
    panel.__body = body;
    return panel;
  }

  function setRow(dl, label, value, ok) {
    var dt = dl.querySelector('dt[data-k="' + label + '"]');
    var dd;
    if (!dt) {
      dt = document.createElement('dt');
      dt.setAttribute('data-k', label);
      dt.textContent = label;
      dd = document.createElement('dd');
      dd.setAttribute('data-k', label);
      dl.append(dt, dd);
    } else {
      dd = dl.querySelector('dd[data-k="' + label + '"]');
    }
    dd.textContent = value == null ? '—' : String(value);
    dd.className = ok === true ? 'ok' : ok === false ? 'bad' : '';
  }

  function parseOpusFmtp(sdp) {
    if (!sdp) return null;
    var m = /^a=fmtp:\d+ (.+)$/m.exec(sdp);
    if (!m) return null;
    var out = {};
    var parts = m[1].split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length === 2) out[kv[0].trim()] = kv[1].trim();
    }
    return out;
  }

  function renderSdp(body, local, remote) {
    var lp = parseOpusFmtp(local && local.sdp);
    var rp = parseOpusFmtp(remote && remote.sdp);
    for (var i = 0; i < OPUS_FMTP_KEYS.length; i++) {
      var k = OPUS_FMTP_KEYS[i];
      var lv = lp ? lp[k] : null;
      var rv = rp ? rp[k] : null;
      // textContent-only insertion — safe even with unexpected SDP content.
      setRow(body, 'fmtp.' + k, (lv || '-') + ' / ' + (rv || '-'), null);
    }
  }

  function renderStats(body, stats) {
    var inbound = null;
    var remoteInbound = null;
    var candidatePair = null;
    stats.forEach(function (report) {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') inbound = report;
      if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') remoteInbound = report;
      if (report.type === 'candidate-pair' && report.selected) candidatePair = report;
      // Firefox uses `nominated` instead of `selected`.
      if (report.type === 'candidate-pair' && report.nominated && !candidatePair) {
        candidatePair = report;
      }
    });
    setRow(body, 'inbound.packetsLost', inbound ? inbound.packetsLost : null, null);
    setRow(body, 'inbound.jitter', inbound ? inbound.jitter : null, null);
    setRow(body, 'inbound.audioLevel', inbound ? inbound.audioLevel : null, null);
    setRow(
      body,
      'remote.roundTripTime',
      remoteInbound ? remoteInbound.roundTripTime : null,
      null
    );
    setRow(
      body,
      'candidate.rtt',
      candidatePair ? candidatePair.currentRoundTripTime : null,
      null
    );
  }

  function renderSettings(body, localTrack) {
    if (!localTrack || typeof localTrack.getSettings !== 'function') {
      for (var j = 0; j < DSP_KEYS.length; j++) {
        setRow(body, 'local.' + DSP_KEYS[j], '—', null);
      }
      return;
    }
    var s = localTrack.getSettings();
    for (var i = 0; i < DSP_KEYS.length; i++) {
      var k = DSP_KEYS[i];
      var v = s[k];
      var honoured =
        v !== undefined && DSP_EXPECTED[k] !== undefined && v === DSP_EXPECTED[k];
      setRow(body, 'local.' + k, v === undefined ? '—' : v, honoured);
    }
  }

  function startDebugOverlay(pc, opts) {
    var enabled = !!document.querySelector('meta[name="sb-debug"]');
    if (!enabled) return { stop: function () {} };
    var container = document.getElementById('sb-debug');
    if (!container) return { stop: function () {} };

    var panel = buildPanel();
    container.append(panel);
    var localTrack = opts && opts.localTrack ? opts.localTrack : null;

    var stopped = false;
    var tick = function () {
      if (stopped || !pc) return;
      Promise.resolve()
        .then(function () { return pc.getStats(); })
        .then(function (stats) {
          if (stopped) return;
          renderStats(panel.__body, stats);
          renderSdp(panel.__body, pc.localDescription, pc.remoteDescription);
          renderSettings(panel.__body, localTrack);
        })
        .catch(function () { /* non-critical */ });
    };
    var interval = setInterval(tick, 1000);
    tick();

    return {
      stop: function () {
        stopped = true;
        clearInterval(interval);
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      },
    };
  }

  if (typeof window !== 'undefined') {
    window.sbDebug = { startDebugOverlay: startDebugOverlay };
  }
})();
