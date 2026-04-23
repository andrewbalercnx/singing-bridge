// File: web/assets/tests/library.test.js
// Purpose: Unit tests for library.js helpers: upload flow, OMR multi-step,
//          synthesise validation, delete confirmation, 503 banner, rasterise,
//          expandAsset, loadAssets.
// Last updated: Sprint 13 (2026-04-22) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub document so library.js init() is skipped (no global document).
// The UMD module checks `typeof document !== 'undefined'`; leaving it
// undefined skips init() and gives us clean helper exports.
const lib = require('../library.js');

// Set up document mock AFTER module load so init() is skipped.
// Functions that construct DOM elements (renderSummary, renderVariantRow, etc.)
// need createElement; this returns makeEl() stubs which support the full
// set of DOM-like operations the tests exercise.
globalThis.document = { createElement: function() { return makeEl(); } };

// ---------------------------------------------------------------------------
// DOM stub helpers
// ---------------------------------------------------------------------------

function makeEl() {
  var _hidden = true;
  var _text = '';
  var _cls = '';
  var _children = [];
  var _listeners = {};
  var _attrs = {};
  var el = {
    get hidden() { return _hidden; },
    set hidden(v) { _hidden = !!v; },
    get textContent() { return _text; },
    set textContent(v) { _text = String(v); },
    get className() { return _cls; },
    set className(v) { _cls = v; },
    get children() { return _children; },
    disabled: false,
    maxLength: Infinity,
    value: '',
    checked: false,
    type: '',
    min: '',
    max: '',
    setAttribute: function(k, v) { _attrs[k] = String(v); },
    getAttribute: function(k) { return _attrs[k]; },
    addEventListener: function(ev, fn) { (_listeners[ev] = _listeners[ev] || []).push(fn); },
    appendChild: function(c) { _children.push(c); return c; },
    prepend: function(c) { _children.unshift(c); return c; },
    replaceChildren: function() { _children = []; },
    querySelectorAll: function() { return []; },
    querySelector: function() { return null; },
    remove: function() { el._removed = true; },
    classList: {
      _cls: '',
      add: function(c) {},
      remove: function(c) {},
    },
    _fire: function(ev, arg) { (_listeners[ev] || []).forEach(function(f) { f(arg || {}); }); },
    _attrs: _attrs,
  };
  return el;
}

function makeBannerEl() {
  var el = makeEl();
  el.hidden = true;
  return el;
}

function fetchStub(status, body) {
  return function() {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function() { return Promise.resolve(body); },
    });
  };
}

function fetchReject(msg) {
  return function() { return Promise.reject(new Error(msg)); };
}

// ---------------------------------------------------------------------------
// Upload tests
// ---------------------------------------------------------------------------

test('upload_sets_x_title_header', async function () {
  var captured;
  globalThis.fetch = function(url, opts) {
    captured = opts;
    return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, title: 'T', kind: 'pdf' }); } });
  };
  var file = { type: 'application/pdf' };
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  var listEl = makeEl(); listEl.replaceChildren = function() {};
  var emptyEl = makeEl();
  var assetsErrorEl = makeEl();
  var bannerEl = makeBannerEl();
  var loadCalled = false;
  await new Promise(function(resolve) {
    lib.startUpload({
      file: file, title: 'Test Title', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/teach/r/library/assets',
      loadAssets: function() { loadCalled = true; resolve(); },
      listEl: listEl, emptyEl: emptyEl, assetsErrorEl: assetsErrorEl, bannerEl: bannerEl,
    });
  });
  assert.equal(captured.headers['X-Title'], 'Test Title');
  delete globalThis.fetch;
});

test('upload_sends_raw_file_body', async function () {
  var capturedBody;
  globalThis.fetch = function(url, opts) {
    capturedBody = opts.body;
    return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, title: 'T', kind: 'pdf' }); } });
  };
  var file = { type: 'application/pdf', _isFile: true };
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  var bannerEl = makeBannerEl();
  await new Promise(function(resolve) {
    lib.startUpload({
      file: file, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() { resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: bannerEl,
    });
  });
  assert.equal(capturedBody, file);
  delete globalThis.fetch;
});

test('upload_shows_progress_during_fetch', async function () {
  var progressEl = makeEl(); progressEl.hidden = true;
  var progressDuringFetch = null;
  globalThis.fetch = function() {
    progressDuringFetch = progressEl.hidden;
    return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, title: 'T', kind: 'pdf' }); } });
  };
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() { resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
    });
  });
  assert.equal(progressDuringFetch, false);
  delete globalThis.fetch;
});

test('upload_hides_progress_after_success', async function () {
  globalThis.fetch = fetchStub(201, { id: 1, title: 'T', kind: 'pdf' });
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() { resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
    });
  });
  assert.equal(progressEl.hidden, true);
  delete globalThis.fetch;
});

test('upload_clears_title_on_success', async function () {
  globalThis.fetch = fetchStub(201, { id: 1, title: 'T', kind: 'pdf' });
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  var titleCleared = false;
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() { resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
      clearTitle: function() { titleCleared = true; },
    });
  });
  assert.equal(titleCleared, true);
  delete globalThis.fetch;
});

test('upload_reloads_asset_list_on_success', async function () {
  globalThis.fetch = fetchStub(201, { id: 1, title: 'T', kind: 'pdf' });
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  var loadCalled = 0;
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() { loadCalled++; resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
    });
  });
  assert.equal(loadCalled, 1);
  delete globalThis.fetch;
});

test('upload_shows_error_message_on_422', async function () {
  globalThis.fetch = fetchStub(422, { code: 'bad_file', message: 'bad file type' });
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() {},
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
      _onDone: resolve,
    });
    setTimeout(resolve, 50);
  });
  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, 'bad file type');
  delete globalThis.fetch;
});

test('upload_does_not_show_banner_on_503', async function () {
  globalThis.fetch = fetchStub(503, { code: 'sidecar_unavailable', message: 'unavailable' });
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  var bannerEl = makeBannerEl();
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: 'T', uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() {},
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: bannerEl,
    });
    setTimeout(resolve, 50);
  });
  assert.equal(bannerEl.hidden, true);
  delete globalThis.fetch;
});

test('upload_accepts_255_byte_title', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() {
    fetchCalled = true;
    return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, title: 'T', kind: 'pdf' }); } });
  };
  var title255 = 'a'.repeat(255);
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  await new Promise(function(resolve) {
    lib.startUpload({
      file: { type: '' }, title: title255, uploadBtn: uploadBtn,
      progressEl: progressEl, errorEl: errorEl,
      BASE: '/base',
      loadAssets: function() { resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
    });
  });
  assert.equal(fetchCalled, true);
  delete globalThis.fetch;
});

test('upload_rejects_256_byte_title', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var title256 = 'a'.repeat(256);
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  lib.startUpload({
    file: { type: '' }, title: title256, uploadBtn: uploadBtn,
    progressEl: progressEl, errorEl: errorEl,
    BASE: '/base',
    loadAssets: function() {},
    listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
  });
  assert.equal(fetchCalled, false);
  assert.equal(errorEl.hidden, false);
  delete globalThis.fetch;
});

