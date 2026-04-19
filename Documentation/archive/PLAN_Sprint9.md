# Plan: Sprint 9 — Lobby completion + Warm Room chat

## Problem Statement

Two experience gaps remain after Sprint 8:

1. **Lobby** — Students land in a waiting state with no self-check. `headphonesConfirmed` is hardcoded `false` in both `teacher.js` and `student.js`, so the session UI chip always shows "No headphones" regardless of what the user actually did. The design brief requires both parties confirm headphones before the lesson begins.

2. **Chat** — The Say button opens the plain Sprint 7 `#chat-panel` HTML element. It works but is entirely outside the Warm Room design system. Separately, the lobby-message banner (teacher → waiting student) also uses unstyled HTML.

This sprint completes both, adding a pre-session self-check flow and replacing all chat surfaces with Warm Room–styled components.

## Scope

- **Lobby self-check**: student and teacher both confirm headphones (and optionally test mic/camera) before the session starts. Headphones state flows through to the session UI chip.
- **In-session chat drawer**: Warm Room–styled slide-up drawer driven by the Say button. Wires to existing `sessionHandle.sendChat()` / `onChat` callbacks.
- **Lobby message toast**: Warm Room–styled toast replacing the plain `#lobby-message-banner`.
- **No new backend tables**: `headphones_confirmed` is session-ephemeral; a single `#[serde(default)]` field on `LobbyEntryView` is all that's needed.

## Current State

| File | Current role |
|---|---|
| `server/src/ws/protocol.rs` | `LobbyEntryView` lacks `headphones_confirmed`; `ClientMsg` has no `HeadphonesConfirmed` variant |
| `server/src/ws/lobby.rs` | `join_lobby` / `watch_lobby`; no headphones state tracking |
| `server/src/ws/mod.rs` | `handle_client_msg` dispatch; no headphones handler |
| `server/src/state.rs` | `LobbyEntry` struct; no headphones field |
| `web/assets/signalling.js` | `connectStudent` delivers `onLobbyUpdate`, `onChat`; no headphones callback |
| `web/assets/teacher.js` | Renders lobby entries; `headphonesConfirmed: false` hardcoded in `sbSessionUI.mount` |
| `web/assets/student.js` | `headphonesConfirmed: false` hardcoded in `sbSessionUI.mount`; shows plain lobby-wait section |
| `web/assets/session-ui.js` | `buildControls` has Say button calling `opts.onSay`; chat is caller-owned |
| `web/student.html` | `#lobby-status` section is plain HTML |
| `web/teacher.html` | Lobby entry rendering is plain HTML in `teacher.js` |

## Proposed Solution

### 1. Server: headphones state

**`server/src/state.rs`** — add `headphones_confirmed: bool` to `LobbyEntry` (default `false`).

**`server/src/ws/connection.rs`** — add `entry_id: Option<EntryId>` to `ConnContext`. Initialised to `None` on connection setup. This is the authoritative lookup key for the `HeadphonesConfirmed` handler; no lobby scan is needed.

**`server/src/ws/protocol.rs`** — two changes:
- `LobbyEntryView` gains `headphones_confirmed: bool` (serialised; `#[serde(default)]` for backwards compat)
- `ClientMsg` gains `HeadphonesConfirmed` (no payload) — the server resolves the entry from `ctx.entry_id`

**`server/src/ws/lobby.rs`** — `join_lobby` writes the newly generated `EntryId` back to `ctx.entry_id` immediately after inserting the `LobbyEntry`. This is the only place `entry_id` is set. A new `confirm_headphones(ctx, state)` function handles the mutation: it checks `ctx.role == Some(Role::Student)` and `ctx.entry_id.is_some()` before acquiring any lock; returns `EntryNotFound` if the entry is no longer in the lobby (already admitted or rejected); sets `headphones_confirmed = true` and re-broadcasts `LobbyState` to the teacher. This follows the existing pattern where lobby mutations live in `lobby.rs`, not `mod.rs`.

**`server/src/ws/mod.rs`** — adds a `HeadphonesConfirmed` branch in `handle_client_msg` that is thin dispatch only:
1. **Student-only guard** — if `ctx.role != Some(Role::Student)`, return an error (`NotInSession` or a new `RoleViolation` code) before acquiring any lock. This is checked before the call to `lobby::confirm_headphones`.
2. Delegates to `lobby::confirm_headphones(ctx, &state)`.

