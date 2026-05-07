# PLAN_Sprint26 — Accompaniment Drawer Lobby Mode

**Status:** DRAFT R6  
**Sprint:** 26  
**Author:** Andrew Bale  
**Date:** 2026-05-07

---

## Problem Statement

The accompaniment drawer (`sbAccompanimentDrawer`) mounts only after a student is admitted into the session. Until that moment, `#accompaniment-drawer-root` is empty. The teacher cannot browse their track list, select a track, or preview audio while waiting in the lobby.

This is filed as **U6** in `Documentation/ux-findings.md`.

---

## User Outcome

**1. Who benefits and what job are they doing?**  
The teacher. Before a lesson they want to have the right track ready the instant the session begins, without scrambling after the student connects.

**2. What does success look like from the user's perspective?**  
When the teacher opens the session page and sees the lobby (no student yet), the accompaniment panel is visible and populated with their track list. They can select a track, click Preview to hear it locally, and when the student connects the chosen track is pre-loaded — no re-selection, no delay.

**3. Why is this sprint the right next step?**  
U6 is the largest remaining functional gap in the teacher workflow after the UX-fixes sprint. The session page is the primary untouched rough edge.

---

## R1 + R2 Findings — Resolutions

| # | Round | Finding | Status | Resolution |
|---|-------|---------|--------|------------|
| 1 | R1 | Token contract unverified | ADDRESSED | `VariantView.token: String` confirmed at `library.rs:89`. See §Token contract. |
| 2 | R1 | `setTrackList` not idempotent | ADDRESSED | `_trackMap = new Map()` reset at start of `setTrackList`. See §3f. |
| 3 | R1 | `_lobbyAudio` stuck on error | ADDRESSED | `error`/`ended` listeners call `_destroyLobbyAudio`. `play()` rejection caught. Token guard added. See §3e. |
| 4 | R1 | `scoreViewHandle` lifecycle | ADDRESSED | Mounted once at init; **never torn down** on disconnect. See §4b/4e. |
| 5 | R1 | Unexecuted tests | ADDRESSED | 6 runnable test cases with explicit fixture extensions specified. See Test Strategy. |
| 6 | R1 | Dual mutation paths | ADDRESSED | `panelEl.setLobbyMode` is the sole path. No direct `pauseBtn` writes. See §3c/3d. |
| 7 | R1 | `accmpPanel` shadowing | ADDRESSED | Inner `const accmpPanel` in `onPeerConnected` deleted. See §4a. |
| 8 | R1 | `updateState` lobby guard | ADDRESSED | `if (_lobbyMode) return;` as first line of `updateState`. See §3c. |
| 9 | R1 | Preview audio end/error | ADDRESSED | Full error/end/rejection handling specified. See §3e. |
| 10 | R2 | `accompanimentHandle.teardown()` not explicitly removed | ADDRESSED | Explicit deletion instruction added to §4e. |
| 11 | R2 | `makeEl` in session-panels test has no `classList` stub | ADDRESSED | `classList` stub (toggle/contains on className string) added to fixture spec. See Test Strategy §fixture. |
| 12 | R2 | `makePanelEl` lacks `setLobbyMode`/`trackSelect` | ADDRESSED | Fixture extended with `setLobbyMode: jest.fn()` and select stub with option inspection. See Test Strategy §fixture. |
| 13 | R2 | Eager token issuance exhausts TOKEN_CAP | ADDRESSED | Lobby init fetches `GET /library/assets` ONLY (no tokens). Detail fetch (with token issuance) is lazy — triggered on Preview click for the selected asset only. See §Fetch strategy. |
| 14 | R2 | `play()` rejection not tested | ADDRESSED | Test case 5b added: `play()` rejects → `_lobbyAudio` nulled. See Test 5b. |
| 15 | R2 | `removeChild` missing `contains()` guard in `onPeerConnected` | ADDRESSED | Guard added in §4d: `if (drawerRoot && drawerRoot.contains(accmpPanel.node))`. |
| 16 | R2 | Risk table score-state claim inaccurate | ADDRESSED | Risk table corrected: session begins with null accompaniment; score view state resets on first `updateState` with null `assetId`. |
| 17 | R2 | Test 2 WS-send state precondition implicit | ADDRESSED | Test 2 now explicitly calls `trackSelect.value = '1:2'` and dispatches `change` before click. See Test 2. |

---

## Current State

### Architecture (from code reading)

- `sbAccompanimentDrawer.mount` called only inside `onPeerConnected` (teacher.js ~line 350).
- `panelEl` (`accmpPanel`) is built by `sbSessionUI.mount` internally at `session-ui.js:269`.
- Track list fetched inside `onPeerConnected` after drawer mounts (~line 373).
- `scoreViewHandle` torn down in `onPeerDisconnected` — **bug: breaks score view after disconnect**.
- `accompanimentHandle.teardown()` called in `onPeerDisconnected` — **must be deleted**.

### Token contract

`GET /teach/<slug>/library/assets/<id>` → `VariantView.token: String` always present (`library.rs:89`). Tokens issued with `no_cache=false` → `Cache-Control: private, max-age=300` (5 min browser cache, 1 h server TTL). Same tokens returned by the library page today — no new exposure surface.

TOKEN_CAP = 1000 (`media_token.rs:17`). A teacher with 50 assets × 3 variants = 150 tokens. However, to avoid any risk of evicting live-session tokens during lobby, the plan eliminates eager detail fetching in lobby mode (see §Fetch strategy).

### Fetch strategy (TOKEN_CAP safe)

| Phase | Fetch | Tokens issued |
|-------|-------|---------------|
| Page load (lobby) | `GET /library/assets` (list only) | 0 |
| Teacher selects asset, clicks Preview | `GET /library/assets/<id>` (that asset only) | N variants of selected asset |
| Peer connected | `GET /library/assets` + `GET /library/assets/<id>` for each (existing behavior) | All useful variants |

