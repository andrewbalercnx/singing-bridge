// File: web/assets/self-check.js
// Purpose: Pre-session self-check overlay — camera self-preview, mic level meter,
//          headphones confirmation toggle. For teachers, shown once per browser
//          session (sessionStorage gate). For students, shown after lobby join
//          while waiting to be admitted.
// Role: Mounts a modal overlay; calls opts.onConfirm(headphonesConfirmed) when done.
// Exports: window.sbSelfCheck.show(stream, opts) → { teardown() }
//          opts.iosAecForced (bool) — when true, hides headphones checkbox and enables confirm
//          button immediately; onConfirm(false) called on confirm (profile fixed as IosForced).
// Depends: DOM, getUserMedia (stream provided by caller), theme.css (.sb-self-check)
// Invariants: teacher sessionStorage gate is UX-only convenience, not a trust boundary;
//             confirm button disabled until headphones checkbox is checked (non-iOS only);
//             when iosAecForced=true, confirm button enabled immediately; onConfirm(false) always.
//             null stream renders overlay without media (degraded path — mic meter hidden);
//             all tracks stopped on teardown; overlay removed from DOM on teardown.
// Last updated: Sprint 20 (2026-04-25) -- iosAecForced: skip headphones checkbox

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

  // ---- DOM builder (pure render, no side-effects) ----

  function buildOverlayDOM() {
    var overlay = el('div', 'sb-self-check-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Setup check');

    var inner = el('div', 'sb-self-check-inner');
    var heading = el('h2', 'sb-self-check-heading');
    heading.textContent = 'Quick setup check';

    var previewWrap = el('div', 'sb-self-check-preview');
    var vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    var previewLabel = el('p', 'sb-self-check-preview-label');
    previewLabel.textContent = 'Camera preview';
    previewWrap.append(vid, previewLabel);

    var meterWrap = el('div', 'sb-self-check-meter-wrap');
    var meterLabel = el('span', 'sb-self-check-meter-label');
    meterLabel.textContent = 'Mic level';
    var meterBar = el('div', 'sb-self-check-meter-bar');
    var meterFill = el('div', 'sb-self-check-meter-fill');
    meterBar.appendChild(meterFill);
    meterWrap.append(meterLabel, meterBar);

    var hpWrap = el('div', 'sb-self-check-headphones');
    var hpLabel = el('label', 'sb-self-check-hp-label');
    var hpCheck = document.createElement('input');
    hpCheck.type = 'checkbox';
    hpCheck.className = 'sb-self-check-hp-check';
    var hpText = el('span');
    hpText.textContent = "I'm wearing headphones";
    hpLabel.append(hpCheck, hpText);
    hpWrap.appendChild(hpLabel);

    var confirmBtn = el('button', 'sb-self-check-confirm');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Ready';
    confirmBtn.disabled = true;

    inner.append(heading, previewWrap, meterWrap, hpWrap, confirmBtn);
    overlay.appendChild(inner);

    return { overlay: overlay, vid: vid, meterFill: meterFill, hpCheck: hpCheck, confirmBtn: confirmBtn };
  }

  // ---- Mic meter loop (media side-effect, isolated) ----

  function startMicMeter(stream, meterFill) {
    var stopped = false;
    var rafId = null;
    var audioCtx = null;
    var analyser = null;
    var source = null;

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
          for (var i = 0; i < buf.length; i++) { var v = (buf[i] / 128) - 1; sum += v * v; }
          meterFill.style.width = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 400)) + '%';
          rafId = requestAnimationFrame(tick);
        })();
      } catch (_) {}
    }

    return {
      stop: function () {
        stopped = true;
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        if (source) { try { source.disconnect(); } catch (_) {} }
        if (analyser) { try { analyser.disconnect(); } catch (_) {} }
        if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
      },
    };
  }

  // ---- Teardown helper ----

  function makeTeardown(overlay, stream, meter) {
    var done = false;
    return function teardown() {
      if (done) return;
      done = true;
      meter.stop();
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
  }

  // ---- Public: show — orchestrator only ----

  function show(stream, opts) {
    var role = opts.role || 'student';
    var onConfirm = opts.onConfirm || function () {};
    var iosAecForced = !!(opts && opts.iosAecForced);

    if (role === 'teacher' && typeof sessionStorage !== 'undefined') {
      if (sessionStorage.getItem(TEACHER_SESSION_KEY)) {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        onConfirm(false);
        return { teardown: function () {} };
      }
    }

    var dom = buildOverlayDOM();
    if (stream) { dom.vid.srcObject = stream; dom.vid.play().catch(function () {}); }
    var meter = startMicMeter(stream, dom.meterFill);
    var teardown = makeTeardown(dom.overlay, stream, meter);

    if (iosAecForced) {
      // iOS: headphones checkbox irrelevant — AEC is always on by the OS.
      dom.hpCheck.parentNode.hidden = true; // hide hpWrap label
      var iosLabel = el('p', 'sb-self-check-ios-note');
      iosLabel.textContent = '\uD83D\uDCF1 AEC is always on for your device \u2014 headphones are still recommended for best quality.';
      dom.hpCheck.parentNode.parentNode.insertBefore(iosLabel, dom.confirmBtn);
      dom.confirmBtn.disabled = false; // no checkbox to gate on
    } else {
      dom.hpCheck.addEventListener('change', function () {
        dom.confirmBtn.disabled = !dom.hpCheck.checked;
      });
    }

    dom.confirmBtn.addEventListener('click', function () {
      var hp = iosAecForced ? false : dom.hpCheck.checked;
      if (role === 'teacher' && typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(TEACHER_SESSION_KEY, '1');
      }
      teardown();
      onConfirm(hp);
    });

    document.body.appendChild(dom.overlay);
    return { teardown: teardown };
  }

  return { show: show };
});
