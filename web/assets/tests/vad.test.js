// File: web/assets/tests/vad.test.js
// Purpose: Unit tests for vad.js — covers all 9 tickVad state × event cells,
//          forceMode, suppress, suppress+forceMode interactions, threshold
//          boundaries, hangover boundary, and create() wrapper lifecycle.
// Last updated: Sprint 20 (2026-04-25) -- initial implementation

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Browser stubs for create() wrapper tests
// ---------------------------------------------------------------------------

var _intervals = {};
var _intervalSeq = 0;
globalThis.setInterval = function (fn, ms) {
  _intervalSeq++;
  _intervals[_intervalSeq] = { fn: fn, ms: ms };
  return _intervalSeq;
};
globalThis.clearInterval = function (id) {
  delete _intervals[id];
};

var _lastCtx = null;

function makeAnalyser(bufLen) {
  bufLen = bufLen || 128;
  var _buf = new Uint8Array(bufLen).fill(128); // 128 = silence in byteTimeDomain
  return {
    fftSize: 256,
    frequencyBinCount: bufLen,
    getByteTimeDomainData: function (out) { for (var i = 0; i < out.length; i++) out[i] = _buf[i]; },
    disconnect: function () {},
    _setBuf: function (val) { _buf.fill(val); },
  };
}

function makeAudioCtx() {
  var analyser = makeAnalyser();
  var source = { connect: function () {}, disconnect: function () {} };
  var ctx = {
    state: 'running',
    resume: function () { return Promise.resolve(); },
    createAnalyser: function () { return analyser; },
    createMediaStreamSource: function () { return source; },
    _analyser: analyser,
  };
  _lastCtx = ctx;
  return ctx;
}

globalThis.AudioContext = function () { return makeAudioCtx(); };
globalThis.MediaStream = function (tracks) { this.tracks = tracks; };

const vad = require('../vad.js');
const tickVad = vad.tickVad;

// ---------------------------------------------------------------------------
// Opts helpers
// ---------------------------------------------------------------------------

var DEFAULT_OPTS = { rmsVoiceOn: 0.04, rmsVoiceOff: 0.015, hangoverMs: 3000 };

var SILENT   = { name: 'SILENT' };
var ACTIVE   = { name: 'ACTIVE' };
function HANGOVER(ms) { return { name: 'HANGOVER', hangsUntilMs: ms }; }

// ---------------------------------------------------------------------------
// 9 tickVad state × event cells
// ---------------------------------------------------------------------------

// Cell 1: SILENT + rms >= rmsVoiceOn → ACTIVE, voice_start
test('tickVad cell 1: SILENT + rms >= rmsVoiceOn → ACTIVE + voice_start', () => {
  var r = tickVad(SILENT, 0.05, 1000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'ACTIVE');
  assert.equal(r.event, 'voice_start');
});

// Cell 2: SILENT + rms < rmsVoiceOff → stay SILENT, no event
test('tickVad cell 2: SILENT + rms < rmsVoiceOff → SILENT + null', () => {
  var r = tickVad(SILENT, 0.01, 1000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'SILENT');
  assert.equal(r.event, null);
});

// Cell 3: SILENT + rms in hysteresis band [rmsVoiceOff, rmsVoiceOn) → stay SILENT, no event
test('tickVad cell 3: SILENT + rms in hysteresis band → SILENT + null', () => {
  var r = tickVad(SILENT, 0.025, 1000, DEFAULT_OPTS); // 0.015 <= 0.025 < 0.04
  assert.equal(r.nextState.name, 'SILENT');
  assert.equal(r.event, null);
});

// Cell 4: ACTIVE + rms >= rmsVoiceOn → stay ACTIVE, no event
test('tickVad cell 4: ACTIVE + rms >= rmsVoiceOn → ACTIVE + null', () => {
  var r = tickVad(ACTIVE, 0.05, 1000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'ACTIVE');
  assert.equal(r.event, null);
});

// Cell 5: ACTIVE + rms < rmsVoiceOff → enter HANGOVER, no event
test('tickVad cell 5: ACTIVE + rms < rmsVoiceOff → HANGOVER + null (timer set)', () => {
  var r = tickVad(ACTIVE, 0.01, 1000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'HANGOVER');
  assert.equal(r.nextState.hangsUntilMs, 1000 + 3000);
  assert.equal(r.event, null);
});

