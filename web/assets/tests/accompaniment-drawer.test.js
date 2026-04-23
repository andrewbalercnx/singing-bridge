// File: web/assets/tests/accompaniment-drawer.test.js
// Purpose: Unit tests for accompaniment-drawer.js: audio lifecycle, rAF bar-advancement,
//          clock skew clamping, teacher/student roles, validation, and edge cases.
// Last updated: Sprint 14 (2026-04-23) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Global stubs — installed before module load
// ---------------------------------------------------------------------------

var fakeNow = 1_000_000;
globalThis.Date = { now: function () { return fakeNow; } };

var rafCallbacks = [];
var rafSeq = 0;
globalThis.requestAnimationFrame = function (cb) {
  rafSeq++;
  rafCallbacks.push({ id: rafSeq, cb: cb });
  return rafSeq;
};
globalThis.cancelAnimationFrame = function (id) {
  rafCallbacks = rafCallbacks.filter(function (r) { return r.id !== id; });
};

var lastAudio = null;
function makeAudioStub() {
  var listeners = {};
  var stub = {
    src: '',
    currentTime: 0,
    paused: true,
    play: function () { stub.paused = false; return Promise.resolve(); },
    pause: function () { stub.paused = true; },
    addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire: function (ev, arg) { (listeners[ev] || []).forEach(function (f) { f(arg || {}); }); },
  };
  return stub;
}
globalThis.Audio = function () {
  lastAudio = makeAudioStub();
  return lastAudio;
};

// DOM stub — supports querySelector one level deep by className substring.
function makeEl() {
  var _hidden = false;
  var _text = '';
  var _cls = '';
  var _children = [];
  var _listeners = {};
  var _attrs = {};
  var _style = {};
  var _dataset = {};
  var el = {
    get hidden() { return _hidden; },
    set hidden(v) { _hidden = !!v; },
    get textContent() { return _text; },
    set textContent(v) { _text = String(v); },
    get className() { return _cls; },
    set className(v) { _cls = v; },
    get style() { return _style; },
    get dataset() { return _dataset; },
    type: '',
    disabled: false,
    value: '',
    setAttribute: function (k, v) { _attrs[k] = String(v); },
    getAttribute: function (k) { return _attrs[k] || null; },
    addEventListener: function (ev, fn) { (_listeners[ev] = _listeners[ev] || []).push(fn); },
    appendChild: function (c) { _children.push(c); return c; },
    insertBefore: function (c, ref) {
      var idx = _children.indexOf(ref);
      if (idx === -1) _children.push(c);
      else _children.splice(idx, 0, c);
      return c;
    },
    contains: function (c) { return _children.indexOf(c) !== -1; },
    removeChild: function (c) { _children = _children.filter(function (x) { return x !== c; }); return c; },
    querySelector: function (sel) {
      var cls = sel.replace(/^\./, '');
      for (var i = 0; i < _children.length; i++) {
        var c = _children[i];
        if (c && c.className && c.className.indexOf(cls) !== -1) return c;
      }
      return null;
    },
    querySelectorAll: function () { return []; },
    _children: _children,
    _listeners: _listeners,
    _fire: function (ev, arg) { (_listeners[ev] || []).forEach(function (f) { f(arg || {}); }); },
  };
  return el;
}
globalThis.document = { createElement: function () { return makeEl(); } };