**No migration needed** — `headphones_confirmed` is in-memory only (lost on server restart, acceptable for a session-ephemeral signal).

### 2. Student pre-session self-check screen

After the student submits their join form and before the "waiting" state is shown, display a self-check overlay:

- Full-page or modal overlay, dark navy background
- Camera self-preview: `<video muted autoplay playsinline>` attached to `getUserMedia` stream (already acquired by `audio.js` + `video.js` in the join flow)
- Mic level indicator: small MeterBar (reuse `buildBaselineStrip` level rendering) driven by a local `AnalyserNode` on the audio track — same pattern as session-ui
- Headphones confirmation: toggle button "I'm wearing headphones" — must be activated before "I'm ready" is enabled
- On "I'm ready": hide overlay, show lobby-wait section, send `HeadphonesConfirmed` over the WS once the connection opens

**Implementation file**: `web/assets/self-check.js` — new module, exports `window.sbSelfCheck.show(stream, opts)` → `{ teardown }`. `opts`: `{ onConfirmed() }`.

**`web/student.html`**: add `<div id="self-check-root"></div>` before `#lobby-status`; add `<script src="/assets/self-check.js">`.

**`web/assets/student.js`**: after `getUserMedia` succeeds and WS opens, call `sbSelfCheck.show(stream, { onConfirmed })`. On `onConfirmed`: send `HeadphonesConfirmed`, hide self-check, show `#lobby-status`.

### 3. Teacher self-check overlay

Teacher's self-check is lighter — they don't need to be in a lobby, they just need headphones before the session. It appears once per browser session (gated by `sessionStorage`).

- Shown on page load of `/teach/<slug>` if `sessionStorage.getItem('sb-teacher-checked')` is falsy
- Same overlay as student: self-preview + mic level + headphones toggle
- On confirm: `sessionStorage.setItem('sb-teacher-checked', '1')`; overlay tears down
- Teacher does **not** send `HeadphonesConfirmed` to the server — teacher headphones state is display-only (shown to teacher themselves, not broadcast to students)
- `headphonesConfirmed` for the teacher's own session-ui mount remains `false` (teacher's chip shows their own state, not needed in MVP)

**Same `self-check.js`** module handles both teacher and student. Teacher call site skips the WS send.

### 3a. Teacher self-check sessionStorage semantics

The `sessionStorage.getItem('sb-teacher-checked')` gate is a **UX-only convenience**, not a trust boundary. Its intent is simply to avoid re-showing the overlay every time the teacher reloads — it carries no security weight. Persistence scope is intentional: the flag survives within one browser session (tab reloads, navigations) but is cleared when the browser closes or the tab is explicitly closed. If the teacher opens a new tab they will see the check again; this is acceptable and expected behaviour.

### 4. Warm Room chat drawer (in-session)

The chat drawer is extracted into its own module `web/assets/chat-drawer.js` to keep `session-ui.js` within the project module size limit. `session-ui.js` imports it and wires the Say button; callers interact only through the session-ui handle.

**New module**: `web/assets/chat-drawer.js` — standard file header block required. Exports `window.sbChatDrawer` (or consumed as a local dependency by `session-ui.js`). Exports `buildChatDrawer({ onSendChat })` → DOM node + `{ open(), close(), toggle(), appendMsg(from, text), hasUnread() }`.

**Script load order in HTML**: `chat-drawer.js` must load before `session-ui.js`.

**`session-ui.js` opts change:**
```js
// removed: onSay (stub)
// added:
onSendChat,   // (text: string) => void — called when user submits a message
onChatMsg,    // not in opts — caller registers via handle.appendChatMsg(from, text)
```

**Public handle gains**: `handle.appendChatMsg(from, text)` — caller invokes this when `onChat` fires from the signalling layer.

Drawer spec (from design brief):
- Slides up from the bottom: `position: absolute; bottom: 0; left: 0; right: 0; height: 140px` when open
- Background: `rgba(15,23,32,0.92); backdrop-filter: blur(8px); border-top: 1px solid rgba(251,246,239,0.12)`
- Header "Say": Fraunces italic 15px, `rgba(251,246,239,0.85)`
- Message list: scrollable, cream text; sent messages right-aligned, received left-aligned
- Input + send button styled with `theme.css` tokens
- CSS transition: `transform: translateY(0)` open, `translateY(100%)` closed; `transition: transform 0.2s ease-out`
- Unread dot: 6px rose (`#E17F8B`) circle on Say button badge when drawer is closed and a new message arrives; clears on open
- Empty-send prevention: send button and Enter key are no-ops when the input is blank or whitespace-only

