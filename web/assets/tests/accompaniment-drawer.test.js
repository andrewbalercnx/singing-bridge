// File: web/assets/tests/accompaniment-drawer.test.js
// Purpose: Unit tests for accompaniment-drawer.js: audio lifecycle, rAF bar-advancement,
//          clock skew clamping, teacher/student roles, validation, edge cases,
//          panelEl path (Sprint 17 v2 layout), and acoustic profile muting (Sprint 20).
// Last updated: Sprint 26 (2026-05-07) -- lobby mode tests (Tests 1-12)

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
    muted: false,
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
globalThis.document = { createElement: function (tag) { var el = makeEl(); el.tag = tag; return el; } };

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

// ---------------------------------------------------------------------------
// panelEl path (Sprint 17 — inline accmpPanel integration)
// ---------------------------------------------------------------------------

function makePanelEl() {
  var positionMs = 0;
  var durationMs = 0;
  var trackName = 'No track selected';
  var pausedState = true;
  var setLobbyModeCalls = [];
  var pauseClickListeners = [];
  var pauseBtn = {
    addEventListener: function (ev, fn) {
      if (ev === 'click') pauseClickListeners.push(fn);
    },
    setAttribute: function (k, v) { pauseBtn[k] = v; },
    getAttribute: function (k) { return pauseBtn[k] || null; },
    firePauseClick: function () { pauseClickListeners.forEach(function (f) { f(); }); },
    _fire: function (ev) { if (ev === 'click') pauseClickListeners.forEach(function (f) { f(); }); },
  };
  var trackSel = makeEl();
  trackSel.options = [{ value: '', disabled: true }];
  trackSel.remove = function (i) { trackSel.options.splice(i, 1); };
  trackSel.value = '';
  // Bridge appendChild → options so setAssetList (<option>) and setTrackList (<optgroup>) work.
  var _tsAppend = trackSel.appendChild.bind(trackSel);
  trackSel.appendChild = function (child) {
    _tsAppend(child);
    if (child && child.tag === 'option') {
      trackSel.options.push(child);
    } else if (child && child.tag === 'optgroup') {
      (child._children || []).forEach(function (c) {
        if (c && c.tag === 'option') trackSel.options.push(c);
      });
    }
    return child;
  };
  return {
    pauseBtn: pauseBtn,
    scoreToggleBtn: { addEventListener: function () {} },
    trackSelect: trackSel,
    setTrackName: function (name) { trackName = name; },
    setPosition: function (ms) { positionMs = ms; },
    setDuration: function (ms) { durationMs = ms; },
    setPaused: function (v) { pausedState = v; },
    getSlider: function () { return { addEventListener: function () {}, value: '0', max: '0' }; },
    setLobbyMode: function (on) { setLobbyModeCalls.push(on); },
    _setLobbyModeCalls: setLobbyModeCalls,
    _get: function () { return { positionMs: positionMs, durationMs: durationMs, trackName: trackName, pausedState: pausedState }; },
  };
}

function setupPanelEl() {
  lastAudio = null;
  rafCallbacks = [];
  fakeNow = 1_000_000;
  var ws = makeSendWs();
  var panelEl = makePanelEl();
  var handle = drawer.mount(null, { role: 'teacher', panelEl: panelEl, sendWs: ws.fn });
  return { handle: handle, ws: ws, panelEl: panelEl };
}

