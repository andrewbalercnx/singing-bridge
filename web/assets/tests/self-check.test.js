// File: web/assets/tests/self-check.test.js
// Purpose: Unit tests for self-check.js: teacher sessionStorage gate (skip/show/write),
//          student path (always shows), teardown stops all tracks and removes DOM,
//          confirm callback receives headphones state.
// Last updated: Sprint 9 (2026-04-19) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const attrs = {};
  const children = [];
  let textContent = '';
  const node = {
    tag,
    get textContent() { return textContent; },
    set textContent(v) { textContent = String(v); },
    get hidden() { return !!attrs.hidden; },
    set hidden(v) { attrs.hidden = !!v; },
    className: '',
    style: { width: '' },
    type: '',
    autoplay: false,
    playsInline: false,
    muted: false,
    get checked() { return !!attrs.checked; },
    set checked(v) { attrs.checked = !!v; },
    children,
    parentNode: null,
    srcObject: null,
    play() { return Promise.resolve(); },
    appendChild(child) {
      if (child && typeof child === 'object') child.parentNode = node;
      children.push(child);
      return child;
    },
    append(...items) {
      for (const item of items) {
        if (item && typeof item === 'object') item.parentNode = node;
        children.push(item);
      }
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        if (child && typeof child === 'object') child.parentNode = null;
      }
    },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
    addEventListener(ev, fn) {
      attrs['_ev_' + ev] = attrs['_ev_' + ev] || [];
      attrs['_ev_' + ev].push(fn);
    },
    _dispatchClick() { (attrs['_ev_click'] || []).forEach(fn => fn()); },
    focus() {},
  };
  return node;
}

const body = makeEl('body');

global.document = {
  createElement(tag) { return makeEl(tag); },
  createTextNode(text) { return { tag: '#text', textContent: String(text) }; },
  body,
};

// Fake requestAnimationFrame — runs callbacks asynchronously but honours cancel.
const _rafCallbacks = {};
let _rafIdCounter = 0;
global.requestAnimationFrame = function (fn) {
  const id = ++_rafIdCounter;
  _rafCallbacks[id] = fn;
  setImmediate(function () {
    if (_rafCallbacks[id]) { const cb = _rafCallbacks[id]; delete _rafCallbacks[id]; cb(); }
  });
  return id;
};
global.cancelAnimationFrame = function (id) {
  delete _rafCallbacks[id];
};

// AudioContext disabled — prevents RAF animation loop from running in tests.
// self-check.js only starts the loop when AudioContext is defined; leaving it
// undefined here keeps the event loop clean so tests exit promptly.
// (Tests that exercise teardown of the stream still work because they pass
//  makeStream() and the stream-stop logic is AudioContext-independent.)
global.AudioContext = undefined;

// Fake sessionStorage.
let _storage = {};
global.sessionStorage = {
  getItem(k) { return _storage[k] !== undefined ? _storage[k] : null; },
  setItem(k, v) { _storage[k] = String(v); },
  removeItem(k) { delete _storage[k]; },
};

function freshMod() {
  delete require.cache[require.resolve('../self-check.js')];
  body.children.length = 0;
  _storage = {};
  return require('../self-check.js');
}

function makeStream(trackCount = 2) {
  const tracks = Array.from({ length: trackCount }, () => {
    let stopped = false;
    return { stop() { stopped = true; }, get stopped() { return stopped; } };
  });
  return {
    getTracks() { return tracks; },
    getAudioTracks() { return [tracks[0]]; },
    getVideoTracks() { return tracks[1] ? [tracks[1]] : []; },
    _tracks: tracks,
  };
}

// ---------------------------------------------------------------------------
// Teacher sessionStorage gate
// ---------------------------------------------------------------------------

test('teacher: calls onConfirm(false) immediately when sessionStorage flag is set', () => {
  const mod = freshMod();
  _storage['sb-teacher-checked'] = '1';
  const confirmed = [];
  mod.show(null, { role: 'teacher', onConfirm(hp) { confirmed.push(hp); } });
  assert.deepEqual(confirmed, [false]);
  assert.equal(body.children.length, 0, 'no overlay appended when gated');
});

test('teacher: early-return stops all stream tracks to avoid media leak', () => {
  const mod = freshMod();
  _storage['sb-teacher-checked'] = '1';
  const stream = makeStream(2);
  mod.show(stream, { role: 'teacher', onConfirm() {} });
  assert.ok(stream._tracks.every(t => t.stopped), 'tracks stopped on cache hit');
});