**Say button in `buildControls`**: becomes a toggle that calls `opts.onSayToggle()`. `session-ui.js` wires this to `chatDrawer.toggle()`.

**`teacher.js` / `student.js`**: remove `onSay` and `#chat-panel` show/hide. Add `onSendChat` to mount opts; call `handle.appendChatMsg(from, text)` in `onChat` callback. The static `#chat-panel` element is removed from both HTML files.

### 5. Warm Room lobby message toast (student waiting)

Replace `#lobby-message-banner` with a Warm Room–styled toast rendered by a new small module.

**`web/assets/lobby-toast.js`** — new module, standard file header block required. Exports `window.sbLobbyToast.show(text, durationMs)`. Appends a toast element into the page body:
- Dark navy pill: `background: rgba(15,23,32,0.88); backdrop-filter: blur(6px); border-radius: 999px; padding: 10px 20px`
- Text in Fraunces italic 14px, cream colour
- Positioned fixed, bottom-centre of viewport
- Auto-dismisses after `durationMs` (default 8000) with a CSS opacity fade-out
- Multiple calls stack (each toast has its own timer); **maximum 3 simultaneous visible toasts** — if a 4th `show()` call arrives while 3 are visible, the oldest is immediately removed before the new one is appended

**`web/student.js`**: remove `#lobby-message-banner` manipulation; call `sbLobbyToast.show(text)` from `onLobbyMessage`.

**`web/student.html`**: remove `#lobby-message-banner` and `#lobby-message-text` elements; add `<script src="/assets/lobby-toast.js">`.

### HTML changes summary

**`web/teacher.html`**:
- Remove `#chat-panel` (chat now inside session-ui)
- Add `<script src="/assets/self-check.js">`
- Add `<script src="/assets/chat-drawer.js">` before `session-ui.js`

**`web/student.html`**:
- Add `<div id="self-check-root"></div>`
- Remove `#lobby-message-banner` + `#lobby-message-text`
- Remove `#chat-panel`
- Add `<script src="/assets/self-check.js">`, `<script src="/assets/lobby-toast.js">`, and `<script src="/assets/chat-drawer.js">` before `session-ui.js`

### CSS additions (`theme.css`)

- `.sb-self-check` overlay layout
- `.sb-chat-drawer` (slide-up animation, backdrop, message bubbles)
- `.sb-lobby-toast` (fixed pill, fade-out animation)
- `.sb-btn-badge` (unread dot on Say button)

### New file headers

All three new JS modules must carry the project's standard structured file header block (`File`, `Purpose`, `Role`, `Exports`, `Depends`, `Invariants`, `Last updated`):
- `web/assets/self-check.js`
- `web/assets/lobby-toast.js`
- `web/assets/chat-drawer.js`

## Test Strategy

### Property / invariant coverage
- `sbSelfCheck`: renders self-preview, mic level indicator, and disabled "I'm ready" button before headphones toggled; button enables after toggle
- `sbSelfCheck`: `onConfirmed` called exactly once when "I'm ready" clicked; not called before headphones toggled
- `sbSelfCheck` (teacher path): overlay skips display when `sessionStorage.getItem('sb-teacher-checked')` is set; confirm writes the flag exactly once; teacher call site does not invoke any WS send
- `sbSelfCheck`: teardown stops all media tracks on the stream and removes the overlay element from the DOM
- `buildChatDrawer`: initial state is closed (closed CSS class present, no open class)
- `buildChatDrawer`: `toggle()` alternates open/closed class; `appendMsg('teacher', 'hello')` adds a bubble with correct sender class; unread dot appears after `appendMsg` while drawer is closed; clears after `open()`
- `buildChatDrawer`: `appendMsg` text written via `.textContent` (XSS guard — same invariant as session-ui)
- `buildChatDrawer`: send is suppressed when input is empty or whitespace-only; `onSendChat` not called
- `sbLobbyToast.show(text)`: creates an element with text set via `.textContent`; element is appended to container; second call before first dismisses creates second element (stacked)
- `sbLobbyToast`: auto-dismisses after `durationMs` ms (fake clock); element is removed from DOM on dismiss
- `sbLobbyToast`: when 3 toasts are already visible, a 4th `show()` removes the oldest before appending the new one (cap enforcement)
- `HeadphonesConfirmed` protocol: server sets `headphones_confirmed = true` on the correct `LobbyEntry`; next `LobbyState` broadcast includes `headphones_confirmed: true` for that entry; exactly one broadcast emitted per confirmation
- `LobbyEntryView` serialisation: `headphones_confirmed` defaults to `false` when absent (backwards compat)
- HTML regression: `student.html` contains `<script src="/assets/self-check.js">`, `<script src="/assets/lobby-toast.js">`, `<script src="/assets/chat-drawer.js">`, and `<div id="self-check-root">`; `teacher.html` contains `<script src="/assets/self-check.js">` and `<script src="/assets/chat-drawer.js">`; both files load `chat-drawer.js` before `session-ui.js`