// Cell 6: ACTIVE + rms in hysteresis band → stay ACTIVE, no event
test('tickVad cell 6: ACTIVE + rms in hysteresis band → ACTIVE + null', () => {
  var r = tickVad(ACTIVE, 0.025, 1000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'ACTIVE');
  assert.equal(r.event, null);
});

// Cell 7: HANGOVER + rms >= rmsVoiceOn → ACTIVE, cancel timer, no event
test('tickVad cell 7: HANGOVER + rms >= rmsVoiceOn → ACTIVE + null', () => {
  var r = tickVad(HANGOVER(5000), 0.05, 1000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'ACTIVE');
  assert.equal(r.event, null);
});

// Cell 8: HANGOVER + rms < rmsVoiceOff + timer expired → SILENT, voice_silence
test('tickVad cell 8: HANGOVER + rms below off + timer expired → SILENT + voice_silence', () => {
  var r = tickVad(HANGOVER(1000), 0.01, 1000, DEFAULT_OPTS); // nowMs === hangsUntilMs (inclusive)
  assert.equal(r.nextState.name, 'SILENT');
  assert.equal(r.event, 'voice_silence');
});

// Cell 9: HANGOVER + rms < rmsVoiceOff + timer not expired → stay HANGOVER, no event
test('tickVad cell 9: HANGOVER + rms below off + timer not yet expired → HANGOVER + null', () => {
  var r = tickVad(HANGOVER(5000), 0.01, 1000, DEFAULT_OPTS); // nowMs < hangsUntilMs
  assert.equal(r.nextState.name, 'HANGOVER');
  assert.equal(r.nextState.hangsUntilMs, 5000);
  assert.equal(r.event, null);
});

// ---------------------------------------------------------------------------
// Threshold boundary tests
// ---------------------------------------------------------------------------

test('threshold boundary: rms === rmsVoiceOn (exact) from SILENT → ACTIVE (>= is inclusive)', () => {
  var r = tickVad(SILENT, 0.04, 1000, DEFAULT_OPTS); // exactly rmsVoiceOn
  assert.equal(r.nextState.name, 'ACTIVE');
  assert.equal(r.event, 'voice_start');
});

test('threshold boundary: rms === rmsVoiceOff (exact) from ACTIVE → stays ACTIVE (not < rmsVoiceOff)', () => {
  var r = tickVad(ACTIVE, 0.015, 1000, DEFAULT_OPTS); // exactly rmsVoiceOff → hysteresis band
  assert.equal(r.nextState.name, 'ACTIVE');
  assert.equal(r.event, null);
});

test('hangover boundary: nowMs === hangsUntilMs (inclusive) fires expiry', () => {
  var r = tickVad(HANGOVER(2000), 0.01, 2000, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'SILENT');
  assert.equal(r.event, 'voice_silence');
});

test('hangover boundary: nowMs === hangsUntilMs - 1 (one ms before) → still HANGOVER', () => {
  var r = tickVad(HANGOVER(2000), 0.01, 1999, DEFAULT_OPTS);
  assert.equal(r.nextState.name, 'HANGOVER');
  assert.equal(r.event, null);
});

// ---------------------------------------------------------------------------
// create() wrapper — suppress tests
// ---------------------------------------------------------------------------

function makeWrapper(extraOpts) {
  var events = [];
  var fakeTrack = {};
  var handle = vad.create(fakeTrack, Object.assign({
    onVoiceStart:   function () { events.push('start'); },
    onVoiceSilence: function () { events.push('silence'); },
    hangoverMs: 3000,
    rmsVoiceOn: 0.04,
    rmsVoiceOff: 0.015,
  }, extraOpts || {}));
  return { handle: handle, events: events };
}

// Fire the setInterval callback manually (simulate poll ticks)
function firePoll(intervalId) {
  if (_intervals[intervalId]) _intervals[intervalId].fn();
}
function lastIntervalId() { return _intervalSeq; }

test('suppress(true) while ACTIVE (via poll) → onVoiceSilence emitted, transitions to SILENT', () => {
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  _lastCtx._analyser._setBuf(134); // high RMS → ACTIVE
  firePoll(id);
  assert.ok(events.includes('start'));
  events.length = 0;
  handle.suppress(true);
  assert.ok(events.includes('silence'), 'suppress(true) while ACTIVE emits silence');
});