const drawer = require('../accompaniment-drawer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer() { return makeEl(); }

function makeSendWs() {
  var sent = [];
  return {
    fn: function (msg) { sent.push(msg); },
    sent: sent,
  };
}

function makeScoreView() {
  var calls = [];
  return {
    seekToBar: function (bar) { calls.push(bar); },
    updatePages: function () {},
    calls: calls,
  };
}

// Drain one round of rAF callbacks (each callback may schedule new ones).
function drainRaf() {
  var cbs = rafCallbacks.slice();
  rafCallbacks = [];
  cbs.forEach(function (r) { r.cb(); });
}

function setup(role) {
  lastAudio = null;
  rafCallbacks = [];
  fakeNow = 1_000_000;
  var ws = makeSendWs();
  var sv = makeScoreView();
  var container = makeContainer();
  var handle = drawer.mount(container, { role: role || 'teacher', sendWs: ws.fn });
  handle.setScoreView(sv);
  return { handle: handle, ws: ws, sv: sv, container: container };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('teacher role: play/pause/stop buttons present', function () {
  var { container } = setup('teacher');
  var root = container._children[0];
  // controls is the second child (first is statusEl)
  var controls = root._children[1];
  assert.ok(controls.querySelector('.sb-btn-play'), 'play button exists');
  assert.ok(controls.querySelector('.sb-btn-pause'), 'pause button exists');
  assert.ok(controls.querySelector('.sb-btn-stop'), 'stop button exists');
});

test('student role: no play/pause/stop buttons', function () {
  var { container } = setup('student');
  var root = container._children[0];
  // Only statusEl — no controls child.
  assert.strictEqual(root._children.length, 1, 'no controls child');
  var statusEl = root._children[0];
  assert.ok(statusEl.className.indexOf('sb-accompaniment-status') !== -1);
});

test('updateState playing: Audio.play() called', function () {
  var { handle } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  assert.ok(lastAudio, 'Audio created');
  assert.ok(!lastAudio.paused, 'audio.play() called');
});

test('updateState paused: Audio.pause() called; rAF loop stopped', function () {
  var { handle } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  // Now send pause.
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: false,
    position_ms: 500, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  assert.ok(lastAudio.paused, 'audio paused');
  assert.strictEqual(rafCallbacks.length, 0, 'rAF loop cleared');
});

test('bar advancement tempo_pct=100: 3 s real → bar at scoreTime ≤ 3.0', function () {
  // barTimings: bar 1 at 0s, bar 2 at 1s, bar 3 at 2.0s
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 1 }, { bar: 3, time_s: 2 }];
  var { handle, sv } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: fakeNow,
  });
  // First tick ran synchronously (at time 0). Advance 3 s, drain one more tick.
  fakeNow += 3000;
  drainRaf();
  var last = sv.calls[sv.calls.length - 1];
  // At scoreTimeSec=3.0, largest time_s ≤ 3.0 is bar 3 (time_s=2)
  assert.ok(last !== undefined, 'seekToBar was called');
  var selectedTimeSec = barTimings.find(function (b) { return b.bar === last; }).time_s;
  assert.ok(selectedTimeSec <= 3.0, 'selected bar time_s ≤ 3.0');
});

test('bar advancement tempo_pct=50: 10 s real → scoreTime=5.0 (not 20.0)', function () {
  // Distinguishes correct formula (×0.5) from incorrect (×2).
  // With barTimings below: correct→bar 2 (time_s=3≤5), wrong→bar 3 (time_s=5.5≤20)
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 3 }, { bar: 3, time_s: 5.5 }];
  var { handle, sv } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 50,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: fakeNow,
  });
  fakeNow += 10000;
  drainRaf();
  var last = sv.calls[sv.calls.length - 1];
  // scoreTimeSec = 10 * 0.5 = 5.0 → time_s ≤ 5.0 → bar 2 (time_s=3)
  assert.strictEqual(last, 2, 'correct bar selected at tempo_pct=50');
});

test('clock-skew clamped: server 600 ms behind (stale) → skew clamped to +500 ms', function () {
  // server_time_ms is 600ms in the past → Date.now()-server_time_ms = +600 → clamped to +500.
  // Positive skew advances currentMs (compensates for network delay).
  // With barTimings [{bar:1,time_s:0},{bar:2,time_s:2.55}]:
  //   unclamped (+600): currentMs=2000+600=2600, score=2.6 > 2.55 → bar 2
  //   clamped   (+500): currentMs=2000+500=2500, score=2.5 < 2.55 → bar 1
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 2.55 }];
  var { handle, sv } = setup('teacher');
  var serverTime = fakeNow - 600;
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: serverTime,
  });
  fakeNow += 2000;
  drainRaf();
  var last = sv.calls[sv.calls.length - 1];
  assert.strictEqual(last, 1, 'skew clamped to +500 → bar 1 selected');
});