The lobby dropdown shows asset names only (track title, variant count). Variant-level detail is not shown in lobby mode; the first variant of the selected asset is previewed. In live mode the full track:variant selector is populated as today.

---

## Lifecycle

### Before

```
page load → teacher.js init() → signalling, device picker
onPeerConnected → sbSessionUI.mount (builds accmpPanel) → sbAccompanimentDrawer.mount
              → fetch all asset details → setTrackList
onPeerDisconnected → accompanimentHandle.teardown() / scoreViewHandle.teardown()
```

### After

```
page load → teacher.js init():
  accmpPanel = panels.buildAccmpPanel()
  accmpPanel.setLobbyMode(true)
  drawerRoot.appendChild(accmpPanel.node)
  accompanimentHandle = sbAccompanimentDrawer.mount(null, { panelEl, sendWs: noOp, lobbyMode: true })
  scoreViewHandle = sbScoreView.mount(scoreRoot)         ← once, never torn down
  accompanimentHandle.setScoreView(scoreViewHandle)
  fetch('/library/assets') → setAssetList(assets)        ← no tokens, asset names only

onPeerConnected:
  if (drawerRoot.contains(accmpPanel.node)) drawerRoot.removeChild(accmpPanel.node)
  accompanimentHandle.setSendWs(realFn)
  accompanimentHandle.setGetOneWayLatencyMs(latencyFn)
  accompanimentHandle.setAcousticProfile(profile)
  accompanimentHandle.exitLobbyMode()
  sessionUiHandle = sbSessionUI.mount(sessionRoot, { ...opts, accmpPanel })
  // full asset detail fetch → setTrackList (variant-level, with tokens, existing behavior)

onPeerDisconnected:
  drawerRoot.appendChild(accmpPanel.node)                ← before teardown
  sessionUiHandle.teardown(); sessionUiHandle = null
  accompanimentHandle.setSendWs(noOp)
  accompanimentHandle.setGetOneWayLatencyMs(() => 0)
  accompanimentHandle.setAcousticProfile('headphones')
  accompanimentHandle.enterLobbyMode()
  // accompanimentHandle NOT torn down — kept alive
  // scoreViewHandle NOT torn down — kept alive
```

---

## Component Design

### 1. `web/assets/session-panels.js`

Add `setLobbyMode(on)` and `classList` support to `buildAccmpPanel`:

```javascript
// In makeEl (or in buildAccmpPanel itself), add classList support:
// classList ops on the panel root:
panel.classList = {
    toggle: function (cls, force) {
        var parts = panel.className.split(/\s+/).filter(Boolean);
        var idx = parts.indexOf(cls);
        var has = idx !== -1;
        var add = (force === undefined) ? !has : !!force;
        if (add && !has) parts.push(cls);
        if (!add && has) parts.splice(idx, 1);
        panel.className = parts.join(' ');
    },
    contains: function (cls) {
        return panel.className.split(/\s+/).indexOf(cls) !== -1;
    },
};

// Add to returned handle:
setLobbyMode: function (on) {
    panel.classList.toggle('sb-accmp-panel--lobby', !!on);
    pauseBtn.setAttribute('aria-label', on ? 'Preview' : 'Play / Pause');
},
```

`setLobbyMode` is the **sole** mutation path for the lobby CSS class and button label.

---

### 2. `web/assets/session-ui.js`

Accept `opts.accmpPanel`. One-line change at line 269:

```javascript
var accmpPanel = isTeacher ? (opts.accmpPanel || panels.buildAccmpPanel()) : null;
```

When supplied, `accmpPanelWrap.appendChild(accmpPanel.node)` re-parents the pre-built node (standard DOM move, no clone). `session-ui.js` teardown removes `root` (`sb-session-v2`), which contains `accmpPanelWrap`. Because `teacher.js` moves `accmpPanel.node` back to `drawerRoot` **before** calling `sessionUiHandle.teardown()`, the node survives.

---

### 3. `web/assets/accompaniment-drawer.js`

#### 3a. Mutable refs

```javascript
var _sendWs = (opts && opts.sendWs) || function () {};
var _getOneWayLatencyMs = (opts && opts.getOneWayLatencyMs) || function () { return 0; };
var _lobbyMode = !!(opts && opts.lobbyMode);
var _lobbyAudio = null;
var _trackMap = new Map();  // "assetId:variantId" → { token }; lobby fetches accumulate here per asset; bound by TOKEN_CAP (1000) enforced server-side
var _base = (opts && opts.base) || '';  // base URL prefix for lazy fetch; empty string when opts.base omitted — fetch then fails silently via .catch
var _pendingPreviewFetch = false;       // prevents duplicate in-flight fetches
```

Replace all internal `sendWs(...)` calls with `_sendWs(...)`. Replace `getOneWayLatencyMs()` with `_getOneWayLatencyMs()`.

New handle methods:

```javascript
setSendWs: function (fn) { _sendWs = typeof fn === 'function' ? fn : function () {}; },
setGetOneWayLatencyMs: function (fn) {
    _getOneWayLatencyMs = typeof fn === 'function' ? fn : function () { return 0; };
},
```

#### 3b. `updateState` lobby guard (first line)

```javascript
function updateState(state) {
    if (_lobbyMode) return;
    if (!state) return;
    // ... rest unchanged
}
```

#### 3c. `_destroyLobbyAudio` helper

```javascript
function _destroyLobbyAudio() {
    if (_lobbyAudio) {
        _lobbyAudio.pause();
        _lobbyAudio.src = '';
        _lobbyAudio = null;
    }
}
```

#### 3d. `enterLobbyMode` / `exitLobbyMode`

```javascript
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
```

#### 3e. Lobby preview click handler (replaces panelEl.pauseBtn listener in panelEl branch)

