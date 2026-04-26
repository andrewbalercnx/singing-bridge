# PLAN — Sprint 24: Synthesis modal + variant management

**Sprint goal:** After OMR succeeds, the teacher can create named synthesis variants via a modal dialog, giving them multiple backing tracks per PDF for use in lessons.

---

## Problem Statement

OMR (Sprint 23) now works end-to-end, but the synthesis step that follows is invisible. The "Extract MIDI" button disappeared after OMR completed (now fixed via a one-line bug fix), and even with the button visible the synthesis UI is an inline form embedded deep inside an expanded asset card — awkward to discover and easy to miss. Teachers cannot currently create backing tracks from their uploaded PDFs in a natural workflow.

Additionally, there is no "New variant" entry point for an asset that already has MIDI — once OMR + extraction has run once, creating a second variant at a different tempo requires knowing to re-expand the card and find the form.

---

## User Outcome

**1. Who benefits and what job are they doing?**
The teacher preparing a singing lesson. They have uploaded a PDF score, run OMR, and now want to create one or more backing tracks at specific tempos and/or transpositions to use while working with their student.

**2. What does success look like from the user's perspective?**
After OMR polling completes, a modal dialog opens automatically showing the detected voices (pre-checked), a name field, tempo, and transpose controls. The teacher fills in a name, adjusts tempo if needed, clicks "Create Backing Track", sees a brief spinner, and the modal closes. A new row labelled with their chosen name appears in the asset's variant list, immediately ready to select in a lesson. They can click "New variant" (shown for MIDI-backed assets) or "Re-synthesise" (on any existing variant row) to open the modal again at any time.

**3. Why is this sprint the right next step?**
OMR is now reliable and fast (Sprint 23) but produces no usable output from the teacher's perspective. Without synthesis, the library feature delivers no value in lessons. Sprint 24 closes the loop from "uploaded PDF" to "playable backing track".

---

## Current State (from codegraph)

| File | Relevant content |
|------|-----------------|
| `web/library.html` | 79-line shell; no `<dialog>` element; all DOM built in JS |
| `web/assets/library.js` | 1026 lines; inline `synthesise-form` section built inside `expandAsset()`; `runOmr` / `pollOmrJob` reveal inline form after OMR; `synthesise()` calls `POST /variants` |
| `server/src/http/library.rs` | `post_midi()` → `POST /:id/midi`; `post_variant()` → `POST /:id/variants`; both exist and are tested |
| `sidecar/app.py` | `POST /synthesise` accepts `midi` file + `tempo_pct` + `transpose_semitones` + `respect_repeats` |

No backend changes are required for the modal UX. Server-side bounds validation gaps are recorded as explicit deferred debt (see below).

---

## Proposed Solution

### Architecture

Replace the inline synthesise-form with a `<dialog>` element (native browser modal, accessible, focus-trapped). The modal is the single entry point for both creating a new variant and re-synthesising an existing one. All three call paths route through it:

1. **After OMR succeeds** — auto-opened by `pollOmrJob`, parts pre-populated, `hasMidi=false`.
2. **"New variant" button** (shown when `has_midi === true`) — opens with defaults, `hasMidi=true`.
3. **"Re-synthesise" on an existing variant row** — opens pre-filled with that variant's values, `hasMidi=true`.

```
[Create Backing Track clicked]
  │
  ├─ modal dataset: hasMidi === '1'?
  │   └─ NO  → extractMidi(assetId, checkedIndices, statusEl, onMidiSuccess, onMidiFailure, base, bannerEl)
  │              ├─ success → onMidiSuccess() → synthesise(assetId, req, statusEl, wrappedList, null, base, bannerEl)
  │              └─ failure → onMidiFailure() → statusEl.textContent = …; submitBtn.disabled = false
  │   └─ YES → synthesise(assetId, req, statusEl, wrappedList, null, base, bannerEl) directly
  │
  └─ wrappedList.prepend(row) → variantListEl.prepend(row) + dialog.close()
     synthesise() error → statusEl.textContent = …; submitBtn.disabled = false
```

### Module-scoped modal state