### Ordering and protocol invariants
- `LobbyJoin` is sent on WS open (inside `connectStudent`) before the self-check can emit `HeadphonesConfirmed`. The student self-check `onConfirmed` callback is only invoked after the WS connection is open; the `HeadphonesConfirmed` send is therefore always preceded by `LobbyJoin` in the same connection.

### Failure-path coverage
- `sbSelfCheck.show(null, ...)`: renders without error when stream is null (camera/mic permission denied); mic level indicator disabled
- `buildChatDrawer.appendMsg` with XSS payload: `<script>xssCheck()</script>` renders as literal text, does not execute
- `handle.appendChatMsg` called after `teardown()`: no-op, no error
- Teacher connection sends `HeadphonesConfirmed`: server rejects with role-violation error before acquiring any lock; student entry unchanged
- Student sends `HeadphonesConfirmed` before `LobbyJoin` (no `entry_id` on context): server returns `EntryNotFound`; client ignores gracefully
- `HeadphonesConfirmed` sent with no active lobby entry (e.g. already admitted): server returns `EntryNotFound`; client ignores gracefully
- `HeadphonesConfirmed` sent twice: idempotent; second broadcast omitted if state unchanged

### Regression guards (one per prior-round finding)
- **[Sprint 8 — session-ui XSS]**: chat drawer inherits the `.textContent`-only invariant; test asserts no `innerHTML` on user-supplied message text
- **[Sprint 7 — lobby banner]**: `#lobby-message-banner` is removed; regression test asserts the old element ID is no longer present in `student.html`
- **[Sprint 8 — headphonesConfirmed hardcoded]**: integration test asserts `headphonesConfirmed` in the session-ui mount opts reflects the actual confirmed state, not `false`
- **[Sprint 7 — chat panel in HTML]**: `#chat-panel` is removed from both HTML files; `http_teach_debug_marker.rs` updated accordingly; test asserts `#chat-panel` ID absent from both HTML files

### Fixture reuse plan
- `self-check.test.js`: new file; reuses DOM stubs from `session-ui.test.js`; `sessionStorage` stubbed as plain object
- `chat-drawer.test.js`: new file (was `session-ui.test.js` extension); reuses DOM stubs; `buildChatDrawer` exported directly
- `ws_headphones.rs`: new Rust integration test; reuses `spawn_app` + `TestOpts` from `common`
- `lobby-toast.test.js`: new file; minimal DOM stubs (just `document.createElement` + `body.appendChild`); fake clock for dismiss timing

### Test runtime budget
- New JS tests: ≤2s total
- `ws_headphones.rs`: ≤200ms (single WS round-trip, in-process)
- Flaky policy: no real timers; `setTimeout` mocked in toast tests via fake clock; RAF stubbed as before

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `getUserMedia` unavailable before `LobbyJoin` is sent | Self-check acquires media independently; on failure shows "camera/mic unavailable" with degraded state; headphones-only confirmation still possible |
| Teacher reloads page mid-session; `sessionStorage` cleared | Self-check re-appears; teacher re-confirms; no functional regression |
| Chat drawer clips on small viewports | Drawer height capped at 50% viewport height on mobile; `overflow-y: scroll` inside message list |
| `HeadphonesConfirmed` arrives after student is already admitted | Server checks entry is still in lobby before updating; returns `EntryNotFound` (not an error from client's perspective — already admitted means `headphonesConfirmed` is irrelevant) |
| Removing `#chat-panel` from HTML breaks old `onChat` wiring | All `onChat` wiring migrated to `handle.appendChatMsg` in `teacher.js`/`student.js` before HTML element removal; regression test asserts old element ID absent |
