// File: web/assets/tests/session-panels.test.js
// Purpose: Unit tests for session-panels.js builders: buildSelfPip, buildAccmpPanel (setters),
//          buildIconBar (button counts, aria-labels, callbacks), buildRemotePanel, buildEndDialog.
// Last updated: Sprint 26 (2026-05-07) -- classList stub; setLobbyMode test

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal DOM stub (same pattern as session-ui.test.js)
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const attrs = {};
  const children = [];
  let textContent = '';
  let _className = '';
  const el = {
    tag,
    get textContent() { return textContent; },
    set textContent(v) { textContent = String(v); },
    get hidden() { return attrs.hidden === true; },
    set hidden(v) { attrs.hidden = v; },
    get className() { return _className; },
    set className(v) { _className = v; },
    style: {},
    children,
    parentNode: null,
    get innerHTML() { return attrs._innerHTML || ''; },
    set innerHTML(v) { attrs._innerHTML = v; },
    classList: {
      toggle(cls, force) {
        const parts = _className.split(/\s+/).filter(Boolean);
        const idx = parts.indexOf(cls);
        const has = idx !== -1;
        const add = (force === undefined) ? !has : !!force;
        if (add && !has) parts.push(cls);
        if (!add && has) parts.splice(idx, 1);
        _className = parts.join(' ');
      },
      contains(cls) {
        return _className.split(/\s+/).indexOf(cls) !== -1;
      },
    },
    appendChild(child) {
      if (child && typeof child === 'object') child.parentNode = el;
      children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
    },
    append(...items) { for (const item of items) children.push(item); },
    replaceChildren(...items) { children.length = 0; for (const item of items) children.push(item); },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
    addEventListener(ev, fn) { (attrs['_ev_' + ev] = attrs['_ev_' + ev] || []).push(fn); },
    dispatchClick() { (attrs['_ev_click'] || []).forEach(fn => fn()); },
    close() { attrs.open = false; },
    showModal() { attrs.open = true; },
    play() { return Promise.resolve(); },
  };
  return el;
}

global.document = {
  createElement(tag) { return makeEl(tag); },
  createElementNS(_ns, tag) { return makeEl(tag); },
  createTextNode(text) { return { textContent: text, tag: '#text' }; },
};

const mod = require('../session-panels.js');

// ---------------------------------------------------------------------------
// buildSelfPip
// ---------------------------------------------------------------------------

test('buildSelfPip: returns node with sb-selfpip class', () => {
  const { node } = mod.buildSelfPip(null);
  assert.equal(node.className, 'sb-selfpip');
});

test('buildSelfPip: contains a muted video element', () => {
  const { node } = mod.buildSelfPip(null);
  const vid = node.children.find(c => c.tag === 'video');
  assert.ok(vid, 'must contain a video element');
  assert.equal(vid.muted, true);
  assert.equal(vid.autoplay, true);
  assert.equal(vid.playsInline, true);
});

// ---------------------------------------------------------------------------
// buildAccmpPanel setters
// ---------------------------------------------------------------------------

test('buildAccmpPanel: setTrackName updates text', () => {
  const p = mod.buildAccmpPanel();
  p.setTrackName('Beethoven');
  const trackName = p.node.children.find(c => c.className === 'sb-accmp-track-name');
  assert.equal(trackName.textContent, 'Beethoven');
});

test('buildAccmpPanel: setTrackName(null) reverts to default', () => {
  const p = mod.buildAccmpPanel();
  p.setTrackName(null);
  const trackName = p.node.children.find(c => c.className === 'sb-accmp-track-name');
  assert.equal(trackName.textContent, 'No track selected');
});

test('buildAccmpPanel: setPosition updates slider value', () => {
  const p = mod.buildAccmpPanel();
  p.setDuration(60000);
  p.setPosition(30000);
  assert.equal(p.getSlider().value, '30000');
});

test('buildAccmpPanel: setDuration updates slider max', () => {
  const p = mod.buildAccmpPanel();
  p.setDuration(90000);
  assert.equal(p.getSlider().max, '90000');
});

test('buildAccmpPanel: setPaused(true) → aria-label Resume', () => {
  const p = mod.buildAccmpPanel();
  p.setPaused(true);
  assert.equal(p.pauseBtn.getAttribute('aria-label'), 'Resume');
  assert.equal(p.pauseBtn.getAttribute('aria-pressed'), 'false');
});

test('buildAccmpPanel: setPaused(false) → aria-label Pause', () => {
  const p = mod.buildAccmpPanel();
  p.setPaused(false);
  assert.equal(p.pauseBtn.getAttribute('aria-label'), 'Pause');
  assert.equal(p.pauseBtn.getAttribute('aria-pressed'), 'true');
});

test('buildAccmpPanel: scoreToggleBtn aria-label correct', () => {
  const p = mod.buildAccmpPanel();
  assert.equal(p.scoreToggleBtn.getAttribute('aria-label'), 'Toggle score viewer');
});

// ---------------------------------------------------------------------------
// buildIconBar
// ---------------------------------------------------------------------------

test('buildIconBar non-teacher: 3 buttons', () => {
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true });
  assert.equal(b.node.children.length, 3);
});

test('buildIconBar teacher: 5 buttons', () => {
  const b = mod.buildIconBar({ isTeacher: true, micEnabled: true, videoEnabled: true });
  assert.equal(b.node.children.length, 5);
});

test('buildIconBar: mic enabled aria attrs', () => {
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true });
  assert.equal(b.node.children[0].getAttribute('aria-label'), 'Mute microphone');
  assert.equal(b.node.children[0].getAttribute('aria-pressed'), 'true');
});

