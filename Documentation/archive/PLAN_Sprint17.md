# PLAN — Sprint 17: Teacher dashboard + session UI redesign

**Status:** DRAFT R3 — pending council review

---

## Problem Statement

The teacher UI has two problems:

1. **No hub.** Assets are scattered across three unlinked pages (`/teach/<slug>/session`, `.../recordings`, `.../library`). There is no central place to check on recent students, find a past recording, or queue up an accompaniment before starting a session.

2. **Session view doesn't use the screen well.** The current session UI is a vertical flex column inside a narrow container. The video tiles don't fill the screen. The self-view is a fixed 110×130px card in the controls row, not an overlay on the remote video. The accompaniment drawer floats outside the video area. On a laptop, the teacher spends time scrolling and hunting rather than teaching.

---

## User Outcome

**1. Who benefits and what job are they doing?**
The teacher. Between sessions: reviewing past recordings, choosing an accompaniment, checking who attended. In-session: coaching — they need to see the student clearly, be aware of their own presence, and cue backing tracks without looking away from the student.

**2. What does success look like from the user's perspective?**
Between sessions: the teacher lands on a single page and can reach any asset — a past recording, the library, their room — in one click, without knowing any URL paths.
In-session: the student fills the screen. The teacher sees themselves in a small corner overlay. The accompaniment panel slides in and out on demand without displacing the video. Controls are icon-only and immediately legible.

**3. Why is this sprint the right next step for the product?**
Persistence is now solved (Sprint 16). The core session works. The UI is the last major barrier to the teacher actually using the product in a real lesson.

---

## Current State

From codegraph + file review:

- `web/teacher.html` — single page with lobby section and session section; served at `GET /teach/<slug>` to authenticated teacher; unauthenticated visitors get `student.html`
- `server/src/http/teach.rs` — `get_teach()` resolves owner from cookie, switches between `teacher.html` and `student.html`; sets `Cache-Control: private, no-store` and `Vary: Cookie`
- `web/assets/teacher.js` — wires lobby (admit/reject/message), session (record, quality badge, send-recording modal), calls `sbSignalling.connectTeacher()`
- `web/assets/session-ui.js` — `sbSessionUI.mount()`: `sb-session` (column flex), `sb-session__stage` (remote panel, breath ring), `sb-baseline` (audio meters, elapsed time), `sb-bottom` (controls row + 110×130px self-preview card)
- `web/assets/session-panels.js` — pure DOM builders: `buildRemotePanel`, `buildControls` (mic/video/note/chat/end with text labels), `buildEndDialog`
- `web/assets/accompaniment-drawer.js` — `sbAccompanimentDrawer.mount()` appended to `#accompaniment-drawer-root`; floating drawer outside session shell
- `web/assets/theme.css` — `.sb-selfcard` fixed 110×130px; `.sb-session` position:absolute flex-column
- Routes: `GET /api/recordings` (JSON list), `GET /teach/:slug/library/assets` (JSON array of assets), `GET /teach/:slug/history` (HTML page); no `/teach/:slug/session` route exists

---

## Proposed Solution

### Part 1 — Teacher dashboard (`GET /teach/<slug>/dashboard`)

**ADR-0001 compliance:** The ADR requires the lobby to remain live in parallel with an active session — "the lobby updates live in parallel with the active media session." The dashboard does NOT replace the lobby. The dashboard is for **between-session** asset management only. The session page retains the full lobby and session UI unchanged in terms of lobby functionality.

**Routing model:**

| URL | Auth state | Response |
|-----|-----------|----------|
| `GET /teach/<slug>` | Authenticated owner | `302` → `/teach/<slug>/dashboard` |
| `GET /teach/<slug>` | Unauthenticated | `student.html` (no change) |
| `GET /teach/<slug>/dashboard` | Authenticated owner | `dashboard.html` |
| `GET /teach/<slug>/dashboard` | Not owner / unauthenticated | `302` → `/teach/<slug>` |
| `GET /teach/<slug>/session` | Authenticated owner | `teacher.html` (session + lobby) |
| `GET /teach/<slug>/session` | Not owner / unauthenticated | `302` → `/teach/<slug>` |

