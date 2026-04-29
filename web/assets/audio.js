// File: web/assets/audio.js
// Purpose: Browser-side audio plumbing for the signalling client.
//          One place for getUserMedia constraints, remote-track
//          attachment, autoplay-blocked recovery, and the
//          duplicate-track predicate.
// Role: Only module that calls getUserMedia or touches the
//       <audio id="remote-audio"> element.
// Exports: window.sbAudio.{
//            startLocalAudio, attachRemoteAudio, detachRemoteAudio,
//            hasTrack
//          }
//          (Under Node/CommonJS, module.exports = { hasTrack } so
//          the pure predicate is unit-testable without a DOM.)
// Depends: none
// Invariants: hasTrack is pure — no DOM, no global state; it is
//             the single source of truth for duplicate detection.
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

'use strict';

// Pure predicate — exported so Node tests can assert it without a DOM.
function hasTrack(stream, id) {
  if (!stream || typeof stream.getTracks !== 'function') return false;
  if (typeof id !== 'string' || id === '') return false;
  var tracks = stream.getTracks();
  for (var i = 0; i < tracks.length; i++) {
    if (tracks[i] && tracks[i].id === id) return true;
  }
  return false;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { hasTrack: hasTrack };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  var AUDIO_CONSTRAINTS = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
    },
    video: false,
  };

  var startLocalAudio = async function () {
    var constraints = {
      audio: Object.assign({}, AUDIO_CONSTRAINTS.audio),
      video: false,
    };
    if (window.sbDevicePicker) {
      var deviceId = window.sbDevicePicker.getInputDeviceId();
      if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    }
    var stream = await navigator.mediaDevices.getUserMedia(constraints);
    var track = stream.getAudioTracks()[0];
    return { stream: stream, track: track, settings: track.getSettings() };
  };

  var showUnmuteAffordance = function (el) {
    var btn = document.getElementById('unmute-audio');
    if (!btn) return;
    btn.hidden = false;
    btn.onclick = function () {
      btn.hidden = true;
      try { el.play(); } catch (_) {}
    };
  };

  var hideUnmuteAffordance = function () {
    var btn = document.getElementById('unmute-audio');
    if (btn) btn.hidden = true;
  };

  var attachRemoteAudio = function (ev) {
    var el = document.getElementById('remote-audio');
    if (!el) return;
    if (!ev || !ev.track) return;
    if (!el.srcObject) el.srcObject = new MediaStream();
    if (hasTrack(el.srcObject, ev.track.id)) return;
    el.srcObject.addTrack(ev.track);
    if (ev.receiver) {
      try { ev.receiver.playoutDelayHint = 0; } catch (_) {}
    }
    var p = null;
    try { p = el.play(); } catch (_) {}
    if (p && typeof p.then === 'function') {
      p.catch(function () { showUnmuteAffordance(el); });
    }
  };

  var detachRemoteAudio = function () {
    var el = document.getElementById('remote-audio');
    if (el && el.srcObject) {
      var tracks = el.srcObject.getTracks();
      for (var i = 0; i < tracks.length; i++) {
        el.srcObject.removeTrack(tracks[i]);
      }
      el.srcObject = null;
    }
    hideUnmuteAffordance();
  };

  window.sbAudio = {
    startLocalAudio: startLocalAudio,
    attachRemoteAudio: attachRemoteAudio,
    detachRemoteAudio: detachRemoteAudio,
    hasTrack: hasTrack,
  };
}