`openSynthModal` sets module-scoped variables read by the single submit handler registered once at init:

```
_modalAssetId       — current asset id
_modalHasMidi       — boolean
_modalParts         — string[] | null
_modalVariantListEl — the <ul> to prepend into
_modalResynFn       — function(variant): void (re-synthesise callback for new rows)
```

The submit handler is registered once (`dialog.addEventListener('submit', ...)` at module init), not on each open. No listener accumulation.

### Function signatures (changed)

#### `extractMidi(assetId, partIndices, statusEl, onSuccess, onFailure, base, bannerEl)`

- `onSuccess: () => void` — called when `POST /midi` returns 2xx.
- `onFailure: () => void` — called on any non-ok response OR network error; callers re-enable the submit button here.
- The `synthesiseFormEl` parameter is removed. No other callers remain after inline form removal.

#### `openSynthModal(assetId, parts, hasMidi, variantListEl, prefill)`

- `parts: string[] | null` — voice names for checkboxes. `null` means no voice selection required.
- `hasMidi: boolean` — if `true`, voice section is hidden; `POST /midi` is skipped.
- `variantListEl: HTMLElement` — the `<ul>` to prepend new variant rows into.
- `prefill: {label, tempo_pct, transpose_semitones} | null` — pre-fills form on open; `null` resets to defaults.
- **Guard**: if `!hasMidi && (!parts || parts.length === 0)` → show error "No voices detected — re-run OMR." and return without opening dialog.
- Sets module-scoped `_modal*` vars; calls `dialog.showModal()`.
- All server-supplied strings written via `.textContent` only — no `innerHTML`.

#### `synthesise(assetId, req, statusEl, variantListEl, formEl, base, bannerEl, resynFn?)`

- `resynFn: (variant) => void` — optional. Passed to `renderVariantRow` as the re-synthesise callback for the newly created row. If omitted, `renderVariantRow` defaults to calling `synthesise()` directly (retained for backward compatibility).
- The modal submit passes a modal-opening function as `resynFn` so that newly created rows also open the modal on re-synthesise.

#### `pollOmrJob(pollUrl, assetId, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl)` (add `variantListEl`)

- All recursive calls and the `runOmr` call site updated to thread `variantListEl`.
- On OMR success: call `rasterise(assetId, statusEl, base, bannerEl)` (preserved as-is), then call `openSynthModal(assetId, parts, false, variantListEl, null)`.

#### `runOmr(assetId, partPickerEl, omrBtn, statusEl, variantListEl, base, bannerEl)` (add `variantListEl`)

- Passes `variantListEl` to `pollOmrJob`.

### Success-close mechanism

The modal submit handler passes a `wrappedList` proxy to `synthesise()`:

```js
var resynFn = function (variant) {
  openSynthModal(assetId, null, true, _modalVariantListEl, {
    label: variant.label,
    tempo_pct: variant.tempo_pct,
    transpose_semitones: variant.transpose_semitones,
  });
};
var wrappedList = {
  prepend: function (el) {
    _modalVariantListEl.prepend(el);
    dialog.close();
    if (!_modalHasMidi) showNewVariantButton(assetId); // update card after first MIDI creation
  }
};
synthesise(assetId, req, statusEl, wrappedList, null, base, bannerEl, resynFn);
```

`synthesise()` calls `variantListEl.prepend()` on success; the proxy closes the dialog and, when this was the `hasMidi=false` path, shows the "New variant" button so the teacher can create a second variant without re-running OMR. This is one unambiguous close mechanism.

### `synthesise()` validation guards retained

`synthesise()` continues to validate `label`, `tempo_pct`, and `transpose_semitones` before firing fetch. The modal validates the same fields client-side first. The `synthesise()` guards are intentional defense-in-depth, not redundancy to remove.

### Re-synthesise from existing variant rows

`renderVariantRow` receives `synthesiseFn` as a callback. In `expandAsset`, the callback passed for all variant rows (both initial load and rows added by the modal) is:

```js
function (variant) {
  openSynthModal(assetId, null, true, variantListEl, {
    label: variant.label,
    tempo_pct: variant.tempo_pct,
    transpose_semitones: variant.transpose_semitones,
  });
}
```