The "Enter Room" button on the dashboard navigates to `/teach/<slug>/session`. No query-param bypass. `/teach/<slug>` for the authenticated owner always redirects to the dashboard; the session is only reachable via the dedicated `/session` route.

**Cache headers:** All three owner-only responses (`/dashboard`, `/session`, redirect) must carry `Cache-Control: private, no-store` and `Vary: Cookie`, matching the pattern already established in `teach.rs`.

**Dashboard page structure (`dashboard.html`):**

```
┌────────────────────────────────────────────────────────────┐
│  singing-bridge   Your room: [slug]      [Enter Room →]    │  ← nav
├──────────────────┬─────────────────────────────────────────┤
│  SESSION HISTORY │  RECORDINGS                             │
│  (links to /hist)│  (last 10 via GET /api/recordings)      │
│                  │  [Send] [Delete] per row                 │
├──────────────────┴─────────────────────────────────────────┤
│  ACCOMPANIMENT LIBRARY                                     │
│  N assets  (via GET /teach/<slug>/library/assets)          │
│  [thumbnail × 4]   → full library link                    │
└────────────────────────────────────────────────────────────┘
```

**Data sources (all JSON, existing endpoints):**
- Recordings: `GET /api/recordings` — JSON array; dashboard renders last 10 rows (send/delete links)
- Library summary: `GET /teach/<slug>/library/assets` — JSON array; asset count = `array.length`; first 4 thumbnails shown via `/api/media/:token` URLs in the asset objects
- Session history: `GET /teach/<slug>/history` returns HTML; dashboard shows a link to the full history page rather than fetching inline (avoids parsing HTML)

All fetches use `fetch()` with `credentials: 'include'`. All student/asset-supplied strings rendered via `.textContent` (no `innerHTML` for user-supplied data).

**New files:**
- `web/dashboard.html`
- `web/assets/dashboard.js`
- `server/src/http/dashboard.rs`

**Modified files:**
- `server/src/http/teach.rs` — add `302` redirect for authenticated owner; add `GET /teach/:slug/session` handler (or share handler with flag)
- `server/src/http/mod.rs` — register `/teach/:slug/dashboard` and `/teach/:slug/session` routes
- `web/teacher.html` — update `<link>` to ensure JS loads for session page at new route (minimal change; lobby wiring unchanged)
- `web/assets/teacher.js` — update slug extraction from pathname (handles `/teach/<slug>/session`)

---

### Part 2 — Session UI layout

**ADR-0001 lobby preserved:** The lobby section in `teacher.html` and all its wiring in `teacher.js` is unchanged. The redesign affects only `#session-root` (the session panel that mounts when a student is admitted) and the surrounding visual layout.

**Target layout (laptop 1280×800, accompaniment panel open):**

```
┌────────────────────────────────────────────────────────────┐
│  LOBBY (unchanged — shown before/during session)           │
├───────────────────────────────────┬────────────────────────┤
│  OTHER VIEW (student)             │  ACCOMPANIMENT PANEL   │
│  ~66% width, full height          │  ~30% width            │
│                                   │  ─────────────────     │
│  ┌──────────────────┐             │  Track name            │
│  │  SELF VIEW (PiP) │  nameplate  │  ◀ ══════ slider ▶    │
│  │  bottom-left 20% │  hp chip    │  ⏸ Pause / Resume     │
│  └──────────────────┘             │  📄 Score viewer       │
├───────────────────────────────────┴────────────────────────┤
│  [🎤] [📷] [🎵]  [💬]                         [📞 End]   │
│  icon-only bar (teacher: all 4; student: mic, vid, end)    │
└────────────────────────────────────────────────────────────┘
```

When accompaniment panel is closed: other-view expands to full width.

**CSS additions in `theme.css`:**

