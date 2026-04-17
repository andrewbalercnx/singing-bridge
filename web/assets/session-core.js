// File: web/assets/session-core.js
// Purpose: Session-orchestration helper extracted from signalling.js.
//          Pure core: applyActions (forwards prebuilt EncodingParams to
//          sender.setParameters; Node-testable with stub senders).
//          Browser wrapper: startSessionSubsystems wires the 2 s adapt
//          interval, quality monitor, and reconnect watcher and returns
//          a { stopAll() } handle.
// Role: Only place the adapt tick + applyActions mutation call site
//       lives. signalling.js owns only the wire protocol + priority
//       hints; everything else runs here.
// Exports: applyActions (Node); applyActions + startSessionSubsystems
//          (browser, via window.sbSessionCore).
// Depends: adapt.js, quality.js, reconnect.js (browser wrapper only);
//          senders interface for applyActions.
// Invariants: applyActions never touches `track.enabled`; setParameters
//             rejections are swallowed + logged (never rethrown);
//             stopAll() clears every timer started by
//             startSessionSubsystems (adapt interval, reconnect watcher).
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbSessionCore = {
      applyActions: mod.applyActions,
      startSessionSubsystems: startSessionSubsystems,
    };
  }

  function startSessionSubsystems(pc, senders, role, callbacks) {
    callbacks = callbacks || {};
    var adapt = window.sbAdapt;
    var quality = window.sbQuality;
    var reconnect = window.sbReconnect;

    var ladderState = adapt.initLadderState(role);
    var prevStats = null;
    var stopped = false;

    function tick() {
      if (stopped || !pc) return;
      Promise.resolve()
        .then(function () { return pc.getStats(); })
        .then(function (stats) {
          if (stopped) return;
          var samples = quality.summariseStats(stats, prevStats);
          prevStats = stats;
          var summary = quality.qualityTierFromSummary(samples);
          if (callbacks.onQuality) callbacks.onQuality(summary);

          var outbound = samples.filter(function (s) { return s.dir === 'outbound'; });
          var res = adapt.decideNextRung(ladderState, outbound, role);
          ladderState = res.next;
          mod.applyActions(res.actions, senders);
          for (var i = 0; i < res.actions.length; i++) {
            if (res.actions[i].type === 'floor_violation' && callbacks.onFloorViolation) {
              callbacks.onFloorViolation();
            }
          }
        })
        .catch(function () { /* non-critical */ });
    }

    var interval = setInterval(tick, 2000);
    // Reconnect watcher binds ICE events + its own timers.
    var watcher = reconnect.startReconnectWatcher(pc, function (effect) {
      if (callbacks.onReconnectEffect) callbacks.onReconnectEffect(effect);
    });

    return {
      stopAll: function () {
        stopped = true;
        clearInterval(interval);
        try { watcher.stop(); } catch (_) {}
      },
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // applyActions: forwards prebuilt EncodingParams to sender.setParameters.
  // - Pure relative to DOM / RTCPeerConnection; only depends on the
  //   supplied senders object.
  // - Swallows both sync throws and async rejections; emits a warning
  //   via console.warn (if available) so the logging contract is real.
  function applyActions(actions, senders) {
    if (!Array.isArray(actions)) return;
    senders = senders || {};
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (!a) continue;
      if (a.type === 'setVideoEncoding' && senders.video && typeof senders.video.setParameters === 'function') {
        try {
          var pV = senders.video.setParameters({ encodings: [a.params] });
          if (pV && typeof pV.catch === 'function') {
            pV.catch(function (err) {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('sb.applyActions: video setParameters rejected', err);
              }
            });
          }
        } catch (err) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('sb.applyActions: video setParameters threw', err);
          }
        }
      } else if (a.type === 'setAudioEncoding' && senders.audio && typeof senders.audio.setParameters === 'function') {
        try {
          var pA = senders.audio.setParameters({ encodings: [a.params] });
          if (pA && typeof pA.catch === 'function') {
            pA.catch(function (err) {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('sb.applyActions: audio setParameters rejected', err);
              }
            });
          }
        } catch (err) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('sb.applyActions: audio setParameters threw', err);
          }
        }
      }
      // 'floor_violation' is handled by the caller, not here.
    }
  }

  return { applyActions: applyActions };
});