test('panelEl: updateState playing sets panelEl track name and unpauses', function () {
  var { handle, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 5000, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  var state = panelEl._get();
  assert.equal(state.pausedState, false, 'panelEl must show playing (paused=false)');
  assert.equal(state.positionMs, 5000, 'panelEl position must match server position');
});

test('panelEl: updateState paused sets pausedState=true', function () {
  var { handle, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: false,
    position_ms: 2000, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  assert.equal(panelEl._get().pausedState, true, 'panelEl must show paused');
});

test('panelEl: cleared state resets track name', function () {
  var { handle, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100, wav_url: 'http://example.com/a.wav', server_time_ms: fakeNow,
  });
  handle.updateState({ asset_id: null, is_playing: false, position_ms: 0, server_time_ms: fakeNow });
  assert.equal(panelEl._get().trackName, null, 'track name cleared to null on stop');
});

test('panelEl: pauseBtn click while playing sends accompaniment_pause', function () {
  var { handle, ws, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 1, variant_id: 2, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  panelEl.pauseBtn.firePauseClick();
  assert.ok(ws.sent.some(function (m) { return m.type === 'accompaniment_pause'; }), 'pause WS message sent');
});

test('panelEl: pauseBtn click while paused sends accompaniment_play', function () {
  var { handle, ws, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 3, variant_id: 4, is_playing: false,
    position_ms: 1000, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  panelEl.pauseBtn.firePauseClick();
  var playMsg = ws.sent.find(function (m) { return m.type === 'accompaniment_play'; });
  assert.ok(playMsg, 'play WS message sent on resume');
  assert.equal(playMsg.asset_id, 3);
  assert.equal(playMsg.variant_id, 4);
});

test('panelEl: rAF tick updates panelEl position', function () {
  var { handle, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 10000, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  // Advance time by 500ms and fire one rAF tick
  fakeNow += 500;
  drainRaf();
  var pos = panelEl._get().positionMs;
  assert.ok(pos >= 10000, 'panelEl position must advance with time');
});

test('panelEl: no UI root built — container null does not throw', function () {
  assert.doesNotThrow(function () {
    var handle = drawer.mount(null, {
      role: 'teacher',
      panelEl: makePanelEl(),
      sendWs: function () {},
    });
    handle.teardown();
  });
});

test('panelEl: loadedmetadata fires setDuration', function () {
  var { handle, panelEl } = setupPanelEl();
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
  // Simulate audio loadedmetadata
  lastAudio.duration = 120;
  lastAudio._fire('loadedmetadata');
  assert.equal(panelEl._get().durationMs, 120000, 'setDuration called with ms from audio.duration');
});

// ---------------------------------------------------------------------------
// Acoustic profile muting (Sprint 20)
// ---------------------------------------------------------------------------

function setupWithProfile(profile) {
  lastAudio = null;
  rafCallbacks = [];
  fakeNow = 1_000_000;
  var ws = makeSendWs();
  var container = makeContainer();
  var handle = drawer.mount(container, {
    role: 'teacher',
    sendWs: ws.fn,
    acousticProfile: profile,
  });
  return { handle: handle, ws: ws, container: container };
}

function playAudio(handle) {
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    server_time_ms: fakeNow,
  });
}

test('setAcousticProfile(speakers): audio.muted = true', function () {
  var { handle } = setup('teacher');
  playAudio(handle);
  handle.setAcousticProfile('speakers');
  assert.equal(lastAudio.muted, true, 'audio.muted is true for speakers');
});

test('setAcousticProfile(headphones): audio.muted = false', function () {
  var { handle } = setup('teacher');
  playAudio(handle);
  handle.setAcousticProfile('speakers');
  handle.setAcousticProfile('headphones');
  assert.equal(lastAudio.muted, false, 'audio.muted is false for headphones');
});

test('setAcousticProfile(ios_forced): audio.muted = true (same as speakers)', function () {
  var { handle } = setup('teacher');
  playAudio(handle);
  handle.setAcousticProfile('ios_forced');
  assert.equal(lastAudio.muted, true, 'audio.muted is true for ios_forced');
});

test('mount-time acousticProfile=speakers: banner shown immediately (before audio created)', function () {
  var { container } = setupWithProfile('speakers');
  var root = container._children[0];
  var bannerEl = null;
  for (var i = 0; i < root._children.length; i++) {
    if (root._children[i].className && root._children[i].className.indexOf('sb-muting-banner') !== -1) {
      bannerEl = root._children[i];
    }
  }
  assert.ok(bannerEl, 'banner element present');
  assert.equal(bannerEl.hidden, false, 'banner visible at mount when acousticProfile=speakers');
  assert.strictEqual(lastAudio, null, 'no audio created yet at mount');
});

test('mount-time acousticProfile=headphones: banner hidden', function () {
  var { container } = setupWithProfile('headphones');
  var root = container._children[0];
  var bannerEl = null;
  for (var i = 0; i < root._children.length; i++) {
    if (root._children[i].className && root._children[i].className.indexOf('sb-muting-banner') !== -1) {
      bannerEl = root._children[i];
    }
  }
  assert.ok(bannerEl, 'banner element present');
  assert.equal(bannerEl.hidden, true, 'banner hidden at mount when acousticProfile=headphones');
});

test('mount-time acousticProfile=speakers: audio.muted=true when audio is subsequently created', function () {
  var { handle } = setupWithProfile('speakers');
  playAudio(handle); // triggers audio creation
  assert.equal(lastAudio.muted, true, 'audio created with muted=true for speakers profile');
});

test('setAcousticProfile: banner shows when muted, hides when headphones', function () {
  var { handle, container } = setup('teacher');
  var root = container._children[0];
  var bannerEl = null;
  for (var i = 0; i < root._children.length; i++) {
    if (root._children[i].className && root._children[i].className.indexOf('sb-muting-banner') !== -1) {
      bannerEl = root._children[i];
    }
  }
  assert.ok(bannerEl, 'banner element present');
  handle.setAcousticProfile('speakers');
  assert.equal(bannerEl.hidden, false, 'banner visible for speakers');
  handle.setAcousticProfile('headphones');
  assert.equal(bannerEl.hidden, true, 'banner hidden for headphones');
});

test('Sprint 14 regression: audio.currentTime tracking correct when audio.muted=true', function () {
  var { handle, sv } = setup('teacher');
  handle.setScoreView(sv);
  var barTimings = [{ bar: 1, time_s: 0 }, { bar: 2, time_s: 1 }];
  handle.updateState({
    asset_id: 1, variant_id: 1, is_playing: true,
    position_ms: 0, tempo_pct: 100,
    wav_url: 'http://example.com/a.wav',
    bar_timings: barTimings,
    server_time_ms: fakeNow,
  });
  handle.setAcousticProfile('speakers');
  // Advance time — bar advancement should still work despite muted
  fakeNow += 1500;
  drainRaf();
  var last = sv.calls[sv.calls.length - 1];
  assert.ok(last !== undefined, 'seekToBar still called when audio muted');
});

// ---------------------------------------------------------------------------
// Sprint 26 — Lobby mode tests (Tests 1-12)
// ---------------------------------------------------------------------------

test('Test 1: setTrackList idempotency — repeated calls replace _trackMap', function () {
  var panel = makePanelEl();
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false });
  h.setTrackList([{ id: 1, title: 'A', variants: [{ id: 10, label: 'x', tempo_pct: 100, token: 'tok1' }] }]);
  h.setTrackList([{ id: 2, title: 'B', variants: [{ id: 20, label: 'y', tempo_pct: 80, token: 'tok2' }] }]);
  // Only asset 2 variants should be in the select (default opt + 1 optgroup with 1 opt = 2).
  assert.strictEqual(panel.trackSelect.options.length, 2);
  assert.ok(String(panel.trackSelect.options[1].value).includes('2:20'));
});

