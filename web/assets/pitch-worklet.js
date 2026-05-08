// File: web/assets/pitch-worklet.js
// Purpose: AudioWorkletProcessor — YIN pitch detection running in the audio thread.
//          Accumulates 2048 samples, then posts the detected F0 (or 0 for unvoiced) to
//          the main thread via port.postMessage. Loaded by pitch-engine.js via addModule().
// Last updated: Sprint 27 (2026-05-08) -- initial implementation

'use strict';

// ── YIN algorithm ────────────────────────────────────────────────────────────
// Detects the fundamental frequency of a monophonic signal.
// Returns the estimated F0 in Hz, or 0 if the frame is unvoiced / no pitch found.
//
// Parameters tuned for singing voice at 48 kHz:
//   W       = 1024  half-window (analysis against second half of the 2048-sample buffer)
//   TAU_MIN = 20    → F0_max ≈ 2400 Hz  (above soprano top)
//   TAU_MAX = 600   → F0_min ≈  80 Hz  (below bass bottom — safe margin)
//   THRESHOLD = 0.12  CMNDF value below which a minimum is accepted as pitched

function detectYin(buf, sr) {
  const W         = 1024;
  const TAU_MIN   = 20;
  const TAU_MAX   = 600;
  const THRESHOLD = 0.12;

  // RMS voicing gate — reject silence / quiet noise (< −42 dBFS)
  let ss = 0;
  for (let i = 0; i < W; i++) ss += buf[i] * buf[i];
  if (ss / W < 6.4e-5) return 0;   // 0.008² = 6.4e-5

  // Step 1 — difference function d(τ) = Σ(x[j] - x[j+τ])²
  // Compute for all τ in [1, TAU_MAX] so the CMNDF running sum is correct.
  const diff = new Float32Array(TAU_MAX + 1);
  for (let tau = 1; tau <= TAU_MAX; tau++) {
    let d = 0;
    for (let j = 0; j < W; j++) {
      const delta = buf[j] - buf[j + tau];
      d += delta * delta;
    }
    diff[tau] = d;
  }

  // Step 2 — cumulative mean normalised difference function (CMNDF)
  // d'(0) = 1; d'(τ) = d(τ) × τ / Σ_{j=1}^{τ} d(j)
  const cmndf = new Float32Array(TAU_MAX + 1);
  cmndf[0] = 1;
  let runSum = 0;
  for (let tau = 1; tau <= TAU_MAX; tau++) {
    runSum += diff[tau];
    cmndf[tau] = runSum > 0 ? diff[tau] * tau / runSum : 1;
  }

  // Step 3 — find first τ ≥ TAU_MIN where the CMNDF dips below the threshold
  let tau = TAU_MIN;
  while (tau < TAU_MAX && cmndf[tau] >= THRESHOLD) tau++;
  if (tau >= TAU_MAX) return 0;

  // Slide to local minimum
  while (tau + 1 < TAU_MAX && cmndf[tau + 1] < cmndf[tau]) tau++;

  // Step 4 — parabolic interpolation for sub-sample accuracy
  let refined = tau;
  if (tau > TAU_MIN && tau < TAU_MAX) {
    const s0 = cmndf[tau - 1], s1 = cmndf[tau], s2 = cmndf[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) refined = tau + (s2 - s0) / denom;
  }

  return sr / refined;
}

// ── Processor ────────────────────────────────────────────────────────────────

class SbPitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: accumulate samples until we have a full analysis frame
    this._buf = new Float32Array(2048);
    this._pos = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._pos++] = channel[i];
      if (this._pos >= 2048) {
        this._pos = 0;
        // Post F0 (Hz) or 0 for unvoiced to main thread
        this.port.postMessage(detectYin(this._buf, sampleRate));
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('sb-pitch-processor', SbPitchProcessor);