```css
/* Session shell — three-zone grid */
.sb-session-v2 {
  position: absolute; inset: 0;
  display: grid;
  grid-template-rows: 1fr auto;          /* [video row] [control bar] */
  grid-template-columns: 1fr;
  background: var(--sb-ink); color: var(--sb-paper);
}
.sb-session-v2.sb-accmp-open {
  grid-template-columns: 1fr 300px;     /* [video] [accompaniment] */
}

/* Video zone — positions other-view + PiP */
.sb-video-zone {
  grid-row: 1; grid-column: 1;
  position: relative; background: #000;
  border-radius: var(--sb-r-lg); overflow: hidden;
  min-width: 0;
}

/* Self-view PiP */
.sb-selfpip {
  position: absolute; bottom: 16px; left: 16px;
  width: 20%; aspect-ratio: 4/3;
  border-radius: var(--sb-r-md); overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  border: 1px solid rgba(251,246,239,0.12);
  z-index: 4;
}
.sb-selfpip video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }

/* Accompaniment panel */
.sb-accmp-panel {
  grid-row: 1; grid-column: 2;
  display: flex; flex-direction: column; gap: var(--sb-space-3);
  padding: var(--sb-space-4);
  border-left: 1px solid rgba(251,246,239,0.08);
  overflow-y: auto; min-width: 0;
}

/* Icon-only control bar */
.sb-iconbar {
  grid-row: 2; grid-column: 1 / -1;
  display: flex; align-items: center; gap: var(--sb-space-2);
  padding: 10px var(--sb-space-4);
  background: rgba(15,23,32,0.85); backdrop-filter: blur(8px);
  border-top: 1px solid rgba(251,246,239,0.06);
}
.sb-iconbtn {
  width: 44px; height: 44px; border: none;
  border-radius: var(--sb-r-md);
  background: rgba(251,246,239,0.08); color: var(--sb-paper);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  flex-shrink: 0;
}
.sb-iconbtn[aria-pressed="true"] { background: rgba(251,246,239,0.18); }
.sb-iconbtn.sb-end { margin-left: auto; background: rgba(225,127,139,0.2); color: var(--sb-rose); }
```

**JS changes — keeping mount() ≤40 lines of own logic:**

All new DOM builders go in `session-panels.js` (the established home for panel builders). `session-ui.js::mount()` remains an orchestrator that calls into `session-panels.js`.

`session-panels.js` additions:
- `buildSelfPip(stream)` — builds `.sb-selfpip` with mirrored video
- `buildAccmpPanel(opts)` — builds `.sb-accmp-panel` with track-name `<p>`, `<input type="range">` seek slider, pause/resume `<button>`, score-viewer-toggle `<button>`; returns `{ node, setTrackName, setPosition, setDuration, setPaused }`
- `buildIconBar(opts)` — replaces `buildControls()`; renders icon-only `sb-iconbtn` buttons; `opts.isTeacher` gates accompaniment toggle button; SVG icon set gains `music` icon

**Shared `el()` helper:** Both `session-ui.js` and `session-panels.js` already define a local `el(tag, cls)` — these remain local (two lines each, no extraction needed). `dashboard.js` defines its own local `el()` for the same reason. No shared utility module introduced.

`session-ui.js::mount()` updated layout:
```js
function mount(container, opts) {
  var panels = _g.sbSessionPanels;
  var audioCtx = new AudioContext();
  // ... audio setup (unchanged) ...
  var remotePanel = panels.buildRemotePanel({...});
  var selfPip     = panels.buildSelfPip(opts.localStream);
  var accmpPanel  = opts.isTeacher ? panels.buildAccmpPanel({...}) : null;
  var iconBar     = panels.buildIconBar({...isTeacher: opts.isTeacher...});
  var baseline    = buildBaselineStrip();
  var mutedBanner = opts.localStream ? buildMutedBanner() : makeNullBanner();
  var endDialog   = panels.buildEndDialog(function () { opts.onEnd(); });

  var videoZone = el('div', 'sb-video-zone');
  videoZone.append(remotePanel.node, selfPip.node);
  var shell = el('div', 'sb-session-v2');
  shell.append(videoZone);
  if (accmpPanel) shell.append(accmpPanel.node);
  shell.append(iconBar.node, mutedBanner.node, endDialog);
  if (chatDrawer) shell.append(chatDrawer.node);
  container.appendChild(shell);

  return runSessionLifecycle(shell, {...}, opts);
}
```
`mount()` call site is ≤40 lines; all building is in named builders.

