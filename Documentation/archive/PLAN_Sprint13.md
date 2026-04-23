# PLAN — Sprint 13: Library Management UI

**Sprint:** 13
**Date:** 2026-04-22
**Status:** DRAFT (R6 addressed)

---

## Problem Statement

Sprint 12 delivered a complete JSON API for the accompaniment library but
`GET /teach/:slug/library` returns a stub HTML page. Sprint 13 delivers the
browser-facing half: a fully functional library management UI wired to every
Sprint 12 endpoint, with a JS unit test suite covering the core flows.

---

## Spec References

- `SPRINTS.md` §Sprint 13 — deliverables, exit criteria
- `knowledge/architecture/accompaniment.md` — API shapes, upload pipeline,
  media tokens, sidecar error codes

---

## Current State

| Item | State |
|------|-------|
| `GET /teach/:slug/library` | Serves inline stub (3-line placeholder) |
| `web/library.html` | Does not exist |
| `web/assets/library.js` | Does not exist |
| `web/assets/tests/library.test.js` | Does not exist |
| All 9 Sprint 12 API endpoints | Fully implemented + tested |
| `library_page_returns_html` server test | Passes; checks status/headers only |

**Existing patterns used:**
- `web/recordings.html` + `web/assets/recordings.js` — page-level IIFE reference
- `web/assets/chat-drawer.js` — UMD wrapper: `(function(root, factory){...})`
- `web/assets/tests/chat-drawer.test.js` — `node:test` + DOM stub pattern
- `server/src/http/teach.rs` — reads `.html` from `state.config.static_dir`

---

## API Surface (from Sprint 12 source)

All routes require a teacher session cookie. Routes are under
`/teach/:slug/library/assets`.

| Method | Path | Request | Success |
|--------|------|---------|---------|
| GET | `.../assets` | — | `AssetSummary[]` |
| POST | `.../assets` | raw file body; `X-Title` header | 201 `{ id, title, kind, variant_id? }` |
| GET | `.../assets/:id` | — | `AssetDetail` |
| DELETE | `.../assets/:id` | — | 204 |
| POST | `.../assets/:id/parts` | — | `PartInfo[]` (flat array `[{index, name}]`) |
| POST | `.../assets/:id/midi` | `{ part_indices: number[] }` | `{ bar_count }` |
| POST | `.../assets/:id/rasterise` | — | `{ page_count }` |
| POST | `.../assets/:id/variants` | `{ label, tempo_pct, transpose_semitones, respect_repeats }` | 201 `{ id, label }` |
| DELETE | `.../assets/:id/variants/:vid` | — | 204 |

**Upload format (critical):** The upload endpoint reads the raw request body
directly (not multipart). `startUpload()` must send
`fetch(BASE, { method: 'POST', headers: { 'X-Title': title, 'Content-Type': file.type }, body: file })`.
No `FormData` wrapper.

**Variant create response:** Returns `{ id, label }` only — not the full
`VariantView`. `renderVariantRow` builds the display from `req` + `data.id`.

**Parts response:** Flat `PartInfo[]` array — not `{ parts: [...] }`.

**Error shape:** `{ code, message }`. HTTP 503 = sidecar unavailable (all
other operations still work). Upload and delete failures are NOT sidecar errors;
they must never show the sidecar banner.

---

## Proposed Solution

### G1: `server/src/http/library.rs` — serve `library.html` from disk + slug ownership

Replace the inline stub in `get_library_page`. Two changes:

1. Add `Path` extraction (currently missing from the signature).
2. Add slug ownership check (the authenticated teacher must own the slug).
3. Read `library.html` from disk.