test('upload_rejects_multibyte_overflow', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  // 86 × U+2764 (❤, 3 bytes each) = 258 bytes
  var title = '\u2764'.repeat(86);
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  lib.startUpload({
    file: { type: '' }, title: title, uploadBtn: uploadBtn,
    progressEl: progressEl, errorEl: errorEl,
    BASE: '/base',
    loadAssets: function() {},
    listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
  });
  assert.equal(fetchCalled, false);
  assert.equal(errorEl.hidden, false);
  delete globalThis.fetch;
});

test('upload_rejects_null_file', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  lib.startUpload({
    file: null, title: 'T', uploadBtn: uploadBtn,
    progressEl: progressEl, errorEl: errorEl,
    BASE: '/base',
    loadAssets: function() {},
    listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
  });
  assert.equal(fetchCalled, false);
  assert.equal(errorEl.hidden, false);
  delete globalThis.fetch;
});

test('upload_rejects_whitespace_only_title', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  lib.startUpload({
    file: { type: '' }, title: '   ', uploadBtn: uploadBtn,
    progressEl: progressEl, errorEl: errorEl,
    BASE: '/base',
    loadAssets: function() {},
    listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
  });
  assert.equal(fetchCalled, false);
  assert.equal(errorEl.hidden, false);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// renderSummary tests
// ---------------------------------------------------------------------------

test('renderSummary_shows_pdf_badge', function () {
  var asset = { id: 1, title: 'Song', has_pdf: true, has_midi: false, variant_count: 0, created_at: 0 };
  var li = lib.renderSummary(asset, '/base', makeBannerEl());
  var meta = li.children.find ? li.children.find(function(c) { return c.className === 'asset-header'; }) : null;
  // Check textContent somewhere in the li contains 'PDF'
  var found = false;
  function walk(node) {
    if (node.textContent && node.textContent.indexOf('PDF') !== -1) found = true;
    (node.children || []).forEach(walk);
  }
  walk(li);
  assert.equal(found, true);
});

test('renderSummary_shows_wav_badge', function () {
  var asset = { id: 2, title: 'S', has_pdf: false, has_midi: false, variant_count: 0, created_at: 0 };
  var li = lib.renderSummary(asset, '/base', makeBannerEl());
  var found = false;
  function walk(node) {
    if (node.textContent && node.textContent.indexOf('WAV') !== -1) found = true;
    (node.children || []).forEach(walk);
  }
  walk(li);
  assert.equal(found, true);
});

test('renderSummary_title_via_textContent', function () {
  var asset = { id: 3, title: '<b>XSS</b>', has_pdf: true, has_midi: false, variant_count: 0, created_at: 0 };
  var li = lib.renderSummary(asset, '/base', makeBannerEl());
  // The expand button textContent should include the raw string, not parsed HTML
  var expandBtn = li.children[0] && li.children[0].children && li.children[0].children[0];
  assert.ok(expandBtn && expandBtn.textContent.indexOf('<b>XSS</b>') !== -1);
});

test('renderSummary_expand_button_fires_expandAsset', async function () {
  var expandCalled = false;
  var origExpand = lib.expandAsset;
  // We can't easily mock lib.expandAsset since it's in the closure.
  // Instead verify that clicking the expand btn triggers a fetch (expandAsset calls fetch).
  globalThis.fetch = function(url) {
    expandCalled = url.indexOf('/1') !== -1;
    return Promise.resolve({ ok: false, status: 404, json: function() { return Promise.resolve({ message: 'not found' }); } });
  };
  var asset = { id: 1, title: 'S', has_pdf: true, has_midi: false, variant_count: 0, created_at: 0 };
  var li = lib.renderSummary(asset, '/base', makeBannerEl());
  // Fire the expand button click (first child of first child of li)
  var header = li.children[0];
  var expandBtn = header.children[0];
  expandBtn._fire('click');
  await new Promise(function(r) { setTimeout(r, 10); });
  assert.equal(expandCalled, true);
  delete globalThis.fetch;
});

test('renderSummary_delete_button_fires_confirmDelete', function () {
  var confirmCalled = false;
  var asset = { id: 5, title: 'Del', has_pdf: true, has_midi: false, variant_count: 0, created_at: 0 };
  var li = lib.renderSummary(asset, '/base', makeBannerEl());
  var header = li.children[0];
  var deleteBtn = header.children[header.children.length - 1];
  // Clicking delete calls confirmFn with asset title; confirm returns false so no fetch.
  globalThis.confirm = function(msg) {
    confirmCalled = msg.indexOf('Del') !== -1;
    return false;
  };
  deleteBtn._fire('click');
  assert.equal(confirmCalled, true);
  delete globalThis.confirm;
});

test('renderVariantRow_shows_label_via_textContent', function () {
  var variant = { id: 10, label: '<script>alert(1)</script>', tempo_pct: 100, transpose_semitones: 0 };
  var li = lib.renderVariantRow(1, variant, '/base', makeBannerEl(), null);
  var labelSpan = li.children[0];
  assert.equal(labelSpan.textContent, variant.label);
});

test('renderVariantRow_uses_data_label_not_req_label', function () {
  var variant = { id: 11, label: 'Server Label', tempo_pct: 100, transpose_semitones: 0 };
  var li = lib.renderVariantRow(1, variant, '/base', makeBannerEl(), null);
  var labelSpan = li.children[0];
  assert.equal(labelSpan.textContent, 'Server Label');
});

// ---------------------------------------------------------------------------
// runOmr tests
// ---------------------------------------------------------------------------

test('runOmr_shows_part_picker_on_success', async function () {
  globalThis.fetch = fetchStub(200, [{ index: 0, name: 'Piano' }]);
  var partPickerEl = makeEl(); partPickerEl.hidden = true;
  var omrBtn = makeEl();
  var statusEl = makeEl();
  var bannerEl = makeBannerEl();
  await new Promise(function(resolve) {
    lib.runOmr(1, partPickerEl, omrBtn, statusEl, '/base', bannerEl);
    setTimeout(resolve, 20);
  });
  assert.equal(partPickerEl.hidden, false);
  delete globalThis.fetch;
});

test('runOmr_renders_correct_checkbox_count', async function () {
  globalThis.fetch = fetchStub(200, [{ index: 0, name: 'Violin' }, { index: 1, name: 'Cello' }]);
  var partPickerEl = makeEl(); partPickerEl.hidden = true;
  var children = [];
  partPickerEl.appendChild = function(c) { children.push(c); return c; };
  partPickerEl.replaceChildren = function() { children = []; };
  var omrBtn = makeEl();
  var statusEl = makeEl();
  await new Promise(function(resolve) {
    lib.runOmr(1, partPickerEl, omrBtn, statusEl, '/base', makeBannerEl());
    setTimeout(resolve, 20);
  });
  // Each part renders a <label> element
  var labelCount = children.filter(function(c) { return !c.className || c.className !== 'extract-midi-btn'; }).length;
  assert.equal(labelCount, 2);
  delete globalThis.fetch;
});

test('runOmr_checkbox_value_uses_part_index', async function () {
  globalThis.fetch = fetchStub(200, [{ index: 3, name: 'Flute' }]);
  var checkboxValue = null;
  var partPickerEl = makeEl(); partPickerEl.hidden = true;
  partPickerEl.appendChild = function(labelEl) {
    if (labelEl.children && labelEl.children[0] && labelEl.children[0].type === 'checkbox') {
      checkboxValue = labelEl.children[0].value;
    }
    return labelEl;
  };
  partPickerEl.replaceChildren = function() {};
  var omrBtn = makeEl(); var statusEl = makeEl();
  await new Promise(function(r) { lib.runOmr(1, partPickerEl, omrBtn, statusEl, '/base', makeBannerEl()); setTimeout(r, 20); });
  assert.equal(checkboxValue, '3');
  delete globalThis.fetch;
});

test('runOmr_renders_part_name_via_textContent', async function () {
  globalThis.fetch = fetchStub(200, [{ index: 0, name: '<b>XSS</b>' }]);
  var spanText = null;
  var partPickerEl = makeEl(); partPickerEl.hidden = true;
  partPickerEl.appendChild = function(labelEl) {
    if (labelEl.children && labelEl.children[1]) {
      spanText = labelEl.children[1].textContent;
    }
    return labelEl;
  };
  partPickerEl.replaceChildren = function() {};
  var omrBtn = makeEl(); var statusEl = makeEl();
  await new Promise(function(r) { lib.runOmr(1, partPickerEl, omrBtn, statusEl, '/base', makeBannerEl()); setTimeout(r, 20); });
  assert.equal(spanText, '<b>XSS</b>');
  delete globalThis.fetch;
});

test('runOmr_shows_banner_on_503', async function () {
  globalThis.fetch = fetchStub(503, { code: 'sidecar_unavailable', message: 'unavailable' });
  var bannerEl = makeBannerEl();
  var partPickerEl = makeEl(); var omrBtn = makeEl(); var statusEl = makeEl();
  await new Promise(function(r) { lib.runOmr(1, partPickerEl, omrBtn, statusEl, '/base', bannerEl); setTimeout(r, 20); });
  assert.equal(bannerEl.hidden, false);
  delete globalThis.fetch;
});

test('runOmr_does_not_show_banner_on_422', async function () {
  globalThis.fetch = fetchStub(422, { code: 'bad_input', message: 'bad input' });
  var bannerEl = makeBannerEl();
  var partPickerEl = makeEl(); var omrBtn = makeEl(); var statusEl = makeEl();
  await new Promise(function(r) { lib.runOmr(1, partPickerEl, omrBtn, statusEl, '/base', bannerEl); setTimeout(r, 20); });
  assert.equal(bannerEl.hidden, true);
  assert.ok(statusEl.textContent.length > 0);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// extractMidi tests
// ---------------------------------------------------------------------------

test('extractMidi_sends_correct_part_indices', async function () {
  var capturedBody;
  globalThis.fetch = function(url, opts) {
    capturedBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve({ bar_count: 4 }); } });
  };
  var statusEl = makeEl(); var rasteriseBtn = makeEl(); var synthFormEl = makeEl(); synthFormEl.hidden = true;
  await new Promise(function(r) { lib.extractMidi(1, [0, 2], statusEl, rasteriseBtn, synthFormEl, '/base', makeBannerEl()); setTimeout(r, 20); });
  assert.deepEqual(capturedBody.part_indices, [0, 2]);
  delete globalThis.fetch;
});