**Accompaniment toggle in `teacher.js`:**
```js
var accmpOpen = sessionStorage.getItem('sb-accmp-open') === '1';
iconBar.setAccmpOpen(accmpOpen);  // syncs aria-pressed + shell class

iconBar.onAccmpToggle = function () {
  accmpOpen = !accmpOpen;
  shell.classList.toggle('sb-accmp-open', accmpOpen);
  iconBar.setAccmpOpen(accmpOpen);
  sessionStorage.setItem('sb-accmp-open', accmpOpen ? '1' : '0');
};
```

**`accompaniment-drawer.js` — `panelEl` option:**
`mount(container, opts)` gains `opts.panelEl`. When provided, render controls into `panelEl` instead of building a floating drawer `<div>`. The audio element lifecycle (play/pause/seek/rAF loop, latency offset) is unchanged. Backward-compatible: `panelEl` absent → current drawer behaviour.

**Old `buildControls()` and `buildSelfPreview()` removal:** Both are removed from `session-ui.js` and `session-panels.js`. `buildSelfPreview` is superseded by `buildSelfPip` in `session-panels.js`. `buildControls` is superseded by `buildIconBar`. The `sb-btn-label` span pattern and associated helpers are deleted. Callers in `session-ui.js` updated. Existing `web/assets/tests/controls.test.js` updated to test `buildIconBar` instead.

**`dashboard.js` module pattern:** Plain IIFE self-contained script, same pattern as `library.js` and `recordings.js` — no ES module syntax, no `window.sbXxx` export (dashboard has no callers).

---

## Component-by-component design

### `server/src/auth/slug.rs` — reserved slug additions

Add `"session"` and `"dashboard"` to `RESERVED_SLUGS`. Both are now server-owned path segments under `/teach/:slug/...`; allowing a teacher to claim either as their room slug would produce an ambiguous URL collision. The existing `rejects_reserved` test exercises all reserved slugs automatically.

---

### `server/src/http/dashboard.rs`

```rust
pub async fn get_dashboard(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response> {
    let slug = validate(&slug).map_err(|_| AppError::NotFound)?;
    let teacher_exists = /* SELECT COUNT(*) FROM teachers WHERE slug = ? */ ...;
    if teacher_exists == 0 { return Err(AppError::NotFound); }
    let is_owner = resolve_teacher_from_cookie(...) matches the slug owner;
    if !is_owner {
        return Ok(Redirect::to(&format!("/teach/{}", slug)).into_response());
    }
    // serve dashboard.html with debug injection + cache headers
    let mut resp = Html(html).into_response();
    resp.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    resp.headers_mut().insert(VARY, HeaderValue::from_static("Cookie"));
    Ok(resp)
}
```

### `server/src/http/teach.rs` changes

`get_teach()` updated: after confirming `is_owner` **and** the request path is `/teach/<slug>` (not `/teach/<slug>/session`), issue `302` to `/teach/<slug>/dashboard`.

New handler `get_session()` reuses the same logic but serves `teacher.html` without redirect. Both handlers set `Cache-Control: private, no-store` + `Vary: Cookie`.

Alternatively (simpler): single handler parameterised by a boolean `is_session_route` derived from which route pattern matched. Implementation choice deferred to coding; either is acceptable.

### `server/src/http/mod.rs`

```rust
.route("/teach/:slug/dashboard", get(dashboard::get_dashboard))
.route("/teach/:slug/session",   get(teach::get_session))
// /teach/:slug → get_teach (now redirects owner to dashboard)
```

