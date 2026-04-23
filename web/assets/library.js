// File: web/assets/library.js
// Purpose: Teacher accompaniment library page — load, upload, OMR flow, synthesise, delete.
// Role: Page-level script for /teach/:slug/library.
// Exports: window.sbLibrary / module.exports (test harness)
// Depends: fetch API
// Invariants: all server-supplied strings rendered via .textContent only (no innerHTML);
//             upload fires raw file body (not FormData) with X-Title header;
//             503 responses show sidecar banner except for upload, delete, and expandAsset;
//             synthesise is validated client-side before fetch.
// Last updated: Sprint 13 (2026-04-22) -- initial implementation

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
    return li;
  }

  // ---------------------------------------------------------------------------
  // Asset detail (expand)
  // ---------------------------------------------------------------------------

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

        var omrStatusEl = document.createElement('p');
        omrStatusEl.className = 'omr-status';
        omrStatusEl.setAttribute('aria-live', 'polite');

        var partPickerEl = document.createElement('div');
        partPickerEl.className = 'part-picker';
        partPickerEl.hidden = true;

        var extractMidiBtn = document.createElement('button');
        extractMidiBtn.type = 'button';
        extractMidiBtn.className = 'extract-midi-btn';
        extractMidiBtn.textContent = 'Extract MIDI';

        var rasteriseBtn = document.createElement('button');
        rasteriseBtn.type = 'button';
        rasteriseBtn.className = 'rasterise-btn';
        rasteriseBtn.textContent = 'Rasterise pages';
        rasteriseBtn.disabled = !detail.has_midi;

        var synthesiseSection = document.createElement('section');
        synthesiseSection.className = 'synthesise-form';
        synthesiseSection.hidden = !detail.has_midi;

        var synthStatusEl = document.createElement('p');
        synthStatusEl.className = 'synthesise-status';
        synthStatusEl.setAttribute('aria-live', 'polite');

        var variantListEl = document.createElement('ul');
        variantListEl.className = 'variant-list';

        // OMR section (PDF only)
        if (detail.has_pdf) {
          var omrSection = document.createElement('section');
          omrSection.className = 'omr-flow';

          var omrBtn = document.createElement('button');
          omrBtn.type = 'button';
          omrBtn.className = 'omr-btn';
          omrBtn.textContent = 'Run OMR';

          partPickerEl.appendChild(extractMidiBtn);

          omrBtn.addEventListener('click', function () {
            omrBtn.disabled = true;
            omrBtn.textContent = 'Running…';
            runOmr(id, partPickerEl, omrBtn, omrStatusEl, base, bannerEl);
          });

          extractMidiBtn.addEventListener('click', function () {
            var checked = partPickerEl.querySelectorAll('input[type=checkbox]:checked');
            var indices = [];
            checked.forEach(function (cb) { indices.push(Number(cb.value)); });
            extractMidiBtn.disabled = true;
            extractMidi(id, indices, omrStatusEl, rasteriseBtn, synthesiseSection, base, bannerEl);
          });

          rasteriseBtn.addEventListener('click', function () {
            rasteriseBtn.disabled = true;
            rasterise(id, omrStatusEl, base, bannerEl);
          });

          omrSection.appendChild(omrBtn);
          omrSection.appendChild(partPickerEl);
          omrSection.appendChild(rasteriseBtn);
          omrSection.appendChild(omrStatusEl);
          detailEl.appendChild(omrSection);
        }

        // Synthesise form (PDF or MIDI asset)
        if (detail.has_pdf || detail.has_midi) {
          var labelInput = document.createElement('input');
          labelInput.type = 'text';
          labelInput.className = 'variant-label';
          labelInput.maxLength = 255;

          var tempoInput = document.createElement('input');
          tempoInput.type = 'number';
          tempoInput.className = 'variant-tempo';
          tempoInput.min = '25';
          tempoInput.max = '300';
          tempoInput.value = '100';

          var transposeInput = document.createElement('input');
          transposeInput.type = 'number';
          transposeInput.className = 'variant-transpose';
          transposeInput.min = '-12';
          transposeInput.max = '12';
          transposeInput.value = '0';

          var repeatsInput = document.createElement('input');
          repeatsInput.type = 'checkbox';
          repeatsInput.className = 'variant-repeats';

          var synthBtn = document.createElement('button');
          synthBtn.type = 'button';
          synthBtn.className = 'synthesise-btn';
          synthBtn.textContent = 'Synthesise';

          var formEl = { labelInput: labelInput, tempoInput: tempoInput, transposeInput: transposeInput, repeatsInput: repeatsInput };

          synthBtn.addEventListener('click', function () {
            synthesise(id, {
              label: labelInput.value,
              tempo_pct: Number(tempoInput.value),
              transpose_semitones: Number(transposeInput.value),
              respect_repeats: repeatsInput.checked,
            }, synthStatusEl, variantListEl, formEl, base, bannerEl);
          });

          synthesiseSection.appendChild(labelInput);
          synthesiseSection.appendChild(tempoInput);
          synthesiseSection.appendChild(transposeInput);
          synthesiseSection.appendChild(repeatsInput);
          synthesiseSection.appendChild(synthBtn);
          synthesiseSection.appendChild(synthStatusEl);
          detailEl.appendChild(synthesiseSection);
        }

        // Variant list
        if (detail.variants) {
          detail.variants.forEach(function (variant) {
            variantListEl.appendChild(renderVariantRow(id, variant, base, bannerEl, function (req) {
              synthesise(id, req, synthStatusEl, variantListEl, null, base, bannerEl);
            }));
          });
        }
        detailEl.appendChild(variantListEl);
      })
      .catch(function (err) {
        detailEl.textContent = 'Failed to load asset: ' + err.message;
      });
  }

  // ---------------------------------------------------------------------------
  // OMR flow
  // ---------------------------------------------------------------------------

  function runOmr(assetId, partPickerEl, omrBtn, statusEl, base, bannerEl) {
    fetch(base + '/' + assetId + '/parts', { method: 'POST' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        omrBtn.disabled = false;
        omrBtn.textContent = 'Run OMR';
        if (!res.ok) {
          if (res.status === 503) show503Banner(bannerEl);
          statusEl.textContent = (res.data && res.data.message) || 'OMR failed';
          return;
        }
        partPickerEl.replaceChildren();
        res.data.forEach(function (part) {
          var label = document.createElement('label');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = String(part.index);
          cb.checked = true;
          var span = document.createElement('span');
          span.textContent = part.name;
          label.appendChild(cb);
          label.appendChild(span);
          partPickerEl.appendChild(label);
        });
        var extractBtn = partPickerEl.querySelector('.extract-midi-btn');
        if (extractBtn) partPickerEl.appendChild(extractBtn);
        partPickerEl.hidden = false;
      })
      .catch(function (err) {
        omrBtn.disabled = false;
        omrBtn.textContent = 'Run OMR';
        statusEl.textContent = 'OMR failed: ' + err.message;
      });
  }

  function extractMidi(assetId, partIndices, statusEl, rasteriseBtn, synthesiseFormEl, base, bannerEl) {
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
          return;
        }
        statusEl.textContent = res.data.bar_count + ' bars extracted';
        if (rasteriseBtn) rasteriseBtn.disabled = false;
        if (synthesiseFormEl) synthesiseFormEl.hidden = false;
      })
      .catch(function (err) {
        statusEl.textContent = 'MIDI extraction failed: ' + err.message;
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

  function synthesise(assetId, req, statusEl, variantListEl, formEl, base, bannerEl) {
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
          variantListEl.prepend(renderVariantRow(assetId, displayReq, base, bannerEl, function (rReq) {
            synthesise(assetId, rReq, statusEl, variantListEl, formEl, base, bannerEl);
          }));
        }
        if (formEl) {
          formEl.labelInput.value = '';
          formEl.tempoInput.value = '100';
          formEl.transposeInput.value = '0';
          formEl.repeatsInput.checked = false;
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

    var resynBtn = document.createElement('button');
    resynBtn.type = 'button';
    resynBtn.className = 'variant-resynth-btn';
    resynBtn.textContent = 'Re-synthesise';
    resynBtn.addEventListener('click', function () {
      if (synthesiseFn) {
        synthesiseFn({
          label: variant.label,
          tempo_pct: variant.tempo_pct,
          transpose_semitones: variant.transpose_semitones,
          respect_repeats: variant.respect_repeats || false,
        });
      }
    });

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'variant-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      confirmDeleteVariant(assetId, variant.id, li, base, globalThis.confirm, globalThis.alert);
    });

    li.appendChild(labelEl);
    li.appendChild(metaEl);
    li.appendChild(resynBtn);
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
    doDelete(base + '/' + assetId, li, confirmFn, 'Delete "' + title + '"? This cannot be undone.', alertFn);
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
  // Browser-only init
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

  function init() {
    var slug = location.pathname.replace(/^\/teach\//, '').replace(/\/library.*$/, '');
    BASE = '/teach/' + slug + '/library/assets';
    document.getElementById('back-link').href = '/teach/' + slug;
    var bannerEl = document.getElementById('sidecar-banner');
    document.getElementById('sidecar-banner-close')
      .addEventListener('click', function () { hide503Banner(bannerEl); });
    initUpload(bannerEl);
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
    extractMidi: extractMidi,
    rasterise: rasterise,
    synthesise: synthesise,
    confirmDelete: confirmDelete,
    confirmDeleteVariant: confirmDeleteVariant,
    show503Banner: show503Banner,
    hide503Banner: hide503Banner,
    startUpload: startUpload,
  };
});