test('clock-skew clamped: server 600 ms ahead → skew clamped to -500 ms', function () {
  // server_time_ms 600ms ahead → Date.now()-server_time_ms = -600 → clamped to -500.
  // Negative skew delays currentMs (server over-estimated elapsed time).
  // barTimings [{bar:1,time_s:0},{bar:2,time_s:0.45}]:
  //   unclamped (-600): currentMs=1000-600=400, score=0.4 < 0.45 → bar 1
  //   clamped   (-500): currentMs=1000-500=500, score=0.5 > 0.45 → bar 2
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 0.45 }];
  var { handle, sv } = setup('teacher');
  var serverTime = fakeNow + 600;
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: serverTime,
  });
  fakeNow += 1000;
  drainRaf();
  var last = sv.calls[sv.calls.length - 1];
  assert.strictEqual(last, 2, 'skew clamped to -500 → bar 2 selected');
});

test('before-first-bar: position_ms=0, bar starts at 0.5 s → seekToBar(1)', function () {
  var barTimings = [{ bar: 1, time_s: 0.5 }];
  var { handle, sv } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: fakeNow,
  });
  // First tick at time 0: scoreTime=0 < 0.5 → findBarIndex returns 0 → bar 1.
  assert.ok(sv.calls.includes(1), 'seekToBar(1) called for before-first-bar');
});

test('after-last-bar: hold at last bar', function () {
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 2 }];
  var { handle, sv } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 10000, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: fakeNow,
  });
  var last = sv.calls[sv.calls.length - 1];
  assert.strictEqual(last, 2, 'clamped to last bar');
});

test('bar_timings null (WAV-only): seekToBar never called; no error', function () {
  var { handle, sv } = setup('teacher');
  assert.doesNotThrow(function () {
    handle.updateState({
      asset_id: 1, variant_id: 1, is_playing: true,
      position_ms: 0, tempo_pct: 100,
      wav_url: 'http://example.com/a.wav',
      bar_timings: null,
      server_time_ms: fakeNow,
    });
  });
  assert.strictEqual(sv.calls.length, 0, 'seekToBar not called');
});

test('bar_timings empty array: seekToBar never called; no error', function () {
  var { handle, sv } = setup('teacher');
  assert.doesNotThrow(function () {
    handle.updateState({
      asset_id: 1, variant_id: 1, is_playing: true,
      position_ms: 0, tempo_pct: 100,
      wav_url: 'http://example.com/a.wav',
      bar_timings: [],
      server_time_ms: fakeNow,
    });
  });
  assert.strictEqual(sv.calls.length, 0, 'seekToBar not called');
});

test('tempo_pct null falls back to 100; no crash; seekToBar called', function () {
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 1 }];
  var { handle, sv } = setup('teacher');
  assert.doesNotThrow(function () {
    handle.updateState({
      asset_id: 1, variant_id: 1, is_playing: true,
      position_ms: 0, tempo_pct: null,
      wav_url: 'http://example.com/a.wav',
      bar_timings: barTimings,
      server_time_ms: fakeNow,
    });
  });
  assert.ok(sv.calls.length > 0, 'seekToBar called despite null tempo');
});

test('Play→Pause: page_urls/bar_coords in Pause snapshot available without re-fetch', function () {
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 1 }];
  var { handle, sv } = setup('teacher');
  var updatedPages = null;
  sv.updatePages = function (urls, coords) { updatedPages = urls; };
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    page_urls: ['http://example.com/p1.png'],
    bar_coords: [{ bar: 1, page: 0, x_frac: 0.1, y_frac: 0.1, w_frac: 0.5, h_frac: 0.1 }],
    server_time_ms: fakeNow,
  });
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: false,
    position_ms: 500, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    page_urls: ['http://example.com/p1.png'],
    bar_coords: [{ bar: 1, page: 0, x_frac: 0.1, y_frac: 0.1, w_frac: 0.5, h_frac: 0.1 }],
    server_time_ms: fakeNow,
  });
  assert.deepStrictEqual(updatedPages, ['http://example.com/p1.png'], 'page_urls passed on pause');
});

