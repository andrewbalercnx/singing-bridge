// File: web/assets/controls.js
// Purpose: Wire the mute / video-off / end-call buttons to the local
//          audio/video tracks. Mute is implemented as track.enabled
//          toggling — never replaceTrack — so no renegotiation is
//          triggered.
// Role: Only place the in-call control bar is wired up.
// Exports: deriveToggleView (pure, Node-testable);
//          wireControls({ audioTrack, videoTrack, onHangup })
//          (browser-only, attached to window.sbControls).
// Depends: DOM (wrapper); none for the pure helper.
// Invariants: `track.enabled` is the sole mute primitive;
//             `replaceTrack`, `removeTrack`, and renegotiation are
//             never used for mute/video-off.
// Last updated: Sprint 3 (2026-04-17) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbControls = {
      deriveToggleView: mod.deriveToggleView,
      wireControls: wireControls,
    };
  }

  function wireControls(opts) {
    opts = opts || {};
    var audioTrack = opts.audioTrack || null;
    var videoTrack = opts.videoTrack || null;
    var onHangup = opts.onHangup;

    var muteBtn  = document.getElementById('mute');
    var videoBtn = document.getElementById('video-off');
    var hangBtn  = document.getElementById('hangup');

    function paint(btn, track, onLabel, offLabel) {
      if (!btn) return;
      var enabled = track ? track.enabled : true;
      var v = mod.deriveToggleView(enabled, onLabel, offLabel);
      btn.textContent = v.label;
      btn.setAttribute('aria-pressed', v.ariaPressed);
    }

    function onMute() {
      if (audioTrack) audioTrack.enabled = !audioTrack.enabled;
      paint(muteBtn, audioTrack, 'Mute', 'Unmute');
    }
    function onVideo() {
      if (videoTrack) videoTrack.enabled = !videoTrack.enabled;
      paint(videoBtn, videoTrack, 'Video off', 'Video on');
    }
    function onHang() { if (typeof onHangup === 'function') onHangup(); }

    // Paint initial state (tracks typically start enabled).
    paint(muteBtn,  audioTrack, 'Mute', 'Unmute');
    paint(videoBtn, videoTrack, 'Video off', 'Video on');

    if (muteBtn)  muteBtn.addEventListener('click', onMute);
    if (videoBtn) videoBtn.addEventListener('click', onVideo);
    if (hangBtn)  hangBtn.addEventListener('click', onHang);

    return {
      teardown: function () {
        if (muteBtn)  muteBtn.removeEventListener('click', onMute);
        if (videoBtn) videoBtn.removeEventListener('click', onVideo);
        if (hangBtn)  hangBtn.removeEventListener('click', onHang);
      },
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Given the current `enabled` state of a track, return the view-
  // model for the button that toggles it. When enabled=true the
  // track is flowing (unmuted / video on) and the button is NOT
  // pressed. When enabled=false the track is silenced and the button
  // IS pressed. Coerces truthy/falsy to strict boolean semantics.
  function deriveToggleView(enabled, onLabel, offLabel) {
    var on = enabled === true;
    return {
      label: on ? onLabel : offLabel,
      ariaPressed: on ? 'false' : 'true',
    };
  }

  return { deriveToggleView: deriveToggleView };
});