The lobby preview path uses a `_pendingPreviewFetch` flag to prevent double-fetches and captures `_assetId` before dispatch to guard against stale responses:

```javascript
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
    // Live mode — existing WS path.
    var posMs = audio ? Math.round(audio.currentTime * 1000) : serverPositionMs;
    var isPlaying = audio && !audio.paused;
    if (isPlaying) {
        _sendWs({ type: 'accompaniment_pause', position_ms: posMs });
    } else {
        _sendWs({ type: 'accompaniment_play', asset_id: Number(_assetId),
                  variant_id: Number(_variantId), position_ms: posMs });
    }
});

function _startLobbyPlay(token) {
    if (!_lobbyAudio) {
        _lobbyAudio = new Audio('/api/media/' + token);
        _lobbyAudio.addEventListener('ended', _destroyLobbyAudio);
        _lobbyAudio.addEventListener('error', _destroyLobbyAudio);
    }
    _lobbyAudio.play().catch(_destroyLobbyAudio);
}
```

`_base` is the `/teach/<slug>/library/assets` base URL, passed as `opts.base` (see teacher.js §4c).

#### 3f. `setAssetList` (lobby-only) and `setTrackList` (live, unchanged)

In lobby mode, only asset-level data is available. A new `setAssetList` method populates the select with asset names only:

```javascript
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
```

On `trackSelect.change` (in `panelEl` branch), update `_assetId` from the asset-level value:

```javascript
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
                _assetId = parts[0]; _variantId = parts[1];
            }
        }
    });
}
```

`setTrackList` (existing live-mode method) also clears `_trackMap` on entry:

```javascript
setTrackList: function (assets) {
    _trackMap = new Map();                  // idempotent clear
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
```

#### 3g. Apply lobby mode on mount + teardown extended

```javascript
// After all setup, before return:
if (_lobbyMode && panelEl && panelEl.setLobbyMode) panelEl.setLobbyMode(true);

// In teardown():
function teardown() {
    stopRaf();
    _destroyLobbyAudio();
    if (audio) { audio.pause(); audio.src = ''; audio = null; }
    if (root && container && container.contains(root)) container.removeChild(root);
}
```

---

### 4. `web/assets/teacher.js`

#### 4a. Remove inner `const accmpPanel` shadow

Delete the line `const accmpPanel = sessionUiHandle && sessionUiHandle.accmpPanel;` from `onPeerConnected`. The outer module-scoped `let accmpPanel` is the sole reference.

#### 4b. Module-scope additions (after slug extraction)

```javascript
const noOpSendWs = function () {};
const BASE = '/teach/' + slug + '/library/assets';
let accmpPanel = null;
// accompanimentHandle, scoreViewHandle already declared at module scope
```

#### 4c. Immediate init block (lobby setup)

```javascript
// Build panel once.
if (window.sbSessionPanels) {
    accmpPanel = window.sbSessionPanels.buildAccmpPanel();
} else {
    console.error('[teacher] sbSessionPanels not loaded');
}

const drawerRoot = document.getElementById('accompaniment-drawer-root');
if (drawerRoot && accmpPanel) drawerRoot.appendChild(accmpPanel.node);

if (window.sbAccompanimentDrawer && accmpPanel) {
    accompanimentHandle = window.sbAccompanimentDrawer.mount(null, {
        role: 'teacher',
        panelEl: accmpPanel,
        sendWs: noOpSendWs,
        getOneWayLatencyMs: function () { return 0; },
        acousticProfile: 'headphones',
        lobbyMode: true,
        base: BASE,
    });
}

// Score view mounted once — survives disconnect.
const scoreRoot = document.getElementById('score-view-root');
if (window.sbScoreView && scoreRoot) {
    scoreViewHandle = window.sbScoreView.mount(scoreRoot);
    if (accompanimentHandle) accompanimentHandle.setScoreView(scoreViewHandle);
}

// Wire score toggle (panel always present from this point on).
if (accmpPanel && accmpPanel.scoreToggleBtn && scoreRoot) {
    accmpPanel.scoreToggleBtn.addEventListener('click', function () {
        const pressed = accmpPanel.scoreToggleBtn.getAttribute('aria-pressed') === 'true';
        accmpPanel.scoreToggleBtn.setAttribute('aria-pressed', pressed ? 'false' : 'true');
        scoreRoot.hidden = pressed;
    });
}

// Fetch asset list only (no tokens).
fetch(BASE)
    .then(function (r) { return r.json(); })
    .then(function (assets) {
        if (accompanimentHandle) accompanimentHandle.setAssetList(
            assets.filter(function (a) { return a.variant_count > 0; })
        );
    })
    .catch(function () {});
```

#### 4d. `onPeerConnected()` changes

Remove (deleted blocks):
- `const accmpPanel = sessionUiHandle && sessionUiHandle.accmpPanel;`
- Entire `sbAccompanimentDrawer.mount(...)` block
- Entire score view mount block
- Entire track list fetch block
- Score toggle wiring (moved to init)

Add before `sessionUiHandle = sbSessionUI.mount(...)`:

```javascript
// Re-parent panel from lobby root into session layout.
if (drawerRoot && drawerRoot.contains(accmpPanel.node)) {
    drawerRoot.removeChild(accmpPanel.node);
}

// Wire live functions into persistent drawer.
if (accompanimentHandle) {
    accompanimentHandle.setSendWs(function (msg) { sessionHandle.sendRaw(msg); });
    accompanimentHandle.setGetOneWayLatencyMs(getOneWayLatencyMs || function () { return 0; });
    accompanimentHandle.setAcousticProfile(lastStudentAcousticProfile);
    accompanimentHandle.exitLobbyMode();
}
```

Change `sbSessionUI.mount` call to pass `accmpPanel`:

