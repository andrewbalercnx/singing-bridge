// File: web/assets/tests/adapt.test.js
// Purpose: Node tests for the pure adapt state machine. Covers the
//          full §5.1 #1–#18 property/invariant set plus §5.2 adapt
//          failure paths.
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapt = require('../adapt.js');

const {
  LADDER,
  DEGRADE_SAMPLES,
  IMPROVE_SAMPLES,
  FLOOR_SAMPLES,
  initLadderState,
  decideNextRung,
  encodingParamsForRung,
  floorViolated,
} = adapt;

// --- Sample helpers --------------------------------------------------------

function bad(kind) {
  return { kind: kind, dir: 'outbound', lossFraction: 0.1, rttMs: 600, outBitrate: 100000 };
}
function good(kind) {
  return { kind: kind, dir: 'outbound', lossFraction: 0.005, rttMs: 80, outBitrate: 1000000 };
}
function drive(state, sampleFn, role, ticks) {
  let s = state;
  let lastActions = [];
  for (let i = 0; i < ticks; i++) {
    const res = decideNextRung(s, [sampleFn('video'), sampleFn('audio')]);
    s = res.next;
    lastActions = res.actions;
  }
  return { state: s, lastActions: lastActions };
}

// --- §5.1 #1 Ladder monotonicity ------------------------------------------

test('#1 ladder monotonicity: each ladder non-empty, maxBitrate non-increasing', () => {
  const keys = ['studentVideo', 'teacherVideo', 'teacherAudio', 'studentAudio'];
  for (const k of keys) {
    const rungs = LADDER[k];
    assert.ok(Array.isArray(rungs) && rungs.length > 0, `${k} non-empty`);
    assert.ok(Object.isFrozen(rungs), `${k} frozen`);
    for (let i = 1; i < rungs.length; i++) {
      assert.ok(
        rungs[i].maxBitrate <= rungs[i - 1].maxBitrate,
        `${k} rung ${i} maxBitrate non-increasing`
      );
    }
  }
});

// --- §5.1 #2 Student audio floor constant ---------------------------------

test('#2 student audio floor is 96_000 on last rung', () => {
  const sa = LADDER.studentAudio;
  assert.equal(sa[sa.length - 1].maxBitrate, 96000);
});

// --- §5.1 #3 Teacher audio floor constant ---------------------------------

test('#3 teacher audio floor is 48_000 on last rung', () => {
  const ta = LADDER.teacherAudio;
  assert.equal(ta[ta.length - 1].maxBitrate, 48000);
});

// --- §5.1 #4 decideNextRung is pure ----------------------------------------

test('#4 decideNextRung is pure (same input → deep-equal output)', () => {
  const roles = ['student', 'teacher'];
  const samples = [
    [good('video'), good('audio')],
    [bad('video'), bad('audio')],
    [
      { kind: 'video', dir: 'outbound', lossFraction: 0.03, rttMs: 250 },
      { kind: 'audio', dir: 'outbound', lossFraction: 0.03, rttMs: 250 },
    ],
  ];
  for (const role of roles) {
    for (const s of samples) {
      const state = initLadderState(role);
      const a = decideNextRung(state, s);
      const b = decideNextRung(state, s);
      assert.deepEqual(a, b);
    }
  }
});

// --- §5.1 #5 Video-before-audio ordering (student) ------------------------
// Video has vLen rungs → (vLen - 1) transitions → (vLen - 1) * DEGRADE_SAMPLES ticks
// to reach terminal. Audio must not start advancing during that period.

test('#5 student: audio stays 0 while video advances to terminal', () => {
  const vLen = LADDER.studentVideo.length;
  const { state } = drive(
    initLadderState('student'), bad, 'student',
    DEGRADE_SAMPLES * (vLen - 1)
  );
  assert.equal(state.videoRung, vLen - 1);
  assert.equal(state.audioRung, 0);
});

// --- §5.1 #6 Audio advances after video exhaustion (student) --------------

test('#6 student: audio advances after video exhausted', () => {
  const vLen = LADDER.studentVideo.length;
  const prime = drive(
    initLadderState('student'), bad, 'student',
    DEGRADE_SAMPLES * (vLen - 1)
  );
  const { state } = drive(prime.state, bad, 'student', DEGRADE_SAMPLES);
  assert.equal(state.videoRung, vLen - 1);
  assert.equal(state.audioRung, 1);
});

