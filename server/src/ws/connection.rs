// File: server/src/ws/connection.rs
// Purpose: ConnContext — per-connection state carried through the inbound
//          loop. Owns the pump JoinHandle for the life of the connection.
// Role: Bag of state; no side-effecting functions here.
// Exports: ConnContext
// Depends: tokio, protocol, state
// Invariants: `pump` is joined-or-aborted exactly once, by cleanup() (§4.8).
//             `tx` is the sole handler-owned sender; cleanup drops it so the
//             pump's rx.recv() returns None and the task exits cleanly.
// Last updated: Sprint 1 (2026-04-17) -- R2 cleanup; drop PreJoin reference.

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::auth::magic_link::TeacherId;
use crate::state::{ConnectionId, SlugKey};
use crate::ws::protocol::{PumpDirective, Role};

pub struct ConnContext {
    pub id: ConnectionId,
    /// Cookie-derived teacher identity, if any. Resolved to a concrete
    /// `Role` only after the first `LobbyWatch` / `LobbyJoin` and only if
    /// the slug is owned by this teacher (R4 #46).
    pub candidate_teacher_id: Option<TeacherId>,
    pub slug: Option<SlugKey>,
    pub role: Option<Role>,
    pub tx: mpsc::Sender<PumpDirective>,
    pub pump: JoinHandle<()>,
}
