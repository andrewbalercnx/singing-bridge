// File: web/assets/accompaniment-drawer.js
// Purpose: In-session accompaniment playback UI — audio control and bar-advancement loop.
//          Teacher sees play/pause/stop controls; student sees read-only status.
// Role: Manages the Audio element lifecycle, rAF bar-advancement loop, and WS message dispatch.
// Exports: window.sbAccompanimentDrawer.mount(container, opts) → { teardown, updateState,
//          setScoreView, setAcousticProfile, setTrackList, setAssetList,
//          setSendWs, setGetOneWayLatencyMs, enterLobbyMode, exitLobbyMode }
// Depends: DOM, Audio, requestAnimationFrame, signalling.js (caller provides sendWs)
// Invariants: skewMs sampled once on receipt; not resampled per rAF tick.
//             _lastTempoPct fallback = 100 when tempo_pct is null or absent.
//             cancelAnimationFrame called via stored handle on every state change.
//             Audio element created only when wav_url is non-null.
//             peer-supplied URL set via audio.src (no innerHTML).
//             Score view wired after mount via handle.setScoreView(scoreViewHandle).
//             opts.panelEl: when provided (v2 layout), drives panelEl API instead of
//             building own UI; container may be null in that case.
//             audio.muted = true when acousticProfile !== 'headphones'.
//             updateState is a no-op in lobby mode (_lobbyMode guard at top).
//             _destroyLobbyAudio called on error, ended, exitLobbyMode, enterLobbyMode, teardown.
//             _pendingPreviewFetch cleared unconditionally before lobby-mode guard in .then().
// Last updated: Sprint 26 (2026-05-07) -- lobby mode: mutable sendWs ref, lobby preview audio, setAssetList

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbAccompanimentDrawer = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_POSITION_MS = 14400000;
  var MIN_TEMPO_PCT = 1;
  var MAX_TEMPO_PCT = 400;
  var MAX_SKEW_MS = 500;

  function clamp(val, lo, hi) {
    return Math.max(lo, Math.min(hi, val));
  }

  // ---- Validation helpers ----

  function isValidPositionMs(v) {
    return typeof v === 'number' && v >= 0 && v <= MAX_POSITION_MS;
  }

  function isValidTempoPct(v) {
    return typeof v === 'number' && v >= MIN_TEMPO_PCT && v <= MAX_TEMPO_PCT;
  }

  // ---- Binary search: largest index where bar_timings[i].time_s <= scoreTime ----

  function findBarIndex(barTimings, scoreTimeSec) {
    if (!barTimings || barTimings.length === 0) return -1;
    if (scoreTimeSec < barTimings[0].time_s) return 0;
    var lo = 0, hi = barTimings.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (barTimings[mid].time_s <= scoreTimeSec) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  // ---- DOM helpers ----

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  // ---- mount ----

  function mount(container, opts) {
    var role = (opts && opts.role) || 'student';
    var panelEl = (opts && opts.panelEl) || null; // buildAccmpPanel handle (v2 layout)
    var _sendWs = (opts && opts.sendWs) || function () {};
    var _getOneWayLatencyMs = (opts && opts.getOneWayLatencyMs) || function () { return 0; };
    var _acousticProfile = (opts && opts.acousticProfile) || 'headphones';
    var _lobbyMode = !!(opts && opts.lobbyMode);
    var _lobbyAudio = null;
    var _trackMap = new Map();  // "assetId:variantId" → { token }; lobby fetches accumulate here per asset; bound by TOKEN_CAP (1000) enforced server-side
    var _base = (opts && opts.base) || '';  // base URL prefix for lazy fetch; empty string when opts.base omitted — fetch then fails silently via .catch
    var _pendingPreviewFetch = false;       // prevents duplicate in-flight fetches

    var audio = null;
    var rafHandle = null;
    var serverPositionMs = 0;
    var clientRefTime = 0;
    var skewMs = 0;
    var scoreViewHandle = null; // wired after mount via handle.setScoreView()
    var _assetId = null;
    var _variantId = null;

    var root = null;
    var statusEl = null;
    var controls = null;
    var _bannerEl = null;

    function _destroyLobbyAudio() {
      if (_lobbyAudio) {
        _lobbyAudio.pause();
        _lobbyAudio.src = '';
        _lobbyAudio = null;
      }
    }

    if (!panelEl) {
      // Build own floating UI (backward-compatible path).
      root = el('div', 'sb-accompaniment-drawer');
      statusEl = el('div', 'sb-accompaniment-status');
      statusEl.textContent = 'No accompaniment';
      root.appendChild(statusEl);

      if (role === 'teacher') {
        controls = el('div', 'sb-accompaniment-controls');

        var playBtn = el('button', 'sb-btn sb-btn-play');
        playBtn.type = 'button';
        playBtn.textContent = 'Play';
        playBtn.setAttribute('aria-label', 'Play accompaniment');

        var pauseBtn = el('button', 'sb-btn sb-btn-pause');
        pauseBtn.type = 'button';
        pauseBtn.textContent = 'Pause';
        pauseBtn.setAttribute('aria-label', 'Pause accompaniment');
        pauseBtn.disabled = true;

        var stopBtn = el('button', 'sb-btn sb-btn-stop');
        stopBtn.type = 'button';
        stopBtn.textContent = 'Stop';
        stopBtn.setAttribute('aria-label', 'Stop accompaniment');
        stopBtn.disabled = true;

        playBtn.addEventListener('click', function () {
          if (!_assetId || !_variantId) return;
          var posMs = audio && !audio.paused ? Math.round(audio.currentTime * 1000) : 0;
          _sendWs({ type: 'accompaniment_play', asset_id: Number(_assetId), variant_id: Number(_variantId), position_ms: posMs });
        });

        pauseBtn.addEventListener('click', function () {
          var posMs = audio ? Math.round(audio.currentTime * 1000) : 0;
          _sendWs({ type: 'accompaniment_pause', position_ms: posMs });
        });

        stopBtn.addEventListener('click', function () {
          _sendWs({ type: 'accompaniment_stop' });
        });

        controls.appendChild(playBtn);
        controls.appendChild(pauseBtn);
        controls.appendChild(stopBtn);
        root.appendChild(controls);
      }

      if (role === 'teacher') {
        _bannerEl = el('div', 'sb-muting-banner');
        _bannerEl.textContent = 'Backing track playing on student\'s machine only';
        _bannerEl.hidden = true;
        root.appendChild(_bannerEl);
      }

      if (container) container.appendChild(root);
    } else if (role === 'teacher') {
      // Drive the inline accmpPanel from session-panels.js (v2 layout).

      function _startLobbyPlay(token) {
        if (!_lobbyAudio) {
          _lobbyAudio = new Audio('/api/media/' + token);
          _lobbyAudio.addEventListener('ended', _destroyLobbyAudio);
          _lobbyAudio.addEventListener('error', _destroyLobbyAudio);
        }
        _lobbyAudio.play().catch(_destroyLobbyAudio);
      }

      panelEl.pauseBtn.addEventListener('click', function () {
        if (_lobbyMode) {
          if (!_assetId) return;
          // Pause if already playing.
          if (_lobbyAudio && !_lobbyAudio.paused) {
            _lobbyAudio.pause();
            return;
          }
          // Resume if paused and src already loaded.
          if (_lobbyAudio && _lobbyAudio.paused && _lobbyAudio.src) {
            _lobbyAudio.play().catch(_destroyLobbyAudio);
            return;
          }
          // Check token cache first (only if _variantId known from a prior fetch).
          var key = _assetId + ':' + (_variantId || '');
          var entry = _variantId ? _trackMap.get(key) : null;
          if (entry && entry.token) {
            _startLobbyPlay(entry.token);
            return;
          }
          // Lazy fetch — get token for selected asset.
          if (_pendingPreviewFetch) return;
          _pendingPreviewFetch = true;
          var capturedAssetId = _assetId;  // guard against selection change during fetch
          fetch(_base + '/' + capturedAssetId)
            .then(function (r) { return r.json(); })
            .then(function (detail) {
              _pendingPreviewFetch = false;              // clear unconditionally first
              if (!_lobbyMode) return;                   // exit if peer connected during fetch
              if (_assetId !== capturedAssetId) return;  // user changed selection while fetch was in flight
              // Store all variant tokens from this asset fetch.
              (detail.variants || []).forEach(function (v) {
                _trackMap.set(String(capturedAssetId) + ':' + String(v.id), { token: v.token });
              });
              // Play first variant if none selected.
              var targetId = _variantId || (detail.variants && detail.variants[0] && String(detail.variants[0].id));
              if (!targetId) return;
              _variantId = targetId;
              var tok = (_trackMap.get(String(capturedAssetId) + ':' + String(targetId)) || {}).token;
              if (tok) _startLobbyPlay(tok);
            })
            .catch(function () { _pendingPreviewFetch = false; });
          return;
        }
        // Live mode — WS path.
        if (!_assetId || !_variantId) return;
        var posMs = audio ? Math.round(audio.currentTime * 1000) : serverPositionMs;
        var isPlaying = audio && !audio.paused;
        if (isPlaying) {
          _sendWs({ type: 'accompaniment_pause', position_ms: posMs });
        } else {
          _sendWs({ type: 'accompaniment_play', asset_id: Number(_assetId), variant_id: Number(_variantId), position_ms: posMs });
        }
      });

      // Track selector: mode-aware change handler.
      if (panelEl.trackSelect) {
        panelEl.trackSelect.addEventListener('change', function () {
          var val = panelEl.trackSelect.value || '';
          if (_lobbyMode) {
            // Lobby: value is just assetId.
            _assetId = val || null;
            _variantId = null;
            _destroyLobbyAudio();
          } else {
            // Live: value is "assetId:variantId".
            var parts = val.split(':');
            if (parts.length === 2 && parts[0] && parts[1]) {
              _assetId = parts[0];
              _variantId = parts[1];
            }
          }
        });
      }

      // Apply lobby mode styling on mount.
      if (_lobbyMode && panelEl.setLobbyMode) panelEl.setLobbyMode(true);
    }

    // ---- Acoustic profile ----

    function _applyProfile(profile) {
      _acousticProfile = profile;
      var muted = (profile !== 'headphones');
      if (audio) audio.muted = muted;
      if (_bannerEl) _bannerEl.hidden = !muted;
    }

    // Apply initial profile (banner visible before any audio is created).
    _applyProfile(_acousticProfile);

    // ---- Internal helpers ----

    function stopRaf() {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    }

    function startRaf(barTimings, seekToBar) {
      stopRaf();
      if (!barTimings && !panelEl) return;
      (function tick() {
        var currentMs = serverPositionMs + (Date.now() - clientRefTime) + skewMs;
        if (panelEl) panelEl.setPosition(currentMs);
        if (barTimings && seekToBar) {
          var tempo = _lastTempoPct;
          if (!tempo || tempo <= 0) {
            console.warn('[accompaniment-drawer] tempo_pct invalid, falling back to 100');
            tempo = 100;
          }
          var scoreTimeSec = (currentMs / 1000) * (tempo / 100);
          var idx = findBarIndex(barTimings, scoreTimeSec);
          if (idx >= 0) seekToBar(barTimings[idx].bar);
        }
        rafHandle = requestAnimationFrame(tick);
      }());
    }

    var _lastTempoPct = 100;

    function ensureAudio(wavUrl) {
      if (!wavUrl) {
        if (audio) {
          audio.pause();
          audio.src = '';
        }
        return;
      }
      if (!audio) {
        audio = new Audio();
        audio.muted = (_acousticProfile !== 'headphones');
        audio.addEventListener('ended', function () {
          if (role === 'teacher') {
            _sendWs({ type: 'accompaniment_stop' });
          }
        });
        audio.addEventListener('error', function (e) {
          console.error('[accompaniment-drawer] audio error', e);
        });
        audio.addEventListener('loadedmetadata', function () {
          if (panelEl && audio.duration && isFinite(audio.duration)) {
            panelEl.setDuration(Math.round(audio.duration * 1000));
          }
        });
      }
    }

    // ---- updateState ----

    function updateState(state) {
      if (_lobbyMode) return;
      if (!state) return;

      stopRaf();

      var isPlaying = !!state.is_playing;
      var assetId = state.asset_id;
      var wavUrl = state.wav_url || null;
      var barTimings = state.bar_timings || null;
      var tempoPct = (state.tempo_pct != null) ? state.tempo_pct : null;

      // Validate client-side bounds (defensive; server enforces too).
      if (state.position_ms !== undefined && !isValidPositionMs(state.position_ms)) {
        console.warn('[accompaniment-drawer] position_ms out of range, ignoring');
        return;
      }
      if (tempoPct !== null && !isValidTempoPct(tempoPct)) {
        console.warn('[accompaniment-drawer] tempo_pct out of range, ignoring');
        return;
      }

      _lastTempoPct = tempoPct || 100;

      if (assetId === null || assetId === undefined) {
        // Cleared state.
        stopRaf();
        _assetId = null; _variantId = null;
        if (audio) { audio.pause(); audio.src = ''; }
        if (statusEl) statusEl.textContent = 'No accompaniment';
        if (panelEl) { panelEl.setTrackName(null); panelEl.setPosition(0); panelEl.setPaused(true); }
        if (controls) {
          controls.querySelector('.sb-btn-pause').disabled = true;
          controls.querySelector('.sb-btn-stop').disabled = true;
        }
        if (scoreViewHandle) scoreViewHandle.updatePages(null, null);
        return;
      }

      _assetId = assetId;
      _variantId = state.variant_id || null;
      if (root) { root.dataset.assetId = assetId; root.dataset.variantId = state.variant_id || ''; }

      // Skew: sampled once on receipt; not per-frame.
      // Positive skew means server_time_ms was in the past (network delay):
      // advance currentMs to compensate. Formula: Date.now() - server_time_ms.
      if (typeof state.server_time_ms === 'number') {
        skewMs = clamp(Date.now() - state.server_time_ms, -MAX_SKEW_MS, MAX_SKEW_MS);
      }

      serverPositionMs = state.position_ms || 0;
      clientRefTime = Date.now();

      ensureAudio(wavUrl);

      if (wavUrl && audio) {
        if (audio.src !== wavUrl) {
          audio.src = wavUrl;
        }
        // Teacher advances their playback by one-way latency so the track
        // arrives in sync with the student's voice (which is delayed by that
        // same amount on the teacher's feed).
        var latencyOffsetMs = (role === 'teacher') ? _getOneWayLatencyMs() : 0;
        audio.currentTime = (serverPositionMs + latencyOffsetMs) / 1000;

        if (isPlaying) {
          audio.play().catch(function (e) {
            console.warn('[accompaniment-drawer] audio.play() rejected', e);
          });
        } else {
          audio.pause();
        }
      }

      // Update score view.
      if (scoreViewHandle) scoreViewHandle.updatePages(state.page_urls || null, state.bar_coords || null);

      if (statusEl) statusEl.textContent = isPlaying ? 'Playing' : 'Paused';
      if (panelEl) {
        panelEl.setTrackName(isPlaying ? 'Playing' : 'Paused');
        panelEl.setPosition(serverPositionMs);
        panelEl.setPaused(!isPlaying);
      }
      if (controls) {
        controls.querySelector('.sb-btn-pause').disabled = !isPlaying;
        controls.querySelector('.sb-btn-stop').disabled = false;
      }

      // Start rAF loop when playing (also updates panelEl position if present).
      if (isPlaying) {
        var seekFn = (scoreViewHandle && barTimings && barTimings.length > 0)
          ? function (bar) { scoreViewHandle.seekToBar(bar); } : null;
        startRaf(barTimings, seekFn);
      }
    }

    function teardown() {
      stopRaf();
      _destroyLobbyAudio();
      if (audio) {
        audio.pause();
        audio.src = '';
        audio = null;
      }
      if (root && container && container.contains(root)) {
        container.removeChild(root);
      }
    }

    return {
      teardown: teardown,
      updateState: updateState,
      setScoreView: function (handle) { scoreViewHandle = handle; },
      setAcousticProfile: _applyProfile,
      setSendWs: function (fn) { _sendWs = typeof fn === 'function' ? fn : function () {}; },
      setGetOneWayLatencyMs: function (fn) {
        _getOneWayLatencyMs = typeof fn === 'function' ? fn : function () { return 0; };
      },
      enterLobbyMode: function () {
        _lobbyMode = true;
        _destroyLobbyAudio();
        if (panelEl && panelEl.setLobbyMode) panelEl.setLobbyMode(true);
      },
      exitLobbyMode: function () {
        _lobbyMode = false;
        _destroyLobbyAudio();
        if (panelEl && panelEl.setLobbyMode) panelEl.setLobbyMode(false);
      },
      // Populate lobby track selector with [{id, title, variant_count}] — no tokens.
      setAssetList: function (assets) {
        if (!panelEl || !panelEl.trackSelect) return;
        var sel = panelEl.trackSelect;
        while (sel.options.length > 1) sel.remove(1);
        assets.forEach(function (a) {
          var opt = document.createElement('option');
          opt.value = String(a.id);
          opt.textContent = a.title + ' (' + a.variant_count + ' variant' +
                            (a.variant_count === 1 ? '' : 's') + ')';
          sel.appendChild(opt);
        });
      },
      // Populate live track selector with [{id, title, variants:[{id,label,tempo_pct,token}]}].
      setTrackList: function (assets) {
        _trackMap = new Map();  // idempotent clear
        if (!panelEl || !panelEl.trackSelect) return;
        var sel = panelEl.trackSelect;
        while (sel.options.length > 1) sel.remove(1);
        assets.forEach(function (a) {
          var grp = document.createElement('optgroup');
          grp.label = a.title;
          (a.variants || []).forEach(function (v) {
            var opt = document.createElement('option');
            opt.value = a.id + ':' + v.id;
            opt.textContent = v.label + ' \u2014 ' + v.tempo_pct + '%';
            grp.appendChild(opt);
            if (v.token) _trackMap.set(String(a.id) + ':' + String(v.id), { token: v.token });
          });
          sel.appendChild(grp);
        });
      },
    };
  }

  return { mount: mount };
});
