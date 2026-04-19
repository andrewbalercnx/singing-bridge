// File: web/assets/self-check.js
// Purpose: Pre-session self-check overlay — camera self-preview, mic level meter,
//          headphones confirmation toggle. For teachers, shown once per browser
//          session (sessionStorage gate). For students, shown after lobby join
//          while waiting to be admitted.
// Role: Mounts a modal overlay; calls opts.onConfirm(headphonesConfirmed) when done.
// Exports: window.sbSelfCheck.show(stream, opts) → { teardown() }
// Depends: DOM, getUserMedia (stream provided by caller), theme.css (.sb-self-check)
// Invariants: teacher sessionStorage gate is UX-only convenience, not a trust boundary;
//             all tracks stopped on teardown; overlay removed from DOM on teardown.
// Last updated: Sprint 9 (2026-04-19) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbSelfCheck = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TEACHER_SESSION_KEY = 'sb-teacher-checked';

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function show(stream, opts) {
    var role = opts.role || 'student';
    var onConfirm = opts.onConfirm || function () {};

    // Teacher gate: skip if already checked this session.
    if (role === 'teacher' && typeof sessionStorage !== 'undefined') {
      if (sessionStorage.getItem(TEACHER_SESSION_KEY)) {
        onConfirm(false);
        return { teardown: function () {} };
      }
    }

    var overlay = el('div', 'sb-self-check-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Setup check');

    var inner = el('div', 'sb-self-check-inner');

    var heading = el('h2', 'sb-self-check-heading');
    heading.textContent = 'Quick setup check';

    // Camera preview.
    var previewWrap = el('div', 'sb-self-check-preview');
    var vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true;
    if (stream) {
      vid.srcObject = stream;
      vid.play().catch(function () {});
    }
    var previewLabel = el('p', 'sb-self-check-preview-label');
    previewLabel.textContent = 'Camera preview';
    previewWrap.append(vid, previewLabel);

    // Mic level bar.
    var meterWrap = el('div', 'sb-self-check-meter-wrap');
    var meterLabel = el('span', 'sb-self-check-meter-label');
    meterLabel.textContent = 'Mic level';
    var meterBar = el('div', 'sb-self-check-meter-bar');
    var meterFill = el('div', 'sb-self-check-meter-fill');
    meterBar.appendChild(meterFill);
    meterWrap.append(meterLabel, meterBar);

    // Headphones toggle.
    var hpWrap = el('div', 'sb-self-check-headphones');
    var hpLabel = el('label', 'sb-self-check-hp-label');
    var hpCheck = document.createElement('input');
    hpCheck.type = 'checkbox';
    hpCheck.className = 'sb-self-check-hp-check';
    var hpText = el('span');
    hpText.textContent = 'I\'m wearing headphones';
    hpLabel.append(hpCheck, hpText);
    hpWrap.appendChild(hpLabel);

    // Confirm button.
    var confirmBtn = el('button', 'sb-self-check-confirm');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Ready';

    inner.append(heading, previewWrap, meterWrap, hpWrap, confirmBtn);
    overlay.appendChild(inner);
    document.body.appendChild(overlay);

    // Mic level animation via AudioContext.
    var audioCtx = null;
    var analyser = null;
    var source = null;
    var rafId = null;
    var stopped = false;

    if (stream && typeof AudioContext !== 'undefined') {
      try {
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
        var buf = new Uint8Array(analyser.frequencyBinCount);
        (function tick() {
          if (stopped) return;
          analyser.getByteTimeDomainData(buf);
          var sum = 0;
          for (var i = 0; i < buf.length; i++) {
            var v = (buf[i] / 128) - 1;
            sum += v * v;
          }
          var rms = Math.sqrt(sum / buf.length);
          meterFill.style.width = Math.min(100, Math.round(rms * 400)) + '%';
          rafId = requestAnimationFrame(tick);
        })();
      } catch (_) {}
    }

    function teardown() {
      if (stopped) return;
      stopped = true;
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (source) { try { source.disconnect(); } catch (_) {} }
      if (analyser) { try { analyser.disconnect(); } catch (_) {} }
      if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
      // Stop all tracks.
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    confirmBtn.addEventListener('click', function () {
      var hp = hpCheck.checked;
      if (role === 'teacher' && typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(TEACHER_SESSION_KEY, '1');
      }
      teardown();
      onConfirm(hp);
    });

    return { teardown: teardown };
  }

  return { show: show };
});
