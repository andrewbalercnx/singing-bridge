// File: web/assets/tests/reconnect.test.js
// Purpose: Node tests for reconnect.js — the pure state machine. Covers
//          §5.1 #25–#29 + §5.2 reconnect edge cases (inc. closed-from-
//          restarting and closed-from-healthy).
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initReconnectState,
  onIceStateEvent,
  STANDARD_FLICKER,
  STRAIGHT_TO_FAILED,
  CLOSED_FROM_HEALTHY,
} = require('../reconnect.js');

// Replay a sequence of iceStates through the pure machine; return the
// list of (state, effect) tuples.
function replay(seq) {
  let s = initReconnectState();
  const trace = [];
  for (const ev of seq) {
    const r = onIceStateEvent(s, ev, 0);
    s = r.next;
    trace.push({ event: ev, phase: s.phase, effect: r.effect });
  }
  return { final: s, trace: trace };
}

// --- §5.1 #25 Happy path healthy → watching → restarting → healthy --------

test('#25 healthy→watching→restarting→healthy emits one of each effect', () => {
  const seq = [
    'disconnected',        // → watching, schedule_watch
    '<watch-timer-fire>',  // → restarting, call_restart_ice
    'connected',           // → healthy, cancel_timer
  ];
  const { trace } = replay(seq);
  assert.equal(trace[0].phase, 'watching');
  assert.equal(trace[0].effect, 'schedule_watch');
  assert.equal(trace[1].phase, 'restarting');
  assert.equal(trace[1].effect, 'call_restart_ice');
  assert.equal(trace[2].phase, 'healthy');
  assert.equal(trace[2].effect, 'cancel_timer');
});

// --- §5.1 #26 Recovery before timer ---------------------------------------

test('#26 disconnected→connected before watch timer: cancel_timer, no call_restart_ice', () => {
  const { trace } = replay(['disconnected', 'connected']);
  assert.equal(trace[1].phase, 'healthy');
  assert.equal(trace[1].effect, 'cancel_timer');
  // Ensure call_restart_ice was never emitted.
  assert.ok(!trace.some((t) => t.effect === 'call_restart_ice'));
});

// --- §5.1 #27 Give-up on restart timer ------------------------------------

test('#27 restart timer fires → give_up', () => {
  const seq = [
    'disconnected',
    '<watch-timer-fire>',
    '<restart-timer-fire>',
  ];
  const { trace } = replay(seq);
  assert.equal(trace[2].phase, 'giveup');
  assert.equal(trace[2].effect, 'give_up');
});

// --- §5.1 #28 Idempotent on repeated disconnected -------------------------

test('#28 repeated disconnected: second returns effect "none"', () => {
  const { trace } = replay(['disconnected', 'disconnected']);
  assert.equal(trace[0].effect, 'schedule_watch');
  assert.equal(trace[1].effect, 'none');
  assert.equal(trace[1].phase, 'watching');
});

// --- §5.1 #29 Pure function does not encode role --------------------------

test('#29 pure function emits call_restart_ice regardless of role', () => {
  // The pure function has no `role` parameter at all; this test simply
  // confirms the contract: same input → same effect, always call_restart_ice.
  const r1 = onIceStateEvent({ phase: 'watching', retryCount: 0 }, '<watch-timer-fire>', 0);
  const r2 = onIceStateEvent({ phase: 'watching', retryCount: 0 }, '<watch-timer-fire>', 0);
  assert.equal(r1.effect, 'call_restart_ice');
  assert.equal(r2.effect, 'call_restart_ice');
});

// --- §5.2 failure paths --------------------------------------------------

test('§5.2 healthy + failed → giveup directly (STRAIGHT_TO_FAILED)', () => {
  const { final, trace } = replay(STRAIGHT_TO_FAILED);
  assert.equal(final.phase, 'giveup');
  assert.equal(trace[trace.length - 1].effect, 'give_up');
});

test('§5.2 healthy + closed → giveup (CLOSED_FROM_HEALTHY)', () => {
  const { final, trace } = replay(CLOSED_FROM_HEALTHY);
  assert.equal(final.phase, 'giveup');
  assert.equal(trace[trace.length - 1].effect, 'give_up');
});

test('§5.2 restarting + closed → giveup (cable yanked mid-restart)', () => {
  const seq = [
    'disconnected',
    '<watch-timer-fire>',
    'closed',
  ];
  const { final, trace } = replay(seq);
  assert.equal(final.phase, 'giveup');
  assert.equal(trace[2].effect, 'give_up');
});

test('§5.2 terminal: once in giveup, all further events yield effect "none"', () => {
  const seq = [
    'disconnected',
    '<watch-timer-fire>',
    '<restart-timer-fire>',  // giveup
    'connected',             // terminal, no effect
    'disconnected',
    'failed',
  ];
  const { trace } = replay(seq);
  for (let i = 3; i < trace.length; i++) {
    assert.equal(trace[i].phase, 'giveup');
    assert.equal(trace[i].effect, 'none');
  }
});

test('§5.2 STANDARD_FLICKER resolves cleanly to healthy', () => {
  const { final } = replay(STANDARD_FLICKER);
  assert.equal(final.phase, 'healthy');
});
