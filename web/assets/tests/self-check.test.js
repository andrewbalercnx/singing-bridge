// File: web/assets/tests/self-check.test.js
// Purpose: Unit tests for self-check.js: teacher sessionStorage gate (skip/show/write),
//          student path (always shows), teardown stops all tracks and removes DOM,
//          confirm-button disabled-until-checkbox-change gating, confirm callback value.
// Last updated: Sprint 9 (2026-04-19) -- fix gating tests: disabled state + change event required

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
    get disabled() { return !!attrs.disabled; },
    set disabled(v) { attrs.disabled = !!v; },
    get checked() { return !!attrs.checked; },
    set checked(v) { attrs.checked = !!v; },
    className: '',
    style: { width: '' },
    type: '',
    autoplay: false,
    playsInline: false,
    muted: false,
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
    // Disabled buttons do not fire click in real browsers.
    _dispatchClick() {
      if (attrs.disabled) return;
      (attrs['_ev_click'] || []).forEach(fn => fn());
    },
    _dispatchChange() { (attrs['_ev_change'] || []).forEach(fn => fn()); },
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

// Shared tree-walk helpers.
function findTag(node, tag) {
  if (node.tag === tag) return node;
  for (const c of (node.children || [])) {
    const f = findTag(c, tag);
    if (f) return f;
  }
  return null;
}

function findBtn(node) { return findTag(node, 'button'); }

// Enable the confirm button by checking the checkbox and dispatching 'change'.
function enableConfirm(overlayRoot) {
  const checkbox = findTag(overlayRoot, 'input');
  checkbox.checked = true;
  checkbox._dispatchChange();
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
  mod.show(makeStream(), { role: 'teacher', onConfirm() {} });
  enableConfirm(body.children[0]);
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
  enableConfirm(body.children[0]);
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
// Confirm button gating — disabled until headphones checkbox change fires
// ---------------------------------------------------------------------------

test('confirm button is initially disabled', () => {
  const mod = freshMod();
  mod.show(makeStream(), { role: 'student', onConfirm() {} });
  const btn = findBtn(body.children[0]);
  assert.ok(btn.disabled, 'confirm button must start disabled');
});

test('clicking disabled confirm button does not call onConfirm', () => {
  const mod = freshMod();
  const results = [];
  mod.show(makeStream(), { role: 'student', onConfirm(hp) { results.push(hp); } });
  // Click without first firing the change event — button stays disabled.
  findBtn(body.children[0])._dispatchClick();
  assert.deepEqual(results, [], 'onConfirm must not fire when button is still disabled');
});

test('confirm button enabled after checkbox change event', () => {
  const mod = freshMod();
  mod.show(makeStream(), { role: 'student', onConfirm() {} });
  const overlay = body.children[0];
  assert.ok(findBtn(overlay).disabled, 'disabled before change');
  enableConfirm(overlay);
  assert.ok(!findBtn(overlay).disabled, 'enabled after change');
});

test('confirm with headphones checked: calls onConfirm(true)', () => {
  const mod = freshMod();
  const results = [];
  mod.show(makeStream(), { role: 'student', onConfirm(hp) { results.push(hp); } });
  enableConfirm(body.children[0]);
  findBtn(body.children[0])._dispatchClick();
  assert.deepEqual(results, [true]);
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
