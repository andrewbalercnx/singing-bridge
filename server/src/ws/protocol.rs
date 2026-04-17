// File: server/src/ws/protocol.rs
// Purpose: Signalling wire format. Tagged-union JSON for lobby + session
//          messages on one WebSocket.
// Role: Only place where client-visible message shapes live.
// Exports: ClientMsg, ServerMsg, PumpDirective, Role, Peer, EntryId,
//          ErrorCode, LobbyEntryView, MAX_SIGNAL_PAYLOAD_BYTES, MAX_*_LEN
// Depends: serde, uuid, bytes via axum
// Invariants: ServerMsg.Signal.from is server-filled; clients cannot spoof.
//             Signal.payload ≤ 16 KiB independent of the 64 KiB frame cap.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_SIGNAL_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_EMAIL_LEN: usize = 256;
pub const MAX_BROWSER_LEN: usize = 128;
pub const MAX_DEVICE_CLASS_LEN: usize = 32;

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Teacher,
    Student,
}

/// `Peer` is the role of the *other* side of the active session. The server
/// resolves the physical target connection from session membership; clients
/// cannot address arbitrary connections.
pub type Peer = Role;

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct EntryId(pub Uuid);

impl EntryId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for EntryId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LobbyEntryView {
    pub id: EntryId,
    pub email: String,
    pub browser: String,
    pub device_class: String,
    pub joined_at_unix: i64,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Malformed,
    SlugInvalid,
    NotOwner,
    AlreadyJoined,
    LobbyFull,
    EntryNotFound,
    SessionInProgress,
    NotInSession,
    InvalidRoute,
    PayloadTooLarge,
    FieldTooLong,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    LobbyJoin {
        slug: String,
        email: String,
        browser: String,
        device_class: String,
    },
    LobbyWatch {
        slug: String,
    },
    LobbyAdmit {
        slug: String,
        entry_id: EntryId,
    },
    LobbyReject {
        slug: String,
        entry_id: EntryId,
    },
    Signal {
        to: Peer,
        payload: serde_json::Value,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    LobbyState {
        entries: Vec<LobbyEntryView>,
    },
    Admitted {
        entry_id: EntryId,
    },
    Rejected {
        reason: String,
    },
    PeerConnected {
        role: Role,
    },
    Signal {
        from: Peer,
        payload: serde_json::Value,
    },
    PeerDisconnected,
    ServerShutdown,
    Error {
        code: ErrorCode,
        message: String,
    },
}

/// Sole control channel for the outbound pump (§4.15). The pump owns the
/// WebSocket write half; every outbound byte flows through here.
#[derive(Clone, Debug)]
pub enum PumpDirective {
    Send(ServerMsg),
    Close {
        code: u16,
        reason: Cow<'static, str>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn client_msg_roundtrips() {
        let cases = vec![
            ClientMsg::LobbyJoin {
                slug: "alice".into(),
                email: "s@example".into(),
                browser: "Firefox/999".into(),
                device_class: "desktop".into(),
            },
            ClientMsg::LobbyWatch {
                slug: "alice".into(),
            },
            ClientMsg::LobbyAdmit {
                slug: "alice".into(),
                entry_id: EntryId::new(),
            },
            ClientMsg::LobbyReject {
                slug: "alice".into(),
                entry_id: EntryId::new(),
            },
            ClientMsg::Signal {
                to: Role::Teacher,
                payload: serde_json::json!({"sdp": "v=0\n"}),
            },
        ];
        for c in cases {
            let s = serde_json::to_string(&c).unwrap();
            let back: ClientMsg = serde_json::from_str(&s).unwrap();
            let again = serde_json::to_string(&back).unwrap();
            assert_eq!(s, again);
        }
    }

    #[test]
    fn server_msg_roundtrips() {
        let cases = vec![
            ServerMsg::LobbyState { entries: vec![] },
            ServerMsg::Admitted {
                entry_id: EntryId::new(),
            },
            ServerMsg::Rejected {
                reason: "teacher_rejected".into(),
            },
            ServerMsg::PeerConnected {
                role: Role::Student,
            },
            ServerMsg::Signal {
                from: Role::Student,
                payload: serde_json::json!({}),
            },
            ServerMsg::PeerDisconnected,
            ServerMsg::ServerShutdown,
            ServerMsg::Error {
                code: ErrorCode::Malformed,
                message: "x".into(),
            },
        ];
        for c in cases {
            let s = serde_json::to_string(&c).unwrap();
            let _: ServerMsg = serde_json::from_str(&s).unwrap();
        }
    }

    proptest! {
        #[test]
        fn random_strings_roundtrip_as_email(email in "[ -~]{0,50}") {
            let msg = ClientMsg::LobbyJoin {
                slug: "alice".into(),
                email,
                browser: "x".into(),
                device_class: "desktop".into(),
            };
            let s = serde_json::to_string(&msg).unwrap();
            let _: ClientMsg = serde_json::from_str(&s).unwrap();
        }
    }
}
