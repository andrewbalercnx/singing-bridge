// File: web/assets/loopback.js
// Purpose: Dev-only mic→speaker loopback latency harness. Plays a
//          pulse train while capturing via AudioWorklet, then
//          cross-correlates captured audio against a reference pulse
//          to estimate round-trip delay. Reports mean / median /
//          p95 to the DOM and to console.
// Role: Standalone measurement tool at /loopback. Never wired into a
//       live lesson. Route is served only when config.dev.
// Exports: none (runs on DOMContentLoaded)
// Depends: Web Audio API, AudioWorkletNode
// Invariants: no SharedArrayBuffer (MessagePort transfer only); no
//             network calls; getUserMedia requested only after
//             user clicks Start.
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

'use strict';

(function () {
  var SAMPLE_RATE = 48000;
  var PULSE_HZ = 1000;
  var PULSE_MS = 5;
  var PULSE_COUNT = 10;
  var PULSE_SPACING_MS = 500;

  function log() {
    console.log.apply(console, ['sb.loopback:'].concat([].slice.call(arguments)));
  }

  function renderResults(out, samples) {
    if (samples.length === 0) {
      out.textContent = 'No samples captured.';
      return;
    }
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    var mean = samples.reduce(function (a, b) { return a + b; }, 0) / samples.length;
    var median = sorted[Math.floor(sorted.length / 2)];
    var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    var variance =
      samples.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) /
      samples.length;
    var stddev = Math.sqrt(variance);
    var lines = [
      'samples: ' + samples.length,
      'mean:    ' + mean.toFixed(2) + ' ms',
      'median:  ' + median.toFixed(2) + ' ms',
      'p95:     ' + p95.toFixed(2) + ' ms',
      'stddev:  ' + stddev.toFixed(2) + ' ms',
      'raw:     [' + samples.map(function (v) { return v.toFixed(1); }).join(', ') + ']',
    ];
    out.textContent = lines.join('\n');
    log({
      samples: samples,
      mean_ms: mean,
      median_ms: median,
      p95_ms: p95,
      stddev_ms: stddev,
    });
  }

  function makeReferencePulse(sampleRate) {
    var len = Math.round((PULSE_MS / 1000) * sampleRate);
    var buf = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      // Hann-windowed tone — distinctive peak under cross-correlation.
      var w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
      buf[i] = w * Math.sin((2 * Math.PI * PULSE_HZ * i) / sampleRate);
    }
    return buf;
  }

  // Find the argmax of the cross-correlation of `ref` against `signal`
  // within [startSample, endSample). Returns the sample index into
  // `signal` at which `ref` best aligns.
  function crossCorrelateArgmax(signal, ref, startSample, endSample) {
    var best = -Infinity;
    var bestIdx = startSample;
    var refLen = ref.length;
    var end = Math.min(endSample, signal.length - refLen);
    for (var i = startSample; i < end; i++) {
      var acc = 0;
      for (var k = 0; k < refLen; k++) {
        acc += signal[i + k] * ref[k];
      }
      if (acc > best) {
        best = acc;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  async function runMeasurement(statusEl, outEl) {
    statusEl.textContent = 'Requesting microphone…';
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
        },
        video: false,
      });
    } catch (e) {
      statusEl.textContent = 'Mic permission denied.';
      return;
    }

    statusEl.textContent = 'Initialising audio graph…';
    var ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE,
      latencyHint: 'interactive',
    });

    try {
      await ctx.audioWorklet.addModule('/assets/loopback-worklet.js');
    } catch (e) {
      statusEl.textContent = 'AudioWorklet failed to load: ' + e;
      return;
    }

    var src = ctx.createMediaStreamSource(stream);
    var worklet = new AudioWorkletNode(ctx, 'sb-capture');
    src.connect(worklet);

    var captured = [];
    var capturedStartTime = ctx.currentTime;
    worklet.port.onmessage = function (ev) {
      captured.push(ev.data);
    };

    var baseLatency = ctx.baseLatency || 0;
    var outputLatency = ctx.outputLatency || 0;

    statusEl.textContent =
      'Playing ' + PULSE_COUNT + ' pulses… baseLatency=' +
      (baseLatency * 1000).toFixed(1) + 'ms outputLatency=' +
      (outputLatency * 1000).toFixed(1) + 'ms';

    var now = ctx.currentTime;
    var emitTimes = [];
    var spacing = PULSE_SPACING_MS / 1000;
    var firstEmit = now + 0.2;
    for (var i = 0; i < PULSE_COUNT; i++) {
      var t = firstEmit + i * spacing;
      var osc = ctx.createOscillator();
      osc.frequency.value = PULSE_HZ;
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(1, t + 0.0005);
      gain.gain.setValueAtTime(1, t + PULSE_MS / 1000 - 0.0005);
      gain.gain.linearRampToValueAtTime(0, t + PULSE_MS / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + PULSE_MS / 1000 + 0.01);
      emitTimes.push(t);
    }

    var runtimeMs = 200 + PULSE_COUNT * PULSE_SPACING_MS + 500;
    await new Promise(function (r) { return setTimeout(r, runtimeMs); });

    stream.getTracks().forEach(function (t) { t.stop(); });
    worklet.disconnect();
    src.disconnect();

    // Concatenate captured buffers.
    var total = 0;
    for (var a = 0; a < captured.length; a++) total += captured[a].length;
    var signal = new Float32Array(total);
    var offset = 0;
    for (var b = 0; b < captured.length; b++) {
      signal.set(captured[b], offset);
      offset += captured[b].length;
    }

    var ref = makeReferencePulse(SAMPLE_RATE);
    var results = [];
    for (var j = 0; j < emitTimes.length; j++) {
      var emitSample =
        Math.round((emitTimes[j] - capturedStartTime) * SAMPLE_RATE);
      // Search window: from emit up to +300 ms to tolerate large
      // round trips without matching a neighbouring pulse.
      var windowStart = Math.max(0, emitSample);
      var windowEnd = Math.min(signal.length - ref.length,
        emitSample + Math.round(0.3 * SAMPLE_RATE));
      if (windowEnd <= windowStart) continue;
      var arrivalSample =
        crossCorrelateArgmax(signal, ref, windowStart, windowEnd);
      var rawDelaySec = (arrivalSample - emitSample) / SAMPLE_RATE;
      var compensatedMs =
        (rawDelaySec - baseLatency - outputLatency) * 1000;
      results.push(compensatedMs);
    }

    statusEl.textContent = 'Done.';
    renderResults(outEl, results);
    ctx.close();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('loopback-start');
    var statusEl = document.getElementById('loopback-status');
    var outEl = document.getElementById('loopback-results');
    if (!btn || !statusEl || !outEl) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      runMeasurement(statusEl, outEl).finally(function () {
        btn.disabled = false;
      });
    });
  });
})();
