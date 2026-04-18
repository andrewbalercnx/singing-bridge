# PLAN Sprint 7: In-session chat + lobby messaging

## Problem statement

Teachers and students currently have no text channel during a lesson. A student who joins the lobby early has no way to receive a message ("be right with you") from the teacher before being admitted. Once in session there is no fallback if audio breaks down. Sprint 7 adds:

1. **Bidirectional in-session chat** between teacher and admitted student.
2. **One-way teacher → lobby chat** so the teacher can send a short message to a waiting student without admitting them.

The design deliberately excludes student → teacher lobby messaging (Option 1 per SPRINTS.md). Students cannot reply until admitted; this keeps the lobby state model simple.

## Spec references

- SPRINTS.md §Sprint 7
- `knowledge/architecture/signalling.md` — tagged-union protocol, single-writer pump, no `.await` under guard
- `knowledge/decisions/0001-mvp-architecture.md` — ephemeral in-memory session model

## Current state (from codegraph)

| File | Relevant exports |
|------|-----------------|
| `server/src/ws/protocol.rs` | `ClientMsg`, `ServerMsg`, `ErrorCode`, `EntryId`, `PumpDirective` |
| `server/src/ws/mod.rs` | `handle_*` dispatch, `RoomState`, `ActiveSession` |
| `server/src/state.rs` | `LobbyEntry { id: EntryId, conn: ClientHandle }`, `RoomState { lobby: Vec<LobbyEntry>, active_session: Option<ActiveSession> }`, `ClientHandle { id: ConnectionId, tx }` |
| `web/assets/teacher.js` | `renderEntry`, session callbacks |
| `web/assets/student.js` | `showConsentBanner`, session callbacks |
| `web/assets/signalling.js` | `sendRecordConsent` and similar send helpers |
| `web/assets/tests/signalling.test.js` | JS unit test pattern (`node:test`) |

`EntryId` is already defined in `protocol.rs` (line 49) and is included in `LobbyEntryView` which the teacher receives in every `LobbyState` message — so the teacher client already has the `entry_id` it needs to address a lobby message. No new state fields are required on `RoomState`.

`LobbyEntry.conn.tx` (`mpsc::Sender<PumpDirective>`) gives direct access to any waiting student's outbound pump. The teacher's own `ConnectionId` is available in the handler context as `sender.conn.id`.

## Proposed solution

All chat flows through the existing `/ws` connection (Alternative A). No new HTTP endpoints, no persistence. Fits the ephemeral session model.

## Component design

### 1. Protocol (`server/src/ws/protocol.rs`)

**New constants:**
```rust
pub const MAX_CHAT_CHARS: usize = 500;
pub const MAX_CHAT_BYTES: usize = 2000; // 500 chars × 4 bytes/char (worst case UTF-8)
```

Both limits are checked: byte count first (fast path, no UTF-8 decode), then char count. This matches the project's established dual-limit pattern (cf. `MAX_TIER_REASON_BYTES` / `MAX_TIER_REASON_CHARS`).

**New `ClientMsg` variants:**
```rust
Chat {
    text: String,
},
LobbyMessage {
    entry_id: EntryId,
    text: String,
},
```

**New `ServerMsg` variants:**
```rust
Chat {
    from: Role,  // Role::Teacher or Role::Student
    text: String,
},
LobbyMessage {
    text: String,
},
```

`from: Role` is sufficient for a two-party session. The UI maps it to display names: teacher sees "You" for `Role::Teacher`, "Student" for `Role::Student`; student sees "Teacher" for `Role::Teacher`, "You" for `Role::Student`. This mapping is fixed in JS and never derived from user input.

**No new `ErrorCode` variant.** `ErrorCode::NotInSession` covers the "chat sent with no active session" case. `ErrorCode::PayloadTooLarge` covers oversized text. Both are already defined.

Empty messages (zero chars after receiving, i.e. `text.is_empty()`) are rejected with `Error { PayloadTooLarge, "chat text must not be empty" }`.

### 2. Server handlers (`server/src/ws/mod.rs`)

**`handle_chat(sender, teacher_tx, rs, text)`**

The `teacher_tx` parameter matches the existing handler signature pattern (already threaded through as `Arc<mpsc::Sender<PumpDirective>>` for record handlers).

