// File: web/assets/vad.js
// Purpose: Voice-activity detector for teacher mic — drives chat-mode AEC toggle on the student side.
// Role: Only VAD logic in the client. Emits onVoiceStart/onVoiceSilence to caller; never touches WS directly.
// Exports: window.sbVad = {
//            create(audioTrack, opts) → handle,
//            tickVad(state, rmsNow, nowMs, opts) → { nextState, event | null },
//          }
//          handle: {
//            suppress(bool)               — suppress=true: silence immediately, block onVoiceStart until released
//            forceMode('auto'|'on'|'off') — 'on': force voice-start; 'off': force silence (Demonstrating mode); 'auto': VAD
//            teardown()                  — stop polling; disconnect nodes
//          }
//          State discriminated union (used by tickVad and tests):
//            { name: 'SILENT' }
//            { name: 'ACTIVE' }
//            { name: 'HANGOVER', hangsUntilMs: number }
// Depends: AudioContext, AnalyserNode, MediaStream (browser-only wrapper);
//          tickVad is pure and has no browser dependency.
// Invariants: onVoiceStart never emitted while _suppressed = true.
//             onVoiceSilence never emitted from SILENT state.
//             suppress takes priority over forceMode: if _suppressed=true and forceMode='on',
//               onVoiceStart is NOT emitted until suppress(false) is called.
//             suppress(false) while forceMode='on': emits onVoiceStart immediately.
//             forceMode('off') immediately emits onVoiceSilence if ACTIVE or HANGOVER.
//             forceMode('auto') resumes VAD from SILENT; no immediate event.
//             HANGOVER timer fires at nowMs >= hangsUntilMs (inclusive).
// Last updated: Sprint 20 (2026-04-25) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbVad = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Pure state machine ----

  var SILENT   = { name: 'SILENT' };
  var ACTIVE   = { name: 'ACTIVE' };
  function HANGOVER(hangsUntilMs) { return { name: 'HANGOVER', hangsUntilMs: hangsUntilMs }; }

  // tickVad: pure function. Returns { nextState, event } where event is
  // 'voice_start' | 'voice_silence' | null. Does not emit callbacks directly —
  // the browser wrapper does that after inspecting the event.
  function tickVad(state, rmsNow, nowMs, opts) {
    var rmsOn  = opts.rmsVoiceOn;
    var rmsOff = opts.rmsVoiceOff;
    var hang   = opts.hangoverMs;

    if (state.name === 'SILENT') {
      if (rmsNow >= rmsOn) return { nextState: ACTIVE, event: 'voice_start' };
      return { nextState: SILENT, event: null };
    }

    if (state.name === 'ACTIVE') {
      if (rmsNow < rmsOff) return { nextState: HANGOVER(nowMs + hang), event: null };
      return { nextState: ACTIVE, event: null };
    }

    // HANGOVER
    if (rmsNow >= rmsOn) return { nextState: ACTIVE, event: null };
    if (nowMs >= state.hangsUntilMs) return { nextState: SILENT, event: 'voice_silence' };
    return { nextState: state, event: null };
  }

  // ---- Browser wrapper ----

  function create(audioTrack, opts) {
    opts = opts || {};
    var onVoiceStart   = opts.onVoiceStart   || function () {};
    var onVoiceSilence = opts.onVoiceSilence || function () {};
    var hangoverMs     = opts.hangoverMs     != null ? opts.hangoverMs     : 3000;
    var rmsVoiceOn     = opts.rmsVoiceOn     != null ? opts.rmsVoiceOn     : 0.04;
    var rmsVoiceOff    = opts.rmsVoiceOff    != null ? opts.rmsVoiceOff    : 0.015;
    var pollMs         = opts.pollIntervalMs != null ? opts.pollIntervalMs : 50;

    var tickOpts = { rmsVoiceOn: rmsVoiceOn, rmsVoiceOff: rmsVoiceOff, hangoverMs: hangoverMs };

    var _state      = SILENT;
    var _suppressed = false;
    var _forceMode  = 'auto'; // 'auto' | 'on' | 'off'
    var _interval   = null;
    var _audioCtx   = null;
    var _analyser   = null;
    var _source     = null;
    var _buf        = null;

    // Set up AnalyserNode on the outbound audio track.
    try {
      _audioCtx = new AudioContext();
      if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(function () {});
      _analyser = _audioCtx.createAnalyser();
      _analyser.fftSize = 256;
      _source = _audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
      _source.connect(_analyser);
      _buf = new Uint8Array(_analyser.frequencyBinCount);
    } catch (_) {}

    function getRms() {
      if (!_analyser || !_buf) return 0;
      _analyser.getByteTimeDomainData(_buf);
      var sum = 0;
      for (var i = 0; i < _buf.length; i++) {
        var v = (_buf[i] / 128) - 1;
        sum += v * v;
      }
      return Math.sqrt(sum / _buf.length);
    }

    function poll() {
      if (_forceMode !== 'auto') return;
      var rms = getRms();
      var result = tickVad(_state, rms, Date.now(), tickOpts);
      _state = result.nextState;
      if (result.event === 'voice_start' && !_suppressed) {
        onVoiceStart();
      } else if (result.event === 'voice_silence') {
        onVoiceSilence();
      }
    }

    _interval = setInterval(poll, pollMs);

    return {
      suppress: function (on) {
        if (on) {
          _suppressed = true;
          if (_state.name === 'ACTIVE' || _state.name === 'HANGOVER') {
            _state = SILENT;
            onVoiceSilence();
          }
        } else {
          _suppressed = false;
          if (_forceMode === 'on') {
            onVoiceStart();
          }
        }
      },

      forceMode: function (mode) {
        _forceMode = mode;
        if (mode === 'off') {
          if (_state.name === 'ACTIVE' || _state.name === 'HANGOVER') {
            _state = SILENT;
            onVoiceSilence();
          }
        } else if (mode === 'on') {
          _state = SILENT; // reset so VAD resumes from SILENT when auto is restored
          if (!_suppressed) {
            onVoiceStart();
          }
        } else if (mode === 'auto') {
          _state = SILENT; // resume from SILENT; no immediate event
        }
      },

      teardown: function () {
        clearInterval(_interval);
        _interval = null;
        if (_source)   { try { _source.disconnect();  } catch (_) {} }
        if (_analyser) { try { _analyser.disconnect(); } catch (_) {} }
        // Do not close _audioCtx — it may be shared with the debug overlay.
      },
    };
  }

  return { create: create, tickVad: tickVad };
});