test('audio ended event → AccompanimentStop sent via WS (teacher only)', function () {
  var { handle, ws } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  lastAudio._fire('ended');
  assert.ok(ws.sent.some(function (m) { return m.type === 'accompaniment_stop'; }), 'stop sent on ended');
});

test('cleared state (asset_id null): audio paused; rAF cleared; UI idle', function () {
  var { handle, sv } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: [{ bar: 1, time_s: 0 }],
    server_time_ms: fakeNow,
  });
  handle.updateState({ asset_id: null, is_playing: false, position_ms: 0, server_time_ms: fakeNow });
  assert.ok(lastAudio.paused, 'audio paused after stop');
  assert.strictEqual(rafCallbacks.length, 0, 'rAF cleared');
});

test('wav_url null: no Audio created; no error', function () {
  var { handle } = setup('teacher');
  assert.doesNotThrow(function () {
    handle.updateState({
      asset_id: 1, variant_id: 1, is_playing: true,
      position_ms: 0, tempo_pct: 100,
      wav_url: null,
      server_time_ms: fakeNow,
    });
  });
  assert.strictEqual(lastAudio, null, 'no Audio element created');
});

test('audio.onerror fires: no crash; error logged', function () {
  var { handle } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  // Fire error event — should not throw.
  assert.doesNotThrow(function () {
    lastAudio._fire('error', new Error('network error'));
  });
});

test('teardown() idempotent: no throw on double teardown', function () {
  var { handle, container } = setup('teacher');
  assert.doesNotThrow(function () {
    handle.teardown();
    handle.teardown();
  });
});

test('rapid Play/Pause/Play/Stop: no leaked rAF loop', function () {
  var barTimings = [{ bar: 1, time_s: 0 }];
  var { handle } = setup('teacher');
  var playing = {
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings, server_time_ms: fakeNow,
  };
  var paused = Object.assign({}, playing, { is_playing: false });
  var stopped = { asset_id: null, is_playing: false, position_ms: 0, server_time_ms: fakeNow };
  handle.updateState(playing);
  handle.updateState(paused);
  handle.updateState(playing);
  handle.updateState(stopped);
  assert.strictEqual(rafCallbacks.length, 0, 'no rAF loop after stop');
});

test('position_ms = 14_400_000 (max valid): accepted', function () {
  var { handle } = setup('teacher');
  assert.doesNotThrow(function () {
    handle.updateState({
      asset_id: 1, variant_id: 1, is_playing: false,
      position_ms: 14_400_000, tempo_pct: 100,
      wav_url: 'http://example.com/a.wav',
      server_time_ms: fakeNow,
    });
  });
});

test('position_ms = 14_400_001 (over max): ignored (no audio created)', function () {
  lastAudio = null;
  var { handle } = setup('teacher');
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: false,
    position_ms: 14_400_001, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  assert.strictEqual(lastAudio, null, 'state ignored for out-of-range position_ms');
});

test('tempo_pct boundary values: 1 and 400 accepted; 0 and 401 rejected', function () {
  var { handle } = setup('teacher');
  var base = {
    asset_id: 1, variant_id: 1, is_playing: false,
    position_ms: 0, wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  };
  // 1 and 400 should not throw and should create audio.
  lastAudio = null;
  handle.updateState(Object.assign({}, base, { tempo_pct: 1 }));
  assert.ok(lastAudio !== null, 'tempo_pct=1 accepted');

  lastAudio = null;
  // Re-mount to get fresh closure.
  var h2 = setup('teacher').handle;
  h2.updateState(Object.assign({}, base, { tempo_pct: 400 }));
  assert.ok(lastAudio !== null, 'tempo_pct=400 accepted');

  // 0 should be ignored.
  lastAudio = null;
  var h3 = setup('teacher').handle;
  h3.updateState(Object.assign({}, base, { tempo_pct: 0 }));
  assert.strictEqual(lastAudio, null, 'tempo_pct=0 rejected');

  // 401 should be ignored.
  lastAudio = null;
  var h4 = setup('teacher').handle;
  h4.updateState(Object.assign({}, base, { tempo_pct: 401 }));
  assert.strictEqual(lastAudio, null, 'tempo_pct=401 rejected');
});
