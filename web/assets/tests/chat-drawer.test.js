// File: web/assets/tests/chat-drawer.test.js
// Purpose: Unit tests for chat-drawer.js: initial state, open/close/toggle,
//          appendMsg (including label text-safety), send suppression on blank
//          input, onSendChat called once per valid send, unread badge lifecycle.
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
    get hidden() { return attrs.hidden === true; },
    set hidden(v) { attrs.hidden = !!v; },
    get scrollTop() { return attrs.scrollTop || 0; },
    set scrollTop(v) { attrs.scrollTop = v; },
    get scrollHeight() { return children.length * 20; },
    className: '',
    style: {},
    children,
    type: '',
    maxLength: undefined,
    placeholder: '',
    autocomplete: '',
    value: '',
    get checked() { return !!attrs.checked; },
    set checked(v) { attrs.checked = v; },
    appendChild(child) { children.push(child); return child; },
    append(...items) { for (const item of items) children.push(item); },
    focus() {},
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
    addEventListener(ev, fn) {
      attrs['_ev_' + ev] = attrs['_ev_' + ev] || [];
      attrs['_ev_' + ev].push(fn);
    },
    _dispatch(ev, data) {
      (attrs['_ev_' + ev] || []).forEach(fn => fn(data || {}));
    },
    _dispatchSubmit() {
      const fakeEvent = { preventDefault() {} };
      (attrs['_ev_submit'] || []).forEach(fn => fn(fakeEvent));
    },
    _dispatchClick() {
      (attrs['_ev_click'] || []).forEach(fn => fn());
    },
    parentNode: null,
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
    },
  };
  return node;
}

global.document = {
  createElement(tag) { return makeEl(tag); },
  createTextNode(text) { return { tag: '#text', textContent: String(text) }; },
};

const mod = require('../chat-drawer.js');
const { buildChatDrawer } = mod;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

test('buildChatDrawer: drawer starts hidden (closed)', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  assert.equal(drawer.node.hidden, true);
});

test('buildChatDrawer: hasUnread() starts false', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  assert.equal(drawer.hasUnread(), false);
});

// ---------------------------------------------------------------------------
// open / close / toggle
// ---------------------------------------------------------------------------

test('open() makes drawer visible', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  drawer.open();
  assert.equal(drawer.node.hidden, false);
});

test('close() hides drawer', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  drawer.open();
  drawer.close();
  assert.equal(drawer.node.hidden, true);
});

test('toggle(): closed → open', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  drawer.toggle();
  assert.equal(drawer.node.hidden, false);
});

test('toggle(): open → closed', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  drawer.toggle();
  drawer.toggle();
  assert.equal(drawer.node.hidden, true);
});

// ---------------------------------------------------------------------------
// Empty-send suppression
// ---------------------------------------------------------------------------

test('form submit with blank input does NOT call onSendChat', () => {
  let calls = 0;
  const drawer = buildChatDrawer({ onSendChat() { calls++; } });
  // The form node is one of the children: find it by tag.
  function findByTag(node, tag) {
    if (node.tag === tag) return node;
    for (const c of (node.children || [])) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
    return null;
  }
  const form = findByTag(drawer.node, 'form');
  const input = findByTag(form, 'input');
  input.value = '   '; // whitespace only
  form._dispatchSubmit();
  assert.equal(calls, 0);
});

test('form submit with whitespace-only input does NOT call onSendChat', () => {
  let calls = 0;
  const drawer = buildChatDrawer({ onSendChat() { calls++; } });
  function findByTag(node, tag) {
    if (node.tag === tag) return node;
    for (const c of (node.children || [])) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
    return null;
  }
  const form = findByTag(drawer.node, 'form');
  const input = findByTag(form, 'input');
  input.value = '\t\n ';
  form._dispatchSubmit();
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Valid send
// ---------------------------------------------------------------------------

test('form submit with valid text calls onSendChat once with trimmed text', () => {
  const sent = [];
  const drawer = buildChatDrawer({ onSendChat(text) { sent.push(text); } });
  function findByTag(node, tag) {
    if (node.tag === tag) return node;
    for (const c of (node.children || [])) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
    return null;
  }
  const form = findByTag(drawer.node, 'form');
  const input = findByTag(form, 'input');
  input.value = '  hello world  ';
  form._dispatchSubmit();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'hello world');
  assert.equal(input.value, '');
});

// ---------------------------------------------------------------------------
// appendMsg — text safety and unread state
// ---------------------------------------------------------------------------

test('appendMsg when closed: sets hasUnread() true and calls onUnreadChange(true)', () => {
  const unread = [];
  const drawer = buildChatDrawer({
    onSendChat() {},
    onUnreadChange(v) { unread.push(v); },
  });
  drawer.appendMsg('teacher', 'hello');
  assert.equal(drawer.hasUnread(), true);
  assert.deepEqual(unread, [true]);
});

test('appendMsg when open: does NOT set unread flag', () => {
  const unread = [];
  const drawer = buildChatDrawer({
    onSendChat() {},
    onUnreadChange(v) { unread.push(v); },
  });
  drawer.open();
  drawer.appendMsg('teacher', 'hello');
  assert.equal(drawer.hasUnread(), false);
  assert.deepEqual(unread, []);
});

test('open() clears unread and fires onUnreadChange(false)', () => {
  const unread = [];
  const drawer = buildChatDrawer({
    onSendChat() {},
    onUnreadChange(v) { unread.push(v); },
  });
  drawer.appendMsg('teacher', 'hi');
  drawer.open();
  assert.equal(drawer.hasUnread(), false);
  assert.ok(unread.includes(false));
});

test('appendMsg renders message label via textContent (XSS safety)', () => {
  const drawer = buildChatDrawer({ onSendChat() {} });
  function findByTag(node, tag) {
    if (node.tag === tag) return node;
    for (const c of (node.children || [])) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
    return null;
  }
  const log = findByTag(drawer.node, 'ul');
  drawer.appendMsg('teacher', '<script>alert(1)</script>');
  // The body span's textContent should be the raw string, not parsed HTML.
  const msgItem = log.children[0];
  // Find the body span (second span child).
  const bodySpan = msgItem.children.find(c => c.className === 'sb-chat-body');
  assert.equal(bodySpan.textContent, '<script>alert(1)</script>');
});
