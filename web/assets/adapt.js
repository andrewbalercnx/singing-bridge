// File: web/assets/adapt.js
// Purpose: Pure adaptive-bitrate state machine driving the four-rung
//          degradation ladder (student-video, teacher-video,
//          teacher-audio-floor, student-audio-floor). No DOM, no
//          RTCPeerConnection access — caller applies the returned
//          actions to senders.
// Role: Only place the rung catalogue + transition logic lives.
//       Called from session-core.js::startSessionSubsystems.
// Exports: LADDER, DEGRADE_LOSS, DEGRADE_RTT_MS, IMPROVE_LOSS,
//          IMPROVE_RTT_MS, DEGRADE_SAMPLES, IMPROVE_SAMPLES,
//          FLOOR_SAMPLES, initLadderState, decideNextRung,
//          encodingParamsForRung, floorViolated.
// Depends: none (pure logic).
// Invariants: decideNextRung never mutates its `prev` argument;
//             next.role === prev.role; student audio rung clamped
//             at 1 (96 kbps floor); video rung advances to terminal
//             before audio rung leaves 0; floor_violation action
//             emitted at most once per streak (guarded by
//             state.floorViolationEmitted, cleared on a sustained
//             good-audio reset — see stepFloorBreach).
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbAdapt = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // --- Rung catalogue ------------------------------------------------------

  var LADDER = Object.freeze({
    studentVideo: Object.freeze([
      Object.freeze({ maxBitrate: 1500000, scaleResolutionDownBy: 1.0 }),
      Object.freeze({ maxBitrate:  500000, scaleResolutionDownBy: 2.0 }),
      Object.freeze({ maxBitrate:  200000, scaleResolutionDownBy: 4.0 }),
      Object.freeze({ maxBitrate:       0, scaleResolutionDownBy: 4.0 }),
    ]),
    teacherVideo: Object.freeze([
      Object.freeze({ maxBitrate: 1500000, scaleResolutionDownBy: 1.0 }),
      Object.freeze({ maxBitrate:  500000, scaleResolutionDownBy: 2.0 }),
      Object.freeze({ maxBitrate:  200000, scaleResolutionDownBy: 4.0 }),
      Object.freeze({ maxBitrate:       0, scaleResolutionDownBy: 4.0 }),
    ]),
    teacherAudio: Object.freeze([
      Object.freeze({ maxBitrate: 128000 }),
      Object.freeze({ maxBitrate:  96000 }),
      Object.freeze({ maxBitrate:  64000 }),
      Object.freeze({ maxBitrate:  48000 }),
    ]),
    studentAudio: Object.freeze([
      Object.freeze({ maxBitrate: 128000 }),
      Object.freeze({ maxBitrate:  96000 }),
    ]),
  });

  // --- Thresholds ----------------------------------------------------------

  var DEGRADE_LOSS = 0.05;
  var DEGRADE_RTT_MS = 500;
  var IMPROVE_LOSS = 0.02;
  var IMPROVE_RTT_MS = 300;
  var DEGRADE_SAMPLES = 4;
  var IMPROVE_SAMPLES = 8;
  var FLOOR_SAMPLES = 6;

  // --- Helpers -------------------------------------------------------------

  function isBadSample(s) {
    if (!s) return false;
    var loss = typeof s.lossFraction === 'number' ? s.lossFraction : null;
    var rtt = typeof s.rttMs === 'number' ? s.rttMs : null;
    if (loss === null && rtt === null) return false; // stats unavailable
    if (loss !== null && loss > DEGRADE_LOSS) return true;
    if (rtt !== null && rtt > DEGRADE_RTT_MS) return true;
    return false;
  }

  function isGoodSample(s) {
    if (!s) return false;
    var loss = typeof s.lossFraction === 'number' ? s.lossFraction : null;
    var rtt = typeof s.rttMs === 'number' ? s.rttMs : null;
    if (loss === null && rtt === null) return false;
    if (loss !== null && loss > IMPROVE_LOSS) return false;
    if (rtt !== null && rtt > IMPROVE_RTT_MS) return false;
    return true;
  }

  function videoLadderKey(role) {
    return role === 'student' ? 'studentVideo' : 'teacherVideo';
  }
  function audioLadderKey(role) {
    return role === 'student' ? 'studentAudio' : 'teacherAudio';
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function pickSample(samples, kind) {
    if (!Array.isArray(samples)) return null;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s && s.kind === kind && s.dir === 'outbound') return s;
    }
    return null;
  }

  function cloneState(prev) {
    return {
      role: prev.role,
      videoRung: prev.videoRung,
      audioRung: prev.audioRung,
      consecutiveBad: {
        video: prev.consecutiveBad.video,
        audio: prev.consecutiveBad.audio,
      },
      consecutiveGood: {
        video: prev.consecutiveGood.video,
        audio: prev.consecutiveGood.audio,
      },
      floorBreachStreak: prev.floorBreachStreak,
      floorViolationEmitted: prev.floorViolationEmitted,
    };
  }

  // Helper: update {bad,good} counters given one sample; returns {bad, good}
  // as new values. Pure.
  function updateStreak(bad, good, isBad, isGood) {
    if (isBad) return { bad: bad + 1, good: 0 };
    if (isGood) return { bad: 0, good: good + 1 };
    return { bad: bad, good: good };
  }

  // Decide whether to step the video rung. Mutates `next` and pushes any
  // emitted action. Returns nothing.
  function stepVideoRung(next, videoSample, vKey, vTerminal, actions) {
    var isBad = isBadSample(videoSample);
    var isGood = isGoodSample(videoSample);
    var upd = updateStreak(next.consecutiveBad.video, next.consecutiveGood.video, isBad, isGood);
    next.consecutiveBad.video = upd.bad;
    next.consecutiveGood.video = upd.good;
    var changed = false;
    if (upd.bad >= DEGRADE_SAMPLES && next.videoRung < vTerminal) {
      next.videoRung += 1;
      next.consecutiveBad.video = 0;
      changed = true;
    } else if (upd.good >= IMPROVE_SAMPLES && next.videoRung > 0) {
      next.videoRung -= 1;
      next.consecutiveGood.video = 0;
      changed = true;
    }
    if (changed) {
      actions.push({
        type: 'setVideoEncoding',
        params: encodingParamsForRung(vKey, next.videoRung),
      });
    }
  }

  // Decide whether to step the audio rung. Mutates `next` and pushes any
  // emitted action. Audio only advances when video is already at terminal.
  function stepAudioRung(next, audioSample, videoAtTerminal, aKey, aTerminal, actions) {
    var isBad = isBadSample(audioSample);
    var isGood = isGoodSample(audioSample);
    if (videoAtTerminal && isBad) {
      next.consecutiveBad.audio += 1;
      next.consecutiveGood.audio = 0;
    } else if (isGood) {
      next.consecutiveBad.audio = 0;
      next.consecutiveGood.audio += 1;
    } else if (!videoAtTerminal) {
      next.consecutiveBad.audio = 0;
      // consecutiveGood stays so we can upgrade when things recover.
    }
    var changed = false;
    if (
      videoAtTerminal &&
      next.consecutiveBad.audio >= DEGRADE_SAMPLES &&
      next.audioRung < aTerminal
    ) {
      next.audioRung += 1;
      next.consecutiveBad.audio = 0;
      changed = true;
    } else if (
      next.consecutiveGood.audio >= IMPROVE_SAMPLES &&
      next.audioRung > 0
    ) {
      next.audioRung -= 1;
      next.consecutiveGood.audio = 0;
      changed = true;
    }
    if (changed) {
      actions.push({
        type: 'setAudioEncoding',
        params: encodingParamsForRung(aKey, next.audioRung),
      });
    }
  }

  // Student-only: track the floor-breach streak and emit the one-shot
  // floor_violation action. Audio at student terminal rung + sustained
  // bad samples are the only way this trips. Mutates `next`.
  function stepFloorBreach(next, audioSample, aTerminal, actions) {
    if (next.role !== 'student' || next.audioRung < aTerminal) {
      next.floorBreachStreak = 0;
      return;
    }
    var isBad = isBadSample(audioSample);
    var isGood = isGoodSample(audioSample);
    if (isBad) {
      next.floorBreachStreak += 1;
    } else if (isGood) {
      next.floorBreachStreak = 0;
      next.floorViolationEmitted = false;
    }
    if (
      next.floorBreachStreak >= FLOOR_SAMPLES &&
      !next.floorViolationEmitted
    ) {
      actions.push({ type: 'floor_violation' });
      next.floorViolationEmitted = true;
    }
  }

  // --- Public API ----------------------------------------------------------

  function initLadderState(role) {
    return {
      role: role === 'student' ? 'student' : 'teacher',
      videoRung: 0,
      audioRung: 0,
      consecutiveBad: { video: 0, audio: 0 },
      consecutiveGood: { video: 0, audio: 0 },
      floorBreachStreak: 0,
      floorViolationEmitted: false,
    };
  }

  function encodingParamsForRung(ladderKey, rungIndex) {
    var ladder = LADDER[ladderKey];
    if (!ladder) {
      throw new RangeError('unknown ladderKey: ' + ladderKey);
    }
    if (typeof rungIndex !== 'number' || rungIndex < 0 || rungIndex >= ladder.length) {
      throw new RangeError('rungIndex out of bounds for ' + ladderKey + ': ' + rungIndex);
    }
    var rung = ladder[rungIndex];
    var out = {};
    out.maxBitrate = rung.maxBitrate;
    if (ladderKey === 'studentVideo' || ladderKey === 'teacherVideo') {
      out.scaleResolutionDownBy = rung.scaleResolutionDownBy;
      out.active = rungIndex < ladder.length - 1;
      if (rungIndex === ladder.length - 1) {
        out.maxBitrate = 0;
      }
    }
    // studentAudio rung 1 is the hard floor — emit minBitrate as a
    // Chrome-only hint. The cross-browser floor is enforced by the
    // audioRung clamp; minBitrate is belt-and-braces.
    if (ladderKey === 'studentAudio' && rungIndex === 1) {
      out.minBitrate = 96000;
    }
    return out;
  }

  function floorViolated(state) {
    if (!state || state.role !== 'student') return false;
    return state.floorBreachStreak >= FLOOR_SAMPLES;
  }

  // decideNextRung(prev, outboundSamples): role is derived from prev.role.
  // Delegates each sub-decision to a helper so this function stays short.
  function decideNextRung(prev, outboundSamples) {
    var next = cloneState(prev);
    var actions = [];

    var vKey = videoLadderKey(next.role);
    var aKey = audioLadderKey(next.role);
    var vTerminal = LADDER[vKey].length - 1;
    var aTerminal = LADDER[aKey].length - 1;
    next.videoRung = clamp(next.videoRung, 0, vTerminal);
    next.audioRung = clamp(next.audioRung, 0, aTerminal);

    var videoSample = pickSample(outboundSamples, 'video');
    var audioSample = pickSample(outboundSamples, 'audio');

    stepVideoRung(next, videoSample, vKey, vTerminal, actions);
    var videoAtTerminal = next.videoRung >= vTerminal;
    stepAudioRung(next, audioSample, videoAtTerminal, aKey, aTerminal, actions);
    stepFloorBreach(next, audioSample, aTerminal, actions);

    return { next: next, actions: actions };
  }

  return {
    LADDER: LADDER,
    DEGRADE_LOSS: DEGRADE_LOSS,
    DEGRADE_RTT_MS: DEGRADE_RTT_MS,
    IMPROVE_LOSS: IMPROVE_LOSS,
    IMPROVE_RTT_MS: IMPROVE_RTT_MS,
    DEGRADE_SAMPLES: DEGRADE_SAMPLES,
    IMPROVE_SAMPLES: IMPROVE_SAMPLES,
    FLOOR_SAMPLES: FLOOR_SAMPLES,
    initLadderState: initLadderState,
    decideNextRung: decideNextRung,
    encodingParamsForRung: encodingParamsForRung,
    floorViolated: floorViolated,
  };
});