```rust
pub(crate) async fn get_library_page(
    State(state): State<Arc<AppState>>,
    Path((slug,)): Path<(String,)>,
    headers: HeaderMap,
) -> Result<Response> {
    let teacher_id = require_auth(&state, &headers).await?;
    // Validate slug format before querying (NotFound on bad slug, same as teach.rs).
    let slug = crate::auth::slug::validate(&slug).map_err(|_| AppError::NotFound)?;
    // Verify this teacher owns the slug.
    let (owned,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM teachers WHERE id = ? AND slug = ?",
    )
    .bind(teacher_id)
    .bind(&slug)
    .fetch_one(&state.db)
    .await?;
    if owned == 0 {
        return Err(AppError::Forbidden);
    }
    let html_path = state.config.static_dir.join("library.html");
    let html = tokio::fs::read_to_string(&html_path).await?;
    Ok((
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
        ],
        Html(html),
    ).into_response())
}
```

**Server test update** (`server/tests/http_library.rs`, `library_page_returns_html`):
Add body content assertion:
```rust
let body = r.text().await.unwrap();
assert!(body.contains("Accompaniment Library"), "body should contain page title");
```

---

### G2: `web/library.html`

Static HTML using the project's shared `styles.css`. No server-side templating;
the slug is read by JS from `window.location.pathname`.

```html
<!doctype html>
<!--
  File: web/library.html
  Purpose: Teacher accompaniment library — upload, OMR flow, synthesise, manage variants.
  Last updated: Sprint 13 (2026-04-22) -- initial implementation
-->
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accompaniment Library — singing-bridge</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <div id="sidecar-banner" class="banner-error" hidden>
    Sheet music tools unavailable. Upload and delete still work.
    <button id="sidecar-banner-close" type="button">✕</button>
  </div>

  <main class="library-page">
    <h1>Accompaniment Library</h1>
    <nav><a id="back-link" href="#">← Back to room</a></nav>

    <!-- Upload panel -->
    <section id="upload-section">
      <div id="drop-zone" class="drop-zone" tabindex="0"
           aria-label="Drop PDF, MIDI, or WAV file here">
        <p>Drop a PDF, MIDI, or WAV file here, or
           <label for="file-input">browse</label></p>
        <input type="file" id="file-input" accept=".pdf,.mid,.midi,.wav"
               aria-label="Choose file">
      </div>
      <div id="title-row">
        <label for="title-input">Title
          <input type="text" id="title-input" maxlength="255"
                 placeholder="e.g. Ave Maria (Schubert)" required>
        </label>
        <button id="upload-btn" type="button">Upload</button>
      </div>
      <p id="upload-error" class="error" hidden></p>
      <p id="upload-progress" hidden>Uploading…</p>
    </section>

    <!-- Asset list -->
    <ul id="asset-list" aria-live="polite"></ul>
    <p id="assets-empty" hidden>No assets yet. Upload a PDF, MIDI, or WAV above.</p>
    <p id="assets-error" class="error" hidden></p>

    <script src="/assets/library.js"></script>
  </main>
</body>
</html>
```

**Per-asset list item** rendered by `renderSummary`:

```html
<li class="asset-row" data-id="42">
  <div class="asset-header">
    <button class="asset-expand-btn" type="button" aria-expanded="false">▸ Ave Maria</button>
    <span class="asset-meta">PDF · 2 variants · 22 Apr 2026</span>
    <button class="asset-delete-btn" type="button">Delete</button>
  </div>
  <div class="asset-detail" hidden></div>
</li>
```

**Asset detail panel** injected into `.asset-detail`:

```html
<!-- OMR flow — only rendered when asset.has_pdf -->
<section class="omr-flow">
  <button class="omr-btn" type="button">Run OMR</button>
  <div class="part-picker" hidden>
    <!-- checkboxes injected per PartInfo element -->
    <button class="extract-midi-btn" type="button">Extract MIDI</button>
  </div>
  <button class="rasterise-btn" type="button">Rasterise pages</button>
  <p class="omr-status" aria-live="polite"></p>
</section>

<!-- Synthesise form — only rendered when asset.has_midi -->
<section class="synthesise-form">
  <h3>New variant</h3>
  <label>Label <input class="variant-label" type="text" maxlength="255"></label>
  <label>Tempo %
    <input class="variant-tempo" type="number" min="25" max="300" value="100">
  </label>
  <label>Transpose (semitones)
    <input class="variant-transpose" type="number" min="-12" max="12" value="0">
  </label>
  <label><input class="variant-repeats" type="checkbox"> Respect repeats</label>
  <button class="synthesise-btn" type="button">Synthesise</button>
  <p class="synthesise-status" aria-live="polite"></p>
</section>

<!-- Variant list -->
<ul class="variant-list"></ul>
```