// --- §5.1 #6a Video-before-audio ordering (teacher) -----------------------

test('#6a teacher: audio stays 0 while video advances to terminal', () => {
  const vLen = LADDER.teacherVideo.length;
  const { state } = drive(
    initLadderState('teacher'), bad, 'teacher',
    DEGRADE_SAMPLES * (vLen - 1)
  );
  assert.equal(state.videoRung, vLen - 1);
  assert.equal(state.audioRung, 0);
});

// --- §5.1 #6b Teacher audio advances after video exhaustion ---------------

test('#6b teacher: audio advances after video exhausted; no floor_violation emitted', () => {
  const vLen = LADDER.teacherVideo.length;
  const aLen = LADDER.teacherAudio.length;
  const prime = drive(initLadderState('teacher'), bad, 'teacher', DEGRADE_SAMPLES * (vLen - 1));
  let s = prime.state;
  let sawFloorViolation = false;
  // Drive enough bad ticks to reach teacher audio terminal rung (3).
  for (let i = 0; i < DEGRADE_SAMPLES * aLen + FLOOR_SAMPLES + 4; i++) {
    const r = decideNextRung(s, [bad('video'), bad('audio')]);
    s = r.next;
    if (r.actions.some((a) => a.type === 'floor_violation')) sawFloorViolation = true;
  }
  assert.equal(s.videoRung, vLen - 1);
  assert.equal(s.audioRung, aLen - 1);
  assert.equal(sawFloorViolation, false);
});

// --- §5.1 #7 Hysteresis ----------------------------------------------------

test('#7 hysteresis: alternating good/bad for 20 ticks does not change rungs', () => {
  let s = initLadderState('student');
  for (let i = 0; i < 20; i++) {
    const sample = i % 2 === 0 ? bad : good;
    const r = decideNextRung(s, [sample('video'), sample('audio')]);
    s = r.next;
  }
  assert.equal(s.videoRung, 0);
  assert.equal(s.audioRung, 0);
});

// --- §5.1 #8 Upgrade is slower than degrade -------------------------------

test('#8 upgrade requires IMPROVE_SAMPLES, not DEGRADE_SAMPLES', () => {
  // Prime to video rung 2.
  let s = initLadderState('student');
  const primed = drive(s, bad, 'student', DEGRADE_SAMPLES * 2);
  assert.ok(primed.state.videoRung >= 2);
  // 4 good ticks: no upgrade (IMPROVE_SAMPLES is 8).
  const partial = drive(primed.state, good, 'student', 4);
  assert.equal(partial.state.videoRung, primed.state.videoRung);
  // 8 good ticks: upgrade by 1.
  const full = drive(primed.state, good, 'student', IMPROVE_SAMPLES);
  assert.equal(full.state.videoRung, primed.state.videoRung - 1);
});

// --- §5.1 #9 Floor-breach streak (one-shot) -------------------------------

test('#9 student: floorBreachStreak emits exactly one floor_violation', () => {
  const saLen = LADDER.studentAudio.length;
  const vLen = LADDER.studentVideo.length;
  // Prime to studentAudio rung 1 (terminal). That's (vLen - 1) video transitions
  // to exhaust video, plus DEGRADE_SAMPLES more ticks to advance audio to rung 1.
  let s = initLadderState('student');
  s = drive(s, bad, 'student', DEGRADE_SAMPLES * (vLen - 1)).state;
  s = drive(s, bad, 'student', DEGRADE_SAMPLES).state;
  assert.equal(s.audioRung, saLen - 1);
  // Now count floor_violation emissions over FLOOR_SAMPLES + 10 bad ticks.
  // The streak starts at 1 (the tick that advanced audio to terminal), so
  // floor_violation fires after FLOOR_SAMPLES - 1 more bad ticks.
  let violations = 0;
  for (let i = 0; i < FLOOR_SAMPLES + 10; i++) {
    const r = decideNextRung(s, [bad('video'), bad('audio')]);
    s = r.next;
    violations += r.actions.filter((a) => a.type === 'floor_violation').length;
  }
  assert.equal(violations, 1, 'exactly one floor_violation (one-shot)');
});