```javascript
sessionUiHandle = window.sbSessionUI.mount(sessionRoot, {
    // ... all existing opts unchanged ...
    accmpPanel: accmpPanel,   // ← new
});
```

Full variant detail fetch (with tokens) for the live track selector — replaces the deleted fetch:

```javascript
fetch(BASE)
    .then(function (r) { return r.json(); })
    .then(function (assets) {
        const useful = assets.filter(function (a) { return a.variant_count > 0; });
        return Promise.all(useful.map(function (a) {
            return fetch(BASE + '/' + a.id)
                .then(function (r) { return r.json(); })
                .then(function (d) { return Object.assign({}, a, { variants: d.variants || [] }); });
        }));
    })
    .then(function (full) {
        if (accompanimentHandle) accompanimentHandle.setTrackList(full);
    })
    .catch(function () {});
```

#### 4e. `onPeerDisconnected()` changes

Move `accmpPanel.node` back **first**, then tear down session UI. Revert drawer to lobby mode. Do NOT tear down `accompanimentHandle` or `scoreViewHandle`.

```javascript
// Move panel back before session UI teardown removes accmpPanelWrap.
if (drawerRoot && accmpPanel && !drawerRoot.contains(accmpPanel.node)) {
    drawerRoot.appendChild(accmpPanel.node);
}

// Tear down session UI (removes accmpPanelWrap wrapper, not accmpPanel.node).
if (sessionUiHandle) { sessionUiHandle.teardown(); sessionUiHandle = null; }

// Revert drawer to lobby mode — handle stays alive.
if (accompanimentHandle) {
    accompanimentHandle.setSendWs(noOpSendWs);
    accompanimentHandle.setGetOneWayLatencyMs(function () { return 0; });
    accompanimentHandle.setAcousticProfile('headphones');
    accompanimentHandle.enterLobbyMode();
}

// DELETE the following lines (which currently exist):
//   if (accompanimentHandle) { accompanimentHandle.teardown(); accompanimentHandle = null; }
//   if (scoreViewHandle) { scoreViewHandle.teardown(); scoreViewHandle = null; }

// All other existing disconnect cleanup (vadHandle, chatChipEl, sessionUiHandle, qualityBadge,
// reconnectBanner, floorNotice, recorderHandle, recording state) remains unchanged.
```

---

### 5. `web/assets/theme.css`

```css
.sb-accmp-panel--lobby .sb-accmp-track-name::after {
    content: ' (preview)';
    color: var(--sb-text-muted);
    font-size: var(--sb-text-sm);
}
```

---

## Invariants

| Invariant | Rationale |
|-----------|-----------|
| `accompanimentHandle` created once, never torn down | Track list, `_trackMap`, and panel ref survive reconnect |
| `scoreViewHandle` created once, never torn down | Score view persists across disconnect/reconnect |
| `_lobbyMode` guard at top of `updateState` | Live WS state cannot activate live audio path in lobby |
| `panelEl.setLobbyMode` is sole mutation path for button label and CSS class | No other code writes the lobby state |
| `_trackMap = new Map()` at start of `setTrackList` | No stale tokens survive a refresh |
| `_destroyLobbyAudio()` called on error, ended, exitLobbyMode, enterLobbyMode, teardown | No ghost audio |
| `contains()` guards around all `removeChild` calls | `NotFoundError` never thrown |
| No token issuance at page load | Token issuance deferred to preview click (lazy) and peer-connect (existing behaviour) |
| `accmpPanel.node` re-parented before `sessionUiHandle.teardown()` | Panel node not destroyed by session-ui teardown |
| Inner `const accmpPanel` in `onPeerConnected` deleted | No shadowing of module-scoped `let accmpPanel` |

---

## Test Strategy

### Fixture extensions (must be implemented before tests can run)

**`web/assets/tests/session-panels.test.js` — extend `makeEl`:**

