// File: web/assets/tests/student.test.js
// Purpose: Regression guard for student.html data-testid="session-active" anchor.
//          Fails if the bot-critical selector is removed from the session element.
// Last updated: Sprint 25 (2026-04-27) -- initial

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STUDENT_HTML = fs.readFileSync(
  path.join(__dirname, '../../student.html'),
  'utf8'
);

test('student.html #session element has data-testid="session-active"', () => {
  assert.ok(
    STUDENT_HTML.includes('data-testid="session-active"'),
    'student.html must have data-testid="session-active" on the #session element'
  );
});

test('student.html session element retains id="session"', () => {
  assert.ok(
    STUDENT_HTML.includes('id="session"'),
    'student.html must retain id="session" for backward-compat student join flow'
  );
});