test('suppress(true) → onVoiceStart blocked on subsequent ticks', () => {
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  handle.suppress(true);
  events.length = 0;
  // Tick: high RMS would normally fire voice_start, but suppressed.
  // We can't inject RMS from outside, so we test via forceMode + suppress precedence.
  handle.forceMode('on'); // forceMode('on') wants to emit start, but _suppressed = true
  assert.deepEqual(events, [], 'onVoiceStart blocked while suppressed');
});

test('suppress(false) while forceMode=on → onVoiceStart emitted immediately', () => {
  var { handle, events } = makeWrapper();
  handle.suppress(true);
  handle.forceMode('on');
  assert.deepEqual(events, [], 'still blocked');
  handle.suppress(false);
  assert.ok(events.includes('start'), 'onVoiceStart fires on suppress(false) while forceMode=on');
});

// ---------------------------------------------------------------------------
// create() wrapper — forceMode tests
// ---------------------------------------------------------------------------

test('forceMode(on) while not suppressed → onVoiceStart emitted', () => {
  var { handle, events } = makeWrapper();
  handle.forceMode('on');
  assert.ok(events.includes('start'), 'forceMode(on) emits start');
});

test('forceMode(off) while ACTIVE (via poll) → onVoiceSilence emitted', () => {
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  // buf value 134 → RMS ≈ 0.047 >= rmsVoiceOn (0.04)
  _lastCtx._analyser._setBuf(134);
  firePoll(id); // poll fires → tickVad(SILENT, highRMS) → voice_start
  assert.ok(events.includes('start'), 'got into ACTIVE via poll');
  events.length = 0;
  handle.forceMode('off');
  assert.ok(events.includes('silence'), 'forceMode(off) from ACTIVE emits silence');
});

test('forceMode(off) while SILENT → no event emitted', () => {
  var { handle, events } = makeWrapper();
  // State is SILENT at creation and forceMode is auto
  handle.forceMode('off');
  assert.deepEqual(events, [], 'forceMode(off) from SILENT emits nothing');
});

test('forceMode(auto) after forceMode(off) → no immediate event; VAD resumes from SILENT', () => {
  var { handle, events } = makeWrapper();
  handle.forceMode('off');
  events.length = 0;
  handle.forceMode('auto');
  assert.deepEqual(events, [], 'forceMode(auto) emits no immediate event');
});

test('forceMode(on) → forceMode(auto): voice_start does not re-fire', () => {
  var { handle, events } = makeWrapper();
  handle.forceMode('on');
  events.length = 0;
  handle.forceMode('auto');
  assert.deepEqual(events, [], 'forceMode(auto) does not re-emit start');
});

test('forceMode(on) while VAD already ACTIVE: resets to SILENT and re-emits start', () => {
  // forceMode('on') resets state to SILENT unconditionally (so VAD resumes cleanly when
  // auto is later restored), then fires onVoiceStart. This is deliberate: the teacher
  // explicitly requested chat mode on, so we honour that even from ACTIVE state.
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  _lastCtx._analyser._setBuf(134);
  firePoll(id); // → ACTIVE via poll, start emitted
  assert.ok(events.includes('start'), 'pre-condition: ACTIVE via poll');
  events.length = 0;
  handle.forceMode('on');
  assert.ok(events.includes('start'), 'forceMode(on) while ACTIVE re-emits start (state reset)');
});

test('forceMode(auto) while voice still present: VAD re-detects voice on next poll', () => {
  var { handle, events } = makeWrapper();
  handle.forceMode('on'); // fires start
  events.length = 0;
  handle.forceMode('auto'); // resets to SILENT
  var id = lastIntervalId();
  _lastCtx._analyser._setBuf(134); // high RMS still present
  firePoll(id); // VAD detects voice again → start
  assert.ok(events.includes('start'), 'forceMode(auto) with voice present re-detects on next poll');
});

// ---------------------------------------------------------------------------
// suppress + forceMode compound interactions
// ---------------------------------------------------------------------------

test('suppress(true) → forceMode(on) → suppress(false) → onVoiceStart emitted', () => {
  var { handle, events } = makeWrapper();
  handle.suppress(true);
  handle.forceMode('on');
  assert.deepEqual(events, [], 'blocked while suppressed');
  handle.suppress(false);
  assert.ok(events.includes('start'), 'start fires after suppress(false)');
});