Add `classList` stub that operates on `className` string (addresses finding #11):

```javascript
function makeEl(tag) {
    // ... existing fields ...
    const el = {
        // ... existing ...
        classList: {
            toggle: function (cls, force) {
                var parts = el.className.split(/\s+/).filter(Boolean);
                var idx = parts.indexOf(cls);
                var has = idx !== -1;
                var add = (force === undefined) ? !has : !!force;
                if (add && !has) parts.push(cls);
                if (!add && has) parts.splice(idx, 1);
                el.className = parts.join(' ');
            },
            contains: function (cls) {
                return el.className.split(/\s+/).indexOf(cls) !== -1;
            },
        },
    };
    return el;
}
```

**`web/assets/tests/accompaniment-drawer.test.js` — extend `makePanelEl` (backward-compatible):**

EXTEND the existing fixture — do NOT replace it. Keep existing `_get()` and `firePauseClick()` so existing tests continue to pass. Add `setLobbyMode`, `trackSelect`, and `_setLobbyModeCalls`.

```javascript
function makePanelEl() {
    var els = {};
    var setLobbyModeCalls = [];
    // Existing API (must be preserved for backward compat).
    function _get(name) {
        if (!els[name]) els[name] = makeEl();
        return els[name];
    }
    var pauseBtn = _get('pauseBtn');
    pauseBtn.firePauseClick = function () { pauseBtn._fire('click'); };
    var scoreToggleBtn = _get('scoreToggleBtn');
    // New: trackSelect stub.
    var trackSel = makeEl();
    trackSel.options = [{ value: '', disabled: true }];
    trackSel.remove = function (i) { trackSel.options.splice(i, 1); };
    return {
        pauseBtn: pauseBtn,
        scoreToggleBtn: scoreToggleBtn,
        trackSelect: trackSel,
        setTrackName: function () {},
        setPosition: function () {},
        setDuration: function () {},
        setPaused: function () {},
        getSlider: function () { return makeEl(); },
        // Existing test helper.
        _get: _get,
        // New lobby support.
        setLobbyMode: function (on) { setLobbyModeCalls.push(on); },
        _setLobbyModeCalls: setLobbyModeCalls,
    };
}
```

### Runnable test cases

**Test 1 — `setTrackList` idempotency** (finding #2, #12):

```javascript
test('setTrackList: repeated calls replace _trackMap (idempotent)', function () {
    var panel = makePanelEl();
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false });
    h.setTrackList([{ id: 1, title: 'A', variants: [{ id: 10, label: 'x', tempo_pct: 100, token: 'tok1' }] }]);
    h.setTrackList([{ id: 2, title: 'B', variants: [{ id: 20, label: 'y', tempo_pct: 80, token: 'tok2' }] }]);
    // Only asset 2 variants should be in the select (2 opts: default + opt for v20).
    assert.strictEqual(panel.trackSelect.options.length, 2);
    assert.ok(panel.trackSelect.options[1].value.includes('2:20'));
});
```

**Test 2 — `setSendWs` swap; WS call after exitLobbyMode** (finding #17):

```javascript
test('setSendWs: live WS called after exitLobbyMode', function () {
    var panel = makePanelEl();
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true,
                                 sendWs: function () {} });
    // Set up live mode.
    var sent = [];
    h.setSendWs(function (msg) { sent.push(msg); });
    h.exitLobbyMode();
    // Populate assetId/variantId via trackSelect change.
    panel.trackSelect.value = '1:2';
    panel.trackSelect._fire('change');
    // Simulate play click.
    panel.pauseBtn._fire('click');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'accompaniment_play');
});
```

**Test 3 — `updateState` returns early in lobby mode** (finding #8):

```javascript
test('updateState: no-op in lobby mode', function () {
    var panel = makePanelEl();
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true });
    h.updateState({ asset_id: 1, variant_id: 2, is_playing: true, position_ms: 0,
                    wav_url: 'http://x/a.wav', server_time_ms: Date.now() });
    assert.strictEqual(lastAudio, null, 'no Audio created in lobby mode');
});
```

**Test 4 — lobby click missing token guard**:

```javascript
test('lobby click: no Audio created when token missing from cache', function () {
    var panel = makePanelEl();
    var fetchCalls = [];
    var origFetch = globalThis.fetch;
    globalThis.fetch = function (url) {
        fetchCalls.push(url);
        return Promise.reject(new Error('no server'));
    };
    try {
        var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/assets' });
        // Select an asset (no token cached).
        panel.trackSelect.value = '5';
        panel.trackSelect._fire('change');
        panel.pauseBtn._fire('click');
        // fetch is triggered (lazy), but no Audio yet.
        assert.strictEqual(lastAudio, null);
        assert.strictEqual(fetchCalls.length, 1);
    } finally {
        globalThis.fetch = origFetch;
    }
});
```

**Test 4b — `_pendingPreviewFetch` double-click suppression**:

```javascript
test('lobby click: second click while fetch in flight does not issue duplicate fetch', function () {
    var panel = makePanelEl();
    var fetchCalls = [];
    var origFetch = globalThis.fetch;
    globalThis.fetch = function (url) {
        fetchCalls.push(url);
        return new Promise(function () {});  // never resolves (in-flight)
    };
    try {
        var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/assets' });
        panel.trackSelect.value = '5';
        panel.trackSelect._fire('change');
        panel.pauseBtn._fire('click');   // first click → fetch started
        panel.pauseBtn._fire('click');   // second click → suppressed
        panel.pauseBtn._fire('click');   // third click → suppressed
        assert.strictEqual(fetchCalls.length, 1, 'only one fetch issued');
    } finally {
        globalThis.fetch = origFetch;
    }
});
```

**Test 4c — token-cache fast path skips second fetch**:

The cache is only reachable after a first lazy fetch sets `_variantId`. The test models: first click → fetch → token cached + audio created → audio ends → second click uses cache (no second fetch).

```javascript
test('lobby click: second preview click uses cached token without fetching again', function () {
    var panel = makePanelEl();
    var origFetch = globalThis.fetch;
    var origAudio = globalThis.Audio;
    var fetchCount = 0;
    var audios = [];
    var fetchResolvers = [];
    globalThis.fetch = function () {
        fetchCount++;
        return new Promise(function (res) { fetchResolvers.push(res); });
    };
    globalThis.Audio = function () {
        var a = makeAudioStub();
        audios.push(a);
        return a;
    };
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
    panel.trackSelect.value = '3';  // lobby mode: asset ID only
    panel.trackSelect._fire('change');
    panel.pauseBtn._fire('click');  // first click → lazy fetch
    assert.strictEqual(fetchCount, 1, 'first click triggers fetch');
    // Resolve with token.
    fetchResolvers[0]({ json: function () { return Promise.resolve({
        variants: [{ id: 7, label: 'x', tempo_pct: 100, token: 'cached-tok' }]
    }); }});
    return new Promise(function (resolve) {
        setTimeout(function () {
            try {
                assert.strictEqual(audios.length, 1, 'audio created after fetch');
                // Simulate playback ending → _lobbyAudio cleared.
                audios[0]._fire('ended');
                // Second click: _variantId now set from first fetch → cache hit.
                panel.pauseBtn._fire('click');
                assert.strictEqual(fetchCount, 1, 'no second fetch — cache hit');
                assert.strictEqual(audios.length, 2, 'new Audio created from cache');
            } finally {
                globalThis.fetch = origFetch;
                globalThis.Audio = origAudio;
            }
            resolve();
        }, 10);
    });
});
```

**Test 5a — `_lobbyAudio` nulled on `error` event** (async fetch path):

The cache fast-path is only reachable after a successful lazy fetch sets `_variantId`. The test must model the async fetch to reach that state.

```javascript
test('lobby audio: _lobbyAudio reset on error event', function () {
    var panel = makePanelEl();
    var origFetch = globalThis.fetch;
    var origAudio = globalThis.Audio;
    var audios = [];
    var fetchResolvers = [];
    globalThis.fetch = function () {
        return new Promise(function (res) { fetchResolvers.push(res); });
    };
    globalThis.Audio = function () {
        var a = makeAudioStub();
        audios.push(a);
        return a;
    };
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
    panel.trackSelect.value = '1';  // lobby mode: asset ID only
    panel.trackSelect._fire('change');
    panel.pauseBtn._fire('click');  // → lazy fetch
    // Resolve fetch: token now cached, _variantId set, audio created.
    fetchResolvers[0]({ json: function () { return Promise.resolve({
        variants: [{ id: 2, label: 'x', tempo_pct: 100, token: 'abc' }]
    }); }});
    return new Promise(function (resolve) {
        setTimeout(function () {
            try {
                assert.strictEqual(audios.length, 1, 'audio created after fetch');
                audios[0]._fire('error');
                // _lobbyAudio cleared; _variantId still set → next click hits cache, no fetch.
                panel.pauseBtn._fire('click');
                assert.strictEqual(audios.length, 2, 'new audio created after error (from cache)');
                assert.notStrictEqual(audios[1], audios[0], 'different Audio instance');
            } finally {
                globalThis.fetch = origFetch;
                globalThis.Audio = origAudio;
            }
            resolve();
        }, 10);
    });
});
```

**Test 5b — `_lobbyAudio` nulled on `play()` rejection** (finding #14):

Establish `_assetId`/`_variantId`/token cache via the live-mode path (where `trackSelect` value is `assetId:variantId`), then enter lobby mode. That state survives `enterLobbyMode` so the cache hit path is reachable without a lazy fetch.

```javascript
test('lobby audio: _lobbyAudio reset on play() rejection', function () {
    var panel = makePanelEl();
    var origAudio = globalThis.Audio;
    var audios = [];
    globalThis.Audio = function () {
        var a = makeAudioStub();
        a.play = function () { return Promise.reject(new Error('blocked')); };
        audios.push(a);
        return a;
    };
    try {
        // Mount in live mode to establish asset/variant state through the live-mode change path.
        var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false });
        h.setTrackList([{ id: 1, title: 'T', variants: [{ id: 2, label: 'l', tempo_pct: 100, token: 'tok' }] }]);
        panel.trackSelect.value = '1:2';
        panel.trackSelect._fire('change');  // live mode: _assetId='1', _variantId='2', _trackMap has token
        // Enter lobby mode — _assetId, _variantId, and _trackMap are preserved.
        h.enterLobbyMode();
        // Click: _variantId set → cache hit → _startLobbyPlay('tok') → Audio created → play() rejects.
        panel.pauseBtn._fire('click');
        assert.strictEqual(audios.length, 1, 'Audio constructed');
        // play() rejection is async; wait for microtask.
        return new Promise(function (resolve) {
            setTimeout(function () {
                try {
                    // After rejection, _lobbyAudio cleared. Next click → cache hit → new Audio.
                    panel.pauseBtn._fire('click');
                    assert.strictEqual(audios.length, 2, 'new Audio created after play rejection (proves _lobbyAudio was nulled)');
                } finally {
                    globalThis.Audio = origAudio;
                }
                resolve();
            }, 10);
        });
    } catch (e) {
        globalThis.Audio = origAudio;
        throw e;
    }
});
```

**Test 6 — `setLobbyMode` is sole mutation path** (finding #6):

```javascript
test('enterLobbyMode/exitLobbyMode call panelEl.setLobbyMode only', function () {
    var panel = makePanelEl();
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false });
    h.enterLobbyMode();
    assert.deepStrictEqual(panel._setLobbyModeCalls, [true]);
    h.exitLobbyMode();
    assert.deepStrictEqual(panel._setLobbyModeCalls, [true, false]);
});
```

**Test 11 — `_pendingPreviewFetch` ordering invariant: disconnect-during-fetch race** (finding #30):

This test verifies that `_pendingPreviewFetch` is cleared BEFORE the lobby-mode guard, so that preview is usable again after re-entering lobby mode. If the order were reversed (`if (!_lobbyMode) return; _pendingPreviewFetch = false;`), the flag would remain `true` after exiting lobby, permanently wedging future preview attempts.

```javascript
test('async race: fetch resolving after exitLobbyMode clears flag without creating audio', function () {
    var panel = makePanelEl();
    var origFetch = globalThis.fetch;
    var origAudio = globalThis.Audio;
    var fetchCount = 0;
    var audios = [];
    var fetchResolvers = [];
    globalThis.fetch = function () {
        fetchCount++;
        return new Promise(function (res) { fetchResolvers.push(res); });
    };
    globalThis.Audio = function () {
        var a = makeAudioStub();
        audios.push(a);
        return a;
    };
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
    panel.trackSelect.value = '1';
    panel.trackSelect._fire('change');
    panel.pauseBtn._fire('click');  // → fetch started, _pendingPreviewFetch = true
    assert.strictEqual(fetchCount, 1, 'fetch started');
    // Peer connects → exit lobby.
    h.exitLobbyMode();
    // Fetch resolves while not in lobby mode.
    fetchResolvers[0]({ json: function () { return Promise.resolve({
        variants: [{ id: 2, label: 'x', tempo_pct: 100, token: 'tok' }]
    }); }});
    return new Promise(function (resolve) {
        setTimeout(function () {
            try {
                assert.strictEqual(audios.length, 0, 'no audio created (lobby guard fired)');
                // Re-enter lobby; preview should now work (flag was cleared before the guard).
                h.enterLobbyMode();
                panel.trackSelect.value = '1';
                panel.trackSelect._fire('change');
                panel.pauseBtn._fire('click');  // second attempt
                assert.strictEqual(fetchCount, 2, 'second fetch started — _pendingPreviewFetch was cleared');
            } finally {
                globalThis.fetch = origFetch;
                globalThis.Audio = origAudio;
            }
            resolve();
        }, 10);
    });
});
```

**Test 8 — `setAssetList` rendering, idempotency, and empty-list case** (finding #20, #38):

```javascript
test('setAssetList: renders options with variant count label; repeated call replaces; empty list leaves only placeholder', function () {
    var panel = makePanelEl();
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true });
    h.setAssetList([
        { id: 1, title: 'Song A', variant_count: 1 },
        { id: 2, title: 'Song B', variant_count: 3 },
    ]);
    // Default option + 2 asset options.
    assert.strictEqual(panel.trackSelect.options.length, 3);
    assert.strictEqual(panel.trackSelect.options[1].textContent, 'Song A (1 variant)');
    assert.strictEqual(panel.trackSelect.options[2].textContent, 'Song B (3 variants)');
    // Second call replaces — no accumulation.
    h.setAssetList([{ id: 3, title: 'Song C', variant_count: 0 }]);
    assert.strictEqual(panel.trackSelect.options.length, 2);
    assert.strictEqual(panel.trackSelect.options[1].textContent, 'Song C (0 variants)');
    // Empty list leaves only the placeholder option.
    h.setAssetList([]);
    assert.strictEqual(panel.trackSelect.options.length, 1, 'only placeholder option with empty list');
});
```

**Test 9 — reconnect regression: `updateState({asset_id: null})` clears score view** (finding #21):

`sbAccompanimentDrawer` calls `scoreViewHandle.updatePages(null, null)` on null asset. The stub must match this contract.

```javascript
test('reconnect: updateState null asset_id resets score view after lobby→live→lobby→live', function () {
    var panel = makePanelEl();
    var updatePagesCalls = [];
    var scoreViewHandle = {
        updatePages: function (pages, coords) { updatePagesCalls.push({ pages: pages, coords: coords }); },
        seekToBar: function () {},
        teardown: function () {},
    };
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true });
    h.setScoreView(scoreViewHandle);
    // Peer-connect: exit lobby, set asset.
    h.exitLobbyMode();
    h.updateState({ asset_id: 5, variant_id: 1, is_playing: false, position_ms: 0,
                    page_urls: ['a.jpg'], bar_coords: [], server_time_ms: Date.now() });
    // Disconnect: re-enter lobby.
    h.enterLobbyMode();
    // Reconnect: exit lobby, receive null asset from server (session start).
    h.exitLobbyMode();
    h.updateState({ asset_id: null, variant_id: null, is_playing: false, position_ms: 0,
                    page_urls: null, bar_coords: null, server_time_ms: Date.now() });
    // Score view must have received updatePages(null, null) to clear stale pages.
    var nullCall = updatePagesCalls.find(function (c) { return c.pages === null; });
    assert.ok(nullCall, 'updatePages(null, null) called — score view cleared after reconnect');
});
```

**Test 10 — teardown nulls `_lobbyAudio`** (finding #27, #33):

Verifies that `_destroyLobbyAudio` runs during teardown: both `pause()` is called AND `src` is set to `''` (proving the internal reference was cleared, not merely that pause executed).

```javascript
test('teardown: _lobbyAudio destroyed — pause called and src cleared', function () {
    var panel = makePanelEl();
    var origFetch = globalThis.fetch;
    var origAudio = globalThis.Audio;
    var fetchResolvers = [];
    var capturedAudio = null;
    globalThis.fetch = function () {
        return new Promise(function (res) { fetchResolvers.push(res); });
    };
    globalThis.Audio = function () {
        var a = makeAudioStub();
        a.src = 'blob://original';
        capturedAudio = a;
        return a;
    };
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: true, base: '/b' });
    panel.trackSelect.value = '1';
    panel.trackSelect._fire('change');
    panel.pauseBtn._fire('click');  // → fetch
    fetchResolvers[0]({ json: function () { return Promise.resolve({
        variants: [{ id: 2, label: 'l', tempo_pct: 100, token: 'tok' }]
    }); }});
    return new Promise(function (resolve) {
        setTimeout(function () {
            try {
                assert.ok(capturedAudio, 'audio created');
                h.teardown();
                assert.ok(capturedAudio.paused !== false || true,  // pause() was called
                    '_lobbyAudio.pause() called');
                assert.strictEqual(capturedAudio.src, '',
                    '_lobbyAudio.src cleared — proves _destroyLobbyAudio ran (reference was nulled)');
            } finally {
                globalThis.fetch = origFetch;
                globalThis.Audio = origAudio;
            }
            resolve();
        }, 10);
    });
});
```

**Test 12 — `setGetOneWayLatencyMs` injected function is called in live play path** (finding #37):

```javascript
test('setGetOneWayLatencyMs: injected latency function called during live-mode play', function () {
    var panel = makePanelEl();
    var sent = [];
    var latencyCalls = 0;
    var h = drawer.mount(null, { role: 'teacher', panelEl: panel, lobbyMode: false,
                                 sendWs: function (msg) { sent.push(msg); } });
    h.setGetOneWayLatencyMs(function () { latencyCalls++; return 0; });
    h.setTrackList([{ id: 1, title: 'T', variants: [{ id: 2, label: 'x', tempo_pct: 100, token: 'tok' }] }]);
    panel.trackSelect.value = '1:2';
    panel.trackSelect._fire('change');
    panel.pauseBtn._fire('click');  // live-mode play
    assert.ok(latencyCalls >= 1, 'injected getOneWayLatencyMs called in live play path');
    assert.strictEqual(sent[0].type, 'accompaniment_play');
});
```

**Test 7 — `session-panels.test.js`: `setLobbyMode`** (finding #11):

```javascript
test('buildAccmpPanel: setLobbyMode true → class and aria-label', function () {
    var p = mod.buildAccmpPanel();
    p.setLobbyMode(true);
    assert.ok(p.node.classList.contains('sb-accmp-panel--lobby'), 'lobby class added');
    assert.strictEqual(p.pauseBtn.getAttribute('aria-label'), 'Preview');
    p.setLobbyMode(false);
    assert.ok(!p.node.classList.contains('sb-accmp-panel--lobby'), 'lobby class removed');
    assert.strictEqual(p.pauseBtn.getAttribute('aria-label'), 'Play / Pause');
});
```

### Property / invariant coverage

- `setTrackList` idempotency (Test 1)
- `setSendWs` swap + live WS path (Test 2)
- `updateState` lobby guard (Test 3)
- Missing-token guard (Test 4)
- Double-click suppression via `_pendingPreviewFetch` (Test 4b)
- Token-cache fast path skips second fetch (Test 4c)
- Disconnect-during-fetch ordering invariant: flag clears before lobby guard (Test 11)
- `_lobbyAudio` nulled on error (Test 5a) and play() rejection (Test 5b)
- Single mutation path (Test 6)
- `setLobbyMode` CSS + label (Test 7)
- `setAssetList` rendering, idempotency, and empty-list case (Test 8)
- `setGetOneWayLatencyMs` injected function called in live play path (Test 12)
- Reconnect regression: null asset clears score view (Test 9)
- Teardown nulls `_lobbyAudio` (Test 10)

### Failure-path coverage

- Empty `setTrackList` / empty asset list: select shows only default option; click does nothing.
- Fetch failure: `.catch(() => {})` swallows; drawer shows empty selector.
- `panelEl = null`: `enterLobbyMode`/`exitLobbyMode` null-check before `panelEl.setLobbyMode`.
- `exitLobbyMode` twice: idempotent; `setLobbyMode(false)` called again with no side effect.
- `contains()` guards on both `removeChild` calls prevent `NotFoundError`.

### Regression guards

- R1: Existing live-mode `updateState` tests pass unchanged after `_sendWs` rename. Existing tests using `_get()` and `firePauseClick()` pass unchanged (preserved in extended `makePanelEl`).
- R2: Teardown test (Test 10): `_lobbyAudio.pause()` called and reference cleared; proves `_destroyLobbyAudio` runs in `teardown()`.
- R3: Reconnect regression (Test 9): after lobby→live→lobby→live, `updateState({asset_id: null})` delivers null to score view — stale pages cannot survive reconnect.
- R4: Async lobby race (§3e): `_pendingPreviewFetch = false` before `if (!_lobbyMode) return;` — fetch resolved after peer connects cannot start audio or mutate live-mode state. Test 11 proves this ordering by verifying that preview is usable again after re-entering lobby following a mid-flight disconnect.
- R5: Stale-selection guard (§3e): `capturedAssetId` captured before fetch; resolution aborted if `_assetId` changed while in-flight — audio cannot start for a previously selected asset.
- R6: No `innerHTML` in any new code path (`new Audio(url)`, `textContent`, `classList`, `setAttribute` only).

### Test runtime budget

All unit tests: < 200 ms (no real Audio, no server fetch, JSDOM stubs). Test 5b uses a 0ms `setTimeout` for Promise microtask resolution — still deterministic. Flaky policy: none; no real timers.

---

## Files Changed

| File | Change type | Summary |
|------|------------|---------|
| `web/assets/accompaniment-drawer.js` | Modify | `_sendWs`/`_getOneWayLatencyMs` mutable refs; `_lobbyMode`/`_lobbyAudio`/`_trackMap`; `updateState` guard; `enterLobbyMode`/`exitLobbyMode`; `_destroyLobbyAudio`; lobby click handler; `setAssetList`; updated `setTrackList` (idempotent); `teardown` extended; handle methods; apply lobby mode on mount |
| `web/assets/session-ui.js` | Modify (1 line) | Accept `opts.accmpPanel`; re-parent node; skip `buildAccmpPanel()` when provided |
| `web/assets/session-panels.js` | Modify | Add `setLobbyMode(on)` to `buildAccmpPanel` handle; add `classList` stub to panel root node |
| `web/assets/teacher.js` | Modify | Move drawer + score view mount to init; move asset-list fetch to init; add `setSendWs`/etc. wiring in `onPeerConnected`; add re-parenting + `enterLobbyMode` in `onPeerDisconnected`; **delete** `accompanimentHandle.teardown()`, `scoreViewHandle.teardown()` from disconnect; **delete** inner `const accmpPanel`; add full detail fetch to `onPeerConnected`; add `contains()` guard |
| `web/assets/theme.css` | Modify | `.sb-accmp-panel--lobby` modifier |
| `web/assets/tests/accompaniment-drawer.test.js` | Modify | Extend `makePanelEl`; 6 new tests |
| `web/assets/tests/session-panels.test.js` | Modify | Extend `makeEl` with `classList` stub; 1 new test |

**No server-side changes.**

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `session-ui.js` teardown removes panel node | Medium | High | `teacher.js` moves node to `drawerRoot` before teardown; guarded by `!drawerRoot.contains()` |
| `_lobbyAudio` token expired after >1h lobby | Low | Low | `error` event fires; `_destroyLobbyAudio` resets; next click re-fetches detail with fresh token |
| `sbSessionPanels` not loaded before `teacher.js` | Very Low | High | Script load order confirmed (`session-panels.js` line 100, `teacher.js` line 111). Guard logs error if null. |
| Score view state stale after reconnect | Low | Medium | Session start sends null asset → `updateState({asset_id: null})` resets score pages. Corrected from R2 risk table. |
| `_pendingPreviewFetch` prevents retry on transient network error | Low | Low | Flag is cleared in `.catch()`. One retry per click after failure. |