---

### G3: `web/assets/library.js`

Uses the project's UMD wrapper (same as `chat-drawer.js`). In the browser,
`init()` runs immediately. In Node (tests), `module.exports` provides the
helpers and `init()` is skipped.

**File header:**
```js
// File: web/assets/library.js
// Purpose: Teacher accompaniment library page — load, upload, OMR flow, synthesise, delete.
// Role: Page-level script for /teach/:slug/library.
// Exports: window.sbLibrary / module.exports (test harness)
// Depends: fetch API
// Invariants: all server-supplied strings rendered via .textContent only (no innerHTML);
//             upload fires raw file body (not FormData) with X-Title header;
//             503 responses show sidecar banner except for upload and delete;
//             synthesise is validated client-side before fetch.
// Last updated: Sprint 13 (2026-04-22) -- initial implementation
```

**Wrapper:**

```js
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

  // ... all implementation ...

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
```

**`init()` — runs in browser only:**
```js
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
```

`BASE` is a module-level `var BASE = ''` set by `init()`. Tests pass the
string explicitly to each helper — no closure dependency in tests.

#### Banner: `show503Banner(bannerEl)` / `hide503Banner(bannerEl)`
Accept explicit element. In browser callers, pass
`document.getElementById('sidecar-banner')`. Tests pass a DOM stub directly.
`show503Banner` is idempotent (no-op if already visible).

```js
function show503Banner(bannerEl) {
  if (bannerEl) bannerEl.hidden = false;
}
function hide503Banner(bannerEl) {
  if (bannerEl) bannerEl.hidden = true;
}
```

#### `loadAssets(BASE, listEl, emptyEl, errorEl, bannerEl)`
All parameters are explicit — no closures over DOM globals — enabling direct
unit test invocation.
```
GET BASE
→ populate listEl with renderSummary(asset, BASE, bannerEl) for each
→ emptyEl.hidden = (assets.length > 0)
→ on error: errorEl.hidden = false; errorEl.textContent = message
```

#### `renderSummary(asset, BASE, bannerEl)` → `<li>`
Returns an `<li class="asset-row">` element. All server strings via
`.textContent`. Wires:
- expand button → `expandAsset(asset.id, detailEl, expandBtn, BASE, bannerEl)`
- delete button → `confirmDelete(asset.id, asset.title, li, BASE)`

Kind badge: `asset.has_pdf ? 'PDF' : asset.has_midi ? 'MIDI' : 'WAV'`.

#### `expandAsset(id, detailEl, expandBtn, BASE, bannerEl)`
```
GET BASE/:id
Note: this is a pure DB read — not sidecar-backed — so no 503 banner for any error.
→ on network failure (fetch rejects): detailEl.textContent = 'Failed to load asset'; return
→ on non-2xx: detailEl.textContent = message; return
→ on success:
    build OMR section (when detail.has_pdf)
      rasteriseBtn.disabled = !detail.has_midi
    build synthesise form (when detail.has_pdf OR detail.has_midi)
      synthesise form hidden = !detail.has_midi
      this allows extractMidi success to unhide it without re-render
    build variant list from detail.variants
    wire all buttons with explicit element params
    toggle detailEl.hidden; update expandBtn aria-expanded
```

Re-expand re-fetches (media tokens may expire).

**`extractMidi` interaction with expandAsset panel:** After `extractMidi`
succeeds on an asset where `has_midi` was previously false, `extractMidi`
unhides the synthesise form in the same expanded panel:
```
→ on success:
    statusEl.textContent = data.bar_count + ' bars extracted'
    synthesiseFormEl.hidden = false   // passed by expandAsset
    rasteriseBtn.disabled = false
```
`expandAsset` passes `synthesiseFormEl` to `extractMidi` when wiring the
Extract MIDI button.

