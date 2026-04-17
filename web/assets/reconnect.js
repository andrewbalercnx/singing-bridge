// File: web/assets/reconnect.js
// Purpose: Pure ICE-state reconnect state machine plus a thin browser
//          wrapper that binds pc.oniceconnectionstatechange and calls
//          effect handlers on timer fires. Full (phase, iceState)
//          transition table per plan §4.3.
// Role: Only place that decides when to issue pc.restartIce() vs
//       give up. Does not actually call restartIce() — emits
//       'call_restart_ice' effect; caller (session-core.js) decides
//       whether to invoke based on role.
// Exports: ICE_WATCH_MS, ICE_RESTART_MS, STANDARD_FLICKER,
//          STRAIGHT_TO_FAILED, CLOSED_FROM_HEALTHY,
//          initReconnectState, onIceStateEvent (pure);
//          startReconnectWatcher (browser-only, window.sbReconnect).
// Depends: none (pure logic); pc for the browser wrapper only.
// Invariants: giveup is terminal (effect stays 'none' on any further
//             event); every (phase, iceState) pair is defined;
//             timers are scheduled and cleared via injected clock —
//             pure function NEVER touches the real clock.
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbReconnect = {
      ICE_WATCH_MS: mod.ICE_WATCH_MS,
      ICE_RESTART_MS: mod.ICE_RESTART_MS,
      STANDARD_FLICKER: mod.STANDARD_FLICKER,
      STRAIGHT_TO_FAILED: mod.STRAIGHT_TO_FAILED,
      CLOSED_FROM_HEALTHY: mod.CLOSED_FROM_HEALTHY,
      initReconnectState: mod.initReconnectState,
      onIceStateEvent: mod.onIceStateEvent,
      startReconnectWatcher: startReconnectWatcher,
    };
  }

  // Browser wrapper: binds ICE state-change events + timers, delegates to
  // the pure function. `clock` must provide { now, setTimeout, clearTimeout }
  // so tests can inject a fake.
  function startReconnectWatcher(pc, onEffect, clock) {
    clock = clock || {
      now: Date.now,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    };
    var state = mod.initReconnectState();
    var watchTimerId = null;
    var restartTimerId = null;

    function cancelTimers() {
      if (watchTimerId !== null) { clock.clearTimeout(watchTimerId); watchTimerId = null; }
      if (restartTimerId !== null) { clock.clearTimeout(restartTimerId); restartTimerId = null; }
    }

    function fireEffect(effect) {
      if (effect === 'schedule_watch') {
        if (watchTimerId !== null) clock.clearTimeout(watchTimerId);
        watchTimerId = clock.setTimeout(function () {
          watchTimerId = null;
          handle('<watch-timer-fire>');
        }, mod.ICE_WATCH_MS);
      } else if (effect === 'call_restart_ice') {
        if (restartTimerId !== null) clock.clearTimeout(restartTimerId);
        restartTimerId = clock.setTimeout(function () {
          restartTimerId = null;
          handle('<restart-timer-fire>');
        }, mod.ICE_RESTART_MS);
      } else if (effect === 'cancel_timer') {
        cancelTimers();
      } else if (effect === 'give_up') {
        cancelTimers();
      }
      if (onEffect) onEffect(effect);
    }

    function handle(iceState) {
      var res = mod.onIceStateEvent(state, iceState, clock.now());
      state = res.next;
      fireEffect(res.effect);
    }

    function listener() {
      handle(pc.iceConnectionState);
    }
    pc.addEventListener('iceconnectionstatechange', listener);

    return {
      stop: function () {
        cancelTimers();
        try { pc.removeEventListener('iceconnectionstatechange', listener); } catch (_) {}
      },
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ICE_WATCH_MS = 3000;
  var ICE_RESTART_MS = 5000;

  function initReconnectState() {
    return { phase: 'healthy', retryCount: 0 };
  }

  // Pure state transition. Returns { next, effect }.
  function onIceStateEvent(prev, iceState, nowMs) {
    var phase = prev.phase;

    // Terminal state: any event returns 'none'.
    if (phase === 'giveup') {
      return { next: { phase: 'giveup', retryCount: prev.retryCount }, effect: 'none' };
    }

    // healthy row
    if (phase === 'healthy') {
      switch (iceState) {
        case 'new': case 'checking': case 'connected': case 'completed':
          return { next: prev, effect: 'none' };
        case 'disconnected':
          return {
            next: { phase: 'watching', retryCount: prev.retryCount },
            effect: 'schedule_watch',
          };
        case 'failed': case 'closed':
          return {
            next: { phase: 'giveup', retryCount: prev.retryCount },
            effect: 'give_up',
          };
      }
    }

    // watching row
    if (phase === 'watching') {
      switch (iceState) {
        case 'new': case 'checking':
          return { next: prev, effect: 'none' };
        case 'connected': case 'completed':
          return {
            next: { phase: 'healthy', retryCount: prev.retryCount },
            effect: 'cancel_timer',
          };
        case 'disconnected':
          // Idempotent — no double timer.
          return { next: prev, effect: 'none' };
        case 'failed': case 'closed':
          return {
            next: { phase: 'giveup', retryCount: prev.retryCount },
            effect: 'give_up',
          };
        case '<watch-timer-fire>':
          return {
            next: { phase: 'restarting', retryCount: prev.retryCount + 1 },
            effect: 'call_restart_ice',
          };
      }
    }

    // restarting row
    if (phase === 'restarting') {
      switch (iceState) {
        case 'new': case 'checking': case 'disconnected':
          return { next: prev, effect: 'none' };
        case 'connected': case 'completed':
          return {
            next: { phase: 'healthy', retryCount: prev.retryCount },
            effect: 'cancel_timer',
          };
        case 'failed': case 'closed': case '<restart-timer-fire>':
          return {
            next: { phase: 'giveup', retryCount: prev.retryCount },
            effect: 'give_up',
          };
      }
    }

    // Unknown event from a known phase: no-op.
    return { next: prev, effect: 'none' };
  }

  // --- Test fixtures -------------------------------------------------------

  // Canonical flicker: healthy → disconnected (watching) → connected (healthy).
  var STANDARD_FLICKER = Object.freeze([
    'connected',       // healthy stays healthy
    'disconnected',    // → watching
    'connected',       // → healthy (cancel_timer)
  ]);

  // Direct failure from healthy.
  var STRAIGHT_TO_FAILED = Object.freeze([
    'connected',
    'failed',          // healthy → giveup
  ]);

  // Peer closed from healthy.
  var CLOSED_FROM_HEALTHY = Object.freeze([
    'connected',
    'closed',          // healthy → giveup
  ]);

  return {
    ICE_WATCH_MS: ICE_WATCH_MS,
    ICE_RESTART_MS: ICE_RESTART_MS,
    STANDARD_FLICKER: STANDARD_FLICKER,
    STRAIGHT_TO_FAILED: STRAIGHT_TO_FAILED,
    CLOSED_FROM_HEALTHY: CLOSED_FROM_HEALTHY,
    initReconnectState: initReconnectState,
    onIceStateEvent: onIceStateEvent,
  };
});