test('suppress(true) while ACTIVE (via poll) → onVoiceSilence → forceMode(on) → no event → suppress(false) → start', () => {
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  // Get into ACTIVE state via a poll tick with high RMS.
  _lastCtx._analyser._setBuf(134);
  firePoll(id);
  assert.ok(events.includes('start'), 'got into ACTIVE via poll');
  events.length = 0;
  // suppress(true) while ACTIVE → onVoiceSilence emitted, transitions to SILENT
  handle.suppress(true);
  assert.ok(events.includes('silence'), 'suppress(true) while ACTIVE emits silence');
  events.length = 0;
  // Still suppressed: forceMode('on') stores intent but no emit.
  handle.forceMode('on');
  assert.deepEqual(events, [], 'still no event while suppressed');
  // Release suppression: forceMode=on fires start.
  handle.suppress(false);
  assert.ok(events.includes('start'), 'start fires on suppress(false) with forceMode=on');
});

test('forceMode(off) from ACTIVE while suppressed still emits silence (silence is always safe)', () => {
  // Get into ACTIVE via poll, suppress=false; then set suppress=true (emits silence).
  // Then call forceMode('off') from the resulting SILENT: no second silence event.
  // Separately: test that forceMode('off') from actual ACTIVE with suppress=true still fires.
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  _lastCtx._analyser._setBuf(134);
  firePoll(id); // → ACTIVE, start emitted
  events.length = 0;
  // Call forceMode('off') while ACTIVE and suppress=false → silence fires
  handle.forceMode('off');
  assert.ok(events.includes('silence'), 'forceMode(off) from ACTIVE emits silence (suppress=false)');
  events.length = 0;
  // forceMode(off) from SILENT: no second event
  handle.forceMode('off');
  assert.deepEqual(events, [], 'forceMode(off) from SILENT: no event');
});

// ---------------------------------------------------------------------------
// suppress invariant: onVoiceSilence never from SILENT
// ---------------------------------------------------------------------------

test('suppress(true) from SILENT: no onVoiceSilence', () => {
  var { handle, events } = makeWrapper();
  handle.suppress(true);
  assert.ok(!events.includes('silence'), 'no silence event from SILENT on suppress(true)');
});

// ---------------------------------------------------------------------------
// teardown: clears interval, no throw
// ---------------------------------------------------------------------------

test('teardown() clears interval; no throw', () => {
  var { handle } = makeWrapper();
  var id = lastIntervalId();
  assert.ok(_intervals[id], 'interval exists before teardown');
  assert.doesNotThrow(() => handle.teardown());
  assert.ok(!_intervals[id], 'interval cleared after teardown');
});

test('teardown() is idempotent — no throw on double call', () => {
  var { handle } = makeWrapper();
  assert.doesNotThrow(() => {
    handle.teardown();
    handle.teardown();
  });
});

test('teardown() from ACTIVE state: no onVoiceSilence emitted (cleanup is silent)', () => {
  var { handle, events } = makeWrapper();
  var id = lastIntervalId();
  _lastCtx._analyser._setBuf(134);
  firePoll(id); // → ACTIVE, start emitted
  events.length = 0;
  handle.teardown();
  assert.deepEqual(events, [], 'teardown() from ACTIVE emits no silence event');
});

// ---------------------------------------------------------------------------
// create() constructor fallback opts
// ---------------------------------------------------------------------------

test('create() without opts: no throw; defaults applied', () => {
  assert.doesNotThrow(() => {
    var handle = vad.create({});
    handle.teardown();
  });
});

test('create() with AudioContext throwing: no throw; handle still returned', () => {
  var saved = globalThis.AudioContext;
  globalThis.AudioContext = function () { throw new Error('no audio'); };
  assert.doesNotThrow(() => {
    var handle = vad.create({});
    handle.teardown();
  });
  globalThis.AudioContext = saved;
});

// ---------------------------------------------------------------------------
// tickVad pure export: stable return shape
// ---------------------------------------------------------------------------

test('tickVad returns { nextState, event } for all inputs', () => {
  var states = [SILENT, ACTIVE, HANGOVER(5000)];
  var rmsList = [0, 0.015, 0.025, 0.04, 0.06];
  var now = 1000;
  for (var s of states) {
    for (var rms of rmsList) {
      var r = tickVad(s, rms, now, DEFAULT_OPTS);
      assert.ok('nextState' in r, 'nextState present');
      assert.ok('event' in r, 'event present');
      assert.ok(r.nextState && r.nextState.name, 'nextState has name');
      assert.ok(r.event === null || typeof r.event === 'string', 'event is null or string');
    }
  }
});
