// File: web/assets/accompaniment-drawer.js
// Purpose: In-session accompaniment playback UI — audio control and bar-advancement loop.
//          Teacher sees play/pause/stop controls; student sees read-only status.
// Role: Manages the Audio element lifecycle, rAF bar-advancement loop, and WS message dispatch.
// Exports: window.sbAccompanimentDrawer.mount(container, opts) → { teardown, updateState }
// Depends: DOM, Audio, requestAnimationFrame, signalling.js (caller provides sendWs)
// Invariants: skewMs sampled once on receipt; not resampled per rAF tick.
//             effectiveTempoPct = tempo_pct || 100 (fallback + console warning on null/0).
//             cancelAnimationFrame called via stored handle on every state change.
//             Audio element created only when wav_url is non-null.
//             peer-supplied URL set via audio.src (no innerHTML).
// Last updated: Sprint 14 (2026-04-23) -- initial implementation

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
    var sendWs = (opts && opts.sendWs) || function () {};

    var audio = null;
    var rafHandle = null;
    var serverPositionMs = 0;
    var clientRefTime = 0;
    var skewMs = 0;
    var currentBarTimings = null;
    var scoreViewHandle = null; // set by caller via opts.scoreView

    // Build minimal UI.
    var root = el('div', 'sb-accompaniment-drawer');

    // Status line (both roles).
    var statusEl = el('div', 'sb-accompaniment-status');
    statusEl.textContent = 'No accompaniment';
    root.appendChild(statusEl);

    // Teacher controls only.
    var controls = null;
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
        var assetId = root.dataset.assetId;
        var variantId = root.dataset.variantId;
        if (!assetId || !variantId) return;
        var posMs = audio && !audio.paused ? Math.round(audio.currentTime * 1000) : 0;
        sendWs({ type: 'accompaniment_play', asset_id: Number(assetId), variant_id: Number(variantId), position_ms: posMs });
      });

      pauseBtn.addEventListener('click', function () {
        var posMs = audio ? Math.round(audio.currentTime * 1000) : 0;
        sendWs({ type: 'accompaniment_pause', position_ms: posMs });
      });

      stopBtn.addEventListener('click', function () {
        sendWs({ type: 'accompaniment_stop' });
      });

      controls.appendChild(playBtn);
      controls.appendChild(pauseBtn);
      controls.appendChild(stopBtn);
      root.appendChild(controls);
    }

    container.appendChild(root);

    // ---- Internal helpers ----

    function stopRaf() {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    }

    function startRaf(barTimings, seekToBar) {
      stopRaf();
      if (!barTimings || !seekToBar) return;
      (function tick() {
        var currentMs = serverPositionMs + (Date.now() - clientRefTime) + skewMs;
        var effectiveTempoPct = currentBarTimings;
        // Use module-scoped tempo from the last updateState call.
        var tempo = _lastTempoPct;
        if (!tempo || tempo <= 0) {
          console.warn('[accompaniment-drawer] tempo_pct invalid, falling back to 100');
          tempo = 100;
        }
        var scoreTimeSec = (currentMs / 1000) * (tempo / 100);
        var idx = findBarIndex(barTimings, scoreTimeSec);
        if (idx >= 0) {
          seekToBar(barTimings[idx].bar);
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
        audio.addEventListener('ended', function () {
          if (role === 'teacher') {
            sendWs({ type: 'accompaniment_stop' });
          }
        });
        audio.addEventListener('error', function (e) {
          console.error('[accompaniment-drawer] audio error', e);
        });
      }
    }

    // ---- updateState ----

    function updateState(state) {
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
        if (audio) {
          audio.pause();
          audio.src = '';
        }
        statusEl.textContent = 'No accompaniment';
        if (controls) {
          controls.querySelector('.sb-btn-pause').disabled = true;
          controls.querySelector('.sb-btn-stop').disabled = true;
        }
        if (scoreViewHandle) {
          scoreViewHandle.updatePages(null, null);
        }
        return;
      }

      // Store asset/variant IDs for teacher controls.
      root.dataset.assetId = assetId;
      root.dataset.variantId = state.variant_id || '';

      // Skew: sampled once on receipt; not per-frame.
      if (typeof state.server_time_ms === 'number') {
        skewMs = clamp(state.server_time_ms - Date.now(), -MAX_SKEW_MS, MAX_SKEW_MS);
      }

      serverPositionMs = state.position_ms || 0;
      clientRefTime = Date.now();
      currentBarTimings = barTimings;

      ensureAudio(wavUrl);

      if (wavUrl && audio) {
        if (audio.src !== wavUrl) {
          audio.src = wavUrl;
          audio.currentTime = serverPositionMs / 1000;
        } else {
          audio.currentTime = serverPositionMs / 1000;
        }

        if (isPlaying) {
          audio.play().catch(function (e) {
            console.warn('[accompaniment-drawer] audio.play() rejected', e);
          });
        } else {
          audio.pause();
        }
      }

      // Update score view.
      if (scoreViewHandle) {
        scoreViewHandle.updatePages(state.page_urls || null, state.bar_coords || null);
      }

      statusEl.textContent = isPlaying ? 'Playing' : 'Paused';

      if (controls) {
        controls.querySelector('.sb-btn-pause').disabled = !isPlaying;
        controls.querySelector('.sb-btn-stop').disabled = false;
      }

      // Start rAF loop when playing and bar timings are available.
      if (isPlaying && barTimings && barTimings.length > 0) {
        var seekFn = scoreViewHandle ? function (bar) { scoreViewHandle.seekToBar(bar); } : null;
        startRaf(barTimings, seekFn);
      }
    }

    function teardown() {
      stopRaf();
      if (audio) {
        audio.pause();
        audio.src = '';
        audio = null;
      }
      if (container.contains(root)) {
        container.removeChild(root);
      }
    }

    return {
      teardown: teardown,
      updateState: updateState,
      setScoreView: function (handle) { scoreViewHandle = handle; },
    };
  }

  return { mount: mount };
});