#### `startUpload(opts)`

`opts`: `{ file, title, uploadBtn, progressEl, errorEl, BASE, loadAssets, listEl, emptyEl, assetsErrorEl, bannerEl }`

All DOM references are explicit — no closures. Tests inject stubs directly.

Steps:
1. Validate: `opts.file` present; `opts.title` not empty after trim.
2. Byte-length check: `new TextEncoder().encode(opts.title).length > 255` → show error, return.
3. Show `opts.progressEl`; `opts.uploadBtn.disabled = true`.
4. `fetch(opts.BASE, { method: 'POST', headers: { 'X-Title': opts.title, 'Content-Type': opts.file.type || 'application/octet-stream' }, body: opts.file })`.
5. On 201: clear pending file; clear `opts.title`; call `opts.loadAssets(opts.BASE, opts.listEl, opts.emptyEl, opts.assetsErrorEl, opts.bannerEl)`.
6. On non-2xx: parse JSON; show `opts.errorEl` with `data.message`.
   **Do NOT call `show503Banner`** — upload failures are not sidecar errors.
7. Always: hide `opts.progressEl`; `opts.uploadBtn.disabled = false`.

#### `runOmr(assetId, partPickerEl, omrBtn, statusEl, BASE, bannerEl)`
```
POST BASE/:id/parts
→ on success (data is PartInfo[]):
    render checkboxes into partPickerEl (one per part, all checked by default)
    each <input type="checkbox"> has value = part.index (used as part_indices in extractMidi)
    each label via .textContent = part.name
    show partPickerEl
→ on 503: show503Banner(bannerEl); statusEl.textContent = 'Sheet music tools unavailable'
→ on error: statusEl.textContent = data.message
→ always: re-enable omrBtn
```

#### `extractMidi(assetId, partIndices, statusEl, rasteriseBtn, synthesiseFormEl, BASE, bannerEl)`
```
POST BASE/:id/midi  body: JSON.stringify({ part_indices: partIndices })
Content-Type: application/json
→ on success: statusEl.textContent = data.bar_count + ' bars extracted'
              rasteriseBtn.disabled = false
              synthesiseFormEl.hidden = false
→ on 503: show503Banner(bannerEl); statusEl.textContent = 'Sheet music tools unavailable'
→ on error: statusEl.textContent = data.message
```

#### `rasterise(assetId, statusEl, BASE, bannerEl)`
```
POST BASE/:id/rasterise
→ on success: statusEl.textContent = data.page_count + ' pages rasterised'
→ on 503: show503Banner(bannerEl); statusEl.textContent = 'Sheet music tools unavailable'
→ on error: statusEl.textContent = data.message
```

#### `synthesise(assetId, req, statusEl, variantListEl, formEl, BASE, bannerEl)`

`formEl` has four child inputs accessible as:
`formEl.labelInput`, `formEl.tempoInput`, `formEl.transposeInput`, `formEl.repeatsInput`
(or by class selector). On success these are reset. Tests pass a stub `formEl`
with explicit `{ labelInput, tempoInput, transposeInput, repeatsInput }` fields.

Client-side validation (set `statusEl.textContent`, return early if invalid):
- `req.label.trim()` non-empty
- `req.tempo_pct` is an integer in [25, 300] (inclusive)
- `req.transpose_semitones` is an integer in [−12, 12] (inclusive)

```
POST BASE/:id/variants  body: JSON.stringify(req)  Content-Type: application/json
→ on success (data = { id, label }):
    build displayReq = { id: data.id, label: data.label, tempo_pct: req.tempo_pct,
                         transpose_semitones: req.transpose_semitones,
                         respect_repeats: req.respect_repeats }
    prepend renderVariantRow(assetId, displayReq, BASE, bannerEl) to variantListEl
    reset formEl.labelInput.value = ''
    reset formEl.tempoInput.value = '100'
    reset formEl.transposeInput.value = '0'
    reset formEl.repeatsInput.checked = false
→ on 503: show503Banner(bannerEl); statusEl.textContent = 'Sheet music tools unavailable'
→ on error: statusEl.textContent = data.message
```