This callback is also passed as `resynFn` to `synthesise()` so that newly prepended rows receive the same wiring. No variant row ever calls `synthesise()` directly — all re-synthesis routes through the modal.

### Voice checkbox → `part_indices` mapping

Parts are displayed in the modal voice list in the same order as the OMR response `parts` array. `part_indices` sent to `POST /midi` are the 0-based indices of checked checkboxes. If the user checks voices at positions 0 and 2, `part_indices = [0, 2]`.

### Client-state update after first MIDI creation

After the `hasMidi=false` synthesis path succeeds (modal closes), `showNewVariantButton(assetId)` unhides the "New variant" button on the expanded card. This function: finds the expanded card by `data-asset-id`, finds its `.new-variant-btn`, and removes `hidden`. No page reload required.

### Component changes

#### `web/library.html`
- Add `<dialog id="synth-modal">` with static skeleton (voice list `<ul>`, form fields, status `<p>`, buttons). All dynamic content filled by JS.

#### `web/assets/library.js`
- **Add** `openSynthModal(assetId, parts, hasMidi, variantListEl, prefill)` as described above.
- **Modify** `pollOmrJob` — add `variantListEl` param; add `openSynthModal` call after `rasterise()`; all recursive call sites updated.
- **Modify** `runOmr` — add `variantListEl` param; pass to `pollOmrJob`.
- **Modify** `expandAsset()` — pass `variantListEl` to `runOmr`; add "New variant" button (shown when `detail.has_midi === true`); replace re-synthesise callback in `renderVariantRow` calls with modal-opening callback; remove `synthesise-form` section; remove `partPickerEl` + "Extract MIDI" button.
- **Modify** `extractMidi` — replace `synthesiseFormEl` param with `onSuccess` + `onFailure` callbacks; call `onFailure()` on non-ok and on catch.
- **Update** `library.js` file header to reflect new exports and validation ownership.

#### `web/assets/styles.css` (or `theme.css`)
- Style `#synth-modal` as a centred sheet: `dialog::backdrop` overlay, padding, max-width ~420px.
- `.synth-modal__voices` section (hidden when `hasMidi=true`).
- Spinner/disabled state on submit button.

### `<dialog>` compatibility

Native `<dialog>` supported in all modern browsers (Chrome 37+, Firefox 98+, Safari 15.4+). No CDN polyfill (CDN scripts conflict with `script-src 'self'` CSP). Feature-detect at init: `if (typeof HTMLDialogElement === 'undefined')`, fall back to a `role="dialog" aria-modal="true"` `<div>` with `hidden` toggle and manual focus trap. No external JS dependency.

### Deferred debt (explicit, not silent)

| Item | Status | Reason |
|------|--------|--------|
| Server-side `tempo_pct` bounds check in `post_variant` | Deferred | UI-only sprint; accepted risk noted |
| Server-side `transpose_semitones` bounds check in `post_variant` | Deferred | Same |
| Server-side `part_indices` length check in `post_midi` | Deferred | Same |
| `respect_repeats` checkbox | Deferred | Sidecar accepts but does not act on the parameter in synthesis output; control will be added when sidecar implements the behaviour |

---

## Test Strategy

### Property / invariant coverage

**openSynthModal guards:**
- `openSynthModal(id, [], false, listEl, null)` → modal does NOT open; error shown.
- `openSynthModal(id, null, false, listEl, null)` → modal does NOT open; error shown. (null separate from empty array)
- `openSynthModal(id, null, true, listEl, null)` → modal opens; voice section hidden; form at defaults.
- `openSynthModal(id, ['Soprano'], false, listEl, null)` → modal opens; voice checkbox rendered; `hasMidi` dataset = ''.
- `openSynthModal(id, null, true, listEl, {label:'X', tempo_pct:80, transpose_semitones:-2})` → form pre-filled.

**Form state:**
- Modal form resets to defaults (tempo=100, transpose=0, label='') when `prefill=null`.
- Modal `dataset.hasMidi` correctly reflects argument.

