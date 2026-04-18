// File: server/src/ws/protocol.rs
// Purpose: Signalling wire format. Tagged-union JSON for lobby + session
//          messages on one WebSocket.
// Role: Only place where client-visible message shapes live.
// Exports: ClientMsg, ServerMsg, PumpDirective, Role, Peer, EntryId,
//          ErrorCode, LobbyEntryView, MAX_SIGNAL_PAYLOAD_BYTES, MAX_*_LEN,
//          MAX_CHAT_CHARS, MAX_CHAT_BYTES
// Depends: serde, uuid, bytes via axum
// Invariants: ServerMsg.Signal.from is server-filled; clients cannot spoof.
//             Signal.payload ≤ 16 KiB independent of the 64 KiB frame cap.
//             LobbyReject.block_ttl_secs is clamped [0, 86400] server-side.
//             Chat.text validated: non-empty, ≤ MAX_CHAT_BYTES then ≤ MAX_CHAT_CHARS.
// Last updated: Sprint 7 (2026-04-18) -- chat messages (Chat, LobbyMessage)

use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_SIGNAL_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_EMAIL_LEN: usize = 256;
pub const MAX_BROWSER_LEN: usize = 128;
pub const MAX_DEVICE_CLASS_LEN: usize = 32;
/// Maximum stored length (in *characters*, not bytes) for a client-
/// supplied tier reason. `String::truncate` is byte-based and would
/// panic on multi-byte UTF-8 at the boundary — callers must use
/// char-safe truncation (see `ws::lobby::truncate_to_chars`).
pub const MAX_TIER_REASON_CHARS: usize = 200;
/// Hard byte cap enforced at the connection boundary. Strings whose
/// byte length exceeds this are rejected with `ErrorCode::FieldTooLong`
/// (paralleling `MAX_EMAIL_LEN`, `MAX_BROWSER_LEN`, etc.). The value
/// is `4 × MAX_TIER_REASON_CHARS` — the worst-case byte length of a
/// 200-char UTF-8 string (4 bytes per codepoint). Strings within the
/// byte cap are then char-truncated at `MAX_TIER_REASON_CHARS`.
pub const MAX_TIER_REASON_BYTES: usize = 4 * MAX_TIER_REASON_CHARS;
/// Maximum chat message length in Unicode codepoints.
pub const MAX_CHAT_CHARS: usize = 500;
/// Hard byte cap for chat: 4 bytes × MAX_CHAT_CHARS (worst-case UTF-8).
/// Checked before char counting for a fast-path rejection.
pub const MAX_CHAT_BYTES: usize = 4 * MAX_CHAT_CHARS;

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

/// Client-reported browser-compatibility tier. Surfaced to the teacher
/// in the lobby so they can see at a glance whether a waiting student
/// is running on a healthy browser. This is **UX advisory**, not a
/// security boundary — a tampered tier only affects the client's own
/// session. Unknown strings fail deserialisation (no `#[serde(other)]`),
/// which the connection pump converts into a WS close with code 1003.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Supported,
    Degraded,
    Unworkable,
}

impl Default for Tier {
    /// CONSERVATIVE DEFAULT: a `lobby_join` without an explicit tier is
    /// assumed Degraded, not Supported. A legitimate Sprint 3+ client
    /// always sends a tier (set by `web/assets/browser.js`); a missing
    /// field is therefore an older build, a hand-crafted client, or a
    /// tampered payload. Flagging it as Degraded warns the teacher
    /// without blocking the join.
    fn default() -> Self {
        Tier::Degraded
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LobbyEntryView {
    pub id: EntryId,
    pub email: String,
    pub browser: String,
    pub device_class: String,
    pub tier: Tier,
    pub tier_reason: Option<String>,
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
    Blocked,
    RateLimited,
    RecordAlreadyActive,
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
        #[serde(default)]
        tier: Tier,
        #[serde(default)]
        tier_reason: Option<String>,
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
        /// Non-zero: add the student's IP to the room block list for this many seconds
        /// (clamped to [0, 86_400] server-side). Zero or absent = plain reject.
        #[serde(default)]
        block_ttl_secs: Option<u32>,
    },
    SessionMetrics {
        loss_bp: u16,
        rtt_ms: u16,
    },
    Signal {
        to: Peer,
        payload: serde_json::Value,
    },
    RecordStart {
        slug: String,
    },
    RecordConsent {
        slug: String,
        granted: bool,
    },
    RecordStop {
        slug: String,
    },
    Chat {
        text: String,
    },
    LobbyMessage {
        entry_id: EntryId,
        text: String,
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
        /// TURN/STUN ICE servers for the student's RTCPeerConnection.
        /// Absent in dev (no TURN host configured). Students MUST use these
        /// credentials instead of calling /turn-credentials directly.
        #[serde(skip_serializing_if = "Option::is_none")]
        ice_servers: Option<serde_json::Value>,
        /// TURN credential TTL in seconds. Absent when ice_servers is None.
        #[serde(skip_serializing_if = "Option::is_none")]
        ttl: Option<i64>,
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
    RecordConsentRequest,
    RecordConsentResult {
        granted: bool,
    },
    RecordingActive,
    RecordingStopped,
    Chat {
        from: Role,
        text: String,
    },
    LobbyMessage {
        text: String,
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
                tier: Tier::Supported,
                tier_reason: None,
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
                block_ttl_secs: None,
            },
            ClientMsg::Signal {
                to: Role::Teacher,
                payload: serde_json::json!({"sdp": "v=0\n"}),
            },
            ClientMsg::Chat { text: "hello".into() },
            ClientMsg::LobbyMessage {
                entry_id: EntryId::new(),
                text: "be right with you".into(),
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
                ice_servers: None,
                ttl: None,
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
            ServerMsg::Chat { from: Role::Teacher, text: "hi".into() },
            ServerMsg::LobbyMessage { text: "starting soon".into() },
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
                tier: Tier::Supported,
                tier_reason: None,
            };
            let s = serde_json::to_string(&msg).unwrap();
            let _: ClientMsg = serde_json::from_str(&s).unwrap();
        }
    }
}
