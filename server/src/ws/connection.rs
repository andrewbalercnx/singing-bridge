// File: server/src/ws/connection.rs
// Purpose: ConnContext — per-connection state carried through the inbound
//          loop. Owns the pump JoinHandle for the life of the connection.
// Role: Bag of state; no side-effecting functions here.
// Exports: ConnContext, PreJoin
// Depends: tokio, protocol, state
// Invariants: `pump` is joined-or-aborted exactly once, by cleanup() (§4.8).
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::state::{ConnectionId, SlugKey};
use crate::ws::protocol::{PumpDirective, Role};

/// Marker used solely to keep the PreJoin phase namable in tests; no data.
pub struct PreJoin;

pub struct ConnContext {
    pub id: ConnectionId,
    pub candidate_teacher_id: Option<i64>,
    pub slug: Option<SlugKey>,
    pub role: Option<Role>,
    pub tx: mpsc::Sender<PumpDirective>,
    pub pump: JoinHandle<()>,
}