test('buildIconBar: mic disabled aria attrs', () => {
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: false, videoEnabled: true });
  assert.equal(b.node.children[0].getAttribute('aria-label'), 'Unmute microphone');
  assert.equal(b.node.children[0].getAttribute('aria-pressed'), 'false');
});

test('buildIconBar: end button aria-label', () => {
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true });
  assert.equal(b.node.children[2].getAttribute('aria-label'), 'Leave call');
});

test('buildIconBar: setMicActive(false) updates aria attrs', () => {
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true });
  b.setMicActive(false);
  assert.equal(b.node.children[0].getAttribute('aria-pressed'), 'false');
  assert.equal(b.node.children[0].getAttribute('aria-label'), 'Unmute microphone');
});

test('buildIconBar: setVideoActive(false) updates aria attrs', () => {
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true });
  b.setVideoActive(false);
  assert.equal(b.node.children[1].getAttribute('aria-pressed'), 'false');
  assert.equal(b.node.children[1].getAttribute('aria-label'), 'Turn on camera');
});

test('buildIconBar: onMicToggle fires on mic click', () => {
  let calls = 0;
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true, onMicToggle() { calls++; } });
  b.node.children[0].dispatchClick();
  assert.equal(calls, 1);
});

test('buildIconBar: onVideoToggle fires on vid click', () => {
  let calls = 0;
  const b = mod.buildIconBar({ isTeacher: false, micEnabled: true, videoEnabled: true, onVideoToggle() { calls++; } });
  b.node.children[1].dispatchClick();
  assert.equal(calls, 1);
});

test('buildIconBar teacher: onAccmpToggle fires on accmp button click', () => {
  let calls = 0;
  const b = mod.buildIconBar({ isTeacher: true, micEnabled: true, videoEnabled: true, onAccmpToggle() { calls++; } });
  b.node.children[2].dispatchClick();
  assert.equal(calls, 1);
});

test('buildIconBar teacher: onSay fires on chat button click', () => {
  let calls = 0;
  const b = mod.buildIconBar({ isTeacher: true, micEnabled: true, videoEnabled: true, onSay() { calls++; } });
  b.node.children[3].dispatchClick();
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// buildRemotePanel — XSS guard
// ---------------------------------------------------------------------------

test('buildRemotePanel: remoteName rendered as textContent, not innerHTML', () => {
  const p = mod.buildRemotePanel({
    remoteName: '<script>alert(1)</script>',
    remoteRoleLabel: 'Student',
    headphonesConfirmed: false,
  });
  const nameEl = p.node.children.find(c => c.tag === 'div');
  // walk to find .sb-name
  function findByClass(node, cls) {
    if (node.className === cls) return node;
    for (const c of (node.children || [])) { const r = findByClass(c, cls); if (r) return r; }
    return null;
  }
  const name = findByClass(p.node, 'sb-name');
  assert.ok(name, 'sb-name element must exist');
  assert.ok(name.textContent.includes('<script>'), 'raw text preserved');
});

test('buildRemotePanel: headphonesConfirmed adds sb-hp-on class', () => {
  const p = mod.buildRemotePanel({ remoteName: 'Alex', remoteRoleLabel: 'Student', headphonesConfirmed: true });
  function findByClassContains(node, part) {
    if (node.className && node.className.includes(part)) return node;
    for (const c of (node.children || [])) { const r = findByClassContains(c, part); if (r) return r; }
    return null;
  }
  assert.ok(findByClassContains(p.node, 'sb-hp-on'), 'sb-hp-on chip must be present');
});

// ---------------------------------------------------------------------------
// buildEndDialog
// ---------------------------------------------------------------------------

test('buildEndDialog: cancel does not call onConfirm', () => {
  let confirmed = false;
  const dlg = mod.buildEndDialog(function () { confirmed = true; });
  dlg.querySelector = function (sel) {
    if (sel === '.sb-btn-cancel') return dlg.children.find(c => c.className === 'sb-end-dialog-actions').children[0];
    if (sel === '.sb-btn-confirm') return dlg.children.find(c => c.className === 'sb-end-dialog-actions').children[1];
    return null;
  };
  // Find actions div
  const actions = dlg.children.find(c => c.className === 'sb-end-dialog-actions');
  actions.children[0].dispatchClick(); // cancel
  assert.equal(confirmed, false);
});

test('buildEndDialog: confirm calls onConfirm', () => {
  let confirmed = false;
  const dlg = mod.buildEndDialog(function () { confirmed = true; });
  const actions = dlg.children.find(c => c.className === 'sb-end-dialog-actions');
  actions.children[1].dispatchClick(); // confirm
  assert.equal(confirmed, true);
});

// ---------------------------------------------------------------------------
// buildAccmpPanel: setLobbyMode (Sprint 26)
// ---------------------------------------------------------------------------

test('buildAccmpPanel: setLobbyMode(true) adds lobby class and sets aria-label Preview', () => {
  const p = mod.buildAccmpPanel();
  p.setLobbyMode(true);
  assert.ok(p.node.classList.contains('sb-accmp-panel--lobby'), 'lobby class added');
  assert.equal(p.pauseBtn.getAttribute('aria-label'), 'Preview');
});

test('buildAccmpPanel: setLobbyMode(false) removes lobby class and sets aria-label Play / Pause', () => {
  const p = mod.buildAccmpPanel();
  p.setLobbyMode(true);
  p.setLobbyMode(false);
  assert.ok(!p.node.classList.contains('sb-accmp-panel--lobby'), 'lobby class removed');
  assert.equal(p.pauseBtn.getAttribute('aria-label'), 'Play / Pause');
});
