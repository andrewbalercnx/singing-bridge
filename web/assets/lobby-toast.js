// File: web/assets/lobby-toast.js
// Purpose: Warm Room lobby message toast — dark navy pill with Fraunces italic
//          header, auto-dismiss with fade, max 3 simultaneous visible.
// Role: Delivers teacher-to-student lobby messages as styled, ephemeral toasts.
// Exports: window.sbLobbyToast.show(text, durationMs)
// Depends: DOM (createElement, document.body), theme.css (.sb-lobby-toast classes)
// Invariants: peer-supplied text rendered via .textContent only (no innerHTML);
//             at most 3 toasts visible at once (oldest removed on 4th show());
//             each toast manages its own auto-dismiss timer;
//             container appended to document.body once on first call.
// Last updated: Sprint 9 (2026-04-19) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbLobbyToast = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_VISIBLE = 3;
  var _container = null;
  var _visible = [];

  function getContainer() {
    if (!_container) {
      _container = document.createElement('div');
      _container.className = 'sb-lobby-toast-container';
      _container.setAttribute('aria-live', 'polite');
      document.body.appendChild(_container);
    }
    return _container;
  }

  function show(text, durationMs) {
    var container = getContainer();

    // Cap: remove oldest if already at MAX_VISIBLE.
    if (_visible.length >= MAX_VISIBLE) {
      var oldest = _visible.shift();
      if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest);
    }

    var toast = document.createElement('div');
    toast.className = 'sb-lobby-toast';
    var label = document.createElement('span');
    label.className = 'sb-lobby-toast-label';
    label.textContent = 'Message from your teacher';
    var body = document.createElement('span');
    body.className = 'sb-lobby-toast-body';
    body.textContent = text;
    toast.append(label, document.createTextNode(': '), body);
    container.appendChild(toast);
    _visible.push(toast);

    var dur = typeof durationMs === 'number' ? durationMs : 8000;
    setTimeout(function () {
      toast.classList.add('sb-lobby-toast-fade');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        var idx = _visible.indexOf(toast);
        if (idx !== -1) _visible.splice(idx, 1);
      }, 400);
    }, dur);
  }

  return { show: show };
});
