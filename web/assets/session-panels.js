// File: web/assets/session-panels.js
// Purpose: DOM sub-component builders for the session UI — remote panel, self-view PiP,
//          accompaniment panel, icon-only control bar, end-call dialog.
// Role: Pure DOM builders; no audio, no lifecycle. session-ui.js is the orchestrator.
// Exports: window.sbSessionPanels.{ buildRemotePanel, buildSelfPip, buildAccmpPanel,
//          buildIconBar, buildEndDialog }
// Depends: DOM (createElement), theme.css (.sb-* classes)
// Invariants: peer-supplied strings rendered via .textContent only (no innerHTML);
//             svgIcon uses innerHTML for hardcoded literal SVG paths only
//             (no user input reaches innerHTML).
//             buildIconBar: teacher gets 5 buttons (mic, vid, accmp, chat, end);
//             non-teacher gets 3 (mic, vid, end).
// Last updated: Sprint 17 (2026-04-23) -- new v2 builders; removed buildControls/buildSelfPreview

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
    s.setAttribute('width', '20'); s.setAttribute('height', '20');
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
      music:    '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
      score:    '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/>',
      chat:     '<path d="M4 5h16v11H8l-4 4z"/>',
      end:      '<path d="M3 13a13 13 0 0118 0l-2 3-4-1-1-3a10 10 0 00-4 0l-1 3-4 1z"/>',
    };
    s.innerHTML = paths[name] || '';
    return s;
  }

  // ---- buildRemotePanel (unchanged from Sprint 9) ----

  function buildRemotePanel(opts) {
    var wrap = el('div', 'sb-remote-panel');
    var ring = el('div', 'sb-breath-ring');
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

  // ---- buildSelfPip — small PiP overlay for self-view ----

  function buildSelfPip(stream) {
    var wrap = el('div', 'sb-selfpip');
    var vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    vid.style.cssText = 'width:100%;height:100%;object-fit:cover;transform:scaleX(-1);';
    if (stream) { vid.srcObject = stream; vid.play().catch(function () {}); }
    wrap.appendChild(vid);
    return { node: wrap };
  }

  // ---- buildAccmpPanel — right-side accompaniment controls (teacher only) ----

  function buildAccmpPanel() {
    var panel = el('div', 'sb-accmp-panel-inner');

    var trackName = el('p', 'sb-accmp-track-name');
    trackName.textContent = 'No track selected';

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '0';
    slider.value = '0';
    slider.className = 'sb-accmp-slider';
    slider.setAttribute('aria-label', 'Position');

    var pauseBtn = el('button', 'sb-iconbtn sb-accmp-pause');
    pauseBtn.type = 'button';
    pauseBtn.setAttribute('aria-label', 'Pause');
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.appendChild(svgIcon('music'));

    var scoreBtn = el('button', 'sb-iconbtn sb-accmp-score');
    scoreBtn.type = 'button';
    scoreBtn.setAttribute('aria-label', 'Toggle score viewer');
    scoreBtn.setAttribute('aria-pressed', 'false');
    scoreBtn.appendChild(svgIcon('score'));

    var btnRow = el('div', 'sb-accmp-btn-row');
    btnRow.append(pauseBtn, scoreBtn);

    panel.append(trackName, slider, btnRow);

    return {
      node: panel,
      pauseBtn: pauseBtn,
      scoreToggleBtn: scoreBtn,
      setTrackName: function (name) { trackName.textContent = name || 'No track selected'; },
      setPosition: function (ms) { slider.value = String(ms); },
      setDuration: function (ms) { slider.max = String(ms); },
      setPaused: function (paused) {
        pauseBtn.setAttribute('aria-pressed', paused ? 'false' : 'true');
        pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
      },
      getSlider: function () { return slider; },
    };
  }

  // ---- buildIconBar — icon-only control strip ----

  function buildIconBar(opts) {
    var bar = el('div', 'sb-iconbar');
    var isTeacher = !!opts.isTeacher;
    var micActive = opts.micEnabled !== false;
    var vidActive = opts.videoEnabled !== false;
    var accmpOpen = !!opts.accmpOpen;

    function makeBtn(icon, label, active, extraCls) {
      var b = el('button', 'sb-iconbtn' + (extraCls ? ' ' + extraCls : ''));
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.appendChild(svgIcon(icon));
      return b;
    }

    var micBtn = makeBtn(micActive ? 'mic' : 'mic-off', micActive ? 'Mute microphone' : 'Unmute microphone', micActive);
    var vidBtn = makeBtn(vidActive ? 'vid' : 'vid-off', vidActive ? 'Turn off camera' : 'Turn on camera', vidActive);
    var endBtn = makeBtn('end', 'Leave call', false, 'sb-end');

    bar.append(micBtn, vidBtn);

    var accmpBtn = null;
    var chatBtn = null;
    var sayBadge = null;

    if (isTeacher) {
      accmpBtn = makeBtn('music', 'Toggle accompaniment', accmpOpen);
      chatBtn = makeBtn('chat', 'Chat', false);
      sayBadge = el('span', 'sb-btn-badge'); sayBadge.hidden = true;
      chatBtn.appendChild(sayBadge);
      bar.append(accmpBtn, chatBtn);
    }

    bar.append(endBtn);

    micBtn.addEventListener('click', function () { if (opts.onMicToggle) opts.onMicToggle(); });
    vidBtn.addEventListener('click', function () { if (opts.onVideoToggle) opts.onVideoToggle(); });
    endBtn.addEventListener('click', function () { if (opts.onEnd) opts.onEnd(); });
    if (accmpBtn) accmpBtn.addEventListener('click', function () { if (opts.onAccmpToggle) opts.onAccmpToggle(); });
    if (chatBtn) chatBtn.addEventListener('click', function () { if (opts.onSay) opts.onSay(); });

    return {
      node: bar,
      setMicActive: function (active) {
        micBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        micBtn.setAttribute('aria-label', active ? 'Mute microphone' : 'Unmute microphone');
        micBtn.replaceChildren(svgIcon(active ? 'mic' : 'mic-off'));
      },
      setVideoActive: function (active) {
        vidBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        vidBtn.setAttribute('aria-label', active ? 'Turn off camera' : 'Turn on camera');
        vidBtn.replaceChildren(svgIcon(active ? 'vid' : 'vid-off'));
      },
      setAccmpOpen: function (open) {
        if (accmpBtn) accmpBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
      },
      setSayBadge: function (visible) { if (sayBadge) sayBadge.hidden = !visible; },
    };
  }

  // ---- buildEndDialog (unchanged) ----

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

  return {
    buildRemotePanel: buildRemotePanel,
    buildSelfPip: buildSelfPip,
    buildAccmpPanel: buildAccmpPanel,
    buildIconBar: buildIconBar,
    buildEndDialog: buildEndDialog,
  };
});