test('Test 2: setSendWs — live WS called after exitLobbyMode', function () {
  var panel = makePanelEl();
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, sendWs: function () {} });
  var sent = [];
  h.setSendWs(function (msg) { sent.push(msg); });
  h.exitLobbyMode();
  // Set assetId/variantId via live-mode trackSelect change.
  panel.trackSelect.value = '1:2';
  panel.trackSelect._fire('change');
  panel.pauseBtn._fire('click');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'accompaniment_play');
});

test('Test 3: updateState is no-op in lobby mode', function () {
  lastAudio = null;
  var panel = makePanelEl();
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true });
  h.updateState({ asset_id: 1, variant_id: 2, is_playing: true, position_ms: 0,
                  wav_url: 'http://x/a.wav', server_time_ms: fakeNow });
  assert.strictEqual(lastAudio, null, 'no Audio created in lobby mode');
});

test('Test 4: lobby click — no Audio when token missing from cache', function () {
  var panel = makePanelEl();
  var fetchCalls = [];
  var origFetch = globalThis.fetch;
  globalThis.fetch = function (url) {
    fetchCalls.push(url);
    return Promise.reject(new Error('no server'));
  };
  try {
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/assets' });
    panel.trackSelect.value = '5';
    panel.trackSelect._fire('change');
    lastAudio = null;
    panel.pauseBtn._fire('click');
    assert.strictEqual(lastAudio, null);
    assert.strictEqual(fetchCalls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Test 4b: lobby click — second click while fetch in flight does not issue duplicate fetch', function () {
  var panel = makePanelEl();
  var fetchCalls = [];
  var origFetch = globalThis.fetch;
  globalThis.fetch = function (url) {
    fetchCalls.push(url);
    return new Promise(function () {});  // never resolves
  };
  try {
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/assets' });
    panel.trackSelect.value = '5';
    panel.trackSelect._fire('change');
    panel.pauseBtn._fire('click');   // first click → fetch started
    panel.pauseBtn._fire('click');   // second click → suppressed
    panel.pauseBtn._fire('click');   // third click → suppressed
    assert.strictEqual(fetchCalls.length, 1, 'only one fetch issued');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Test 4c: lobby click — second preview click uses cached token without fetching again', function () {
  var panel = makePanelEl();
  var origFetch = globalThis.fetch;
  var origAudio = globalThis.Audio;
  var fetchCount = 0;
  var audios = [];
  var fetchResolvers = [];
  globalThis.fetch = function () {
    fetchCount++;
    return new Promise(function (res) { fetchResolvers.push(res); });
  };
  globalThis.Audio = function () {
    var a = makeAudioStub();
    audios.push(a);
    return a;
  };
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
  panel.trackSelect.value = '3';
  panel.trackSelect._fire('change');
  panel.pauseBtn._fire('click');  // first click → lazy fetch
  assert.strictEqual(fetchCount, 1, 'first click triggers fetch');
  fetchResolvers[0]({ json: function () { return Promise.resolve({
    variants: [{ id: 7, label: 'x', tempo_pct: 100, token: 'cached-tok' }]
  }); }});
  return new Promise(function (resolve) {
    setTimeout(function () {
      try {
        assert.strictEqual(audios.length, 1, 'audio created after fetch');
        audios[0]._fire('ended');  // _lobbyAudio cleared
        panel.pauseBtn._fire('click');  // second click: _variantId set → cache hit
        assert.strictEqual(fetchCount, 1, 'no second fetch — cache hit');
        assert.strictEqual(audios.length, 2, 'new Audio created from cache');
      } finally {
        globalThis.fetch = origFetch;
        globalThis.Audio = origAudio;
      }
      resolve();
    }, 10);
  });
});

test('Test 5a: lobby audio — _lobbyAudio reset on error event', function () {
  var panel = makePanelEl();
  var origFetch = globalThis.fetch;
  var origAudio = globalThis.Audio;
  var audios = [];
  var fetchResolvers = [];
  globalThis.fetch = function () {
    return new Promise(function (res) { fetchResolvers.push(res); });
  };
  globalThis.Audio = function () {
    var a = makeAudioStub();
    audios.push(a);
    return a;
  };
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
  panel.trackSelect.value = '1';
  panel.trackSelect._fire('change');
  panel.pauseBtn._fire('click');  // lazy fetch
  fetchResolvers[0]({ json: function () { return Promise.resolve({
    variants: [{ id: 2, label: 'x', tempo_pct: 100, token: 'abc' }]
  }); }});
  return new Promise(function (resolve) {
    setTimeout(function () {
      try {
        assert.strictEqual(audios.length, 1, 'audio created after fetch');
        audios[0]._fire('error');  // _lobbyAudio cleared; _variantId still set
        panel.pauseBtn._fire('click');  // cache hit → new Audio
        assert.strictEqual(audios.length, 2, 'new audio created after error (from cache)');
        assert.notStrictEqual(audios[1], audios[0], 'different Audio instance');
      } finally {
        globalThis.fetch = origFetch;
        globalThis.Audio = origAudio;
      }
      resolve();
    }, 10);
  });
});

test('Test 5b: lobby audio — _lobbyAudio reset on play() rejection', function () {
  var panel = makePanelEl();
  var origAudio = globalThis.Audio;
  var audios = [];
  globalThis.Audio = function () {
    var a = makeAudioStub();
    a.play = function () { return Promise.reject(new Error('blocked')); };
    audios.push(a);
    return a;
  };
  try {
    // Mount in live mode to establish asset/variant via the live-mode change path.
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false });
    h.setTrackList([{ id: 1, title: 'T', variants: [{ id: 2, label: 'l', tempo_pct: 100, token: 'tok' }] }]);
    panel.trackSelect.value = '1:2';
    panel.trackSelect._fire('change');  // live: _assetId='1', _variantId='2', token in _trackMap
    h.enterLobbyMode();
    // Click: _variantId set → cache hit → _startLobbyPlay → Audio created → play() rejects.
    panel.pauseBtn._fire('click');
    assert.strictEqual(audios.length, 1, 'Audio constructed');
    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          panel.pauseBtn._fire('click');
          assert.strictEqual(audios.length, 2, 'new Audio created after play rejection');
        } finally {
          globalThis.Audio = origAudio;
        }
        resolve();
      }, 10);
    });
  } catch (e) {
    globalThis.Audio = origAudio;
    throw e;
  }
});

