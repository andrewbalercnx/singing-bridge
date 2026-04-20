// File: web/assets/session-panels.js
// Purpose: DOM sub-component builders extracted from session-ui.js —
//          remote panel, controls cluster, SVG icons, end-call dialog.
//          Extracted to keep session-ui.js within the project module size limit.
// Role: Pure DOM builders; no audio, no lifecycle. session-ui.js is the orchestrator.
// Exports: window.sbSessionPanels.{ buildRemotePanel, buildControls, buildEndDialog }
// Depends: DOM (createElement), theme.css (.sb-* classes)
// Invariants: peer-supplied strings rendered via .textContent only (no innerHTML);
//             svgIcon uses innerHTML for hardcoded literal SVG paths only
//             (no user input reaches innerHTML).
// Last updated: Sprint 9 (2026-04-19) -- extracted from session-ui.js

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbSessionPanels = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function svgIcon(name) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('aria-hidden', 'true');
    var paths = {
      mic:      '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3"/>',
      'mic-off':'<rect x="9" y="3" width="6" height="12" rx="3" opacity=".4"/><path d="M5 11a7 7 0 0014 0" opacity=".4"/><path d="M12 18v3"/><line x1="4" y1="4" x2="20" y2="20"/>',
      vid:      '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
      'vid-off':'<rect x="3" y="6" width="13" height="12" rx="2" opacity=".4"/><path d="M16 10l5-3v10l-5-3z" opacity=".4"/><line x1="4" y1="4" x2="20" y2="20"/>',
      note:     '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
      chat:     '<path d="M4 5h16v11H8l-4 4z"/>',
      end:      '<path d="M3 13a13 13 0 0118 0l-2 3-4-1-1-3a10 10 0 00-4 0l-1 3-4 1z"/>',
    };
    s.innerHTML = paths[name] || '';
    return s;
  }

  function buildRemotePanel(opts) {
    var wrap = el('div', 'sb-remote-panel');
    var ring = el('div', 'sb-breath-ring');
    // Muted video for display — browsers block autoplay on unmuted video.
    // Audio is routed through a separate hidden <audio> element which can
    // autoplay freely (no user-gesture requirement for audio-only elements).
    var vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    var aud = document.createElement('audio');
    aud.autoplay = true;
    var namePlate = el('div', 'sb-name-plate');
    var nameEl = el('div', 'sb-name'); nameEl.textContent = opts.remoteName;
    var roleEl = el('div', 'sb-role'); roleEl.textContent = opts.remoteRoleLabel;
    namePlate.append(nameEl, roleEl);
    var hpChip = el('div', 'sb-hp-chip ' + (opts.headphonesConfirmed ? 'sb-hp-on' : 'sb-hp-off'));
    var hpDot = el('span', 'sb-hp-dot');
    var hpText = el('span');
    hpText.textContent = opts.headphonesConfirmed ? 'Headphones on' : 'No headphones';
    hpChip.append(hpDot, hpText);
    wrap.append(ring, vid, aud, namePlate, hpChip);
    var smoothLevel = 0;
    return {
      node: wrap,
      videoEl: vid,
      setRingLevel: function (rms) {
        var ATTACK = 0.2, RELEASE = 0.02;
        smoothLevel = rms > smoothLevel
          ? smoothLevel + (rms - smoothLevel) * ATTACK
          : smoothLevel + (rms - smoothLevel) * RELEASE;
        var level = Math.min(smoothLevel, 1);
        ring.style.boxShadow = 'inset 0 0 0 ' + (4 + level * 10) + 'px rgba(225,127,139,' + (0.15 + level * 0.35) + ')';
      },
      setStream: function (stream) {
        vid.srcObject = stream || null;
        aud.srcObject = stream || null;
        if (vid.srcObject) vid.play().catch(function () {});
        if (aud.srcObject) aud.play().catch(function () {});
      },
      teardown: function () { vid.srcObject = null; aud.srcObject = null; },
    };
  }

  function buildControls(opts) {
    var wrap = el('div', 'sb-controls');
    var micActive = !!opts.micEnabled;
    var vidActive = !!opts.videoEnabled;

    function makeBtn(icon, label, active, isEnd) {
      var b = el('button', 'sb-btn' + (isEnd ? ' sb-end' : active ? ' sb-active' : ''));
      b.type = 'button';
      b.append(svgIcon(icon));
      var lbl = el('span', 'sb-btn-label'); lbl.textContent = label;
      b.append(lbl);
      return b;
    }

    function refreshBtn(btn, icon, active) {
      btn.className = 'sb-btn' + (active ? ' sb-active' : '');
      btn.replaceChildren(svgIcon(icon));
      var lbl = el('span', 'sb-btn-label'); lbl.textContent = btn._label;
      btn.append(lbl);
    }

    var micBtn  = makeBtn(micActive ? 'mic' : 'mic-off', 'Mic',   micActive, false);
    var vidBtn  = makeBtn(vidActive ? 'vid' : 'vid-off', 'Video', vidActive, false);
    var noteBtn = makeBtn('note', 'Note', false, false);
    var sayBtn  = makeBtn('chat', 'Say',  false, false);
    var endBtn  = makeBtn('end',  'End',  false, true);
    micBtn._label = 'Mic';
    vidBtn._label = 'Video';

    var sayBadge = el('span', 'sb-btn-badge'); sayBadge.hidden = true;
    sayBtn.appendChild(sayBadge);

    micBtn.addEventListener('click', function () { opts.onMicToggle(); });
    vidBtn.addEventListener('click', function () { opts.onVideoToggle(); });
    noteBtn.addEventListener('click', function () { opts.onNote(); });
    sayBtn.addEventListener('click', function () { opts.onSay(); });
    endBtn.addEventListener('click', function () { opts.onEnd(); });

    wrap.append(micBtn, vidBtn, noteBtn, sayBtn, endBtn);

    return {
      node: wrap,
      setMicActive: function (active) { refreshBtn(micBtn, active ? 'mic' : 'mic-off', active); },
      setVideoActive: function (active) { refreshBtn(vidBtn, active ? 'vid' : 'vid-off', active); },
      setSayBadge: function (visible) { sayBadge.hidden = !visible; },
    };
  }

  function buildEndDialog(onConfirm) {
    var dlg = document.createElement('dialog');
    dlg.className = 'sb-end-dialog';
    var h = el('h2'); h.textContent = 'End this lesson?';
    var actions = el('div', 'sb-end-dialog-actions');
    var cancelBtn = el('button', 'sb-btn-cancel'); cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
    var confirmBtn = el('button', 'sb-btn-confirm'); confirmBtn.type = 'button'; confirmBtn.textContent = 'End';
    cancelBtn.addEventListener('click', function () { dlg.close(); });
    confirmBtn.addEventListener('click', function () { dlg.close(); onConfirm(); });
    actions.append(cancelBtn, confirmBtn);
    dlg.append(h, actions);
    return dlg;
  }

  return { buildRemotePanel: buildRemotePanel, buildControls: buildControls, buildEndDialog: buildEndDialog };
});