Sequence (all under write guard, no `.await`):
1. Validate byte length: `text.len() > MAX_CHAT_BYTES` → `Error { PayloadTooLarge }`.
2. Validate char length: `text.chars().count() > MAX_CHAT_CHARS` → `Error { PayloadTooLarge }`.
3. Validate not empty: `text.is_empty()` → `Error { PayloadTooLarge }`.
4. Verify active session: `rs.active_session.is_none()` → `Error { NotInSession }`.
5. **Authorise sender identity:**
   - If `sender.role == Role::Teacher`: assert `sender.conn.id` matches the room's teacher connection id (passed in from the WS handler context). A rogue teacher-role connection on a different room cannot chat.
   - If `sender.role == Role::Student`: assert `sender.conn.id == rs.active_session.as_ref().unwrap().student.conn.id`. A stale or spoofed student connection cannot chat.
6. Clone both txs (target + self) under the guard. Drop the guard.
7. Send `ServerMsg::Chat { from: sender.role, text: text.clone() }` to **both** parties (sender receives their own echo so both UIs share one append path and stay in sync on delivery failures).

**`handle_lobby_message(sender, teacher_conn_id, rs, entry_id, text)`**

`teacher_conn_id: ConnectionId` is the `ConnectionId` of the WS connection that opened the teacher watch, threaded in from the handler context.

Sequence:
1. Validate byte + char length (same as above).
2. Validate not empty.
3. Authorise: `sender.conn.id != teacher_conn_id` → `Error { NotOwner }`. Role alone is not sufficient; the sender must be the specific teacher connection for this room.
4. Look up entry: `rs.lobby.iter().find(|e| e.id == entry_id)` — None → `Error { EntryNotFound }`. If the student was admitted or rejected between the teacher typing and sending, this returns `EntryNotFound`; the teacher UI handles this as a transient "student no longer in lobby" notice.
5. Clone the entry's `tx` under the guard. Drop the guard.
6. Send `ServerMsg::LobbyMessage { text }` to the entry's tx.
7. Nothing sent back to the teacher (one-way). The teacher UI shows an optimistic "Sent" state immediately on form submit, clearing on `EntryNotFound` error response.

Dispatch additions in the main message match:
```rust
ClientMsg::Chat { text } => handle_chat(&sender, &teacher_tx, &mut rs, text),
ClientMsg::LobbyMessage { entry_id, text } => handle_lobby_message(&sender, teacher_conn_id, &mut rs, entry_id, text),
```

### 3. Teacher UI (`web/teacher.html`, `web/assets/teacher.js`)

**Chat panel** (in-session, `teacher.html`):
```html
<div id="chat-panel" hidden aria-label="Chat">
  <ul id="chat-log" aria-live="polite"></ul>
  <form id="chat-form">
    <input id="chat-input" type="text" maxlength="500" placeholder="Message…" autocomplete="off">
    <button type="submit">Send</button>
  </form>
</div>
```
Shown on `PeerConnected`, hidden on `PeerDisconnected`.

`onChat({ from, text })` in `teacher.js`:
```js
function appendChat(from, text) {
  var li = document.createElement('li');
  li.className = 'chat-msg from-' + from; // fixed class, no user input in className
  var label = document.createElement('span');
  label.className = 'chat-label';
  label.textContent = from === 'teacher' ? 'You' : 'Student'; // textContent only
  var body = document.createElement('span');
  body.className = 'chat-body';
  body.textContent = text; // textContent only — no innerHTML anywhere
  li.appendChild(label);
  li.appendChild(body);
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}
```

**Lobby message inline action** (added to `renderEntry` in `teacher.js`):
```html
<form class="lobby-msg-form">
  <input type="text" maxlength="500" placeholder="Send a message…" autocomplete="off">
  <button type="submit">Send</button>
  <span class="lobby-msg-status" hidden></span>
</form>
```
On submit: `sessionHandle.sendLobbyMessage(entry_id, text)`. On success: clear input, show "Sent ✓" for 2 s. On `EntryNotFound` response: show "Student left the lobby".

**`sendChat(text)` and `sendLobbyMessage(entry_id, text)`** added to `signalling.js` alongside the existing `sendRecordConsent` pattern:
```js
sendChat: function (text) {
  ws.send(JSON.stringify({ type: 'chat', text: text }));
},
sendLobbyMessage: function (entry_id, text) {
  ws.send(JSON.stringify({ type: 'lobby_message', entry_id: entry_id, text: text }));
},
```

### 4. Student UI (`web/student.html`, `web/assets/student.js`)