**Client validation (no fetch on error):**
- Empty label → inline error; no fetch.
- tempo=24 → error; tempo=25 → ok.
- tempo=300 → ok; tempo=301 → error.
- transpose=-13 → error; -12 → ok.
- transpose=12 → ok; 13 → error.
- All voices unchecked (hasMidi=false) → error; no fetch.

**Success path:**
- `hasMidi=false`: POST /midi 200 then POST /variants 201 → `dialog.close()` called; variant row prepended.
- `hasMidi=true`: POST /variants 201 directly → `dialog.close()` called; variant row prepended.

**Cancel:**
- Cancel click → `dialog.close()` called; no fetch fired; `submitBtn.disabled === false`.

### Failure-path coverage

- POST /midi 503 → error shown; `submitBtn.disabled === false`; modal stays open.
- POST /midi non-ok (400) → error shown; `submitBtn.disabled === false`; modal stays open.
- POST /midi succeeds + POST /variants 503 → error shown; `submitBtn.disabled === false`; modal stays open.
- POST /midi succeeds + POST /variants non-ok → error shown; `submitBtn.disabled === false`.
- Network fetch throws → error shown; `submitBtn.disabled === false`.

### Fetch mock strategy

Tests use an ordered `fetchStub` array; each element is `{ok, status, data}`. Stub replaces `window.fetch`, shifts one response per call. Supports ordered multi-fetch tests:

```js
fetchStub = [
  { ok: true,  status: 200, data: { bar_count: 42 } },   // POST /midi
  { ok: false, status: 503, data: { message: 'down' } },  // POST /variants
];
window.fetch = () => {
  const r = fetchStub.shift();
  return Promise.resolve({
    ok: r.ok,
    status: r.status,
    json: () => Promise.resolve(r.data),
  });
};
```

### Regression guards

- `pollOmrJob` success path: `openSynthModal` called with parts array and `variantListEl` ref (new test).
- `synthesise()` callable from the `wrappedList` proxy path: row prepended AND `dialog.close()` called.
- Re-synthesise on loaded variant: `renderVariantRow` callback opens modal pre-filled with `{label, tempo_pct, transpose_semitones}`; voice section hidden.
- "New variant" button entry: `openSynthModal(assetId, null, true, variantListEl, null)` → modal opens with defaults, voice section hidden.
- Newly prepended row gets `synthesiseFn` that opens modal (not calls `synthesise()` directly): verified by checking the callback stored on the row.
- `hasMidi=false` success path: `showNewVariantButton` called (new variant button becomes visible).
- `loadAssets()` still populates asset list with variant counts (unchanged).
- Existing `library.test.js` unit tests for `synthesise()` validation remain green.
- `extractMidi` with `onSuccess` + `onFailure` callbacks: correct callback called in each case.

### Fixture reuse plan

Extend `library.test.js` with modal unit tests using existing `makeEl()` stubs. Add to `makeEl('dialog')`:
```js
dlg.showModal = function () { this.open = true; };
dlg.close = function () { this.open = false; };
```
`dialog.dataset` available via standard JSDOM. `extractMidi` unit tests updated for new callback signature. No new test infrastructure required.

### Test runtime budget

- Unit tests (`library.test.js`): < 1 s total (pure JS, no I/O).
- E2E (`library.spec.ts`) is a smoke test (library page loads); no synthesis E2E added this sprint.
- Flaky policy: all async is Promise-based and synchronously resolvable with stub; no `setTimeout` in unit tests.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `<dialog>` not natively supported on very old iOS Safari (< 15.4) | Feature-detect + inline fallback to `role=dialog` div; no CDN polyfill (CSP incompatible) |
| Re-enable button on partial failure missed for a code path | `onFailure` callback pattern makes re-enable explicit; failure-path tests cover all branches |
| Part indices stale if user re-runs OMR without refreshing modal | Modal populated fresh on each open from the latest OMR response |
| CSS `::backdrop` not themed | Add explicit backdrop colour in `theme.css` matching the existing overlay pattern |
| `synthesise()` called twice if modal submit clicked twice | Submit button disabled on first click; re-enabled only on failure |
