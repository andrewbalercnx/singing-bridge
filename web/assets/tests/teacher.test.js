// File: web/assets/tests/teacher.test.js
// Purpose: Regression guards for teacher.js bot-API contract — window._sbSend
//          serialization and data-testid="admit-btn" presence.
// Last updated: Sprint 25 (2026-04-27) -- initial

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Signalling } = require('../signalling.js');

const TEACHER_SRC = fs.readFileSync(path.join(__dirname, '../teacher.js'), 'utf8');

// Regression: Signalling.send serializes objects to JSON (the mechanism _sbSend relies on).
test('Signalling.send serializes object to JSON string', () => {
  let sent;
  const sock = {
    readyState: 1,
    send(data) { sent = data; },
    addEventListener() {},
  };
  const sig = new Signalling(sock);
  sig.send({ type: 'accompaniment_play', asset_id: 1, variant_id: 2, position_ms: 0 });
  assert.equal(sent, '{"type":"accompaniment_play","asset_id":1,"variant_id":2,"position_ms":0}');
});

// Regression: _sbSend uses sendRaw (no double-encoding).
test('teacher.js exposes window._sbSend via sendRaw under localhost guard', () => {
  assert.ok(TEACHER_SRC.includes('_sbSend'), 'teacher.js must define window._sbSend');
  assert.ok(TEACHER_SRC.includes('sendRaw'), 'teacher.js _sbSend must delegate to sendRaw');
  assert.ok(
    TEACHER_SRC.includes("location.hostname === 'localhost'") ||
    TEACHER_SRC.includes('location.hostname === "localhost"'),
    'teacher.js must guard _sbSend with a localhost check'
  );
});

// Regression: admit button carries data-testid="admit-btn".
test('teacher.js sets data-testid="admit-btn" on the admit button', () => {
  assert.ok(
    TEACHER_SRC.includes('admit-btn'),
    'teacher.js must set data-testid="admit-btn" on the Admit button'
  );
  assert.ok(
    TEACHER_SRC.includes('setAttribute') && TEACHER_SRC.includes('admit-btn'),
    'teacher.js must use setAttribute to set admit-btn testid'
  );
});