// --- §5.1 #10 Student audio floor — both fields ---------------------------

test('#10 encodingParamsForRung studentAudio rung 1 writes both maxBitrate and minBitrate', () => {
  const p = encodingParamsForRung('studentAudio', 1);
  assert.equal(p.maxBitrate, 96000);
  assert.equal(p.minBitrate, 96000);
});

// --- §5.1 #10a minBitrate is studentAudio rung-1 only ---------------------

test('#10a minBitrate is written only at studentAudio rung 1', () => {
  // studentAudio rung 0 has no minBitrate
  assert.equal('minBitrate' in encodingParamsForRung('studentAudio', 0), false);
  // other ladders: every rung has no minBitrate
  const others = ['teacherAudio', 'studentVideo', 'teacherVideo'];
  for (const key of others) {
    for (let i = 0; i < LADDER[key].length; i++) {
      assert.equal(
        'minBitrate' in encodingParamsForRung(key, i),
        false,
        `${key} rung ${i} must not have minBitrate`
      );
    }
  }
});

// --- §5.1 #11 Teacher audio floor ------------------------------------------

test('#11 encodingParamsForRung teacherAudio rung 3 returns maxBitrate 48_000 without minBitrate', () => {
  const p = encodingParamsForRung('teacherAudio', 3);
  assert.equal(p.maxBitrate, 48000);
  assert.equal('minBitrate' in p, false);
});

// --- §5.1 #12 Video terminal rung ------------------------------------------

test('#12 video terminal rung returns active:false, maxBitrate:0', () => {
  for (const key of ['studentVideo', 'teacherVideo']) {
    const terminal = LADDER[key].length - 1;
    const p = encodingParamsForRung(key, terminal);
    assert.equal(p.active, false);
    assert.equal(p.maxBitrate, 0);
    assert.equal(p.scaleResolutionDownBy, 4.0);
  }
});

// --- §5.1 #13 Video non-terminal rung --------------------------------------

test('#13 video rung 0 returns active:true with full-res bitrate', () => {
  const p = encodingParamsForRung('studentVideo', 0);
  assert.equal(p.active, true);
  assert.ok(p.maxBitrate > 0);
  assert.equal(p.scaleResolutionDownBy, 1.0);
});

// --- §5.1 #14 Invalid rung -------------------------------------------------

test('#14 invalid rung index throws RangeError', () => {
  assert.throws(() => encodingParamsForRung('studentVideo', 99), RangeError);
  assert.throws(() => encodingParamsForRung('studentVideo', -1), RangeError);
  assert.throws(() => encodingParamsForRung('unknownKey', 0), RangeError);
});

// --- §5.1 #15 Audio has no scaleResolutionDownBy --------------------------

test('#15 audio params have no scaleResolutionDownBy', () => {
  assert.equal('scaleResolutionDownBy' in encodingParamsForRung('studentAudio', 0), false);
  assert.equal('scaleResolutionDownBy' in encodingParamsForRung('teacherAudio', 0), false);
});

// --- §5.1 #16 floorViolated true when student at FLOOR_SAMPLES -------------

test('#16 floorViolated true for student with floorBreachStreak >= FLOOR_SAMPLES', () => {
  const s = initLadderState('student');
  s.floorBreachStreak = FLOOR_SAMPLES;
  assert.equal(floorViolated(s), true);
});

// --- §5.1 #17 floorViolated false one-shy ---------------------------------

test('#17 floorViolated false at FLOOR_SAMPLES - 1', () => {
  const s = initLadderState('student');
  s.floorBreachStreak = FLOOR_SAMPLES - 1;
  assert.equal(floorViolated(s), false);
});

// --- §5.1 #18 floorViolated false for teacher ------------------------------

test('#18 floorViolated false for teacher at FLOOR_SAMPLES', () => {
  const s = initLadderState('teacher');
  s.floorBreachStreak = FLOOR_SAMPLES;
  assert.equal(floorViolated(s), false);
});

// --- §5.2 Failure-path coverage -------------------------------------------