test('Test 6: enterLobbyMode/exitLobbyMode call panelEl.setLobbyMode only', function () {
  var panel = makePanelEl();
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false });
  h.enterLobbyMode();
  assert.deepStrictEqual(panel._setLobbyModeCalls, [true]);
  h.exitLobbyMode();
  assert.deepStrictEqual(panel._setLobbyModeCalls, [true, false]);
});

test('Test 8: setAssetList — renders options; idempotent; empty list leaves placeholder', function () {
  var panel = makePanelEl();
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true });
  h.setAssetList([
    { id: 1, title: 'Song A', variant_count: 1 },
    { id: 2, title: 'Song B', variant_count: 3 },
  ]);
  assert.strictEqual(panel.trackSelect.options.length, 3);
  assert.strictEqual(panel.trackSelect.options[1].textContent, 'Song A (1 variant)');
  assert.strictEqual(panel.trackSelect.options[2].textContent, 'Song B (3 variants)');
  h.setAssetList([{ id: 3, title: 'Song C', variant_count: 0 }]);
  assert.strictEqual(panel.trackSelect.options.length, 2);
  assert.strictEqual(panel.trackSelect.options[1].textContent, 'Song C (0 variants)');
  h.setAssetList([]);
  assert.strictEqual(panel.trackSelect.options.length, 1, 'only placeholder with empty list');
});