test('extractMidi_updates_status_on_success', async function () {
  globalThis.fetch = fetchStub(200, { bar_count: 4 });
  var statusEl = makeEl(); var rasteriseBtn = makeEl(); var synthFormEl = makeEl(); synthFormEl.hidden = true;
  await new Promise(function(r) { lib.extractMidi(1, [0], statusEl, rasteriseBtn, synthFormEl, '/base', makeBannerEl()); setTimeout(r, 20); });
  assert.ok(statusEl.textContent.indexOf('4') !== -1);
  delete globalThis.fetch;
});

test('extractMidi_unhides_synthesise_form_on_success', async function () {
  globalThis.fetch = fetchStub(200, { bar_count: 2 });
  var statusEl = makeEl(); var rasteriseBtn = makeEl(); var synthFormEl = makeEl(); synthFormEl.hidden = true;
  await new Promise(function(r) { lib.extractMidi(1, [0], statusEl, rasteriseBtn, synthFormEl, '/base', makeBannerEl()); setTimeout(r, 20); });
  assert.equal(synthFormEl.hidden, false);
  delete globalThis.fetch;
});

test('extractMidi_shows_banner_on_503', async function () {
  globalThis.fetch = fetchStub(503, { message: 'unavail' });
  var bannerEl = makeBannerEl();
  var statusEl = makeEl(); var rasteriseBtn = makeEl(); var synthFormEl = makeEl();
  await new Promise(function(r) { lib.extractMidi(1, [], statusEl, rasteriseBtn, synthFormEl, '/base', bannerEl); setTimeout(r, 20); });
  assert.equal(bannerEl.hidden, false);
  delete globalThis.fetch;
});

test('extractMidi_does_not_show_banner_on_422', async function () {
  globalThis.fetch = fetchStub(422, { message: 'bad' });
  var bannerEl = makeBannerEl();
  var statusEl = makeEl(); var rasteriseBtn = makeEl(); var synthFormEl = makeEl();
  await new Promise(function(r) { lib.extractMidi(1, [], statusEl, rasteriseBtn, synthFormEl, '/base', bannerEl); setTimeout(r, 20); });
  assert.equal(bannerEl.hidden, true);
  assert.ok(statusEl.textContent.length > 0);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// rasterise tests
// ---------------------------------------------------------------------------

test('rasterise_updates_status_on_success', async function () {
  globalThis.fetch = fetchStub(200, { page_count: 3 });
  var statusEl = makeEl();
  await new Promise(function(r) { lib.rasterise(1, statusEl, '/base', makeBannerEl()); setTimeout(r, 20); });
  assert.ok(statusEl.textContent.indexOf('3') !== -1);
  delete globalThis.fetch;
});

test('rasterise_shows_banner_on_503', async function () {
  globalThis.fetch = fetchStub(503, { message: 'unavail' });
  var bannerEl = makeBannerEl(); var statusEl = makeEl();
  await new Promise(function(r) { lib.rasterise(1, statusEl, '/base', bannerEl); setTimeout(r, 20); });
  assert.equal(bannerEl.hidden, false);
  delete globalThis.fetch;
});

test('rasterise_does_not_show_banner_on_422', async function () {
  globalThis.fetch = fetchStub(422, { message: 'bad input' });
  var bannerEl = makeBannerEl(); var statusEl = makeEl();
  await new Promise(function(r) { lib.rasterise(1, statusEl, '/base', bannerEl); setTimeout(r, 20); });
  assert.equal(bannerEl.hidden, true);
  assert.ok(statusEl.textContent.length > 0);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// synthesise tests
// ---------------------------------------------------------------------------

function makeSynthForm() {
  var labelInput = makeEl(); labelInput.value = 'My Label';
  var tempoInput = makeEl(); tempoInput.value = '120';
  var transposeInput = makeEl(); transposeInput.value = '2';
  var repeatsInput = makeEl(); repeatsInput.checked = true;
  return { labelInput: labelInput, tempoInput: tempoInput, transposeInput: transposeInput, repeatsInput: repeatsInput };
}

test('synthesise_rejects_empty_label', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var statusEl = makeEl(); var variantListEl = makeEl(); var formEl = makeSynthForm();
  lib.synthesise(1, { label: '', tempo_pct: 100, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, formEl, '/base', makeBannerEl());
  assert.equal(fetchCalled, false);
  assert.ok(statusEl.textContent.length > 0);
  delete globalThis.fetch;
});

test('synthesise_rejects_tempo_below_25', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var statusEl = makeEl(); var variantListEl = makeEl();
  lib.synthesise(1, { label: 'L', tempo_pct: 24, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  assert.equal(fetchCalled, false);
  delete globalThis.fetch;
});

test('synthesise_accepts_tempo_25', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, label: 'L' }); } }); };
  var statusEl = makeEl(); var variantListEl = makeEl();
  variantListEl.prepend = function() {};
  lib.synthesise(1, { label: 'L', tempo_pct: 25, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  await new Promise(function(r) { setTimeout(r, 20); });
  assert.equal(fetchCalled, true);
  delete globalThis.fetch;
});

