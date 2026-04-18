# Findings Tracker: Sprint 7 (plan)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R1 | High | domain | plan-states-student-before | The plan states a student-before-admission signalling problem but only designs teacher-to-student lobby messaging. Th... | OPEN |  | R1,R2 |
| 2 | R1 | High | domain | lobby-messaging-design-uses | The lobby messaging design uses an undefined `EntryId`, assumes `LobbyEntry.id`, and does not expose any entry identi... | OPEN |  | R1,R2 |
| 3 | R1 | High | security | handle-chat-must-authorize | `handle_chat` must authorize by current connection identity and active-session membership, not only by role or `activ... | OPEN |  | R1,R2 |
| 4 | R1 | High | security | handle-lobby-message-must | `handle_lobby_message` must verify that the sender is the current `teacher_conn`, not only a connection with `Role::T... | OPEN |  | R1,R2 |
| 5 | R1 | High | test_quality | test-strategy-omits-required | The test strategy omits required regression coverage for the new DOM elements and does not verify `ServerMsg::Chat.fr... | OPEN |  | R1,R2 |
| 6 | R1 | Medium | code_quality | plan-proposes-new-chatnotinsessi | The plan proposes a new `ChatNotInSession` error even though `ErrorCode::NotInSession` already exists for the same co... | OPEN |  | R1,R2 |
| 7 | R1 | Medium | code_quality | chat-length-validation-does | Chat length validation does not follow the project’s established dual-limit pattern. The plan needs `MAX_CHAT_BYTES` ... | OPEN |  | R1,R2 |
| 8 | R1 | Medium | domain | admission-race-lobby-messaging | The admission race for lobby messaging is not fully specified in the teacher UX. If a student is admitted before the ... | OPEN |  | R1,R2 |
| 9 | R1 | Medium | test_quality | plan-does-not-specify | The plan does not specify whether empty chat messages are valid. The handler design currently accepts them, and the t... | OPEN |  | R1,R2 |
| 10 | R1 | Medium | test_quality | test-plan-references-unverified | The test plan references unverified regression guards and a new helper despite existing uncertainty about actual test... | OPEN |  | R1,R2 |
| 11 | R1 | Medium | test_quality | new-client-api-functions | New client API functions `sendChat` and `sendLobbyMessage` are not covered in JS unit tests even though similar signa... | OPEN |  | R1,R2 |
| 12 | R1 | Low | domain | chat-from | The `Chat { from: Role }` field is workable for a two-party chat, but the UI mapping of role-to-self is not documente... | OPEN |  | R1,R2 |
| 13 | R1 | Low | code_quality | handle-chat-pseudocode-says | The `handle_chat` pseudocode says it resolves the other party’s tx and sends to both parties without explicitly stati... | OPEN |  | R1,R2 |
| 14 | R1 | Low | security | plan-should-explicitly-preserve | The plan should explicitly preserve text-only rendering for chat and lobby messages with `textContent` and fixed clas... | OPEN |  | R1,R2 |
| 15 | R2 | Medium | test_quality | plan-adds-new-teacher | The plan adds new teacher and student chat-related DOM nodes but does not require extending the established HTML regr... | OPEN |  | R2 |
| 16 | R2 | Medium | code_quality | handle-lobby-message-relies | `handle_lobby_message` relies on `EntryNotFound` and `NotOwner` failure paths, but the plan does not state whether th... | OPEN |  | R2 |
| 17 | R2 | Low | test_quality | test-strategy-does-not | The test strategy does not list an empty-string rejection case for `LobbyMessage`, despite the handler design requiri... | OPEN |  | R2 |
| 18 | R2 | Low | test_quality | js-test-plan-does | The JS test plan does not cover `#chat-panel` visibility changes on `PeerConnected` and `PeerDisconnected`. (File: `P... | OPEN |  | R2 |
| 19 | R2 | Low | code_quality | validation-order-checks-upper | Validation order checks upper bounds before rejecting empty text in the handler pseudocode. (File: `server/src/ws/mod... | OPEN |  | R2 |
| 20 | R2 | Low | code_quality | reusing-payloadtoolarge-empty-te | Reusing `PayloadTooLarge` for empty text overloads the meaning of the error code and weakens machine-readable error h... | OPEN |  | R2 |
| 21 | R2 | Low | code_quality | plan-acknowledges-chat-log | The plan acknowledges chat log growth as a risk but does not make an explicit bounded-resource decision for the clien... | OPEN |  | R2 |