### `web/teacher.html`

Minimal change: update slug extraction note. The `<script src>` list unchanged. Script at the bottom gains a comment that the page is now served at `/teach/<slug>/session`.

### `web/assets/teacher.js`

Update slug extraction:
```js
// Handles both /teach/<slug> and /teach/<slug>/session
const slug = location.pathname.replace(/^\/teach\//, '').replace(/\/session$/, '');
```

Add accompaniment-toggle wiring (after session mounts) connecting `iconBar.onAccmpToggle` and restoring `sessionStorage` state.

---

## Test Strategy

### Property / invariant coverage

**Rust (`server/tests/http_dashboard.rs` — new file):**
- Authenticated owner `GET /teach/<slug>/dashboard` → 200 with `Cache-Control: private, no-store` and `Vary: Cookie`
- Non-owner authenticated `GET /teach/<slug>/dashboard` → 302 to `/teach/<slug>`
- Unauthenticated `GET /teach/<slug>/dashboard` → 302 to `/teach/<slug>`
- `GET /teach/<slug>` as authenticated owner → 302 with `Location: /teach/<slug>/dashboard`; response carries `Cache-Control: private, no-store` and `Vary: Cookie`
- `GET /teach/<slug>` as unauthenticated → 200 with student.html content (no regression)
- `GET /teach/<slug>/session` as authenticated owner → 200 with teacher.html content; `Cache-Control: private, no-store`
- `GET /teach/<slug>/session` as unauthenticated → 302 to `/teach/<slug>`
- Unknown slug `/teach/nosuchslug/dashboard` → 404

**Node (`web/assets/tests/session-panels.test.js` — new file):**
- `buildSelfPip(stream)` — returns node with class `sb-selfpip`; video element is muted and has `transform: scaleX(-1)` style
- `buildAccmpPanel({})` — node contains `<input type="range">` and `<button>` for pause/resume; setters: `setTrackName('X')` updates track name `<p>` textContent; `setPosition(500)` updates slider value; `setDuration(1000)` updates slider max; `setPaused(true)` updates button text/aria
- `buildIconBar({ isTeacher: true })` — renders 5 buttons (mic, vid, accompaniment, chat, end); each has `aria-label`; end button has class `sb-end`
- `buildIconBar({ isTeacher: false })` — renders 3 buttons (mic, vid, end); no accompaniment or chat button
- No `sb-btn-label` spans anywhere in `buildIconBar` output (regression against removed label pattern)

**Node (`web/assets/tests/dashboard.test.js` — new file):**
- Dashboard JS renders recording rows with `textContent` only (no `innerHTML` for user-supplied data — XSS guard)
- `GET /api/recordings` fetch failure → recordings panel contains an error message element; library panel still present in DOM (independent failure)
- `GET /teach/<slug>/library/assets` fetch failure → library panel contains an error message element; recordings panel still present in DOM

### Failure-path coverage

- `GET /api/recordings` fails → recordings panel shows inline error; library panel still renders
- `GET /teach/<slug>/library/assets` fails → library panel shows inline error; rest of dashboard still renders
- `panelEl` null in `accompaniment-drawer.js` → falls back to floating drawer (existing behaviour, verified by existing `accompaniment-drawer.test.js`)
- `panelEl` non-null in `accompaniment-drawer.js` → controls rendered into provided element; play/pause button click updates `audio.paused` state; seek slider update seeks `audio.currentTime` (new test case in `accompaniment-drawer.test.js`)
- Malformed slug in `get_dashboard` → 404 (validated by `validate()` call)

### Regression guards (one per prior-round finding)