test('§5.2 decideNextRung with null lossFraction: no rung change, no crash', () => {
  const s = initLadderState('student');
  const sample = { kind: 'video', dir: 'outbound', lossFraction: null, rttMs: null };
  let cur = s;
  for (let i = 0; i < DEGRADE_SAMPLES + 2; i++) {
    const r = decideNextRung(cur, [sample, { ...sample, kind: 'audio' }]);
    cur = r.next;
  }
  assert.equal(cur.videoRung, 0);
  assert.equal(cur.audioRung, 0);
});

test('§5.2 decideNextRung with oversized rung index: clamped, no throw', () => {
  const s = initLadderState('student');
  s.videoRung = 999; // simulate corruption
  s.audioRung = 999;
  assert.doesNotThrow(() => {
    const r = decideNextRung(s, [bad('video'), bad('audio')]);
    assert.ok(r.next.videoRung < LADDER.studentVideo.length);
    assert.ok(r.next.audioRung < LADDER.studentAudio.length);
  });
});

test('§5.2 teacher state never advances studentAudio ladder', () => {
  // Drive enough bad ticks to exhaust every teacher rung.
  let s = initLadderState('teacher');
  for (let i = 0; i < 100; i++) {
    const r = decideNextRung(s, [bad('video'), bad('audio')]);
    s = r.next;
  }
  assert.equal(s.role, 'teacher');
  assert.equal(s.audioRung, LADDER.teacherAudio.length - 1);
});

test('§5.2 decideNextRung preserves role through transitions', () => {
  for (const role of ['student', 'teacher']) {
    let s = initLadderState(role);
    for (let i = 0; i < 10; i++) {
      const r = decideNextRung(s, [bad('video'), bad('audio')]);
      s = r.next;
      assert.equal(s.role, role);
    }
  }
});

test('floorViolationEmitted resets on sustained good audio and re-fires on next streak', () => {
  // Prime to studentAudio rung 1 then emit floor_violation.
  const vLen = LADDER.studentVideo.length;
  let s = initLadderState('student');
  s = drive(s, bad, 'student', DEGRADE_SAMPLES * (vLen - 1)).state;
  s = drive(s, bad, 'student', DEGRADE_SAMPLES).state;
  // Drive enough bad ticks to trip the first floor_violation.
  let firstEmitted = 0;
  for (let i = 0; i < FLOOR_SAMPLES + 2; i++) {
    const r = decideNextRung(s, [bad('video'), bad('audio')]);
    s = r.next;
    firstEmitted += r.actions.filter((a) => a.type === 'floor_violation').length;
  }
  assert.equal(firstEmitted, 1);
  assert.equal(s.floorViolationEmitted, true);
  // Now feed sustained good audio. The streak resets; floorViolationEmitted
  // resets to false the first time a good sample is observed at the floor rung.
  // (Video still bad — audio rung stays terminal, which is exactly the
  // intersection in which the reset applies.)
  const goodAudioBadVideo = [bad('video'), good('audio')];
  const r = decideNextRung(s, goodAudioBadVideo);
  s = r.next;
  assert.equal(s.floorBreachStreak, 0);
  assert.equal(s.floorViolationEmitted, false);
  // Now start a NEW streak of bad audio — should re-fire once.
  let secondEmitted = 0;
  for (let i = 0; i < FLOOR_SAMPLES + 2; i++) {
    const r2 = decideNextRung(s, [bad('video'), bad('audio')]);
    s = r2.next;
    secondEmitted += r2.actions.filter((a) => a.type === 'floor_violation').length;
  }
  assert.equal(secondEmitted, 1, 'second floor_violation fires after reset');
});

test('§5.2 actions never target track.enabled', () => {
  let s = initLadderState('student');
  for (let i = 0; i < 30; i++) {
    const r = decideNextRung(s, [bad('video'), bad('audio')]);
    s = r.next;
    for (const a of r.actions) {
      assert.ok(!/^setTrackEnabled/.test(a.type), `unexpected action type ${a.type}`);
      assert.ok(
        ['setVideoEncoding', 'setAudioEncoding', 'floor_violation'].includes(a.type)
      );
    }
  }
});