#### `renderVariantRow(assetId, variant, BASE, bannerEl, synthesiseFn)` → `<li>`
Shows: `variant.label`, `variant.tempo_pct`, `variant.transpose_semitones`.
All via `.textContent`.

Buttons:
- **Delete** → `confirmDeleteVariant(assetId, variant.id, li, BASE, globalThis.confirm, globalThis.alert)`
- **Re-synthesise** → calls `synthesiseFn` (passed by `expandAsset`) with
  pre-populated `req = { label: variant.label, tempo_pct: variant.tempo_pct,
  transpose_semitones: variant.transpose_semitones, respect_repeats: variant.respect_repeats }`.
  Uses the same `synthesise()` helper; new variant is prepended to the list.

#### `confirmDelete(assetId, title, li, BASE, confirmFn, alertFn)`
`confirmFn` defaults to `globalThis.confirm`; `alertFn` defaults to
`globalThis.alert`. Both are injected as parameters so tests can stub them
without touching globals.

```
if (!confirmFn('Delete "' + title + '"? This cannot be undone.')) return;
DELETE BASE/:id
→ on 204: li.remove()
→ on error: alertFn(data.message)
```
No sidecar banner (delete is not a sidecar operation).

#### `confirmDeleteVariant(assetId, variantId, variantLi, BASE, confirmFn, alertFn)`
```
DELETE BASE/:id/variants/:vid
→ on 204: variantLi.remove()
→ on error: alertFn(data.message)
```

#### `initUpload()` (browser only, called from `init()`)
1. Drag-and-drop on `#drop-zone`: `dragover`/`dragenter` → add class
   `drop-zone--active` + `e.preventDefault()`; `dragleave`/`drop` → remove class;
   `drop` → set `pendingFile`.
2. `#file-input change` → set `pendingFile`.
3. `#upload-btn click` → call `startUpload({ file: pendingFile, title: titleInput.value, ... })`.

---

### G4: `web/assets/tests/library.test.js`

`node:test` + `node:assert/strict`. UMD module loaded via `require('./library.js')`.
`init()` skipped because `document` is not defined at require time (Node has no
global `document`). Helpers are called directly with explicit DOM stub arguments.

**DOM stub:**
```js
function makeEl() {
  var hidden = true;
  var text = '';
  var cls = '';
  var children = [];
  var listeners = {};
  return {
    get hidden() { return hidden; },
    set hidden(v) { hidden = !!v; },
    get textContent() { return text; },
    set textContent(v) { text = String(v); },
    get className() { return cls; },
    set className(v) { cls = v; },
    get children() { return children; },
    disabled: false,
    addEventListener: function(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    appendChild: function(c) { children.push(c); return c; },
    prepend: function(c) { children.unshift(c); return c; },
    remove: function() { this._removed = true; },
    replaceChildren: function() { children = []; },
    _fire: function(ev) { (listeners[ev] || []).forEach(function(f) { f(); }); },
  };
}
```

**Fetch stub:**
```js
function fetchStub(status, body) {
  return function() {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function() { return Promise.resolve(body); },
    });
  };
}
```

Restored in `afterEach`. `globalThis.confirm` also stubbed per test.

**File header:**
```js
// File: web/assets/tests/library.test.js
// Purpose: Unit tests for library.js helpers: upload flow, OMR multi-step,
//          synthesise validation, delete confirmation, 503 banner, rasterise.
// Last updated: Sprint 13 (2026-04-22) -- initial implementation
```

**Test cases:**

