// File: web/assets/tests/controls.test.js
// Purpose: Node tests for `deriveToggleView`, the pure view-model
//          helper that drives the mute / video-off button labels
//          and aria-pressed attributes.
// Last updated: Sprint 8 (2026-04-19) -- import relocated to session-ui.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveToggleView } = require('../session-ui.js');

test('enabled=true yields onLabel and aria-pressed=false', () => {
  const v = deriveToggleView(true, 'Mute', 'Unmute');
  assert.deepEqual(v, { label: 'Mute', ariaPressed: 'false' });
});

test('enabled=false yields offLabel and aria-pressed=true', () => {
  const v = deriveToggleView(false, 'Mute', 'Unmute');
  assert.deepEqual(v, { label: 'Unmute', ariaPressed: 'true' });
});

test('repeated toggle between enabled states is deterministic', () => {
  const a = deriveToggleView(true, 'A', 'B');
  const b = deriveToggleView(false, 'A', 'B');
  const c = deriveToggleView(true, 'A', 'B');
  assert.deepEqual(a, c);
  assert.notDeepEqual(a, b);
});

test('null/undefined enabled is treated as disabled (ariaPressed=true)', () => {
  const vn = deriveToggleView(null, 'On', 'Off');
  const vu = deriveToggleView(undefined, 'On', 'Off');
  assert.equal(vn.ariaPressed, 'true');
  assert.equal(vn.label, 'Off');
  assert.equal(vu.ariaPressed, 'true');
  assert.equal(vu.label, 'Off');
});

test('absent on/off labels surface undefined in label (documents the contract)', () => {
  const v = deriveToggleView(true);
  assert.equal(v.label, undefined);
  assert.equal(v.ariaPressed, 'false');
});

test('return shape is exactly {label, ariaPressed} — no extra keys', () => {
  const v = deriveToggleView(true, 'A', 'B');
  assert.deepEqual(Object.keys(v).sort(), ['ariaPressed', 'label']);
});