test('synthesise_rejects_tempo_above_300', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var statusEl = makeEl(); var variantListEl = makeEl();
  lib.synthesise(1, { label: 'L', tempo_pct: 301, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  assert.equal(fetchCalled, false);
  delete globalThis.fetch;
});

test('synthesise_accepts_tempo_300', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, label: 'L' }); } }); };
  var statusEl = makeEl(); var variantListEl = makeEl(); variantListEl.prepend = function() {};
  lib.synthesise(1, { label: 'L', tempo_pct: 300, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  await new Promise(function(r) { setTimeout(r, 20); });
  assert.equal(fetchCalled, true);
  delete globalThis.fetch;
});

test('synthesise_rejects_transpose_below_minus12', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var statusEl = makeEl(); var variantListEl = makeEl();
  lib.synthesise(1, { label: 'L', tempo_pct: 100, transpose_semitones: -13, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  assert.equal(fetchCalled, false);
  delete globalThis.fetch;
});

test('synthesise_accepts_transpose_minus12', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, label: 'L' }); } }); };
  var statusEl = makeEl(); var variantListEl = makeEl(); variantListEl.prepend = function() {};
  lib.synthesise(1, { label: 'L', tempo_pct: 100, transpose_semitones: -12, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  await new Promise(function(r) { setTimeout(r, 20); });
  assert.equal(fetchCalled, true);
  delete globalThis.fetch;
});