- **R1/Sprint 14:** Teacher latency offset (`getOneWayLatencyMs`) applied in `accompaniment-drawer.js` audio scheduling — unaffected by `panelEl` addition (scheduling is in the audio loop, not the DOM path). Verified by `accompaniment-drawer.test.js` latency test (existing).
- **R2/Sprint 9:** Peer-supplied strings (student name, email, track names) reach no `innerHTML` in any new panel builder or dashboard renderer — asserted by XSS test in `session-panels.test.js` and `dashboard.test.js`.
- **R3/Sprint 16:** Unauthenticated `GET /teach/<slug>` still serves `student.html` — explicit test case in `http_dashboard.rs`.
- **R4/Sprint 11:** Dashboard history panel is a link to `/teach/<slug>/history`, not an inline fetch — no unbounded request risk; verified structurally.

### Fixture reuse plan

- `server/tests/common/` — reuse existing `spawn_app()`, `register_teacher()`, `login_teacher()` helpers in new `http_dashboard.rs`
- `web/assets/tests/controls.test.js` — renamed / updated to test `buildIconBar` in place of the removed `buildControls` with labels
- `web/assets/tests/session-panels.test.js` — extend with `buildSelfPip` and `buildAccmpPanel` cases using existing Node test runner pattern (`node --test`)

### Test runtime budget

`cargo test` (all Rust integration tests): currently ~30 s; new `http_dashboard.rs` adds ~3 s (8 HTTP tests). Node tests (`node --test web/assets/tests/*.test.js`): currently ~2 s; new tests add <1 s. Total budget: ≤40 s. Flaky policy: failure in CI that passes locally 3× → quarantine and file bug; do not skip.

---

## File paths and required header updates

| Action | File | Header change |
|--------|------|---------------|
| Create | `web/dashboard.html` | New header |
| Create | `web/assets/dashboard.js` | New header |
| Create | `server/src/http/dashboard.rs` | New header |
| Create | `server/tests/http_dashboard.rs` | New header |
| Create | `web/assets/tests/dashboard.test.js` | New header |
| Modify | `server/src/http/teach.rs` | Bump `Last updated`; update Purpose (redirect logic) |
| Modify | `server/src/http/mod.rs` | Bump `Last updated` |
| Modify | `web/teacher.html` | Bump `Last updated` |
| Modify | `web/assets/teacher.js` | Bump `Last updated`; update Purpose (session route slug extraction) |
| Modify | `web/assets/session-ui.js` | Bump `Last updated`; update Exports (v2 layout) |
| Modify | `web/assets/session-panels.js` | Bump `Last updated`; update Exports (buildSelfPip, buildAccmpPanel, buildIconBar; remove buildControls) |
| Modify | `web/assets/accompaniment-drawer.js` | Bump `Last updated`; update Purpose (panelEl option) |
| Modify | `web/assets/theme.css` | Bump `Last updated` |
| Modify | `web/assets/tests/controls.test.js` | Bump `Last updated`; update Purpose |
| Create | `web/assets/tests/session-panels.test.js` | New header |
| Modify | `web/assets/tests/accompaniment-drawer.test.js` | Bump `Last updated` (add panelEl positive-path test) |
| Modify | `server/src/auth/slug.rs` | Bump `Last updated`; add `"session"` and `"dashboard"` to `RESERVED_SLUGS` |
| Update | `knowledge/decisions/0001-mvp-architecture.md` | No change — lobby model preserved; no ADR amendment needed |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `buildControls` removal breaks `session-ui.js` callers | Only one call site in `session-ui.js`; renamed to `buildIconBar` at the same time; caught by `session-panels.test.js` |
| `accompaniment-drawer.js::mount()` is already long; `panelEl` branch adds more | The branch is a single `if (opts.panelEl)` at DOM construction time; audio lifecycle untouched; no function length increase in hot paths |
| `sb-accmp-open` sessionStorage key persists across page reloads but the session may have ended | Cleared in teardown via `sessionStorage.removeItem('sb-accmp-open')` |
| 300px accompaniment panel too narrow on 1280px | Panel uses `overflow-y: auto`; slider uses `width: 100%`; no fixed-width inner content |
| Library thumbnail fetch (`/api/media/:token`) may 404 if asset has no WAV yet | Dashboard shows placeholder for missing thumbnails; errors are per-card, not page-fatal |