test('Test 9: reconnect — updateState(null asset_id) calls updatePages(null, null)', function () {
  var panel = makePanelEl();
  var updatePagesCalls = [];
  var scoreViewHandle = {
    updatePages: function (pages, coords) { updatePagesCalls.push({ pages: pages, coords: coords }); },
    seekToBar: function () {},
    teardown: function () {},
  };
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true });
  h.setScoreView(scoreViewHandle);
  h.exitLobbyMode();
  h.updateState({ asset_id: 5, variant_id: 1, is_playing: false, position_ms: 0,
                  page_urls: ['a.jpg'], bar_coords: [], server_time_ms: fakeNow });
  h.enterLobbyMode();
  h.exitLobbyMode();
  h.updateState({ asset_id: null, variant_id: null, is_playing: false, position_ms: 0,
                  page_urls: null, bar_coords: null, server_time_ms: fakeNow });
  var nullCall = updatePagesCalls.find(function (c) { return c.pages === null; });
  assert.ok(nullCall, 'updatePages(null, null) called — score view cleared after reconnect');
});

test('Test 10: teardown — _lobbyAudio pause called and src cleared', function () {
  var panel = makePanelEl();
  var origFetch = globalThis.fetch;
  var origAudio = globalThis.Audio;
  var fetchResolvers = [];
  var capturedAudio = null;
  globalThis.fetch = function () {
    return new Promise(function (res) { fetchResolvers.push(res); });
  };
  globalThis.Audio = function () {
    var a = makeAudioStub();
    a.src = 'blob://original';
    capturedAudio = a;
    return a;
  };
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
  panel.trackSelect.value = '1';
  panel.trackSelect._fire('change');
  panel.pauseBtn._fire('click');  // fetch starts
  fetchResolvers[0]({ json: function () { return Promise.resolve({
    variants: [{ id: 2, label: 'l', tempo_pct: 100, token: 'tok' }]
  }); }});
  return new Promise(function (resolve) {
    setTimeout(function () {
      try {
        assert.ok(capturedAudio, 'audio created');
        h.teardown();
        assert.strictEqual(capturedAudio.src, '',
          '_lobbyAudio.src cleared — proves _destroyLobbyAudio ran');
      } finally {
        globalThis.fetch = origFetch;
        globalThis.Audio = origAudio;
      }
      resolve();
    }, 10);
  });
});