test('synthesise_rejects_transpose_above_12', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var statusEl = makeEl(); var variantListEl = makeEl();
  lib.synthesise(1, { label: 'L', tempo_pct: 100, transpose_semitones: 13, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  assert.equal(fetchCalled, false);
  delete globalThis.fetch;
});

test('synthesise_accepts_transpose_12', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({ ok: true, status: 201, json: function() { return Promise.resolve({ id: 1, label: 'L' }); } }); };
  var statusEl = makeEl(); var variantListEl = makeEl(); variantListEl.prepend = function() {};
  lib.synthesise(1, { label: 'L', tempo_pct: 100, transpose_semitones: 12, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
  await new Promise(function(r) { setTimeout(r, 20); });
  assert.equal(fetchCalled, true);
  delete globalThis.fetch;
});

test('synthesise_prepends_variant_on_success', async function () {
  globalThis.fetch = fetchStub(201, { id: 99, label: 'Fast' });
  var statusEl = makeEl();
  var prependCount = 0;
  var variantListEl = makeEl();
  variantListEl.prepend = function() { prependCount++; };
  await new Promise(function(r) {
    lib.synthesise(1, { label: 'Fast', tempo_pct: 150, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, makeSynthForm(), '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(prependCount, 1);
  delete globalThis.fetch;
});

test('synthesise_uses_data_label_on_success', async function () {
  globalThis.fetch = fetchStub(201, { id: 5, label: 'Server Label' });
  var statusEl = makeEl();
  var renderedLabel = null;
  var variantListEl = makeEl();
  variantListEl.prepend = function(li) {
    if (li.children && li.children[0]) renderedLabel = li.children[0].textContent;
  };
  var form = makeSynthForm();
  await new Promise(function(r) {
    lib.synthesise(1, { label: 'Client Label', tempo_pct: 100, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, form, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(renderedLabel, 'Server Label');
  delete globalThis.fetch;
});

test('synthesise_clears_form_fields_on_success', async function () {
  globalThis.fetch = fetchStub(201, { id: 1, label: 'L' });
  var statusEl = makeEl();
  var variantListEl = makeEl(); variantListEl.prepend = function() {};
  var form = makeSynthForm();
  form.labelInput.value = 'Old Label';
  form.tempoInput.value = '150';
  form.transposeInput.value = '5';
  form.repeatsInput.checked = true;
  await new Promise(function(r) {
    lib.synthesise(1, { label: 'Old Label', tempo_pct: 150, transpose_semitones: 5, respect_repeats: true }, statusEl, variantListEl, form, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(form.labelInput.value, '');
  assert.equal(form.tempoInput.value, '100');
  assert.equal(form.transposeInput.value, '0');
  assert.equal(form.repeatsInput.checked, false);
  delete globalThis.fetch;
});

test('synthesise_shows_banner_on_503', async function () {
  globalThis.fetch = fetchStub(503, { message: 'unavail' });
  var bannerEl = makeBannerEl(); var statusEl = makeEl(); var variantListEl = makeEl();
  await new Promise(function(r) {
    lib.synthesise(1, { label: 'L', tempo_pct: 100, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, null, '/base', bannerEl);
    setTimeout(r, 20);
  });
  assert.equal(bannerEl.hidden, false);
  delete globalThis.fetch;
});

test('synthesise_does_not_show_banner_on_422', async function () {
  globalThis.fetch = fetchStub(422, { message: 'bad' });
  var bannerEl = makeBannerEl(); var statusEl = makeEl(); var variantListEl = makeEl();
  await new Promise(function(r) {
    lib.synthesise(1, { label: 'L', tempo_pct: 100, transpose_semitones: 0, respect_repeats: false }, statusEl, variantListEl, null, '/base', bannerEl);
    setTimeout(r, 20);
  });
  assert.equal(bannerEl.hidden, true);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// confirmDelete / confirmDeleteVariant tests
// ---------------------------------------------------------------------------

test('confirmDelete_cancel_no_fetch', async function () {
  var fetchCalled = false;
  globalThis.fetch = function() { fetchCalled = true; return Promise.resolve({}); };
  var li = makeEl(); var bannerEl = makeBannerEl();
  lib.confirmDelete(1, 'Song', li, '/base', function() { return false; }, function() {});
  await new Promise(function(r) { setTimeout(r, 20); });
  assert.equal(fetchCalled, false);
  assert.ok(!li._removed);
  delete globalThis.fetch;
});

test('confirmDelete_confirm_fires_delete', async function () {
  globalThis.fetch = function() { return Promise.resolve({ status: 204, ok: true, json: function() { return Promise.resolve({}); } }); };
  var li = makeEl();
  await new Promise(function(r) {
    lib.confirmDelete(1, 'Song', li, '/base', function() { return true; }, function() {});
    setTimeout(r, 20);
  });
  assert.equal(li._removed, true);
  delete globalThis.fetch;
});

test('confirmDelete_does_not_show_banner_on_error', async function () {
  globalThis.fetch = fetchStub(500, { message: 'server error' });
  var li = makeEl(); var bannerEl = makeBannerEl();
  var alertMsg = null;
  await new Promise(function(r) {
    lib.confirmDelete(1, 'S', li, '/base', function() { return true; }, function(m) { alertMsg = m; r(); });
  });
  assert.equal(bannerEl.hidden, true);
  assert.ok(alertMsg !== null);
  assert.ok(!li._removed);
  delete globalThis.fetch;
});

test('confirmDeleteVariant_removes_li_on_204', async function () {
  globalThis.fetch = function() { return Promise.resolve({ status: 204, ok: true, json: function() { return Promise.resolve({}); } }); };
  var variantLi = makeEl();
  await new Promise(function(r) {
    lib.confirmDeleteVariant(1, 10, variantLi, '/base', function() { return true; }, function() {});
    setTimeout(r, 20);
  });
  assert.equal(variantLi._removed, true);
  delete globalThis.fetch;
});

test('confirmDeleteVariant_does_not_show_banner_on_error', async function () {
  globalThis.fetch = fetchStub(500, { message: 'err' });
  var variantLi = makeEl(); var bannerEl = makeBannerEl();
  var alertCalled = false;
  await new Promise(function(r) {
    lib.confirmDeleteVariant(1, 10, variantLi, '/base', function() { return true; }, function() { alertCalled = true; r(); });
  });
  assert.equal(bannerEl.hidden, true);
  assert.equal(alertCalled, true);
  assert.ok(!variantLi._removed);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// loadAssets tests
// ---------------------------------------------------------------------------

test('loadAssets_calls_fetch_on_BASE', async function () {
  var fetchedUrl;
  globalThis.fetch = function(url) {
    fetchedUrl = url;
    return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve([]); } });
  };
  var listEl = makeEl(); var emptyEl = makeEl(); var errorEl = makeEl();
  await new Promise(function(r) {
    lib.loadAssets('/my/base', listEl, emptyEl, errorEl, makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(fetchedUrl, '/my/base');
  delete globalThis.fetch;
});

test('loadAssets_shows_empty_state_when_no_assets', async function () {
  globalThis.fetch = fetchStub(200, []);
  var listEl = makeEl(); var emptyEl = makeEl(); emptyEl.hidden = true; var errorEl = makeEl();
  await new Promise(function(r) {
    lib.loadAssets('/base', listEl, emptyEl, errorEl, makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(emptyEl.hidden, false);
  delete globalThis.fetch;
});

test('loadAssets_hides_empty_state_when_assets_present', async function () {
  globalThis.fetch = fetchStub(200, [{ id: 1, title: 'S', has_pdf: true, has_midi: false, variant_count: 0, created_at: 0 }]);
  var listEl = makeEl(); var emptyEl = makeEl(); emptyEl.hidden = false; var errorEl = makeEl();
  await new Promise(function(r) {
    lib.loadAssets('/base', listEl, emptyEl, errorEl, makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(emptyEl.hidden, true);
  delete globalThis.fetch;
});

test('loadAssets_shows_error_on_fetch_failure', async function () {
  globalThis.fetch = fetchReject('network down');
  var listEl = makeEl(); var emptyEl = makeEl(); var errorEl = makeEl(); errorEl.hidden = true;
  await new Promise(function(r) {
    lib.loadAssets('/base', listEl, emptyEl, errorEl, makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(errorEl.hidden, false);
  assert.ok(errorEl.textContent.length > 0);
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// expandAsset tests
// ---------------------------------------------------------------------------

test('expandAsset_toggles_detail_hidden', async function () {
  globalThis.fetch = fetchStub(200, { id: 1, title: 'S', has_pdf: false, has_midi: false, variants: [], page_tokens: [], bar_coords: [], bar_timings: [] });
  var detailEl = makeEl(); detailEl.hidden = true;
  var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(1, detailEl, expandBtn, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(detailEl.hidden, false);
  assert.equal(expandBtn._attrs['aria-expanded'], 'true');
  delete globalThis.fetch;
});

test('expandAsset_collapses_on_second_click', async function () {
  // expandAsset is called once per click; simulate second call as re-expand
  // (collapsing is done by renderSummary's click handler, not expandAsset itself).
  // Test that calling expandAsset twice re-fetches and re-renders correctly.
  var fetchCount = 0;
  globalThis.fetch = function() {
    fetchCount++;
    return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve({ id: 1, title: 'S', has_pdf: false, has_midi: false, variants: [], page_tokens: [], bar_coords: [], bar_timings: [] }); } });
  };
  var detailEl = makeEl(); detailEl.hidden = true;
  var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  // Simulate two expand clicks via renderSummary
  var asset = { id: 1, title: 'S', has_pdf: false, has_midi: false, variant_count: 0, created_at: 0 };
  var li = lib.renderSummary(asset, '/base', makeBannerEl());
  var header = li.children[0];
  var btn = header.children[0];
  btn._fire('click'); // expand
  await new Promise(function(r) { setTimeout(r, 20); });
  btn._fire('click'); // collapse (should NOT re-fetch)
  await new Promise(function(r) { setTimeout(r, 20); });
  // On second click: collapse happens without a new fetch
  assert.equal(li.children[1].hidden, true);
  delete globalThis.fetch;
});

test('expandAsset_fetches_asset_detail', async function () {
  var fetchedUrl;
  globalThis.fetch = function(url) {
    fetchedUrl = url;
    return Promise.resolve({ ok: false, status: 404, json: function() { return Promise.resolve({ message: 'nf' }); } });
  };
  var detailEl = makeEl(); var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(42, detailEl, expandBtn, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(fetchedUrl, '/base/42');
  delete globalThis.fetch;
});

test('expandAsset_shows_omr_section_for_pdf_asset', async function () {
  globalThis.fetch = fetchStub(200, { id: 1, title: 'S', has_pdf: true, has_midi: false, variants: [], page_tokens: [], bar_coords: [], bar_timings: [] });
  var omrSectionFound = false;
  var detailEl = makeEl();
  detailEl.appendChild = function(el) {
    if (el.className === 'omr-flow') omrSectionFound = true;
    return el;
  };
  var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(1, detailEl, expandBtn, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(omrSectionFound, true);
  delete globalThis.fetch;
});

test('expandAsset_hides_synthesise_form_when_no_midi', async function () {
  globalThis.fetch = fetchStub(200, { id: 1, title: 'S', has_pdf: true, has_midi: false, variants: [], page_tokens: [], bar_coords: [], bar_timings: [] });
  var synthFormHidden = null;
  var detailEl = makeEl();
  detailEl.appendChild = function(el) {
    if (el.className === 'synthesise-form') synthFormHidden = el.hidden;
    return el;
  };
  var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(1, detailEl, expandBtn, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(synthFormHidden, true);
  delete globalThis.fetch;
});

test('expandAsset_shows_synthesise_form_for_midi_only_asset', async function () {
  globalThis.fetch = fetchStub(200, { id: 1, title: 'S', has_pdf: false, has_midi: true, variants: [], page_tokens: [], bar_coords: [], bar_timings: [] });
  var synthFormFound = false;
  var omrSectionFound = false;
  var detailEl = makeEl();
  detailEl.appendChild = function(el) {
    if (el.className === 'synthesise-form') synthFormFound = true;
    if (el.className === 'omr-flow') omrSectionFound = true;
    return el;
  };
  var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(1, detailEl, expandBtn, '/base', makeBannerEl());
    setTimeout(r, 20);
  });
  assert.equal(synthFormFound, true);
  assert.equal(omrSectionFound, false);
  delete globalThis.fetch;
});

test('expandAsset_shows_inline_error_on_422', async function () {
  globalThis.fetch = fetchStub(422, { message: 'not yours' });
  var bannerEl = makeBannerEl();
  var detailEl = makeEl(); var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(1, detailEl, expandBtn, '/base', bannerEl);
    setTimeout(r, 20);
  });
  assert.ok(detailEl.textContent.length > 0);
  assert.equal(bannerEl.hidden, true);
  delete globalThis.fetch;
});

test('expandAsset_shows_inline_error_on_network_failure', async function () {
  globalThis.fetch = fetchReject('network down');
  var bannerEl = makeBannerEl();
  var detailEl = makeEl(); var expandBtn = makeEl(); expandBtn.setAttribute('aria-expanded', 'false');
  await new Promise(function(r) {
    lib.expandAsset(1, detailEl, expandBtn, '/base', bannerEl);
    setTimeout(r, 20);
  });
  assert.ok(detailEl.textContent.length > 0);
  assert.equal(bannerEl.hidden, true);
  delete globalThis.fetch;
});

test('renderVariantRow_resynthesize_button_calls_synthesise', function () {
  var calledWith = null;
  var variant = { id: 7, label: 'Slow', tempo_pct: 75, transpose_semitones: -2, respect_repeats: true };
  var li = lib.renderVariantRow(1, variant, '/base', makeBannerEl(), function(req) { calledWith = req; });
  // resynth button is the 3rd child
  var resynBtn = li.children[2];
  resynBtn._fire('click');
  assert.ok(calledWith !== null);
  assert.equal(calledWith.label, 'Slow');
  assert.equal(calledWith.tempo_pct, 75);
  assert.equal(calledWith.transpose_semitones, -2);
  assert.equal(calledWith.respect_repeats, true);
});

// ---------------------------------------------------------------------------
// Banner tests
// ---------------------------------------------------------------------------

test('show503Banner_unhides_element', function () {
  var bannerEl = makeBannerEl();
  lib.show503Banner(bannerEl);
  assert.equal(bannerEl.hidden, false);
});

test('show503Banner_idempotent', function () {
  var bannerEl = makeBannerEl();
  lib.show503Banner(bannerEl);
  lib.show503Banner(bannerEl);
  assert.equal(bannerEl.hidden, false);
});

test('hide503Banner_hides_element', function () {
  var bannerEl = makeBannerEl();
  bannerEl.hidden = false;
  lib.hide503Banner(bannerEl);
  assert.equal(bannerEl.hidden, true);
});

// ---------------------------------------------------------------------------
// VLQ encoding tests
// ---------------------------------------------------------------------------

test('encodeVlq_zero', function () {
  assert.deepEqual(lib.encodeVlq(0), [0x00]);
});

test('encodeVlq_127', function () {
  assert.deepEqual(lib.encodeVlq(127), [0x7F]);
});

test('encodeVlq_128', function () {
  assert.deepEqual(lib.encodeVlq(128), [0x81, 0x00]);
});

test('encodeVlq_16383', function () {
  assert.deepEqual(lib.encodeVlq(16383), [0xFF, 0x7F]);
});

test('encodeVlq_16384', function () {
  assert.deepEqual(lib.encodeVlq(16384), [0x81, 0x80, 0x00]);
});

test('encodeVlq_4byte_boundary', function () {
  // 2097151 = 0x1FFFFF -> [0xFF, 0xFF, 0x7F] (3 bytes)
  assert.deepEqual(lib.encodeVlq(2097151), [0xFF, 0xFF, 0x7F]);
  // 2097152 = 0x200000 -> [0x81, 0x80, 0x80, 0x00] (4 bytes)
  assert.deepEqual(lib.encodeVlq(2097152), [0x81, 0x80, 0x80, 0x00]);
});

// ---------------------------------------------------------------------------
// serializeMidi — byte-level invariants
// ---------------------------------------------------------------------------

test('serializeMidi_empty_starts_with_MThd', function () {
  var buf = lib.serializeMidi([]);
  assert.equal(buf[0], 0x4D); // M
  assert.equal(buf[1], 0x54); // T
  assert.equal(buf[2], 0x68); // h
  assert.equal(buf[3], 0x64); // d
});

test('serializeMidi_empty_format_type1', function () {
  var buf = lib.serializeMidi([]);
  // bytes 8-9 = format word
  assert.equal(buf[8], 0x00);
  assert.equal(buf[9], 0x01);
});

test('serializeMidi_empty_numtracks_2', function () {
  var buf = lib.serializeMidi([]);
  // bytes 10-11 = numTracks
  assert.equal(buf[10], 0x00);
  assert.equal(buf[11], 0x02);
});

test('serializeMidi_empty_ticks_480_default', function () {
  var buf = lib.serializeMidi([]);
  // bytes 12-13 = ticks/beat
  assert.equal(buf[12], 0x01);
  assert.equal(buf[13], 0xE0); // 480 = 0x01E0
});

test('serializeMidi_empty_tempo_track_has_set_tempo', function () {
  var buf = lib.serializeMidi([]);
  // Tempo MTrk starts at byte 14+8 = 22
  // MTrk header: 4D 54 72 6B at bytes 14..17
  assert.equal(buf[14], 0x4D); // M
  assert.equal(buf[15], 0x54); // T
  assert.equal(buf[16], 0x72); // r
  assert.equal(buf[17], 0x6B); // k
  // Tempo track data starts at byte 22 (after 4-byte length)
  assert.equal(buf[22], 0x00); // delta VLQ
  assert.equal(buf[23], 0xFF); // meta event
  assert.equal(buf[24], 0x51); // set-tempo type
  assert.equal(buf[25], 0x03); // 3 data bytes
});

test('serializeMidi_empty_tempo_track_length_11', function () {
  var buf = lib.serializeMidi([]);
  // Tempo track chunk length at bytes 18-21
  var len = (buf[18] << 24) | (buf[19] << 16) | (buf[20] << 8) | buf[21];
  assert.equal(len, 11);
});

test('serializeMidi_empty_note_track_length_4', function () {
  var buf = lib.serializeMidi([]);
  // Note MTrk header starts after tempo chunk: 14 + 8 + 11 = 33
  var noteHdrStart = 33;
  assert.equal(buf[noteHdrStart], 0x4D);
  assert.equal(buf[noteHdrStart + 1], 0x54);
  assert.equal(buf[noteHdrStart + 2], 0x72);
  assert.equal(buf[noteHdrStart + 3], 0x6B);
  var len = (buf[noteHdrStart + 4] << 24) | (buf[noteHdrStart + 5] << 16) |
            (buf[noteHdrStart + 6] << 8) | buf[noteHdrStart + 7];
  assert.equal(len, 4); // just end-of-track: 00 FF 2F 00
});

test('serializeMidi_tempo_60bpm_encodes_1000000_micros', function () {
  var buf = lib.serializeMidi([], { bpm: 60 });
  // microsPerBeat = 1000000 = 0x0F4240
  assert.equal(buf[26], 0x0F);
  assert.equal(buf[27], 0x42);
  assert.equal(buf[28], 0x40);
});

test('serializeMidi_both_tracks_end_with_end_of_track', function () {
  var buf = lib.serializeMidi([]);
  // Tempo track end-of-track: at bytes 29-32 (22+7 = 29)
  assert.equal(buf[29], 0x00);
  assert.equal(buf[30], 0xFF);
  assert.equal(buf[31], 0x2F);
  assert.equal(buf[32], 0x00);
  // Note track end-of-track: at bytes 41-44 (33+8 = 41 start of data)
  assert.equal(buf[41], 0x00);
  assert.equal(buf[42], 0xFF);
  assert.equal(buf[43], 0x2F);
  assert.equal(buf[44], 0x00);
});

test('serializeMidi_delta_tick_500ms_120bpm_480tpb', function () {
  // 500ms at 120 BPM = 1 beat = 480 ticks
  var events = [{ elapsedMs: 500, type: 'note_on', channel: 0, data1: 60, data2: 80 }];
  var buf = lib.serializeMidi(events, { bpm: 120, ticksPerBeat: 480 });
  // Note track data starts at noteHdrStart + 8 = 41
  var noteDataStart = 41;
  // VLQ for 480: 480 = 0x1E0 -> [0x83, 0x60]
  assert.equal(buf[noteDataStart], 0x83);
  assert.equal(buf[noteDataStart + 1], 0x60);
  assert.equal(buf[noteDataStart + 2], 0x90); // note_on ch0
  assert.equal(buf[noteDataStart + 3], 60);   // middle C
  assert.equal(buf[noteDataStart + 4], 80);   // velocity
});

test('serializeMidi_default_opts_same_as_explicit', function () {
  var evs = [{ elapsedMs: 100, type: 'note_on', channel: 0, data1: 64, data2: 64 }];
  var a = lib.serializeMidi(evs);
  var b = lib.serializeMidi(evs, { ticksPerBeat: 480, bpm: 120 });
  assert.equal(a.length, b.length);
  for (var i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

// ---------------------------------------------------------------------------
// serializeMidi — guards
// ---------------------------------------------------------------------------

test('serializeMidi_throws_on_bpm_zero', function () {
  assert.throws(function () { lib.serializeMidi([], { bpm: 0 }); }, RangeError);
});

test('serializeMidi_throws_on_bpm_negative', function () {
  assert.throws(function () { lib.serializeMidi([], { bpm: -1 }); }, RangeError);
});

test('serializeMidi_throws_on_ticksPerBeat_zero', function () {
  assert.throws(function () { lib.serializeMidi([], { ticksPerBeat: 0 }); }, RangeError);
});

test('serializeMidi_throws_on_ticksPerBeat_negative', function () {
  assert.throws(function () { lib.serializeMidi([], { ticksPerBeat: -1 }); }, RangeError);
});

test('serializeMidi_negative_elapsedMs_clamped_to_tick_0', function () {
  var evNeg = [{ elapsedMs: -500, type: 'note_on', channel: 0, data1: 60, data2: 64 }];
  var evZero = [{ elapsedMs: 0, type: 'note_on', channel: 0, data1: 60, data2: 64 }];
  var a = lib.serializeMidi(evNeg);
  var b = lib.serializeMidi(evZero);
  assert.equal(a.length, b.length);
  for (var i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

// ---------------------------------------------------------------------------
// handleMidiMessage — filter and normalization
// ---------------------------------------------------------------------------

function makeMidiState() {
  return {
    recording: true,
    captureStart: 0,
    events: [],
    heldNotes: {},
    port: { onmidimessage: null },
    noteDisplayEl: null,
    statusEl: null,
  };
}

function midiEvt(bytes, timeStamp) {
  return { data: new Uint8Array(bytes), timeStamp: timeStamp || 0 };
}

test('handleMidiMessage_note_on_pushed_and_held', function () {
  var state = makeMidiState();
  var result = lib.handleMidiMessage(state, midiEvt([0x90, 60, 80]));
  assert.equal(result, 'pushed');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'note_on');
  assert.equal(state.events[0].data1, 60);
  assert.equal(state.heldNotes[60], true);
});

test('handleMidiMessage_note_off_pushed_and_released', function () {
  var state = makeMidiState();
  state.heldNotes[60] = true;
  var result = lib.handleMidiMessage(state, midiEvt([0x80, 60, 0]));
  assert.equal(result, 'pushed');
  assert.equal(state.events[0].type, 'note_off');
  assert.equal(state.heldNotes[60], undefined);
});

test('handleMidiMessage_note_on_velocity_zero_normalised_to_note_off', function () {
  var state = makeMidiState();
  state.heldNotes[60] = true;
  lib.handleMidiMessage(state, midiEvt([0x90, 60, 0]));
  assert.equal(state.events[0].type, 'note_off');
  assert.equal(state.heldNotes[60], undefined);
});

test('handleMidiMessage_control_change_pushed', function () {
  var state = makeMidiState();
  var result = lib.handleMidiMessage(state, midiEvt([0xB0, 64, 127]));
  assert.equal(result, 'pushed');
  assert.equal(state.events[0].type, 'control_change');
});

test('handleMidiMessage_program_change_ignored', function () {
  var state = makeMidiState();
  var result = lib.handleMidiMessage(state, midiEvt([0xC0, 40, 0]));
  assert.equal(result, 'ignored');
  assert.equal(state.events.length, 0);
});

test('handleMidiMessage_sysex_ignored', function () {
  var state = makeMidiState();
  var result = lib.handleMidiMessage(state, midiEvt([0xF0, 0x7E, 0xF7]));
  assert.equal(result, 'ignored');
  assert.equal(state.events.length, 0);
});

test('handleMidiMessage_clock_ignored', function () {
  var state = makeMidiState();
  var result = lib.handleMidiMessage(state, midiEvt([0xF8]));
  assert.equal(result, 'ignored');
  assert.equal(state.events.length, 0);
});

test('handleMidiMessage_not_recording_ignored', function () {
  var state = makeMidiState();
  state.recording = false;
  var result = lib.handleMidiMessage(state, midiEvt([0x90, 60, 80]));
  assert.equal(result, 'ignored');
  assert.equal(state.events.length, 0);
});

test('handleMidiMessage_elapsed_ms_computed_from_captureStart', function () {
  var state = makeMidiState();
  state.captureStart = 1000;
  lib.handleMidiMessage(state, midiEvt([0x90, 60, 80], 1500));
  assert.equal(state.events[0].elapsedMs, 500);
});

test('handleMidiMessage_note_display_updated_on_held', function () {
  var displayEl = makeEl();
  var state = makeMidiState();
  state.noteDisplayEl = displayEl;
  lib.handleMidiMessage(state, midiEvt([0x90, 60, 80])); // C4
  assert.ok(displayEl.textContent.indexOf('C4') !== -1);
  lib.handleMidiMessage(state, midiEvt([0x80, 60, 0]));  // release
  assert.ok(displayEl.textContent.indexOf('C4') === -1);
});

test('handleMidiMessage_cap_10000_stops_recording', function () {
  var state = makeMidiState();
  // Fill buffer to exactly 10000
  for (var i = 0; i < 10000; i++) {
    state.events.push({ elapsedMs: i, type: 'note_on', channel: 0, data1: 60, data2: 80 });
  }
  var result = lib.handleMidiMessage(state, midiEvt([0x90, 62, 80]));
  assert.equal(result, 'capped');
  assert.equal(state.recording, false);
  assert.equal(state.events.length, 10000); // cap-triggering event NOT pushed
  assert.equal(state.port.onmidimessage, null);
});

test('handleMidiMessage_cap_shows_status_message', function () {
  var state = makeMidiState();
  var statusEl = makeEl();
  state.statusEl = statusEl;
  for (var i = 0; i < 10000; i++) {
    state.events.push({ elapsedMs: i, type: 'note_on', channel: 0, data1: 60, data2: 80 });
  }
  lib.handleMidiMessage(state, midiEvt([0x90, 62, 80]));
  assert.ok(statusEl.textContent.length > 0);
});

// ---------------------------------------------------------------------------
// initMidiRecording — degradation
// ---------------------------------------------------------------------------

test('initMidiRecording_shows_unavailable_when_no_provider', function () {
  var noteEl = makeEl(); noteEl.hidden = true;
  var savedGetEl = globalThis.document.getElementById;
  globalThis.document.getElementById = function (id) {
    if (id === 'midi-unavailable-note') return noteEl;
    return null;
  };
  // Pass null provider → no MIDI API → unavailable note shown
  lib.initMidiRecording(null, null);
  assert.equal(noteEl.hidden, false);
  globalThis.document.getElementById = savedGetEl;
});

test('initMidiRecording_shows_unavailable_on_rejected_promise', async function () {
  var noteEl = makeEl(); noteEl.hidden = true;
  var savedGetEl = globalThis.document.getElementById;
  globalThis.document.getElementById = function (id) {
    if (id === 'midi-unavailable-note') return noteEl;
    return null;
  };
  var rejectingProvider = function () { return Promise.reject(new Error('permission denied')); };
  lib.initMidiRecording(null, rejectingProvider);
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.equal(noteEl.hidden, false);
  globalThis.document.getElementById = savedGetEl;
});

test('initMidiRecording_reveals_section_on_access_with_port', async function () {
  var sectionEl = makeEl(); sectionEl.hidden = true;
  var mockPort = { id: 'p1', name: 'Piano', onmidimessage: null };
  var mockInputs = new Map([['p1', mockPort]]);
  var successProvider = function () {
    return Promise.resolve({ inputs: mockInputs, onstatechange: null });
  };
  var savedGetEl = globalThis.document.getElementById;
  globalThis.document.getElementById = function (id) {
    if (id === 'midi-record-section') return sectionEl;
    if (id === 'midi-device-row') return null;
    if (id === 'midi-device-select') return null;
    return null;
  };
  lib.initMidiRecording(null, successProvider);
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.equal(sectionEl.hidden, false);
  globalThis.document.getElementById = savedGetEl;
});

// ---------------------------------------------------------------------------
// Device picker XSS guard
// ---------------------------------------------------------------------------

test('initMidiRecording_device_picker_uses_textContent', async function () {
  var optionTextContent = null;
  var mockPort1 = { id: 'p1', name: '<script>alert(1)</script>', onmidimessage: null };
  var mockPort2 = { id: 'p2', name: 'Piano 2', onmidimessage: null };
  var mockInputs = new Map([['p1', mockPort1], ['p2', mockPort2]]);
  var provider = function () {
    return Promise.resolve({ inputs: mockInputs, onstatechange: null });
  };
  var appendedTexts = [];
  var deviceSelect = makeEl();
  deviceSelect.replaceChildren = function () { appendedTexts = []; };
  deviceSelect.appendChild = function (opt) {
    if (opt.textContent != null) appendedTexts.push(opt.textContent);
  };
  var savedGetEl = globalThis.document.getElementById;
  globalThis.document.getElementById = function (id) {
    if (id === 'midi-record-section') return makeEl();
    if (id === 'midi-device-row') { var el = makeEl(); el.hidden = true; return el; }
    if (id === 'midi-device-select') return deviceSelect;
    return null;
  };
  lib.initMidiRecording(null, provider);
  await new Promise(function (r) { setTimeout(r, 20); });
  // XSS string stored as literal text, not parsed as HTML
  assert.ok(appendedTexts.indexOf('<script>alert(1)</script>') !== -1);
  globalThis.document.getElementById = savedGetEl;
});

// ---------------------------------------------------------------------------
// startUpload — no-onSuccess regression
// ---------------------------------------------------------------------------

test('startUpload_no_onSuccess_completes_without_error', async function () {
  globalThis.fetch = fetchStub(201, { id: 42, title: 'T', kind: 'midi' });
  var progressEl = makeEl(); progressEl.hidden = true;
  var errorEl = makeEl(); errorEl.hidden = true;
  var uploadBtn = makeEl();
  var loadCalled = false;
  await new Promise(function (resolve) {
    lib.startUpload({
      file: { type: 'audio/midi' },
      title: 'T',
      uploadBtn: uploadBtn,
      progressEl: progressEl,
      errorEl: errorEl,
      BASE: '/base',
      loadAssets: function () { loadCalled = true; resolve(); },
      listEl: makeEl(), emptyEl: makeEl(), assetsErrorEl: makeEl(), bannerEl: makeBannerEl(),
      // no onSuccess
    });
  });
  assert.equal(loadCalled, true);
  assert.equal(errorEl.hidden, true);
  delete globalThis.fetch;
});
