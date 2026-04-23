// File: web/assets/library.js
// Purpose: Teacher accompaniment library page — load, upload, OMR flow, synthesise, delete,
//          and Web MIDI keyboard recording.
// Role: Page-level script for /teach/:slug/library.
// Exports: window.sbLibrary / module.exports (test harness)
// Depends: fetch API, Web MIDI API (optional — graceful degradation if absent)
// Invariants: all server-supplied strings rendered via .textContent only (no innerHTML);
//             upload fires raw file body (not FormData) with X-Title header;
//             503 responses show sidecar banner except for upload, delete, and expandAsset;
//             synthesise is validated client-side before fetch;
//             MIDI port.name set via .textContent only (no innerHTML);
//             serializeMidi is a pure function — no side effects, no DOM access.
// Last updated: Sprint 15 (2026-04-23) -- MIDI keyboard recording

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
    extractMidi: extractMidi,
    rasterise: rasterise,
    synthesise: synthesise,
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
    // Test-only hook: set _pendingAutoExpandId without triggering DOM/upload.
    _setPendingAutoExpandId: function (id) { _pendingAutoExpandId = id; },
  };
});
