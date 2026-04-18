# Signalling architecture — singing-bridge

*One-line purpose:* How the teacher and student browsers negotiate a
peer-to-peer WebRTC connection over our server, and how the server
keeps the lobby consistent while that's happening.

## What this is and where it sits

The server is a single Rust / axum binary (`server/`). It never sees
media — it only brokers **signalling**:

1. **HTTP side** (`server/src/http/`): teacher signup + magic-link
   consume + `/teach/<slug>` landing page.
2. **WebSocket side** (`server/src/ws/`): one `/ws` connection per
   client, tagged-union JSON messages, lobby admission, relay of
   SDP + ICE between admitted peers.

The browser then opens an `RTCPeerConnection` directly between the two
peers; the server stops being on the data path once ICE completes.

## Why it exists

WebRTC needs a rendezvous channel for SDP + ICE exchange. We also need
to let teachers vet each arriving student manually (see
[ADR-0001](../decisions/0001-mvp-architecture.md) §Lobby model). One
WebSocket per client carrying both "lobby" and "session" messages is
the minimum infra that meets both needs. The server does not see
media and does not speak WebRTC; it only forwards opaque JSON
payloads it defines the frame shape for.

## Message shapes

Declared in `server/src/ws/protocol.rs`. Client → server:
`LobbyJoin`, `LobbyWatch`, `LobbyAdmit`, `LobbyReject`,
`SessionMetrics`, `Signal`.
Server → client: `LobbyState`, `Admitted`, `Rejected`,
`PeerConnected`, `Signal`, `PeerDisconnected`, `ServerShutdown`,
`Error`.

`Signal` is the SDP + ICE relay. Its `payload` is opaque JSON capped
at 16 KiB independent of the 64 KiB WebSocket frame cap. `Peer` is a
`Role` enum (`Teacher` / `Student`) — the server resolves the
physical target connection from `active_session` membership; clients
cannot address arbitrary connections (this is the authorisation
boundary).

`Admitted` carries optional `ice_servers` + `ttl` fields (Sprint 5):
the TURN/STUN credentials the student should use for `RTCPeerConnection`
setup. Students never call `/turn-credentials` directly — credentials
are delivered in the WS handshake. Teachers fetch via `/turn-credentials`
with their session cookie.

## Connection lifecycle

```mermaid
sequenceDiagram
  participant S as Student
  participant Srv as Server
  participant T as Teacher
  T->>Srv: WS /ws + sb_session cookie
  T->>Srv: LobbyWatch { slug }
  Srv->>T: LobbyState { entries: [] }
  S->>Srv: WS /ws (no cookie)
  S->>Srv: LobbyJoin { slug, email, ... }
  Srv->>T: LobbyState { entries: [S] }
  T->>Srv: LobbyAdmit { entry_id }
  Srv->>S: Admitted, PeerConnected { Teacher }
  Srv->>T: PeerConnected { Student }, LobbyState { entries: [] }
  S-->>Srv: Signal { to: Teacher, payload: {sdp: offer} }
  Srv-->>T: Signal { from: Student, payload: {sdp: offer} }
  T-->>Srv: Signal { to: Student, payload: {sdp: answer} }
  Srv-->>S: Signal { from: Teacher, payload: {sdp: answer} }
  Note over S,T: ICE candidates exchanged the same way;<br/>RTCDataChannel opens peer-to-peer.
```

## Invariants and gotchas

- **Single writer per socket:** the per-connection pump task owns
  the WebSocket write half. Every outbound byte — protocol messages
  and close frames — flows through a `mpsc::Sender<PumpDirective>`.
  `PumpDirective::Close { code }` is how we send close frames 1000
  (reject), 1008 (malformed / not-slug-owner), 1009 (oversize),
  1012 (server shutdown).
- **Slug-aware role resolution:** a cookie carrying
  `candidate_teacher_id` is promoted to `Role::Teacher` only if
  that teacher owns the slug being watched. Cross-room bypass
  (teacher-A cookie + `LobbyWatch slug_b`) returns `NotOwner` +
  close 1008.
- **No `.await` inside a `RoomState` guard.** Handlers acquire the
  `tokio::sync::RwLock` write guard, compute a delta, drop the
  guard, then `.await` the sends. `clippy::await_holding_lock` is
  denied at workspace root.
- **Rooms are never eagerly dropped.** `LOBBY_CAP_PER_ROOM` and an
  atomic `active_rooms` counter bound the working set; atomic
  fetch-add with rollback keeps the cap under concurrent inserts.
- **No durable student state.** Students are stateless per visit
  (email is a per-session lobby label only). Only teacher
  accounts + sessions + pending magic links are persisted.
- **Session log is append-only, no raw PII.** `open_row` at admit,
  `record_peak` (5-second metrics ticks), `close_row` at disconnect.
  Student email stored as `sha256(lower(email) || pepper)` only.
  `record_peak` SQL guards `AND ended_at IS NULL` (no writes to
  closed rows). Pepper ≥ 32 bytes required in prod.

## File map

| Concern | File |
|---|---|
| WS upgrade + Origin check + dispatcher | `server/src/ws/mod.rs` |
| Per-connection state + pump JoinHandle | `server/src/ws/connection.rs` |
| `ClientMsg`, `ServerMsg`, `PumpDirective`, caps | `server/src/ws/protocol.rs` |
| Lobby join / admit / reject transitions | `server/src/ws/lobby.rs` |
| Signal relay authorisation | `server/src/ws/session.rs` |
| Per-room in-memory state | `server/src/state.rs` |
| Per-IP rate limiting (WS join + TURN creds) | `server/src/ws/rate_limit.rs` |
| Session log (open/record/close) | `server/src/ws/session_log.rs` |
| TURN credential HTTP endpoint (teacher-only) | `server/src/http/turn.rs` |

## Related

- [ADR-0001](../decisions/0001-mvp-architecture.md) — why browser-only, why manual admission, bandwidth degradation order.
- [Runbook: deploy](../runbook/deploy.md) — one-time bootstrap + per-release deploy.
- [Runbook: rollback](../runbook/rollback.md) — container revision rollback.
- [Runbook: TURN down](../runbook/incident-turn-down.md) — coturn incident response.