| # | Test name | Assertion |
|---|-----------|-----------|
| 1 | `upload_sets_x_title_header` | fetch called with `X-Title: 'Test Title'` |
| 2 | `upload_sends_raw_file_body` | fetch body is the File object (not FormData) |
| 3 | `upload_shows_progress_during_fetch` | progressEl.hidden === false before await resolves |
| 4 | `upload_hides_progress_after_success` | progressEl.hidden === true after 201 |
| 5 | `upload_clears_title_on_success` | titleInput.value === '' after 201 |
| 6 | `upload_reloads_asset_list_on_success` | loadAssets stub called once after 201 |
| 7 | `upload_shows_error_message_on_422` | errorEl.textContent === expected message |
| 8 | `upload_does_not_show_banner_on_503` | bannerEl.hidden stays true even for 503 |
| 9 | `upload_accepts_255_byte_title` | fetch called (no early return) |
| 10 | `upload_rejects_256_byte_title` | errorEl shows error; fetch not called |
| 11 | `upload_rejects_multibyte_overflow` | 86 × 3-byte chars = 258 bytes → error; fetch not called |
| 12 | `upload_rejects_null_file` | errorEl shows error; fetch not called |
| 13 | `upload_rejects_whitespace_only_title` | errorEl shows error; fetch not called |
| 14 | `renderSummary_shows_pdf_badge` | `has_pdf:true` → meta contains 'PDF' |
| 15 | `renderSummary_shows_wav_badge` | `has_pdf:false, has_midi:false` → meta contains 'WAV' |
| 16 | `renderSummary_title_via_textContent` | expand button textContent set; no innerHTML |
| 17 | `renderSummary_expand_button_fires_expandAsset` | clicking expand calls expandAsset with correct assetId |
| 18 | `renderSummary_delete_button_fires_confirmDelete` | clicking delete calls confirmDelete with correct assetId and title |
| 19 | `renderVariantRow_shows_label_via_textContent` | textContent set from variant.label |
| 20 | `renderVariantRow_uses_data_label_not_req_label` | rendered label === data.label when data.label ≠ req.label |
| 21 | `runOmr_shows_part_picker_on_success` | partPickerEl.hidden === false |
| 22 | `runOmr_renders_correct_checkbox_count` | two checkboxes for two-part response |
| 23 | `runOmr_checkbox_value_uses_part_index` | checkbox.value === String(part.index) |
| 24 | `runOmr_renders_part_name_via_textContent` | label textContent === part.name (not innerHTML) |
| 25 | `runOmr_shows_banner_on_503` | bannerEl.hidden === false |
| 26 | `runOmr_does_not_show_banner_on_422` | bannerEl.hidden stays true; statusEl text set |
| 25 | `extractMidi_sends_correct_part_indices` | fetch body `{ part_indices: [0, 2] }` |
| 26 | `extractMidi_updates_status_on_success` | statusEl.textContent includes '4 bars' |
| 27 | `extractMidi_unhides_synthesise_form_on_success` | synthesiseFormEl.hidden === false |
| 28 | `extractMidi_shows_banner_on_503` | bannerEl.hidden === false |
| 29 | `extractMidi_does_not_show_banner_on_422` | bannerEl.hidden stays true; statusEl text set |
| 30 | `rasterise_updates_status_on_success` | statusEl.textContent includes '3 pages' |
| 31 | `rasterise_shows_banner_on_503` | bannerEl.hidden === false |
| 32 | `rasterise_does_not_show_banner_on_422` | bannerEl.hidden stays true; statusEl text set |
| 33 | `synthesise_rejects_empty_label` | statusEl has error; fetch not called |
| 34 | `synthesise_rejects_tempo_below_25` | error; no fetch |
| 35 | `synthesise_accepts_tempo_25` | fetch called |
| 36 | `synthesise_rejects_tempo_above_300` | error; no fetch |
| 37 | `synthesise_accepts_tempo_300` | fetch called |
| 38 | `synthesise_rejects_transpose_below_minus12` | error; no fetch |
| 39 | `synthesise_accepts_transpose_minus12` | fetch called |
| 40 | `synthesise_rejects_transpose_above_12` | error; no fetch |
| 41 | `synthesise_accepts_transpose_12` | fetch called |
| 42 | `synthesise_prepends_variant_on_success` | variantListEl.children.length === 1 |
| 43 | `synthesise_uses_data_label_on_success` | rendered label === data.label (not req.label) |
| 44 | `synthesise_clears_form_fields_on_success` | label→'', tempo→'100', transpose→'0', repeats→false |
| 45 | `synthesise_shows_banner_on_503` | bannerEl.hidden === false |
| 46 | `synthesise_does_not_show_banner_on_422` | bannerEl.hidden stays true |
| 47 | `confirmDelete_cancel_no_fetch` | fetch not called; li not removed |
| 48 | `confirmDelete_confirm_fires_delete` | fetch called with DELETE; li._removed === true |
| 49 | `confirmDelete_does_not_show_banner_on_error` | bannerEl.hidden stays true; alertFn called; li._removed !== true |
| 50 | `confirmDeleteVariant_removes_li_on_204` | variantLi._removed === true |
| 51 | `confirmDeleteVariant_does_not_show_banner_on_error` | bannerEl.hidden stays true; alertFn called; variantLi._removed !== true |
| 52 | `loadAssets_calls_fetch_on_BASE` | fetch called with GET on BASE |
| 53 | `loadAssets_shows_empty_state_when_no_assets` | emptyEl.hidden === false |
| 54 | `loadAssets_hides_empty_state_when_assets_present` | emptyEl.hidden === true |
| 55 | `loadAssets_shows_error_on_fetch_failure` | errorEl.hidden === false; errorEl.textContent set |
| 56 | `expandAsset_toggles_detail_hidden` | detailEl.hidden === false; expandBtn aria-expanded === 'true' after first call |
| 57 | `expandAsset_collapses_on_second_click` | detailEl.hidden === true; aria-expanded === 'false' after second call |
| 58 | `expandAsset_fetches_asset_detail` | fetch called with GET on BASE/:id |
| 59 | `expandAsset_shows_omr_section_for_pdf_asset` | OMR section present; rasteriseBtn.disabled===true when has_midi=false |
| 60 | `expandAsset_hides_synthesise_form_when_no_midi` | synthesise form hidden when has_midi=false |
| 61 | `expandAsset_shows_synthesise_form_for_midi_only_asset` | synthesise form present and OMR section absent when has_pdf=false, has_midi=true |
| 62 | `expandAsset_shows_inline_error_on_422` | detailEl.textContent set; bannerEl.hidden stays true |
| 63 | `expandAsset_shows_inline_error_on_network_failure` | detailEl.textContent set when fetch rejects; bannerEl.hidden stays true |
| 64 | `renderVariantRow_resynthesize_button_calls_synthesise` | clicking Re-synthesise calls synthesiseFn with correct req |
| 65 | `show503Banner_unhides_element` | bannerEl.hidden === false |
| 66 | `show503Banner_idempotent` | calling twice leaves hidden === false (no toggle) |
| 67 | `hide503Banner_hides_element` | bannerEl.hidden === true |

