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
//             emitted at most once per streak (one-shot).
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

  function decideNextRung(prev, outboundSamples, role) {
    var next = {
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
    var actions = [];

    // Clamp possibly-corrupted rung indices.
    var vKey = videoLadderKey(next.role);
    var aKey = audioLadderKey(next.role);
    next.videoRung = clamp(next.videoRung, 0, LADDER[vKey].length - 1);
    next.audioRung = clamp(next.audioRung, 0, LADDER[aKey].length - 1);

    var videoSample = pickSample(outboundSamples, 'video');
    var audioSample = pickSample(outboundSamples, 'audio');

    // --- Video rung transitions --------------------------------------------
    var vTerminal = LADDER[vKey].length - 1;
    var videoBad = isBadSample(videoSample);
    var videoGood = isGoodSample(videoSample);
    if (videoBad) {
      next.consecutiveBad.video += 1;
      next.consecutiveGood.video = 0;
    } else if (videoGood) {
      next.consecutiveGood.video += 1;
      next.consecutiveBad.video = 0;
    }
    var videoChanged = false;
    if (next.consecutiveBad.video >= DEGRADE_SAMPLES && next.videoRung < vTerminal) {
      next.videoRung += 1;
      next.consecutiveBad.video = 0;
      videoChanged = true;
    } else if (next.consecutiveGood.video >= IMPROVE_SAMPLES && next.videoRung > 0) {
      next.videoRung -= 1;
      next.consecutiveGood.video = 0;
      videoChanged = true;
    }
    if (videoChanged) {
      actions.push({
        type: 'setVideoEncoding',
        params: encodingParamsForRung(vKey, next.videoRung),
      });
    }

    // --- Audio rung transitions (only after video is at terminal) ----------
    var videoAtTerminal = next.videoRung >= vTerminal;
    var audioBad = isBadSample(audioSample);
    var audioGood = isGoodSample(audioSample);
    var aTerminal = LADDER[aKey].length - 1;
    // Track streaks only when we're allowed to degrade audio.
    if (videoAtTerminal && audioBad) {
      next.consecutiveBad.audio += 1;
      next.consecutiveGood.audio = 0;
    } else if (audioGood) {
      next.consecutiveGood.audio += 1;
      next.consecutiveBad.audio = 0;
    } else if (!videoAtTerminal) {
      // Video still degrading — hold audio counters.
      next.consecutiveBad.audio = 0;
      // consecutiveGood stays so we can upgrade when things recover.
    }

    var audioChanged = false;
    if (
      videoAtTerminal &&
      next.consecutiveBad.audio >= DEGRADE_SAMPLES &&
      next.audioRung < aTerminal
    ) {
      next.audioRung += 1;
      next.consecutiveBad.audio = 0;
      audioChanged = true;
    } else if (
      next.consecutiveGood.audio >= IMPROVE_SAMPLES &&
      next.audioRung > 0
    ) {
      next.audioRung -= 1;
      next.consecutiveGood.audio = 0;
      audioChanged = true;
    }
    if (audioChanged) {
      actions.push({
        type: 'setAudioEncoding',
        params: encodingParamsForRung(aKey, next.audioRung),
      });
    }

    // --- Floor-breach streak (student only) --------------------------------
    if (next.role === 'student' && next.audioRung >= aTerminal) {
      // At the floor rung for student audio. Persistent bad audio here is
      // the "your connection can't support this lesson" signal.
      if (audioBad) {
        next.floorBreachStreak += 1;
      } else if (audioGood) {
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
    } else {
      next.floorBreachStreak = 0;
    }

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
