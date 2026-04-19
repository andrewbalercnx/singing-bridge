// File: web/assets/session-ui.js
// Purpose: Variation A "The Warm Room" session UI — breath ring, audio meters,
//          control cluster, self-preview, muted banner, end-call dialog.
// Role: Mounts the full live-session UI into a container element; wires to real
//       Web Audio AnalyserNodes for RMS-driven breath ring and level meters.
// Exports: window.sbSessionUI.mount(container, opts) → { teardown, setRemoteStream };
//          deriveToggleView (pure, Node-testable; relocated from controls.js);
//          buildBaselineStrip, buildMutedBanner, runAudioLoop (exported for testing)
// Depends: Web Audio API (AudioContext, AnalyserNode), DOM (video, dialog elements)
// Invariants: peer-supplied strings (remoteName, remoteRoleLabel, "You") rendered via
//             .textContent only; svgIcon uses innerHTML for hardcoded literal SVG
//             paths only (no user input reaches innerHTML);
//             exactly one RAF loop per mount; teardown is idempotent;
//             mount is an orchestrator only (≤40 lines of own logic).
// Last updated: Sprint 8 (2026-04-19) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbSessionUI = {
      mount: mod.mount,
      deriveToggleView: mod.deriveToggleView,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Pure helpers ----

  function deriveToggleView(enabled, onLabel, offLabel) {
    var on = enabled === true;
    return { label: on ? onLabel : offLabel, ariaPressed: on ? 'false' : 'true' };
  }

  function fmtTime(seconds) {
    var s = (typeof seconds === 'number' && isFinite(seconds) && seconds >= 0) ? Math.floor(seconds) : 0;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + pad(m) + ':' + pad(sec);
    return m + ':' + pad(sec);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function rmsFromAnalyser(analyser) {
    if (!analyser) return 0;
    var buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) {
      var v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  var MUTE_DETECT_THRESHOLD = 0.05;
  var MUTE_DETECT_FRAMES = 4;
  var MUTE_BANNER_MS = 3000;

  // ---- DOM helpers ----

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function svgIcon(name) {
    // innerHTML used here only for hardcoded SVG literal paths (no user input).
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

  // ---- Subcomponent builders ----

  function buildRemotePanel(opts) {
    var wrap = el('div', 'sb-remote-panel');
    var ring = el('div', 'sb-breath-ring');
    var vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true; vid.muted = false;
    var namePlate = el('div', 'sb-name-plate');
    var nameEl = el('div', 'sb-name'); nameEl.textContent = opts.remoteName;
    var roleEl = el('div', 'sb-role'); roleEl.textContent = opts.remoteRoleLabel;
    namePlate.append(nameEl, roleEl);
    var hpChip = el('div', 'sb-hp-chip ' + (opts.headphonesConfirmed ? 'sb-hp-on' : 'sb-hp-off'));
    var hpDot = el('span', 'sb-hp-dot');
    var hpText = el('span');
    hpText.textContent = opts.headphonesConfirmed ? 'Headphones on' : 'No headphones';
    hpChip.append(hpDot, hpText);
    wrap.append(ring, vid, namePlate, hpChip);
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
        if (vid.srcObject) vid.play().catch(function () {});
      },
      teardown: function () { vid.srcObject = null; },
    };
  }

  function buildBaselineStrip() {
    var strip = el('div', 'sb-baseline');
    var meterRow = el('div', 'sb-meter-row');
    var selfMeter = buildMeterBar('YOU', 'left');
    var midEl = el('div', 'sb-meter-mid');
    midEl.textContent = '0:00';
    var remoteMeter = buildMeterBar('', 'right');
    meterRow.append(selfMeter.node, midEl, remoteMeter.node);
    strip.append(meterRow);
    return {
      node: strip,
      setLevels: function (selfRms, remoteRms) {
        selfMeter.setLevel(selfRms);
        remoteMeter.setLevel(remoteRms);
      },
      setElapsed: function (seconds) {
        midEl.textContent = fmtTime(seconds);
      },
    };
  }

  function buildMeterBar(label, side) {
    var n = 14;
    var wrap = el('div', 'sb-meter-bar' + (side === 'right' ? ' sb-right' : ''));
    var labelEl = el('span', 'sb-meter-label'); labelEl.textContent = label;
    var pipsWrap = el('div', 'sb-meter-pips');
    var pips = [];
    for (var i = 0; i < n; i++) {
      var pip = el('span', 'sb-pip');
      pip.style.height = (6 + i * 1.2) + 'px';
      pip.style.background = 'rgba(251,246,239,0.15)';
      pipsWrap.appendChild(pip);
      pips.push(pip);
    }
    wrap.append(labelEl, pipsWrap);
    return {
      node: wrap,
      setLevel: function (level) {
        var active = Math.round(level * n);
        for (var i = 0; i < n; i++) {
          pips[i].style.background = i < active
            ? (i < n * 0.6 ? '#F3ECE0' : i < n * 0.85 ? '#E3A950' : '#E17F8B')
            : 'rgba(251,246,239,0.15)';
        }
      },
      setLabel: function (text) { labelEl.textContent = text; },
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
    };
  }

  function buildSelfPreview(stream) {
    var wrap = el('div', 'sb-self-preview');
    var vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    if (stream) { vid.srcObject = stream; vid.play().catch(function () {}); }
    var lbl = el('div', 'sb-self-label'); lbl.textContent = 'You';
    wrap.append(vid, lbl);
    return { node: wrap };
  }

  function buildMutedBanner() {
    var banner = el('div', 'sb-muted-banner');
    banner.setAttribute('role', 'status');
    banner.textContent = 'You are muted';
    banner.hidden = true;
    var hideTimer = null;
    var frames = 0;
    return {
      node: banner,
      checkAndUpdate: function (micEnabled, rms) {
        if (micEnabled) {
          frames = 0;
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
          banner.hidden = true;
          return;
        }
        if (rms > MUTE_DETECT_THRESHOLD) {
          frames++;
          if (frames >= MUTE_DETECT_FRAMES) {
            if (!banner.hidden && hideTimer) { clearTimeout(hideTimer); }
            banner.hidden = false;
            hideTimer = setTimeout(function () {
              banner.hidden = true; hideTimer = null; frames = 0;
            }, MUTE_BANNER_MS);
          }
        } else {
          frames = 0;
        }
      },
    };
  }

  function makeNullBanner() {
    return { node: el('span'), checkAndUpdate: function () {} };
  }

  function runAudioLoop(analyserSelf, analyserRemote, onFrame) {
    var rafId = null;
    var stopped = false;
    function tick() {
      if (stopped) return;
      onFrame(rmsFromAnalyser(analyserSelf), rmsFromAnalyser(analyserRemote));
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return {
      stop: function () {
        stopped = true;
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      },
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

  // ---- Session lifecycle (extracted from mount to keep mount ≤40 lines) ----

  function runSessionLifecycle(root, parts, opts) {
    // parts: { audioCtx, analyserSelf, remotePanel, baseline, mutedBanner, controls }
    var analyserRemote = null;
    var sourceRemote = null;
    var micEnabled = opts.micEnabled !== false;
    var elapsedS = 0;
    var tornDown = false;

    var timerInterval = setInterval(function () {
      elapsedS++;
      parts.baseline.setElapsed(elapsedS);
    }, 1000);

    function makeLoopFrame() {
      return function (selfRms, remoteRms) {
        parts.remotePanel.setRingLevel(remoteRms);
        parts.baseline.setLevels(selfRms, remoteRms);
        parts.mutedBanner.checkAndUpdate(micEnabled, selfRms);
      };
    }

    var loop = runAudioLoop(parts.analyserSelf, analyserRemote, makeLoopFrame());

    function attachRemoteStream(stream) {
      loop.stop();
      if (sourceRemote) { try { sourceRemote.disconnect(); } catch (_) {} sourceRemote = null; }
      if (analyserRemote) { try { analyserRemote.disconnect(); } catch (_) {} analyserRemote = null; }
      if (stream) {
        analyserRemote = parts.audioCtx.createAnalyser();
        sourceRemote = parts.audioCtx.createMediaStreamSource(stream);
        sourceRemote.connect(analyserRemote);
      }
      parts.remotePanel.setStream(stream);
      loop = runAudioLoop(parts.analyserSelf, analyserRemote, makeLoopFrame());
    }

    function teardown() {
      if (tornDown) return;
      tornDown = true;
      loop.stop();
      clearInterval(timerInterval);
      if (sourceRemote) { try { sourceRemote.disconnect(); } catch (_) {} }
      if (analyserRemote) { try { analyserRemote.disconnect(); } catch (_) {} }
      if (parts.analyserSelf) { try { parts.analyserSelf.disconnect(); } catch (_) {} }
      parts.audioCtx.close();
      parts.remotePanel.teardown();
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    if (opts.remoteStream) attachRemoteStream(opts.remoteStream);

    // Expose mic state mutation so controls can read it via closure.
    parts.controls.setMicActive = (function (originalSetMicActive) {
      return function (active) {
        micEnabled = active;
        originalSetMicActive(active);
      };
    })(parts.controls.setMicActive);

    return {
      teardown: teardown,
      setRemoteStream: function (stream) {
        if (tornDown) return;
        attachRemoteStream(stream);
      },
    };
  }

  // ---- mount — orchestrator only (≤40 lines) ----

  function mount(container, opts) {
    var audioCtx = new AudioContext();
    var analyserSelf = null;
    if (opts.localStream) {
      analyserSelf = audioCtx.createAnalyser();
      audioCtx.createMediaStreamSource(opts.localStream).connect(analyserSelf);
    }

    var micEnabled = opts.micEnabled !== false;
    var vidEnabled = opts.videoEnabled !== false;
    var remotePanel = buildRemotePanel({ remoteName: opts.remoteName, remoteRoleLabel: opts.remoteRoleLabel, headphonesConfirmed: opts.headphonesConfirmed });
    var baseline = buildBaselineStrip();
    var mutedBanner = opts.localStream ? buildMutedBanner() : makeNullBanner();
    var endDialog = buildEndDialog(function () { opts.onEnd(); });
    var controls = buildControls({
      micEnabled: micEnabled, videoEnabled: vidEnabled,
      onMicToggle: function () { micEnabled = !micEnabled; controls.setMicActive(micEnabled); opts.onMicToggle(); },
      onVideoToggle: function () { vidEnabled = !vidEnabled; controls.setVideoActive(vidEnabled); opts.onVideoToggle(); },
      onEnd: function () { endDialog.showModal(); },
      onNote: opts.onNote,
      onSay: opts.onSay,
    });
    var selfPreview = buildSelfPreview(opts.localStream);
    var bottom = el('div', 'sb-bottom');
    bottom.append(controls.node, selfPreview.node);
    var root = el('div', 'sb-session');
    root.append(remotePanel.node, baseline.node, bottom, mutedBanner.node, endDialog);
    container.appendChild(root);

    return runSessionLifecycle(root, { audioCtx: audioCtx, analyserSelf: analyserSelf, remotePanel: remotePanel, baseline: baseline, mutedBanner: mutedBanner, controls: controls }, opts);
  }

  return {
    mount: mount,
    deriveToggleView: deriveToggleView,
    fmtTime: fmtTime,
    buildBaselineStrip: buildBaselineStrip,
    buildMutedBanner: buildMutedBanner,
    runAudioLoop: runAudioLoop,
  };
});