---

## Test Strategy

### Property / invariant coverage

**`startUpload`:** raw file body (not FormData); `X-Title` header from title input;
title byte limit enforced at 255/256 and multibyte boundary; null file rejected;
whitespace-only title rejected; upload 503 never shows sidecar banner;
`loadAssets` called on success.

**`loadAssets`:** always called with explicit DOM refs (no closures); empty-state
toggled; error state shown on fetch failure.

**`renderSummary` / `renderVariantRow`:** all server-supplied strings via `.textContent`
(XSS invariant); expand and delete buttons fire correct callbacks with asset identity.

**`expandAsset`:** detail toggled on first call; collapsed on second call;
`aria-expanded` updated; no 503 banner (not a sidecar endpoint); network failure
and non-2xx both show inline error; rasterise button initially disabled when
`has_midi=false`; synthesise form hidden when `!has_midi`.

**`runOmr`:** flat `PartInfo[]` response; checkboxes use `part.index` as value
and `part.name` via textContent; 503 → banner; 422 → inline only.

**`extractMidi`:** `part_indices` sent correctly; synthesise form unhidden on
success; 503 → banner; 422 → inline only.

**`rasterise`:** 503 → banner; 422 → inline only.

**`synthesise`:** fencepost tests at 25, 300, −12, 12 (inclusive bounds accepted);
`data.label` used (not `req.label`); all four form fields reset on success;
503 → banner; 422 → inline only.

