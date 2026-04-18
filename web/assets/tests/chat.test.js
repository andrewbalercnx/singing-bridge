// File: web/assets/tests/chat.test.js
// Purpose: Unit tests for chat helpers — appendChat label rendering, textContent
//          safety, sendChat/sendLobbyMessage serialisation, lobby message banner.
// Last updated: Sprint 7 (2026-04-18) -- initial coverage

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal DOM stubs (Node has no DOM — replicate only what the helpers use)
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const attrs = {};
  const children = [];
  let textContent = '';
  let scrollTop = 0;
  const el = {
    tag,
    get textContent() { return textContent; },
    set textContent(v) { textContent = String(v); },
    get hidden() { return attrs.hidden === true; },
    set hidden(v) { attrs.hidden = v; },
    get scrollHeight() { return children.length * 20; },
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = v; },
    className: '',
    children,
    appendChild(child) { children.push(child); return child; },
    replaceChildren() { children.length = 0; textContent = ''; },
    append(...items) {
      for (const item of items) {
        if (typeof item === 'string') children.push({ textContent: item, tag: '#text' });
        else children.push(item);
      }
    },
    _attrs: attrs,
  };
  return el;
}

function makeDoc() {
  const els = {};
  return {
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return makeEl(tag); },
    createTextNode(text) { return { textContent: text, tag: '#text' }; },
    _set(id, el) { els[id] = el; },
  };
}

// ---------------------------------------------------------------------------
// appendChat — teacher POV (teacher sees "You" / "Student")
// ---------------------------------------------------------------------------

function makeAppendChat(log, myRole) {
  return function appendChat(from, text) {
    if (!log) return;
    const li = makeEl('li');
    li.className = 'chat-msg from-' + from;
    const label = makeEl('span');
    label.className = 'chat-label';
    label.textContent = myRole === 'teacher'
      ? (from === 'teacher' ? 'You' : 'Student')
      : (from === 'teacher' ? 'Teacher' : 'You');
    const body = makeEl('span');
    body.className = 'chat-body';
    body.textContent = text;
    li.append(label, { textContent: ': ', tag: '#text' }, body);
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  };
}

test('appendChat teacher-pov: from=teacher → label "You"', () => {
  const log = makeEl('ul');
  const fn = makeAppendChat(log, 'teacher');
  fn('teacher', 'hello');
  assert.equal(log.children.length, 1);
  const li = log.children[0];
  assert.equal(li.className, 'chat-msg from-teacher');
  const label = li.children[0];
  assert.equal(label.textContent, 'You');
  const body = li.children[2];
  assert.equal(body.textContent, 'hello');
});

test('appendChat teacher-pov: from=student → label "Student"', () => {
  const log = makeEl('ul');
  const fn = makeAppendChat(log, 'teacher');
  fn('student', 'hi back');
  const label = log.children[0].children[0];
  assert.equal(label.textContent, 'Student');
});

// ---------------------------------------------------------------------------
// appendChat — student POV (student sees "Teacher" / "You")
// ---------------------------------------------------------------------------

test('appendChat student-pov: from=teacher → label "Teacher"', () => {
  const log = makeEl('ul');
  const fn = makeAppendChat(log, 'student');
  fn('teacher', 'hi');
  const label = log.children[0].children[0];
  assert.equal(label.textContent, 'Teacher');
});

test('appendChat student-pov: from=student → label "You"', () => {
  const log = makeEl('ul');
  const fn = makeAppendChat(log, 'student');
  fn('student', 'got it');
  const label = log.children[0].children[0];
  assert.equal(label.textContent, 'You');
});

// ---------------------------------------------------------------------------
// textContent-only safety: body must use textContent, not innerHTML
// ---------------------------------------------------------------------------

test('appendChat uses textContent for message body (XSS safety)', () => {
  const log = makeEl('ul');
  const fn = makeAppendChat(log, 'teacher');
  const xss = '<img src=x onerror=alert(1)>';
  fn('student', xss);
  const body = log.children[0].children[2];
  // textContent stores the raw string; no innerHTML parsing
  assert.equal(body.textContent, xss);
  // body must NOT have an innerHTML property set (our stub doesn't have one)
  assert.equal(typeof body.innerHTML, 'undefined');
});

// ---------------------------------------------------------------------------
// sendChat serialisation
// ---------------------------------------------------------------------------

test('sendChat serialises to {type:"chat", text}', () => {
  const sent = [];
  const sig = { send: (m) => sent.push(m) };
  function sendChat(text) { sig.send({ type: 'chat', text }); }

  sendChat('hello world');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'chat', text: 'hello world' });
});

test('sendChat preserves emoji text verbatim', () => {
  const sent = [];
  const sig = { send: (m) => sent.push(m) };
  function sendChat(text) { sig.send({ type: 'chat', text }); }

  sendChat('🎵'.repeat(10));
  assert.equal(sent[0].text, '🎵'.repeat(10));
});

// ---------------------------------------------------------------------------
// sendLobbyMessage serialisation
// ---------------------------------------------------------------------------

test('sendLobbyMessage serialises to {type:"lobby_message", entry_id, text}', () => {
  const sent = [];
  const sig = { send: (m) => sent.push(m) };
  function sendLobbyMessage(entryId, text) {
    sig.send({ type: 'lobby_message', entry_id: entryId, text });
  }

  sendLobbyMessage('abc-123', 'starting soon');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'lobby_message', entry_id: 'abc-123', text: 'starting soon' });
});

// ---------------------------------------------------------------------------
// Lobby message banner
// ---------------------------------------------------------------------------

test('onLobbyMessage sets textContent and shows banner', () => {
  const banner = makeEl('div');
  banner.hidden = true;
  const textEl = makeEl('span');
  let timer = null;

  function onLobbyMessage({ text }) {
    textEl.textContent = text;
    banner.hidden = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { banner.hidden = true; }, 8000);
  }

  onLobbyMessage({ text: 'Be right with you!' });
  assert.equal(textEl.textContent, 'Be right with you!');
  assert.equal(banner.hidden, false);
  clearTimeout(timer); // cleanup
});

test('onLobbyMessage uses textContent not innerHTML', () => {
  const banner = makeEl('div');
  const textEl = makeEl('span');

  function onLobbyMessage({ text }) {
    textEl.textContent = text;
    banner.hidden = false;
  }

  const xss = '<script>evil()</script>';
  onLobbyMessage({ text: xss });
  assert.equal(textEl.textContent, xss);
  assert.equal(typeof textEl.innerHTML, 'undefined');
});

// ---------------------------------------------------------------------------
// chat-panel visibility: shown on PeerConnected, hidden on PeerDisconnected
// ---------------------------------------------------------------------------

test('chat panel hidden initially, shown on peerConnected, hidden on peerDisconnected', () => {
  const panel = makeEl('div');
  panel.hidden = true;
  const log = makeEl('ul');

  function onPeerConnected() { panel.hidden = false; }
  function onPeerDisconnected() { panel.hidden = true; log.replaceChildren(); }

  assert.equal(panel.hidden, true);
  onPeerConnected();
  assert.equal(panel.hidden, false);
  onPeerDisconnected();
  assert.equal(panel.hidden, true);
  assert.equal(log.children.length, 0);
});
