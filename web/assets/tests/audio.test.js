// File: web/assets/tests/audio.test.js
// Purpose: Node tests for the pure hasTrack predicate. DOM-facing
//          code in audio.js is covered under manual verification.
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasTrack } = require('../audio.js');

function fakeStream(tracks) {
  return { getTracks: () => tracks.slice() };
}

test('returns true when matching track id is present', () => {
  const s = fakeStream([{ id: 'a1' }, { id: 'a2' }]);
  assert.equal(hasTrack(s, 'a2'), true);
});

test('returns false when id is absent', () => {
  const s = fakeStream([{ id: 'a1' }]);
  assert.equal(hasTrack(s, 'missing'), false);
});

test('returns false for empty stream', () => {
  assert.equal(hasTrack(fakeStream([]), 'a1'), false);
});

test('returns false for null / invalid stream', () => {
  assert.equal(hasTrack(null, 'a1'), false);
  assert.equal(hasTrack(undefined, 'a1'), false);
  assert.equal(hasTrack({}, 'a1'), false);
  assert.equal(hasTrack({ getTracks: 'not-a-function' }, 'a1'), false);
});

test('returns false for invalid id', () => {
  const s = fakeStream([{ id: 'a1' }]);
  assert.equal(hasTrack(s, ''), false);
  assert.equal(hasTrack(s, null), false);
  assert.equal(hasTrack(s, 42), false);
  assert.equal(hasTrack(s, undefined), false);
});

test('tolerates null entries inside the tracks array', () => {
  const s = fakeStream([null, { id: 'a1' }, undefined]);
  assert.equal(hasTrack(s, 'a1'), true);
  assert.equal(hasTrack(s, 'other'), false);
});