**`confirmDelete` / `confirmDeleteVariant`:** no fetch if `confirmFn` returns false;
`alertFn` called on error; row stays in DOM on error; no sidecar banner ever.

**Banner helpers:** `show503Banner` idempotent; `hide503Banner` works.

### Failure-path coverage
- Upload 422 → inline error; no banner.
- Upload 503 → inline error; no banner (not sidecar).
- OMR 503 → banner; OMR 422 → inline only.
- extractMidi 503 → banner; extractMidi 422 → inline only.
- rasterise 503 → banner; rasterise 422 → inline only.
- synthesise 503 → banner; synthesise 422 → inline only.
- expandAsset network failure → inline error; no banner.
- expandAsset 422 → inline error; no banner.
- confirmDelete 500 → alertFn called; li stays in DOM; no banner.
- confirmDeleteVariant 500 → alertFn called; li stays in DOM; no banner.

### Regression guards
- Sprint 12A F47 (SidecarBadInput is 422, not 503):
  `runOmr_does_not_show_banner_on_422`, `synthesise_does_not_show_banner_on_422`,
  `extractMidi_does_not_show_banner_on_422`, `rasterise_does_not_show_banner_on_422`.
- Sprint 12A F16 (title ≤ 255 bytes):
  `upload_accepts_255_byte_title`, `upload_rejects_256_byte_title`,
  `upload_rejects_multibyte_overflow`.
- XSS invariant (textContent, not innerHTML):
  `renderSummary_title_via_textContent`, `renderVariantRow_shows_label_via_textContent`,
  `runOmr_renders_part_name_via_textContent`.

### Fixture reuse plan
- `fetchStub(status, body)` — shared across all tests.
- `makeEl()` — shared DOM stub constructor.
- `makeBannerEl()` — `makeEl()` pre-set `hidden: true`; used wherever banner is asserted.
- Teardown: `afterEach` restores `globalThis.fetch`. `confirmFn` and `alertFn` are injected as params, so no global patching/restore needed for confirm or alert.
- No shared state between tests (no module-level mutable state leaks across
  test boundaries because each helper receives its deps explicitly).

### Test runtime budget
Target: under 2 s for all 68 tests. Flaky policy: no `setTimeout`, no real fetch.

---

## Implementation Order

1. `web/library.html` — static structure; all IDs the JS reads.
2. `web/assets/library.js` — UMD module with `init()` guard.
3. `web/assets/tests/library.test.js` — unit tests.
4. `server/src/http/library.rs` — `get_library_page` disk read + slug ownership.
5. `server/tests/http_library.rs` — add body assertion to `library_page_returns_html`;
   add `library_page_returns_403_for_wrong_slug` test.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| OMR takes 10–30 s | Button shows spinner text; no JS timeout |
| Media tokens expire during long session | Re-expand re-fetches `GET .../assets/:id` |
| Large WAV (≤ 50 MB) stalls browser | `#upload-progress` shown; server enforces 413 |
| `confirm()` absent in test runner | Tests stub `globalThis.confirm` |
| `init()` runs before DOM ready | Script tag at bottom of `<body>` (no DOMContentLoaded needed) |

---

## Known Debt

| Finding | Decision |
|---------|---------|
| Extract slug-ownership query into shared helper (raised R6 code_quality) | WONTFIX for this sprint — inline ownership query is 3 lines matching `teach.rs`; extraction into a shared function adds abstraction without immediate benefit. Revisit if a third caller appears. |

---

## Files Changed

| File | Change |
|------|--------|
| `web/library.html` | New |
| `web/assets/library.js` | New |
| `web/assets/tests/library.test.js` | New |
| `server/src/http/library.rs` | Modify `get_library_page` (add Path, slug check, disk read) |
| `server/tests/http_library.rs` | Add body assertion + 403-wrong-slug test |
