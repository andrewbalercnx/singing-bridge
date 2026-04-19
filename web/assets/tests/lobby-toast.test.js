// File: web/assets/tests/lobby-toast.test.js
// Purpose: Unit tests for lobby-toast.js: show(), text safety, auto-dismiss
//          via fake clock, and max-3 simultaneous toast cap.
// Last updated: Sprint 9 (2026-04-19) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal DOM stub + fake timers
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const attrs = {};
  const children = [];
  let textContent = '';
  const node = {
    tag,
    get textContent() { return textContent; },
    set textContent(v) { textContent = String(v); },
    className: '',
    style: {},
    children,
    parentNode: null,
    appendChild(child) {
      child.parentNode = node;
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
        child.parentNode = null;
      }
    },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); node.className = [...this._classes].join(' '); },
      contains(c) { return this._classes.has(c); },
    },
  };
  return node;
}

// Fake document.body.
const body = makeEl('body');

global.document = {
  createElement(tag) { return makeEl(tag); },
  createTextNode(text) { return { tag: '#text', textContent: String(text) }; },
  body,
};

// Fake setTimeout/clearTimeout with manual advance.
let _timers = [];
let _now = 0;

global.setTimeout = function (fn, delay) {
  const id = _timers.length + 1;
  _timers.push({ id, fn, at: _now + delay, done: false });
  return id;
};
global.clearTimeout = function (id) {
  const t = _timers.find(t => t.id === id);
  if (t) t.done = true;
};

function advanceTo(ms) {
  _now = ms;
  for (const t of _timers) {
    if (!t.done && t.at <= _now) {
      t.done = true;
      t.fn();
    }
  }
}

function resetTimers() {
  _timers = [];
  _now = 0;
}

// Reset container state between tests by clearing body's children and
// resetting the module's internal container reference via re-require.
function freshMod() {
  // Clear cached require.
  delete require.cache[require.resolve('../lobby-toast.js')];
  body.children.length = 0;
  resetTimers();
  return require('../lobby-toast.js');
}

// ---------------------------------------------------------------------------
// show() — basic
// ---------------------------------------------------------------------------

test('show() appends a toast to document.body (via container)', () => {
  const mod = freshMod();
  mod.show('Hello teacher');
  // Container should be appended and have one child.
  assert.equal(body.children.length, 1);
  const container = body.children[0];
  assert.equal(container.children.length, 1);
});

test('show() renders text safely via textContent', () => {
  const mod = freshMod();
  mod.show('<img src=x onerror=alert(1)>');
  const container = body.children[0];
  const toast = container.children[0];
  // Find the body span (last child with class sb-lobby-toast-body).
  const bodySpan = toast.children.find(c => c && c.className === 'sb-lobby-toast-body');
  assert.equal(bodySpan.textContent, '<img src=x onerror=alert(1)>');
});

// ---------------------------------------------------------------------------
// Auto-dismiss
// ---------------------------------------------------------------------------

test('show() removes toast after duration ms', () => {
  const mod = freshMod();
  mod.show('hi', 1000);
  const container = body.children[0];
  assert.equal(container.children.length, 1);
  // Two-stage dismiss: fade at 1000ms schedules removal at _now+400.
  advanceTo(1000); // fade timer fires, schedules removal at 1000+400=1400
  advanceTo(1400); // removal timer fires
  assert.equal(container.children.length, 0);
});

// ---------------------------------------------------------------------------
// Cap enforcement (max 3)
// ---------------------------------------------------------------------------

test('4th show() removes oldest before appending', () => {
  const mod = freshMod();
  mod.show('msg1', 60000);
  mod.show('msg2', 60000);
  mod.show('msg3', 60000);
  const container = body.children[0];
  assert.equal(container.children.length, 3);
  mod.show('msg4', 60000);
  // Should still be 3 (oldest removed, new one added).
  assert.equal(container.children.length, 3);
  // The remaining toasts should be msg2, msg3, msg4 — verify msg4 is last.
  const last = container.children[container.children.length - 1];
  const bodySpan = last.children.find(c => c && c.className === 'sb-lobby-toast-body');
  assert.equal(bodySpan.textContent, 'msg4');
});

test('cap: after oldest auto-dismisses, new toast is accepted', () => {
  const mod = freshMod();
  mod.show('a', 500);
  mod.show('b', 60000);
  mod.show('c', 60000);
  const container = body.children[0];
  assert.equal(container.children.length, 3);
  // Two-stage dismiss: fade fires at 500ms, DOM removal fires at 500+400=900ms.
  // _now is set to 900 first, so the removal timer fires at 900+400=1300.
  advanceTo(500);  // triggers fade callback, schedules removal at _now+400=900
  advanceTo(900);  // triggers removal (at=900)
  assert.equal(container.children.length, 2);
  // Now 4th show should not need to evict.
  mod.show('d', 60000);
  assert.equal(container.children.length, 3);
});
