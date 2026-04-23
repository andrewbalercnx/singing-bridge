// File: web/assets/session-ui.js
// Purpose: Variation A "The Warm Room" session UI — breath ring, audio meters,
//          control cluster, self-preview, muted banner, end-call dialog.
// Role: Mounts the full live-session UI into a container element; wires to real
//       Web Audio AnalyserNodes for RMS-driven breath ring and level meters.
//       Orchestrator only — sub-component DOM builders live in session-panels.js.
// Exports: window.sbSessionUI.mount(container, opts) → { teardown, setRemoteStream, appendChatMsg, accmpPanel };
//          deriveToggleView (pure, Node-testable; relocated from controls.js);
//          buildBaselineStrip, buildMutedBanner, runAudioLoop (exported for testing)
// Depends: Web Audio API (AudioContext, AnalyserNode), DOM (video, dialog elements),
//          window.sbSessionPanels (buildRemotePanel, buildSelfPip, buildAccmpPanel, buildIconBar, buildEndDialog),
//          window.sbChatDrawer (buildChatDrawer, optional)
// Invariants: peer-supplied strings (remoteName, remoteRoleLabel) rendered via .textContent only;
//             exactly one RAF loop per mount; teardown is idempotent;
//             mount is an orchestrator only (≤40 lines of own logic);
//             accmpPanel open-state persisted in sessionStorage (sb-accmp-open).
// Last updated: Sprint 17 (2026-04-23) -- v2 layout: sb-session-v2 grid, buildSelfPip, buildIconBar, buildAccmpPanel

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

  // ---- Subcomponent builders (audio/UI, not extracted) ----

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

  // ---- Session lifecycle (extracted from mount to keep mount ≤40 lines) ----

  function runSessionLifecycle(root, parts, opts) {
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

    parts.iconBar.setMicActive = (function (orig) {
      return function (active) {
        micEnabled = active;
        orig(active);
      };
    })(parts.iconBar.setMicActive);

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
    var _g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    var panels = _g.sbSessionPanels;
    var isTeacher = !!opts.isTeacher;

    var audioCtx = new AudioContext();
    var analyserSelf = null;
    if (opts.localStream) {
      analyserSelf = audioCtx.createAnalyser();
      audioCtx.createMediaStreamSource(opts.localStream).connect(analyserSelf);
    }

    var micEnabled = opts.micEnabled !== false;
    var vidEnabled = opts.videoEnabled !== false;
    var _ss = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
    var accmpOpen = isTeacher && (_ss ? _ss.getItem('sb-accmp-open') !== '0' : true);

    var remotePanel = panels.buildRemotePanel({ remoteName: opts.remoteName, remoteRoleLabel: opts.remoteRoleLabel, headphonesConfirmed: opts.headphonesConfirmed });
    var selfPip = panels.buildSelfPip(opts.localStream);
    var accmpPanel = isTeacher ? panels.buildAccmpPanel() : null;
    var baseline = buildBaselineStrip();
    var mutedBanner = opts.localStream ? buildMutedBanner() : makeNullBanner();
    var endDialog = panels.buildEndDialog(function () { opts.onEnd(); });

    var chatDrawer = null;
    if (opts.onSendChat && _g.sbChatDrawer) {
      chatDrawer = _g.sbChatDrawer.buildChatDrawer({
        onSendChat: opts.onSendChat,
        onUnreadChange: function (hasUnread) {
          if (iconBar) iconBar.setSayBadge(hasUnread);
        },
      });
    }

    var accmpPanelWrap = null;
    var iconBar = panels.buildIconBar({
      isTeacher: isTeacher,
      micEnabled: micEnabled,
      videoEnabled: vidEnabled,
      accmpOpen: accmpOpen,
      onMicToggle: function () { micEnabled = !micEnabled; iconBar.setMicActive(micEnabled); opts.onMicToggle(); },
      onVideoToggle: function () { vidEnabled = !vidEnabled; iconBar.setVideoActive(vidEnabled); opts.onVideoToggle(); },
      onEnd: function () { endDialog.showModal(); },
      onAccmpToggle: isTeacher ? function () {
        accmpOpen = !accmpOpen;
        if (_ss) _ss.setItem('sb-accmp-open', accmpOpen ? '1' : '0');
        iconBar.setAccmpOpen(accmpOpen);
        if (accmpPanelWrap) accmpPanelWrap.hidden = !accmpOpen;
      } : null,
      onSay: chatDrawer ? function () { chatDrawer.toggle(); } : (opts.onSay || function () {}),
    });

    var videoZone = el('div', 'sb-video-zone');
    videoZone.append(remotePanel.node, selfPip.node);

    var body = el('div', 'sb-session-body');
    body.appendChild(videoZone);

    if (accmpPanel) {
      accmpPanelWrap = el('div', 'sb-accmp-panel');
      accmpPanelWrap.appendChild(accmpPanel.node);
      accmpPanelWrap.hidden = !accmpOpen;
      body.appendChild(accmpPanelWrap);
    }

    var root = el('div', 'sb-session-v2 sb-theme-dark');
    root.append(body, iconBar.node, baseline.node, mutedBanner.node, endDialog);
    if (chatDrawer) root.append(chatDrawer.node);
    container.appendChild(root);

    var lifecycle = runSessionLifecycle(root, {
      audioCtx: audioCtx, analyserSelf: analyserSelf,
      remotePanel: remotePanel, baseline: baseline,
      mutedBanner: mutedBanner, iconBar: iconBar,
    }, opts);

    return {
      teardown: lifecycle.teardown,
      setRemoteStream: lifecycle.setRemoteStream,
      appendChatMsg: function (from, text) {
        if (chatDrawer) chatDrawer.appendMsg(from, text);
      },
      accmpPanel: accmpPanel,
    };
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
