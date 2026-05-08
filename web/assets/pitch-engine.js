// File: web/assets/pitch-engine.js
// Purpose: Main-thread pitch detection controller. Loads pitch-worklet.js into an
//          AudioContext, connects the student's mic stream, applies vibrato smoothing,
//          converts F0 → note name + cents, and throttles the onNote callback to ~10 Hz.
//          API: window.sbPitchEngine = { start(stream, onNote), stop() }
// Last updated: Sprint 27 (2026-05-08) -- initial implementation

'use strict';

window.sbPitchEngine = (function () {
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Min interval between onNote callbacks — keeps data-channel traffic reasonable
  const THROTTLE_MS = 90;

  // Smoothing: snap on jumps > 1.5 semitones (note change); otherwise low-pass (vibrato)
  const ALPHA       = 0.35;
  const SNAP_THRESH = 1.5;

  var _ctx    = null;
  var _node   = null;
  var _source = null;
  var _gain   = null;

  var _smoothedMidi = 0;
  var _lastSendMs   = 0;

  // ── Frequency / note helpers ──────────────────────────────────────────────

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  function midiToDisplay(midi) {
    var midiRound = Math.round(midi);
    var cents     = Math.round((midi - midiRound) * 100);
    var octave    = Math.floor(midiRound / 12) - 1;
    var noteName  = NOTES[((midiRound % 12) + 12) % 12] + octave;
    return { name: noteName, cents: Math.max(-50, Math.min(50, cents)) };
  }

  // ── Vibrato smoother ─────────────────────────────────────────────────────
  // Operates in the MIDI domain (linear in cents) so smoothing is musically uniform.

  function smooth(freq) {
    if (freq <= 0) return null;        // unvoiced frame — skip
    var midi = freqToMidi(freq);
    if (_smoothedMidi === 0) {
      _smoothedMidi = midi;            // cold start — initialise
    } else if (Math.abs(midi - _smoothedMidi) > SNAP_THRESH) {
      _smoothedMidi = midi;            // large jump → snap (note change / octave error)
    } else {
      _smoothedMidi = (1 - ALPHA) * _smoothedMidi + ALPHA * midi;
    }
    return _smoothedMidi;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function start(stream, onNote) {
    stop(); // clean up any previous run
    _smoothedMidi = 0;
    _lastSendMs   = 0;

    if (!stream || !stream.getAudioTracks().length) return;
    if (!window.AudioWorkletNode) return; // not supported — fail silently

    try {
      _ctx = new AudioContext();
      await _ctx.audioWorklet.addModule('/assets/pitch-worklet.js');
      _node   = new AudioWorkletNode(_ctx, 'sb-pitch-processor');
      _source = _ctx.createMediaStreamSource(stream);
      // Silent gain sink — required to activate the worklet graph
      _gain         = _ctx.createGain();
      _gain.gain.value = 0;
      _source.connect(_node);
      _node.connect(_gain);
      _gain.connect(_ctx.destination);

      _node.port.onmessage = function (ev) {
        var midi = smooth(ev.data);
        if (midi === null) return;
        var now = performance.now();
        if (now - _lastSendMs < THROTTLE_MS) return;
        _lastSendMs = now;
        var display = midiToDisplay(midi);
        onNote(display.name, display.cents);
      };

      // Resume if browser suspended the context (e.g. created outside gesture)
      if (_ctx.state === 'suspended') _ctx.resume();
    } catch (e) {
      console.warn('[sbPitchEngine] failed to start:', e);
      stop();
    }
  }

  function stop() {
    if (_node) {
      _node.port.onmessage = null;
      try { _node.disconnect(); } catch (_) {}
      _node = null;
    }
    if (_source) {
      try { _source.disconnect(); } catch (_) {}
      _source = null;
    }
    if (_gain) {
      try { _gain.disconnect(); } catch (_) {}
      _gain = null;
    }
    if (_ctx) {
      _ctx.close();
      _ctx = null;
    }
    _smoothedMidi = 0;
  }

  return { start: start, stop: stop };
}());
