// File: web/assets/library.js
// Purpose: Teacher accompaniment library page — load, upload, OMR flow, synthesis modal,
//          variant management, and Web MIDI keyboard recording.
// Role: Page-level script for /teach/:slug/library.
// Exports: window.sbLibrary / module.exports (test harness)
// Depends: fetch API, Web MIDI API (optional — graceful degradation if absent)
// Invariants: all server-supplied strings rendered via .textContent only (no innerHTML);
//             upload fires raw file body (not FormData) with X-Title header;
//             503 responses show sidecar banner except for upload, delete, and expandAsset;
//             synthesise() validates client-side before fetch (defense-in-depth; modal also validates);
//             MIDI port.name set via .textContent only (no innerHTML);
//             serializeMidi is a pure function — no side effects, no DOM access;
//             openSynthModal submit handler registered once at init — no listener accumulation.
// Last updated: Sprint 25 (2026-04-28) -- score modal scrolls highlighted bar into upper third

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbLibrary = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BASE = '';

  // Module-level synthesis modal state — set by openSynthModal, read by submit handler.
  var _modalAssetId = null;
  var _modalHasMidi = false;
  var _modalVariantListEl = null;
  var _modalResynFn = null;     // (variant) => void — passed to renderVariantRow for new rows
  var _modalBannerEl = null;
  var _modalBase = '';

  // Module-level score modal state — set by openScoreModal.
  var _scoreAudio = null;
  var _scoreTimings = [];    // [{bar, time_s}] at accompaniment's natural tempo
  var _scoreBarCoords = [];  // [{bar, page, x_frac, y_frac, w_frac, h_frac}]
  var _scoreTempoPct = 100;

  // Module-level MIDI recording state.
  var _midiState = {
    recording: false,
    captureStart: 0,
    events: [],
    heldNotes: {},
    port: null,
    noteDisplayEl: null,
    statusEl: null,
  };
  var _midiAccess = null;
  var _pendingAutoExpandId = null;

  // ---------------------------------------------------------------------------
  // Banner
  // ---------------------------------------------------------------------------

  function show503Banner(bannerEl) {
    if (bannerEl) bannerEl.hidden = false;
  }

  function hide503Banner(bannerEl) {
    if (bannerEl) bannerEl.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Asset list
  // ---------------------------------------------------------------------------

  function loadAssets(base, listEl, emptyEl, errorEl, bannerEl) {
    fetch(base)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          errorEl.hidden = false;
          errorEl.textContent = (res.data && res.data.message) || 'Failed to load assets';
          return;
        }
        listEl.replaceChildren();
        emptyEl.hidden = res.data.length > 0;
        res.data.forEach(function (asset) {
          listEl.appendChild(renderSummary(asset, base, bannerEl));
        });
      })
      .catch(function (err) {
        errorEl.hidden = false;
        errorEl.textContent = 'Failed to load assets: ' + err.message;
      });
  }

  function renderSummary(asset, base, bannerEl) {
    var li = document.createElement('li');
    li.className = 'asset-row';
    li.setAttribute('data-id', String(asset.id));

    var header = document.createElement('div');
    header.className = 'asset-header';

    var expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'asset-expand-btn';
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.textContent = '▸ ' + asset.title;

    var kind = asset.has_pdf ? 'PDF' : asset.has_midi ? 'MIDI' : 'WAV';
    var date = new Date(asset.created_at * 1000).toLocaleDateString();
    var meta = document.createElement('span');
    meta.className = 'asset-meta';
    meta.textContent = kind + ' · ' + asset.variant_count + ' variants · ' + date;

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'asset-delete-btn';
    deleteBtn.textContent = 'Delete';

    var detailEl = document.createElement('div');
    detailEl.className = 'asset-detail';
    detailEl.hidden = true;

    var expanded = false;
    expandBtn.addEventListener('click', function () {
      if (!expanded) {
        expanded = true;
        expandBtn.setAttribute('aria-expanded', 'true');
        detailEl.hidden = false;
        expandAsset(asset.id, detailEl, expandBtn, base, bannerEl);
      } else {
        expanded = false;
        expandBtn.setAttribute('aria-expanded', 'false');
        detailEl.hidden = true;
      }
    });

    deleteBtn.addEventListener('click', function () {
      confirmDelete(asset.id, asset.title, li, base, globalThis.confirm, globalThis.alert);
    });

    header.appendChild(expandBtn);
    header.appendChild(meta);
    header.appendChild(deleteBtn);
    li.appendChild(header);
    li.appendChild(detailEl);

    // Auto-expand if this row is the result of a MIDI keyboard upload.
    if (_pendingAutoExpandId !== null && asset.id === _pendingAutoExpandId) {
      _pendingAutoExpandId = null;
      expanded = true;
      expandBtn.setAttribute('aria-expanded', 'true');
      detailEl.hidden = false;
      expandAsset(asset.id, detailEl, expandBtn, base, bannerEl);
    }

    return li;
  }

  // ---------------------------------------------------------------------------
  // Asset detail (expand)
  // ---------------------------------------------------------------------------

  function buildOmrSection(id, variantListEl, base, bannerEl) {
    var statusEl = document.createElement('p');
    statusEl.className = 'omr-status';
    statusEl.setAttribute('aria-live', 'polite');

    var section = document.createElement('section');
    section.className = 'omr-flow';

    var omrBtn = document.createElement('button');
    omrBtn.type = 'button';
    omrBtn.className = 'omr-btn';
    omrBtn.textContent = 'Run OMR';

    var partPickerEl = document.createElement('div');
    partPickerEl.className = 'part-picker';
    partPickerEl.hidden = true;

    omrBtn.addEventListener('click', function () {
      omrBtn.disabled = true;
      omrBtn.textContent = 'Running\u2026';
      runOmr(id, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl);
    });

    section.appendChild(omrBtn);
    section.appendChild(partPickerEl);
    section.appendChild(statusEl);
    return section;
  }

  function expandAsset(id, detailEl, expandBtn, base, bannerEl) {
    detailEl.hidden = false;
    expandBtn.setAttribute('aria-expanded', 'true');
    fetch(base + '/' + id)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          detailEl.textContent = (res.data && res.data.message) || 'Failed to load asset';
          return;
        }
        var detail = res.data;
        detailEl.textContent = '';

        var variantListEl = document.createElement('ul');
        variantListEl.className = 'variant-list';

        // Re-synthesise callback opens the modal pre-filled with existing variant values.
        function makeResynFn(listEl) {
          return function (variant) {
            openSynthModal(id, null, true, listEl, {
              label: variant.label,
              tempo_pct: variant.tempo_pct,
              transpose_semitones: variant.transpose_semitones,
            }, base, bannerEl);
          };
        }

        if (detail.page_tokens && detail.page_tokens.length > 0) {
          var viewScoreBtn = document.createElement('button');
          viewScoreBtn.type = 'button';
          viewScoreBtn.className = 'sb-btn sb-btn--ghost view-score-btn sb-mt-2';
          viewScoreBtn.textContent = 'View Score';
          viewScoreBtn.addEventListener('click', function () {
            openScoreModal(detail, base);
          });
          detailEl.appendChild(viewScoreBtn);
        }

        if (detail.has_pdf) {
          detailEl.appendChild(buildOmrSection(id, variantListEl, base, bannerEl));
        }

        // "New variant" button (shown only when MIDI exists — parts already extracted).
        if (detail.has_midi) {
          var newVariantBtn = document.createElement('button');
          newVariantBtn.type = 'button';
          newVariantBtn.className = 'new-variant-btn sb-btn sb-btn--ghost sb-mt-2';
          newVariantBtn.setAttribute('data-asset-id', String(id));
          newVariantBtn.textContent = '+ New variant';
          newVariantBtn.addEventListener('click', function () {
            openSynthModal(id, null, true, variantListEl, null, base, bannerEl);
          });
          detailEl.appendChild(newVariantBtn);
        }

        // Variant list — re-synthesise only available when MIDI exists.
        if (detail.variants) {
          detail.variants.forEach(function (variant) {
            var resynCb = detail.has_midi ? makeResynFn(variantListEl) : null;
            variantListEl.appendChild(renderVariantRow(id, variant, base, bannerEl, resynCb));
          });
        }
        detailEl.appendChild(variantListEl);
      })
      .catch(function (err) {
        detailEl.textContent = 'Failed to load asset: ' + err.message;
      });
  }

  // Show the "New variant" button on an already-expanded card after first MIDI creation.
  function showNewVariantButton(assetId, variantListEl, base, bannerEl) {
    var allBtns = document.querySelectorAll('.new-variant-btn');
    var btn = null;
    for (var i = 0; i < allBtns.length; i++) {
      if (allBtns[i].getAttribute('data-asset-id') === String(assetId)) {
        btn = allBtns[i];
        break;
      }
    }
    if (btn) {
      btn.hidden = false;
      return;
    }
    // Button doesn't exist yet (asset was has_pdf only at expand time) — create and insert.
    var detailEls = document.querySelectorAll('.asset-detail');
    var targetDetail = null;
    for (var i = 0; i < detailEls.length; i++) {
      var row = detailEls[i].closest('[data-id]');
      if (row && row.getAttribute('data-id') === String(assetId)) {
        targetDetail = detailEls[i];
        break;
      }
    }
    if (!targetDetail) return;
    var newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'new-variant-btn sb-btn sb-btn--ghost sb-mt-2';
    newBtn.setAttribute('data-asset-id', String(assetId));
    newBtn.textContent = '+ New variant';
    newBtn.addEventListener('click', function () {
      openSynthModal(assetId, null, true, variantListEl, null, base, bannerEl);
    });
    var list = targetDetail.querySelector('.variant-list');
    if (list) {
      targetDetail.insertBefore(newBtn, list);
    } else {
      targetDetail.appendChild(newBtn);
    }
  }

  // ---------------------------------------------------------------------------
  // OMR flow
  // ---------------------------------------------------------------------------

  function runOmr(assetId, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl) {
    fetch(base + '/' + assetId + '/parts', { method: 'POST' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok || res.status !== 202) {
          omrBtn.disabled = false;
          omrBtn.textContent = 'Run OMR';
          if (res.status === 503) show503Banner(bannerEl);
          statusEl.textContent = (res.data && res.data.message) || 'OMR failed';
          return;
        }
        statusEl.textContent = 'OMR running\u2026';
        pollOmrJob(res.data.poll_url, assetId, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl);
      })
      .catch(function (err) {
        omrBtn.disabled = false;
        omrBtn.textContent = 'Run OMR';
        statusEl.textContent = 'OMR failed: ' + err.message;
      });
  }

  function pollOmrJob(pollUrl, assetId, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl) {
    fetch(pollUrl)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 202) {
          setTimeout(function () {
            pollOmrJob(pollUrl, assetId, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl);
          }, 3000);
          return;
        }
        omrBtn.disabled = false;
        omrBtn.textContent = 'Run OMR';
        if (!res.ok) {
          if (res.status === 503) show503Banner(bannerEl);
          statusEl.textContent = (res.data && res.data.message) || 'OMR failed';
          return;
        }
        var parts = res.data.parts || [];
        partPickerEl.hidden = true; // part picker no longer needed; modal handles voice selection
        rasterise(assetId, statusEl, base, bannerEl);
        if (parts.length > 0) {
          openSynthModal(assetId, parts, false, variantListEl, null, base, bannerEl);
        } else {
          statusEl.textContent = 'No voices detected \u2014 re-run OMR.';
        }
      })
      .catch(function (err) {
        omrBtn.disabled = false;
        omrBtn.textContent = 'Run OMR';
        statusEl.textContent = 'OMR failed: ' + err.message;
      });
  }

  function extractMidi(assetId, partIndices, statusEl, onSuccess, onFailure, base, bannerEl) {
    fetch(base + '/' + assetId + '/midi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part_indices: partIndices }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 503) show503Banner(bannerEl);
          statusEl.textContent = (res.data && res.data.message) || 'MIDI extraction failed';
          if (onFailure) onFailure();
          return;
        }
        statusEl.textContent = res.data.bar_count + ' bars extracted';
        if (onSuccess) onSuccess();
      })
      .catch(function (err) {
        statusEl.textContent = 'MIDI extraction failed: ' + err.message;
        if (onFailure) onFailure();
      });
  }

  function rasterise(assetId, statusEl, base, bannerEl) {
    fetch(base + '/' + assetId + '/rasterise', { method: 'POST' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 503) show503Banner(bannerEl);
          statusEl.textContent = (res.data && res.data.message) || 'Rasterise failed';
          return;
        }
        statusEl.textContent = res.data.page_count + ' pages rasterised';
      })
      .catch(function (err) {
        statusEl.textContent = 'Rasterise failed: ' + err.message;
      });
  }

  // ---------------------------------------------------------------------------
  // Synthesise
  // ---------------------------------------------------------------------------

  function synthesise(assetId, req, statusEl, variantListEl, base, bannerEl, resynFn) {
    if (!req.label || !req.label.trim()) {
      if (statusEl) statusEl.textContent = 'Label is required';
      return;
    }
    if (!Number.isInteger(req.tempo_pct) || req.tempo_pct < 25 || req.tempo_pct > 300) {
      if (statusEl) statusEl.textContent = 'Tempo must be between 25 and 300';
      return;
    }
    if (!Number.isInteger(req.transpose_semitones) || req.transpose_semitones < -12 || req.transpose_semitones > 12) {
      if (statusEl) statusEl.textContent = 'Transpose must be between -12 and 12';
      return;
    }

    fetch(base + '/' + assetId + '/variants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 503) show503Banner(bannerEl);
          if (statusEl) statusEl.textContent = (res.data && res.data.message) || 'Synthesise failed';
          return;
        }
        var displayReq = {
          id: res.data.id,
          label: res.data.label,
          tempo_pct: req.tempo_pct,
          transpose_semitones: req.transpose_semitones,
          respect_repeats: req.respect_repeats,
        };
        if (variantListEl) {
          var rowResynFn = resynFn || function (rReq) {
            synthesise(assetId, rReq, statusEl, variantListEl, base, bannerEl);
          };
          variantListEl.prepend(renderVariantRow(assetId, displayReq, base, bannerEl, rowResynFn));
        }
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = 'Synthesise failed: ' + err.message;
      });
  }

  function renderVariantRow(assetId, variant, base, bannerEl, synthesiseFn) {
    var li = document.createElement('li');
    li.className = 'variant-row';

    var labelEl = document.createElement('span');
    labelEl.className = 'variant-label-text';
    labelEl.textContent = variant.label;

    var metaEl = document.createElement('span');
    metaEl.className = 'variant-meta';
    metaEl.textContent = variant.tempo_pct + '% · ' + (variant.transpose_semitones >= 0 ? '+' : '') + variant.transpose_semitones + ' semitones';

    var audio = document.createElement('audio');
    audio.className = 'variant-audio';
    audio.controls = true;
    audio.preload = 'none';
    audio.src = '/api/media/' + variant.token;

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'variant-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      confirmDeleteVariant(assetId, variant.id, li, base, globalThis.confirm, globalThis.alert);
    });

    li.appendChild(labelEl);
    li.appendChild(metaEl);
    li.appendChild(audio);
    if (synthesiseFn) {
      var resynBtn = document.createElement('button');
      resynBtn.type = 'button';
      resynBtn.className = 'variant-resynth-btn';
      resynBtn.textContent = 'Re-synthesise';
      resynBtn.addEventListener('click', function () {
        synthesiseFn({
          label: variant.label,
          tempo_pct: variant.tempo_pct,
          transpose_semitones: variant.transpose_semitones,
          respect_repeats: variant.respect_repeats || false,
        });
      });
      li.appendChild(resynBtn);
    }
    li.appendChild(deleteBtn);
    return li;
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  function doDelete(url, li, confirmFn, prompt, alertFn) {
    if (!confirmFn(prompt)) return;
    fetch(url, { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 204) { li.remove(); return; }
        return r.json().then(function (d) { alertFn((d && d.message) || 'Delete failed'); });
      })
      .catch(function (err) { alertFn('Delete failed: ' + err.message); });
  }

  function confirmDelete(assetId, title, li, base, confirmFn, alertFn) {
    var safeTitle = title.replace(/[\r\n]/g, ' ');
    doDelete(base + '/' + assetId, li, confirmFn, 'Delete "' + safeTitle + '"? This cannot be undone.', alertFn);
  }

  function confirmDeleteVariant(assetId, variantId, variantLi, base, confirmFn, alertFn) {
    doDelete(base + '/' + assetId + '/variants/' + variantId, variantLi, confirmFn, 'Delete this variant?', alertFn);
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  function startUpload(opts) {
    var file = opts.file;
    var title = (opts.title || '').trim();
    var progressEl = opts.progressEl;
    var errorEl = opts.errorEl;
    var uploadBtn = opts.uploadBtn;
    var base = opts.BASE;
    var loadAssetsFn = opts.loadAssets;
    var listEl = opts.listEl;
    var emptyEl = opts.emptyEl;
    var assetsErrorEl = opts.assetsErrorEl;
    var bannerEl = opts.bannerEl;

    errorEl.hidden = true;
    if (!file) {
      errorEl.hidden = false;
      errorEl.textContent = 'Please select a file';
      return;
    }
    if (!title) {
      errorEl.hidden = false;
      errorEl.textContent = 'Title is required';
      return;
    }
    var encoded = new TextEncoder().encode(title);
    if (encoded.length > 255) {
      errorEl.hidden = false;
      errorEl.textContent = 'Title is too long (max 255 bytes)';
      return;
    }

    progressEl.hidden = false;
    uploadBtn.disabled = true;

    fetch(base, {
      method: 'POST',
      headers: { 'X-Title': title, 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        progressEl.hidden = true;
        uploadBtn.disabled = false;
        if (!res.ok) {
          errorEl.hidden = false;
          errorEl.textContent = (res.data && res.data.message) || 'Upload failed';
          return;
        }
        if (opts.clearTitle) opts.clearTitle();
        opts.clearFile && opts.clearFile();
        // onSuccess must run before loadAssets so _pendingAutoExpandId is set before renderSummary.
        if (opts.onSuccess) opts.onSuccess(res.data);
        loadAssetsFn(base, listEl, emptyEl, assetsErrorEl, bannerEl);
      })
      .catch(function (err) {
        progressEl.hidden = true;
        uploadBtn.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = 'Upload failed: ' + err.message;
      });
  }

  // ---------------------------------------------------------------------------
  // Browser-only file upload init
  // ---------------------------------------------------------------------------

  function initUpload(bannerEl) {
    var dropZone = document.getElementById('drop-zone');
    var fileInput = document.getElementById('file-input');
    var uploadBtn = document.getElementById('upload-btn');
    var titleInput = document.getElementById('title-input');
    var progressEl = document.getElementById('upload-progress');
    var errorEl = document.getElementById('upload-error');
    var listEl = document.getElementById('asset-list');
    var emptyEl = document.getElementById('assets-empty');
    var assetsErrorEl = document.getElementById('assets-error');
    var pendingFile = null;

    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('drop-zone--active');
    });
    dropZone.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dropZone.classList.add('drop-zone--active');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('drop-zone--active');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('drop-zone--active');
      if (e.dataTransfer.files[0]) pendingFile = e.dataTransfer.files[0];
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files[0]) pendingFile = fileInput.files[0];
    });
    uploadBtn.addEventListener('click', function () {
      startUpload({
        file: pendingFile,
        title: titleInput.value,
        uploadBtn: uploadBtn,
        progressEl: progressEl,
        errorEl: errorEl,
        BASE: BASE,
        loadAssets: loadAssets,
        listEl: listEl,
        emptyEl: emptyEl,
        assetsErrorEl: assetsErrorEl,
        bannerEl: bannerEl,
        clearTitle: function () { titleInput.value = ''; },
        clearFile: function () { pendingFile = null; fileInput.value = ''; },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Score modal (sheet music + audio playthrough)
  // ---------------------------------------------------------------------------

  function initScoreModal() {
    var dialog = document.getElementById('score-modal');
    if (!dialog) return;
    document.getElementById('score-modal-close').addEventListener('click', function () {
      dialog.close();
    });
    dialog.addEventListener('close', function () {
      if (_scoreAudio) { _scoreAudio.pause(); }
    });
  }

  function openScoreModal(detail, base) {
    var dialog = document.getElementById('score-modal');
    if (!dialog) return;

    _scoreTimings = Array.isArray(detail.bar_timings) ? detail.bar_timings : [];
    _scoreBarCoords = Array.isArray(detail.bar_coords) ? detail.bar_coords : [];
    _scoreTempoPct = 100;

    document.getElementById('score-modal-title').textContent = detail.title;

    // Variant selector
    var variantSel = document.getElementById('score-modal-variant-select');
    variantSel.textContent = '';
    var hasVariants = detail.variants && detail.variants.length > 0;
    document.getElementById('score-modal-audio-section').hidden = !hasVariants;
    if (hasVariants) {
      detail.variants.forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = '/api/media/' + v.token;
        opt.setAttribute('data-tempo', String(v.tempo_pct));
        opt.textContent = v.label + ' \u2014 ' + v.tempo_pct + '%';
        variantSel.appendChild(opt);
      });
      _scoreTempoPct = detail.variants[0].tempo_pct;
    }

    // Audio element — rebuild fresh each open
    var audioContainer = document.getElementById('score-modal-audio-container');
    audioContainer.textContent = '';
    var audioEl = document.createElement('audio');
    audioEl.className = 'score-modal__audio';
    audioEl.controls = true;
    audioEl.preload = 'none';
    audioEl.src = hasVariants ? variantSel.value : '';
    audioContainer.appendChild(audioEl);
    _scoreAudio = audioEl;

    variantSel.onchange = function () {
      var selOpt = variantSel.options[variantSel.selectedIndex];
      _scoreTempoPct = parseInt(selOpt.getAttribute('data-tempo'), 10) || 100;
      audioEl.pause();
      audioEl.src = variantSel.value;
      audioEl.load();
    };

    audioEl.addEventListener('timeupdate', scoreHighlightBar);
    audioEl.addEventListener('ended', scoreClearHighlights);
    audioEl.addEventListener('seeked', scoreHighlightBar);

    // Pages
    var pagesEl = document.getElementById('score-modal-pages');
    pagesEl.textContent = '';
    detail.page_tokens.forEach(function (token, pageIdx) {
      var wrapper = document.createElement('div');
      wrapper.className = 'score-page';
      wrapper.setAttribute('data-page', String(pageIdx));
      var img = document.createElement('img');
      img.src = '/api/media/' + token;
      img.className = 'score-page__img';
      img.alt = 'Page ' + (pageIdx + 1);
      var canvas = document.createElement('canvas');
      canvas.className = 'score-page__overlay';
      img.addEventListener('load', function () {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      });
      wrapper.appendChild(img);
      wrapper.appendChild(canvas);
      pagesEl.appendChild(wrapper);
    });

    dialog.showModal();
  }

  function scoreHighlightBar() {
    if (!_scoreAudio || !_scoreTimings.length || !_scoreBarCoords.length) return;
    var scaledTime = _scoreAudio.currentTime * (_scoreTempoPct / 100);

    var currentBar = _scoreTimings[0].bar;
    for (var i = 0; i < _scoreTimings.length; i++) {
      if (_scoreTimings[i].time_s <= scaledTime) {
        currentBar = _scoreTimings[i].bar;
      } else { break; }
    }

    var coord = null;
    for (var j = 0; j < _scoreBarCoords.length; j++) {
      if (_scoreBarCoords[j].bar === currentBar) { coord = _scoreBarCoords[j]; break; }
    }
    if (!coord) return;

    var pages = document.querySelectorAll('.score-page');
    var pagesEl = document.getElementById('score-modal-pages');
    for (var k = 0; k < pages.length; k++) {
      var canvas = pages[k].querySelector('.score-page__overlay');
      if (!canvas || !canvas.width) continue;
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (parseInt(pages[k].getAttribute('data-page'), 10) === coord.page) {
        ctx.fillStyle = 'rgba(255, 200, 0, 0.42)';
        ctx.fillRect(
          coord.x_frac * canvas.width,
          coord.y_frac * canvas.height,
          coord.w_frac * canvas.width,
          coord.h_frac * canvas.height
        );
        // Smooth-scroll the pages container so the highlighted measure sits
        // in the upper third of the viewport, leaving room for upcoming bars.
        if (pagesEl) {
          var pageRect = pages[k].getBoundingClientRect();
          var containerRect = pagesEl.getBoundingClientRect();
          var highlightTopRel = (pageRect.top - containerRect.top) + coord.y_frac * pageRect.height;
          var desiredOffset = pagesEl.clientHeight * 0.3;
          pagesEl.scrollBy({
            top: highlightTopRel - desiredOffset,
            behavior: 'smooth',
          });
        }
      }
    }
  }

  function scoreClearHighlights() {
    var canvases = document.querySelectorAll('.score-page__overlay');
    for (var i = 0; i < canvases.length; i++) {
      var c = canvases[i];
      if (c.width) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    }
  }

  // ---------------------------------------------------------------------------
  // MIDI helpers (pure functions — no DOM, no module state)
  // ---------------------------------------------------------------------------

  // Standard variable-length quantity encoding (MIDI spec section 1).
  // Throws RangeError for negative values to surface upstream delta-timing bugs.
  function encodeVlq(value) {
    if (value < 0) throw new RangeError('encodeVlq: value must be >= 0');
    if (value === 0) return [0x00];
    var bytes = [];
    bytes.push(value & 0x7F);
    value = value >>> 7;
    while (value > 0) {
      bytes.push((value & 0x7F) | 0x80);
      value = value >>> 7;
    }
    bytes.reverse();
    return bytes;
  }

  function midiNoteToName(note) {
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return names[note % 12] + (Math.floor(note / 12) - 1);
  }

  // Serialize captured events to a Type-1 MIDI file (Uint8Array).
  // opts: { ticksPerBeat?: number (default 480), bpm?: number (default 120) }
  // Throws RangeError for bpm <= 0 or ticksPerBeat <= 0.
  // Negative elapsedMs values are clamped to 0.
  function serializeMidi(events, opts) {
    var ticksPerBeat = (opts && opts.ticksPerBeat != null) ? opts.ticksPerBeat : 480;
    var bpm = (opts && opts.bpm != null) ? opts.bpm : 120;
    if (typeof ticksPerBeat !== 'number' || ticksPerBeat <= 0) {
      throw new RangeError('ticksPerBeat must be > 0');
    }
    if (ticksPerBeat > 32767) {
      throw new RangeError('ticksPerBeat must be <= 32767 (MIDI PPQ limit)');
    }
    if (typeof bpm !== 'number' || bpm <= 0) {
      throw new RangeError('bpm must be > 0');
    }

    var microsPerBeat = Math.round(60000000 / bpm);
    var msPerBeat = 60000 / bpm;

    // Track 0: tempo + end-of-track (11 bytes)
    var tempoBytes = [
      0x00,                               // delta VLQ = 0
      0xFF, 0x51, 0x03,                   // set-tempo meta event
      (microsPerBeat >>> 16) & 0xFF,
      (microsPerBeat >>> 8) & 0xFF,
      microsPerBeat & 0xFF,
      0x00, 0xFF, 0x2F, 0x00,             // end-of-track
    ];

    // Track 1: note events + end-of-track
    var noteBytes = [];
    var lastTick = 0;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var elapsedMs = Math.max(0, ev.elapsedMs != null ? ev.elapsedMs : 0);
      var tick = Math.round(elapsedMs * ticksPerBeat / msPerBeat);
      var delta = tick - lastTick;
      lastTick = tick;
      var vlq = encodeVlq(delta);
      for (var j = 0; j < vlq.length; j++) noteBytes.push(vlq[j]);
      var statusByte;
      if (ev.type === 'note_on') {
        statusByte = 0x90 | (ev.channel & 0x0F);
      } else if (ev.type === 'note_off') {
        statusByte = 0x80 | (ev.channel & 0x0F);
      } else {
        statusByte = 0xB0 | (ev.channel & 0x0F);
      }
      noteBytes.push(statusByte, ev.data1 & 0xFF, ev.data2 & 0xFF);
    }
    noteBytes.push(0x00, 0xFF, 0x2F, 0x00); // end-of-track

    var totalSize = 14 + 8 + tempoBytes.length + 8 + noteBytes.length;
    var buf = new Uint8Array(totalSize);
    var pos = 0;

    function w32(v) {
      buf[pos++] = (v >>> 24) & 0xFF;
      buf[pos++] = (v >>> 16) & 0xFF;
      buf[pos++] = (v >>> 8) & 0xFF;
      buf[pos++] = v & 0xFF;
    }
    function w16(v) {
      buf[pos++] = (v >>> 8) & 0xFF;
      buf[pos++] = v & 0xFF;
    }
    function wArr(arr) {
      for (var k = 0; k < arr.length; k++) buf[pos++] = arr[k];
    }

    // MThd
    buf[pos++] = 0x4D; buf[pos++] = 0x54; buf[pos++] = 0x68; buf[pos++] = 0x64;
    w32(6);
    w16(1);             // format: Type-1
    w16(2);             // numTracks: 2
    w16(ticksPerBeat);

    // MTrk (tempo)
    buf[pos++] = 0x4D; buf[pos++] = 0x54; buf[pos++] = 0x72; buf[pos++] = 0x6B;
    w32(tempoBytes.length);
    wArr(tempoBytes);

    // MTrk (notes)
    buf[pos++] = 0x4D; buf[pos++] = 0x54; buf[pos++] = 0x72; buf[pos++] = 0x6B;
    w32(noteBytes.length);
    wArr(noteBytes);

    return buf;
  }

  // ---------------------------------------------------------------------------
  // MIDI recording — message handler (exported for unit tests)
  // ---------------------------------------------------------------------------

  // Process a single MIDI message against an explicit state object.
  // state: { recording, captureStart, events, heldNotes, port, noteDisplayEl, statusEl }
  // evt: { data: Uint8Array-like, timeStamp: number }
  // Returns: 'ignored' | 'pushed' | 'capped'
  function handleMidiMessage(state, evt) {
    if (!state.recording) return 'ignored';
    var data = evt.data;
    if (!data || data.length < 1) return 'ignored';

    var status = data[0] & 0xFF;
    var statusType = status & 0xF0;
    var channel = status & 0x0F;

    // Accept note_off (0x8n), note_on (0x9n), control_change (0xBn) only.
    if (statusType !== 0x80 && statusType !== 0x90 && statusType !== 0xB0) return 'ignored';

    var data1 = data.length > 1 ? (data[1] & 0xFF) : 0;
    var data2 = data.length > 2 ? (data[2] & 0xFF) : 0;
    var elapsedMs = Math.max(0, (evt.timeStamp != null ? evt.timeStamp : 0) - state.captureStart);

    var type;
    if (statusType === 0x90 && data2 > 0) {
      type = 'note_on';
    } else if (statusType === 0x80 || statusType === 0x90) {
      // note_off or note_on with velocity 0 (normalised to note_off)
      type = 'note_off';
    } else {
      type = 'control_change';
    }

    // Auto-stop at event cap; do NOT push the cap-triggering event.
    if (state.events.length >= 10000) {
      state.recording = false;
      if (state.port) state.port.onmidimessage = null;
      if (state.statusEl) {
        state.statusEl.textContent = 'Recording limit reached (10 000 events). Click Stop to save.';
      }
      return 'capped';
    }

    state.events.push({ elapsedMs: elapsedMs, type: type, channel: channel, data1: data1, data2: data2 });

    if (type === 'note_on') {
      state.heldNotes[data1] = true;
    } else if (type === 'note_off') {
      delete state.heldNotes[data1];
    }

    if (state.noteDisplayEl) {
      var held = Object.keys(state.heldNotes).map(Number).sort(function (a, b) { return a - b; });
      state.noteDisplayEl.textContent = held.length > 0 ? held.map(midiNoteToName).join(' ') : '';
    }

    return 'pushed';
  }

  // ---------------------------------------------------------------------------
  // MIDI recording — device management and capture lifecycle
  // ---------------------------------------------------------------------------

  function getMidiInputs() {
    if (!_midiAccess) return [];
    var inputs = [];
    _midiAccess.inputs.forEach(function (port) { inputs.push(port); });
    return inputs;
  }

  function updateMidiDevicePicker() {
    var inputs = getMidiInputs();
    var section = document.getElementById('midi-record-section');
    var deviceRow = document.getElementById('midi-device-row');
    var deviceSelect = document.getElementById('midi-device-select');

    if (inputs.length === 0) return;

    if (section) section.hidden = false;

    if (!deviceRow || !deviceSelect) return;
    deviceRow.hidden = inputs.length <= 1;
    if (inputs.length > 1) {
      deviceSelect.replaceChildren();
      inputs.forEach(function (port) {
        var option = document.createElement('option');
        option.value = port.id;
        option.textContent = port.name; // XSS safe: textContent only, never innerHTML
        deviceSelect.appendChild(option);
      });
    }
  }

  // accessProvider: optional injectable for tests; defaults to navigator.requestMIDIAccess.
  function initMidiRecording(bannerEl, accessProvider) {
    var requestAccess = accessProvider ||
      (typeof navigator !== 'undefined' && navigator.requestMIDIAccess &&
        navigator.requestMIDIAccess.bind(navigator));

    if (!requestAccess) {
      var noteEl = document.getElementById('midi-unavailable-note');
      if (noteEl) noteEl.hidden = false;
      return;
    }
    requestAccess({ sysex: false }).then(function (access) {
      _midiAccess = access;
      _midiAccess.onstatechange = function () {
        updateMidiDevicePicker();
      };
      updateMidiDevicePicker();
    }).catch(function () {
      var noteEl = document.getElementById('midi-unavailable-note');
      if (noteEl) noteEl.hidden = false;
    });
  }

  function getSelectedPort() {
    var inputs = getMidiInputs();
    if (inputs.length === 0) return null;
    if (inputs.length === 1) return inputs[0];
    var select = document.getElementById('midi-device-select');
    if (select && select.value) {
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].id === select.value) return inputs[i];
      }
    }
    return inputs[0];
  }

  function startMidiCapture() {
    var port = getSelectedPort();
    if (!port) return;

    _midiState.recording = true;
    _midiState.captureStart = typeof performance !== 'undefined' ? performance.now() : 0;
    _midiState.events = [];
    _midiState.heldNotes = {};
    _midiState.port = port;
    _midiState.noteDisplayEl = document.getElementById('midi-note-display');
    _midiState.statusEl = document.getElementById('midi-error');

    port.onmidimessage = function (evt) {
      handleMidiMessage(_midiState, evt);
    };

    var recordBtn = document.getElementById('midi-record-btn');
    var stopBtn = document.getElementById('midi-stop-btn');
    if (recordBtn) recordBtn.hidden = true;
    if (stopBtn) stopBtn.hidden = false;
    if (_midiState.noteDisplayEl) {
      _midiState.noteDisplayEl.textContent = '';
      _midiState.noteDisplayEl.hidden = false;
    }
    if (_midiState.statusEl) _midiState.statusEl.hidden = true;
  }

  // Stops recording, detaches the MIDI handler, returns a copy of captured events.
  function stopMidiCapture() {
    _midiState.recording = false;
    if (_midiState.port) {
      _midiState.port.onmidimessage = null;
    }
    var result = _midiState.events.slice();
    _midiState.events = [];
    _midiState.heldNotes = {};

    var recordBtn = document.getElementById('midi-record-btn');
    var stopBtn = document.getElementById('midi-stop-btn');
    var noteDisplay = document.getElementById('midi-note-display');
    if (recordBtn) recordBtn.hidden = false;
    if (stopBtn) stopBtn.hidden = true;
    if (noteDisplay) noteDisplay.hidden = true;

    return result;
  }

  // ---------------------------------------------------------------------------
  // MIDI upload
  // ---------------------------------------------------------------------------

  function initMidiUploadControls(bannerEl) {
    var midiRecordBtn = document.getElementById('midi-record-btn');
    var midiStopBtn = document.getElementById('midi-stop-btn');
    var midiTitleInput = document.getElementById('midi-title-input');
    var midiProgressEl = document.getElementById('midi-upload-progress');
    var midiErrorEl = document.getElementById('midi-error');
    var listEl = document.getElementById('asset-list');
    var emptyEl = document.getElementById('assets-empty');
    var assetsErrorEl = document.getElementById('assets-error');

    if (midiRecordBtn) {
      midiRecordBtn.addEventListener('click', function () {
        startMidiCapture();
      });
    }

    if (midiStopBtn) {
      midiStopBtn.addEventListener('click', function () {
        var events = stopMidiCapture();
        var midiBytes;
        try {
          midiBytes = serializeMidi(events);
        } catch (e) {
          if (midiErrorEl) {
            midiErrorEl.hidden = false;
            midiErrorEl.textContent = 'MIDI serialization failed: ' + e.message;
          }
          return;
        }
        var blob = new Blob([midiBytes], { type: 'audio/midi' });
        startUpload({
          file: blob,
          title: midiTitleInput ? midiTitleInput.value : '',
          uploadBtn: midiRecordBtn,
          progressEl: midiProgressEl,
          errorEl: midiErrorEl,
          BASE: BASE,
          loadAssets: loadAssets,
          listEl: listEl,
          emptyEl: emptyEl,
          assetsErrorEl: assetsErrorEl,
          bannerEl: bannerEl,
          clearTitle: function () { if (midiTitleInput) midiTitleInput.value = ''; },
          onSuccess: function (data) {
            if (data && data.id != null) _pendingAutoExpandId = data.id;
          },
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Synthesis modal
  // ---------------------------------------------------------------------------

  function openSynthModal(assetId, parts, hasMidi, variantListEl, prefill, base, bannerEl) {
    var dialog = document.getElementById('synth-modal');
    if (!dialog) return;

    // Guard: if no MIDI yet and no parts, cannot synthesise.
    if (!hasMidi && (!parts || parts.length === 0)) {
      return;
    }

    // Store state for the submit handler.
    _modalAssetId = assetId;
    _modalHasMidi = hasMidi;
    _modalVariantListEl = variantListEl;
    _modalBase = base;
    _modalBannerEl = bannerEl;
    _modalResynFn = function (variant) {
      openSynthModal(assetId, null, true, variantListEl, {
        label: variant.label,
        tempo_pct: variant.tempo_pct,
        transpose_semitones: variant.transpose_semitones,
      }, base, bannerEl);
    };

    // Populate / reset form.
    var labelInput = document.getElementById('synth-modal-label');
    var tempoInput = document.getElementById('synth-modal-tempo');
    var transposeInput = document.getElementById('synth-modal-transpose');
    var voicesSection = dialog.querySelector('.synth-modal__voices');
    var voiceList = document.getElementById('synth-modal-voice-list');
    var voicesError = document.getElementById('synth-modal-voices-error');
    var statusP = document.getElementById('synth-modal-status');
    var submitBtn = document.getElementById('synth-modal-submit');

    if (labelInput) labelInput.value = prefill ? prefill.label : '';
    if (tempoInput) tempoInput.value = prefill ? String(prefill.tempo_pct) : '100';
    if (transposeInput) transposeInput.value = prefill ? String(prefill.transpose_semitones) : '0';
    if (statusP) { statusP.textContent = ''; statusP.hidden = true; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Backing Track'; }
    if (voicesError) { voicesError.textContent = ''; voicesError.hidden = true; }

    // Voice checkboxes (only when parts need selecting).
    if (voicesSection) {
      if (!hasMidi && parts && parts.length > 0) {
        voiceList.replaceChildren();
        parts.forEach(function (part) {
          var li = document.createElement('li');
          var lbl = document.createElement('label');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = String(part.index); // backend-authoritative index (not array position)
          cb.checked = true;
          var span = document.createElement('span');
          span.textContent = part.name; // .textContent only — no innerHTML
          lbl.appendChild(cb);
          lbl.appendChild(span);
          li.appendChild(lbl);
          voiceList.appendChild(li);
        });
        voicesSection.hidden = false;
      } else {
        voicesSection.hidden = true;
      }
    }

    dialog.showModal();
  }

  // Submit handler body — extracted to keep initSynthModal under the logic-length threshold.
  function handleSynthSubmit(dialog, submitBtn, statusP, showError, resetSubmitBtn) {
    if (!statusP) return;
    statusP.hidden = true;

    var labelInput = document.getElementById('synth-modal-label');
    var tempoInput = document.getElementById('synth-modal-tempo');
    var transposeInput = document.getElementById('synth-modal-transpose');
    var voicesSection = dialog.querySelector('.synth-modal__voices');
    var voicesError = document.getElementById('synth-modal-voices-error');

    var label = labelInput ? labelInput.value : '';
    var tempo = tempoInput ? Number(tempoInput.value) : NaN;
    var transpose = transposeInput ? Number(transposeInput.value) : NaN;

    if (!label || !label.trim()) { showError('Name is required'); return; }
    if (!Number.isInteger(tempo) || tempo < 25 || tempo > 300) { showError('Tempo must be between 25 and 300'); return; }
    if (!Number.isInteger(transpose) || transpose < -12 || transpose > 12) { showError('Transpose must be between \u221212 and +12'); return; }

    var checkedIndices = [];
    if (!_modalHasMidi && voicesSection && !voicesSection.hidden) {
      var checked = voicesSection.querySelectorAll('input[type=checkbox]:checked');
      if (checked.length === 0) {
        if (voicesError) { voicesError.textContent = 'Select at least one voice'; voicesError.hidden = false; }
        return;
      }
      checked.forEach(function (cb) { checkedIndices.push(Number(cb.value)); });
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Synthesising\u2026';

    var req = { label: label.trim(), tempo_pct: tempo, transpose_semitones: transpose, respect_repeats: false };
    var assetId = _modalAssetId;
    var hasMidi = _modalHasMidi;
    var variantListEl = _modalVariantListEl;
    var resynFn = _modalResynFn;
    var base = _modalBase;
    var bannerEl = _modalBannerEl;

    var wrappedList = {
      prepend: function (el) {
        if (variantListEl) variantListEl.prepend(el);
        dialog.close();
        if (!hasMidi) showNewVariantButton(assetId, variantListEl, base, bannerEl);
      }
    };

    function doSynth() {
      // statusProxy intercepts textContent assignments so that any error message
      // written by synthesise() also re-enables the submit button.
      var statusProxy = { _el: statusP };
      Object.defineProperty(statusProxy, 'textContent', {
        get: function () { return statusProxy._el ? statusProxy._el.textContent : ''; },
        set: function (v) {
          if (statusProxy._el) { statusProxy._el.textContent = v; statusProxy._el.hidden = !v; }
          if (v) resetSubmitBtn();
        },
      });
      synthesise(assetId, req, statusProxy, wrappedList, base, bannerEl, resynFn);
    }

    if (!hasMidi) {
      extractMidi(assetId, checkedIndices, statusP,
        function onSuccess() { doSynth(); },
        function onFailure() { resetSubmitBtn(); },
        base, bannerEl
      );
    } else {
      doSynth();
    }
  }

  function initSynthModal() {
    var dialog = document.getElementById('synth-modal');
    if (!dialog) return;

    // Fallback for browsers without native <dialog> support.
    if (typeof HTMLDialogElement === 'undefined') {
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.showModal = function () { this.removeAttribute('hidden'); this.setAttribute('open', ''); };
      dialog.close = function () { this.setAttribute('hidden', ''); this.removeAttribute('open'); };
      dialog.setAttribute('hidden', '');
    }

    var submitBtn = document.getElementById('synth-modal-submit');
    var cancelBtn = document.getElementById('synth-modal-cancel');
    var statusP = document.getElementById('synth-modal-status');

    function showError(msg) {
      if (statusP) { statusP.textContent = msg; statusP.hidden = false; }
    }
    function resetSubmitBtn() {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Backing Track'; }
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () { dialog.close(); });
    }

    // Submit registered once — reads module-scoped _modal* vars.
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        handleSynthSubmit(dialog, submitBtn, statusP, showError, resetSubmitBtn);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Page init
  // ---------------------------------------------------------------------------

  function init() {
    var slug = location.pathname.replace(/^\/teach\//, '').replace(/\/library.*$/, '');
    BASE = '/teach/' + slug + '/library/assets';
    document.getElementById('back-link').href = '/teach/' + slug;
    var bannerEl = document.getElementById('sidecar-banner');
    document.getElementById('sidecar-banner-close')
      .addEventListener('click', function () { hide503Banner(bannerEl); });
    initUpload(bannerEl);
    initSynthModal();
    initScoreModal();
    initMidiRecording(bannerEl);
    initMidiUploadControls(bannerEl);
    loadAssets(
      BASE,
      document.getElementById('asset-list'),
      document.getElementById('assets-empty'),
      document.getElementById('assets-error'),
      bannerEl
    );
  }

  if (typeof document !== 'undefined') {
    init();
  }

  return {
    loadAssets: loadAssets,
    renderSummary: renderSummary,
    renderVariantRow: renderVariantRow,
    expandAsset: expandAsset,
    runOmr: runOmr,
    pollOmrJob: pollOmrJob,
    extractMidi: extractMidi,
    rasterise: rasterise,
    synthesise: synthesise,
    openSynthModal: openSynthModal,
    initSynthModal: initSynthModal,
    confirmDelete: confirmDelete,
    confirmDeleteVariant: confirmDeleteVariant,
    show503Banner: show503Banner,
    hide503Banner: hide503Banner,
    startUpload: startUpload,
    // MIDI — exported for unit tests
    encodeVlq: encodeVlq,
    serializeMidi: serializeMidi,
    handleMidiMessage: handleMidiMessage,
    initMidiRecording: initMidiRecording,
    startMidiCapture: startMidiCapture,
    stopMidiCapture: stopMidiCapture,
    // Test-only hooks
    _setPendingAutoExpandId: function (id) { _pendingAutoExpandId = id; },
    _setModalState: function (s) {
      if (s.assetId !== undefined) _modalAssetId = s.assetId;
      if (s.hasMidi !== undefined) _modalHasMidi = s.hasMidi;
      if (s.variantListEl !== undefined) _modalVariantListEl = s.variantListEl;
      if (s.resynFn !== undefined) _modalResynFn = s.resynFn;
      if (s.base !== undefined) _modalBase = s.base;
      if (s.bannerEl !== undefined) _modalBannerEl = s.bannerEl;
    },
  };
});