**Lobby banner** (in lobby waiting state):
```html
<div id="lobby-message-banner" hidden role="status" aria-live="polite">
  <span id="lobby-message-text"></span>
</div>
```
`onLobbyMessage({ text })`:
```js
lobbyMessageText.textContent = text; // textContent only
lobbyMessageBanner.hidden = false;
if (lobbyMsgTimer) clearTimeout(lobbyMsgTimer);
lobbyMsgTimer = setTimeout(function () { lobbyMessageBanner.hidden = true; }, 8000);
```

**Chat panel** (in-session, identical structure to teacher). Shown on `PeerConnected`, hidden on `PeerDisconnected`. Same `appendChat` logic with swapped label: `from === 'teacher' ? 'Teacher' : 'You'`.

### 5. No database changes

All chat is ephemeral. No new tables, no migrations.

## XSS safety invariant

All user-supplied text is rendered exclusively via `.textContent`. No `innerHTML`, no `insertAdjacentHTML`, no dynamic class names derived from message content anywhere in chat or lobby message rendering.

## Test strategy

### Property / invariant coverage
- `handle_chat`: teacher sends → both teacher and student receive `Chat { from: teacher, text }`.
- `handle_chat`: student sends → both receive `Chat { from: student, text }`.
- `handle_chat`: 500-char message accepted; 501-char rejected with `PayloadTooLarge`.
- `handle_chat`: 500 × "🎵" (4 bytes each = 2000 bytes) accepted; 501 × "🎵" rejected.
- `handle_chat`: empty string rejected with `PayloadTooLarge`.
- `handle_lobby_message`: delivers `LobbyMessage { text }` to the correct lobby entry's connection.
- `handle_lobby_message`: unknown `entry_id` → `EntryNotFound`.
- `handle_lobby_message`: does not send anything back to the teacher connection.

### Failure-path coverage
- `Chat` with no active session → `NotInSession`.
- `Chat` from a connection whose `conn.id` does not match the session's teacher or student → `NotInSession` (treated as unauthorised; no session membership).
- Student sends `LobbyMessage` (role = student) → `NotOwner`.
- Rogue teacher-role connection (different `conn_id`) sends `LobbyMessage` → `NotOwner`.
- `Chat` or `LobbyMessage` text > 500 chars → `PayloadTooLarge`.
- `Chat` or `LobbyMessage` text > 2000 bytes → `PayloadTooLarge`.
- `LobbyMessage` to student who was admitted between send and delivery → `EntryNotFound`.

### Regression guards (verified test names)
- `ws_session_handshake::full_sdp_exchange_over_signalling` — chat is additive, existing handshake must be unaffected.
- `ws_session_handshake::student_disconnect_clears_session` — disconnect behaviour unchanged.
- `protocol::client_msg_roundtrips` — extended to include `Chat` and `LobbyMessage` variants.
- `protocol::server_msg_roundtrips` — extended to include `Chat` and `LobbyMessage` variants.

### JS unit tests (`web/assets/tests/chat.test.js`)
Following the `node:test` pattern in `signalling.test.js`:
- `sendChat` serialises to `{ type: "chat", text }`.
- `sendLobbyMessage` serialises to `{ type: "lobby_message", entry_id, text }`.
- `appendChat` with `from="teacher"` renders label `"Teacher"` / `"You"` correctly for student/teacher POV.
- `appendChat` with `from="student"` renders label correctly.
- `appendChat` uses `textContent` not `innerHTML` (verified by checking `innerHTML` is never called in the helper under test).
- `onLobbyMessage` sets `textContent` and shows the banner.

### Fixture reuse plan
- Rust integration tests reuse `TestOpts` / app-builder from `ws_session_handshake.rs`.
- A `make_teacher_and_student_in_session` helper (new, extracted from the handshake test) is the base fixture for all chat tests.
- Lobby-message tests reuse the existing `LobbyJoin` / `LobbyWatch` message pattern.

### Test runtime budget
All new Rust tests are in-process (no real network). All JS tests run under `node --test`. Target < 150 ms total. No async sleeps — assertions are direct channel reads.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Lobby entry removed (admitted/rejected) between lookup and send | Lock is held across lookup and `tx.clone()`; `EntryNotFound` returned atomically if missing |
| Teacher identity spoofing via `role: Teacher` WS header | `handle_lobby_message` checks `sender.conn.id == teacher_conn_id`, not just role |
| XSS via chat text | All rendering via `.textContent`; no `innerHTML` anywhere in chat path |
| Chat log growing without bound in a long session | Client-side DOM only; no server memory impact; acceptable for MVP |