test('teacher: shows overlay when sessionStorage flag is NOT set', () => {
  const mod = freshMod();
  mod.show(makeStream(), { role: 'teacher', onConfirm() {} });
  assert.equal(body.children.length, 1, 'overlay appended to body');
});

test('teacher: writes sessionStorage flag on confirm', () => {
  const mod = freshMod();
  const { teardown: _t } = mod.show(makeStream(), { role: 'teacher', onConfirm() {} });
  // Find the confirm button and click it.
  function findBtn(node) {
    if (node.tag === 'button') return node;
    for (const c of (node.children || [])) {
      const f = findBtn(c);
      if (f) return f;
    }
    return null;
  }
  const btn = findBtn(body.children[0]);
  btn._dispatchClick();
  assert.equal(_storage['sb-teacher-checked'], '1');
});

test('teacher: sessionStorage flag written exactly once', () => {
  const mod = freshMod();
  const spy = [];
  const origSet = sessionStorage.setItem.bind(sessionStorage);
  sessionStorage.setItem = function (k, v) { spy.push(k); origSet(k, v); };
  mod.show(makeStream(), { role: 'teacher', onConfirm() {} });
  function findBtn(node) {
    if (node.tag === 'button') return node;
    for (const c of (node.children || [])) {
      const f = findBtn(c);
      if (f) return f;
    }
    return null;
  }
  const btn = findBtn(body.children[0]);
  btn._dispatchClick();
  assert.equal(spy.filter(k => k === 'sb-teacher-checked').length, 1);
});

// ---------------------------------------------------------------------------
// Student path
// ---------------------------------------------------------------------------

test('student: always shows overlay (no sessionStorage gate)', () => {
  const mod = freshMod();
  mod.show(makeStream(), { role: 'student', onConfirm() {} });
  assert.equal(body.children.length, 1);
});

// ---------------------------------------------------------------------------
// Confirm callback
// ---------------------------------------------------------------------------

test('confirm with headphones checked: calls onConfirm(true)', () => {
  const mod = freshMod();
  const results = [];
  mod.show(makeStream(), { role: 'student', onConfirm(hp) { results.push(hp); } });
  // Find checkbox and button.
  function findTag(node, tag) {
    if (node.tag === tag) return node;
    for (const c of (node.children || [])) {
      const f = findTag(c, tag);
      if (f) return f;
    }
    return null;
  }
  const checkbox = findTag(body.children[0], 'input');
  checkbox.checked = true;
  const btn = findTag(body.children[0], 'button');
  btn._dispatchClick();
  assert.deepEqual(results, [true]);
});

test('confirm without headphones: calls onConfirm(false)', () => {
  const mod = freshMod();
  const results = [];
  mod.show(makeStream(), { role: 'student', onConfirm(hp) { results.push(hp); } });
  function findTag(node, tag) {
    if (node.tag === tag) return node;
    for (const c of (node.children || [])) {
      const f = findTag(c, tag);
      if (f) return f;
    }
    return null;
  }
  const btn = findTag(body.children[0], 'button');
  btn._dispatchClick();
  assert.deepEqual(results, [false]);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

test('teardown() removes overlay from DOM', () => {
  const mod = freshMod();
  const handle = mod.show(makeStream(), { role: 'student', onConfirm() {} });
  assert.equal(body.children.length, 1);
  handle.teardown();
  assert.equal(body.children.length, 0);
});

test('teardown() stops all stream tracks', () => {
  const mod = freshMod();
  const stream = makeStream(2);
  const handle = mod.show(stream, { role: 'student', onConfirm() {} });
  handle.teardown();
  assert.ok(stream._tracks.every(t => t.stopped), 'all tracks stopped');
});

test('teardown() is idempotent (second call does not throw)', () => {
  const mod = freshMod();
  const handle = mod.show(makeStream(), { role: 'student', onConfirm() {} });
  assert.doesNotThrow(() => { handle.teardown(); handle.teardown(); });
});

// ---------------------------------------------------------------------------
// Null-stream degraded-render path
// ---------------------------------------------------------------------------

test('show() with null stream renders overlay without error', () => {
  const mod = freshMod();
  assert.doesNotThrow(() => {
    mod.show(null, { role: 'student', onConfirm() {} });
  });
  assert.equal(body.children.length, 1, 'overlay appended even without stream');
});

test('show() with null stream: teardown() does not throw', () => {
  const mod = freshMod();
  const handle = mod.show(null, { role: 'student', onConfirm() {} });
  assert.doesNotThrow(() => handle.teardown());
});