test('Test 11: async race — fetch resolving after exitLobbyMode clears flag without creating audio', function () {
  var panel = makePanelEl();
  var origFetch = globalThis.fetch;
  var origAudio = globalThis.Audio;
  var fetchCount = 0;
  var audios = [];
  var fetchResolvers = [];
  globalThis.fetch = function () {
    fetchCount++;
    return new Promise(function (res) { fetchResolvers.push(res); });
  };
  globalThis.Audio = function () {
    var a = makeAudioStub();
    audios.push(a);
    return a;
  };
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
  panel.trackSelect.value = '1';
  panel.trackSelect._fire('change');
  panel.pauseBtn._fire('click');  // fetch started
  assert.strictEqual(fetchCount, 1, 'fetch started');
  h.exitLobbyMode();  // peer connects → exit lobby
  fetchResolvers[0]({ json: function () { return Promise.resolve({
    variants: [{ id: 2, label: 'x', tempo_pct: 100, token: 'tok' }]
  }); }});
  return new Promise(function (resolve) {
    setTimeout(function () {
      try {
        assert.strictEqual(audios.length, 0, 'no audio created (lobby guard fired)');
        h.enterLobbyMode();
        panel.trackSelect.value = '1';
        panel.trackSelect._fire('change');
        panel.pauseBtn._fire('click');  // should start new fetch (flag was cleared)
        assert.strictEqual(fetchCount, 2, 'second fetch started — _pendingPreviewFetch was cleared');
      } finally {
        globalThis.fetch = origFetch;
        globalThis.Audio = origAudio;
      }
      resolve();
    }, 10);
  });
});

test('Test 12: setGetOneWayLatencyMs — injected function called in live play path', function () {
  var panel = makePanelEl();
  var sent = [];
  var latencyCalls = 0;
  var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false,
                               sendWs: function (msg) { sent.push(msg); } });
  h.setGetOneWayLatencyMs(function () { latencyCalls++; return 0; });
  h.setTrackList([{ id: 1, title: 'T', variants: [{ id: 2, label: 'x', tempo_pct: 100, token: 'tok' }] }]);
  panel.trackSelect.value = '1:2';
  panel.trackSelect._fire('change');
  // Trigger audio creation so getOneWayLatencyMs is called via updateState.
  h.updateState({ asset_id: 1, variant_id: 2, is_playing: true, position_ms: 0,
                  wav_url: 'http://x/a.wav', server_time_ms: fakeNow });
  assert.ok(latencyCalls >= 1, 'injected getOneWayLatencyMs called in live play path');
});
