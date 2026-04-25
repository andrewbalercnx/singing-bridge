// File: server/src/ws/protocol.rs
// Purpose: Signalling wire format. Tagged-union JSON for lobby + session
//          messages on one WebSocket.
// Role: Only place where client-visible message shapes live.
// Exports: ClientMsg, ServerMsg, PumpDirective, Role, Peer, EntryId,
//          ErrorCode, LobbyEntryView, MAX_SIGNAL_PAYLOAD_BYTES, MAX_*_LEN,
//          MAX_CHAT_CHARS, MAX_CHAT_BYTES
// Depends: serde, uuid, bytes via axum, sidecar (BarCoord, BarTiming)
// Invariants: ServerMsg.Signal.from is server-filled; clients cannot spoof.
//             Signal.payload ≤ 16 KiB independent of the 64 KiB frame cap.
//             LobbyReject.block_ttl_secs is clamped [0, 86400] server-side.
//             Chat.text validated: non-empty, ≤ MAX_CHAT_BYTES then ≤ MAX_CHAT_CHARS.
//             AccompanimentPlay/Pause/Stop are teacher-only; student receives Forbidden.
// Last updated: Sprint 20 (2026-04-25) -- AcousticProfile enum; SetAcousticProfile/ChattingMode msgs; replace headphones_confirmed

use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use crate::sidecar::{BarCoord, BarTiming};

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

/// Acoustic profile for a student connection.
/// `Unknown` is a serde deserialization fallback only — it is never serialized
/// outbound. Handlers must normalize `Unknown → Speakers` before storing.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcousticProfile {
    Headphones,
    Speakers,
    IosForced,
    #[serde(other)]
    Unknown,
}

impl Default for AcousticProfile {
    fn default() -> Self {
        AcousticProfile::Speakers
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
    #[serde(default)]
    pub acoustic_profile: AcousticProfile,
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
    Forbidden,
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
        /// Optional acoustic profile derived from UA (e.g. "ios_forced").
        /// Absent from pre-Sprint-20 clients → server defaults to Speakers.
        #[serde(default)]
        acoustic_profile: Option<AcousticProfile>,
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
    /// Deprecated: kept for backwards compat with pre-Sprint-20 clients.
    /// Updates acoustic_profile Speakers → Headphones (no-op for IosForced or Headphones).
    HeadphonesConfirmed,
    /// Teacher-only: override the acoustic profile for a lobby/session student entry.
    /// Role-checked in mod.rs; Unknown variant normalised to Speakers before storing.
    SetAcousticProfile {
        entry_id: EntryId,
        profile: AcousticProfile,
    },
    /// Teacher→server: relay chat-mode AEC enable/disable to the student.
    /// Role-checked in mod.rs; requires an active session peer.
    ChattingMode {
        enabled: bool,
    },
    // Teacher-only accompaniment control messages.
    AccompanimentPlay {
        asset_id: i64,
        variant_id: i64,
        position_ms: u64,
    },
    AccompanimentPause {
        position_ms: u64,
    },
    AccompanimentStop,
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
    /// Sent to both session peers when a student's acoustic profile changes.
    AcousticProfileChanged {
        profile: AcousticProfile,
    },
    /// Server→student only: relay teacher chat-mode (AEC on/off) instruction.
    /// Teacher never receives this message.
    ChattingMode {
        enabled: bool,
    },
    /// Full snapshot of accompaniment playback state.
    /// Cleared state: asset_id=None, is_playing=false, position_ms=0, all urls/coords=None.
    AccompanimentState {
        asset_id: Option<i64>,
        variant_id: Option<i64>,
        is_playing: bool,
        position_ms: u64,
        tempo_pct: Option<i32>,
        wav_url: Option<String>,
        page_urls: Option<Vec<String>>,
        bar_coords: Option<Vec<BarCoord>>,
        bar_timings: Option<Vec<BarTiming>>,
        server_time_ms: u64,
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
                acoustic_profile: None,
            },
            ClientMsg::LobbyJoin {
                slug: "alice".into(),
                email: "s@example".into(),
                browser: "Safari/17".into(),
                device_class: "phone".into(),
                tier: Tier::Supported,
                tier_reason: None,
                acoustic_profile: Some(AcousticProfile::IosForced),
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
            ClientMsg::HeadphonesConfirmed,
            ClientMsg::SetAcousticProfile {
                entry_id: EntryId::new(),
                profile: AcousticProfile::Headphones,
            },
            ClientMsg::ChattingMode { enabled: true },
            ClientMsg::ChattingMode { enabled: false },
            ClientMsg::AccompanimentPlay {
                asset_id: 42,
                variant_id: 7,
                position_ms: 1000,
            },
            ClientMsg::AccompanimentPause { position_ms: 500 },
            ClientMsg::AccompanimentStop,
        ];
        for c in cases {
            let s = serde_json::to_string(&c).unwrap();
            let back: ClientMsg = serde_json::from_str(&s).unwrap();
            let again = serde_json::to_string(&back).unwrap();
            assert_eq!(s, again);
        }
    }

    #[test]
    fn acoustic_profile_roundtrips() {
        let cases = [
            (AcousticProfile::Headphones, "\"headphones\""),
            (AcousticProfile::Speakers, "\"speakers\""),
            (AcousticProfile::IosForced, "\"ios_forced\""),
        ];
        for (profile, expected_json) in cases {
            let s = serde_json::to_string(&profile).unwrap();
            assert_eq!(s, expected_json, "serialize {profile:?}");
            let back: AcousticProfile = serde_json::from_str(&s).unwrap();
            assert_eq!(back, profile, "roundtrip {profile:?}");
        }
    }

    #[test]
    fn acoustic_profile_unknown_deserialises_to_unknown_variant() {
        // Future clients may send values we don't know; they must not close the socket.
        let v: AcousticProfile = serde_json::from_str("\"bluetooth\"").unwrap();
        assert_eq!(v, AcousticProfile::Unknown);
    }

    #[test]
    fn lobby_entry_view_acoustic_profile_defaults_to_speakers_when_absent() {
        // Pre-Sprint-20 LobbyEntryView payloads lack acoustic_profile.
        // The default must be Speakers (conservative — applies mitigation).
        let json = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "email": "s@example.test",
            "browser": "Firefox/1",
            "device_class": "desktop",
            "tier": "supported",
            "tier_reason": null,
            "joined_at_unix": 0,
        });
        let view: LobbyEntryView = serde_json::from_value(json).unwrap();
        assert_eq!(view.acoustic_profile, AcousticProfile::Speakers);
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
            // New in Sprint 14: Forbidden error variant.
            ServerMsg::Error {
                code: ErrorCode::Forbidden,
                message: "not a teacher".into(),
            },
            // New in Sprint 20: acoustic profile changed + chatting mode.
            ServerMsg::AcousticProfileChanged { profile: AcousticProfile::IosForced },
            ServerMsg::AcousticProfileChanged { profile: AcousticProfile::Headphones },
            ServerMsg::ChattingMode { enabled: true },
            ServerMsg::ChattingMode { enabled: false },
            // New in Sprint 14: populated AccompanimentState.
            ServerMsg::AccompanimentState {
                asset_id: Some(1),
                variant_id: Some(2),
                is_playing: true,
                position_ms: 1000,
                tempo_pct: Some(100),
                wav_url: Some("http://example.com/a.wav".into()),
                page_urls: Some(vec!["http://example.com/p1.png".into()]),
                bar_coords: Some(vec![]),
                bar_timings: Some(vec![]),
                server_time_ms: 1_000_000,
            },
            // New in Sprint 14: cleared AccompanimentState (asset_id=None).
            ServerMsg::AccompanimentState {
                asset_id: None,
                variant_id: None,
                is_playing: false,
                position_ms: 0,
                tempo_pct: None,
                wav_url: None,
                page_urls: None,
                bar_coords: None,
                bar_timings: None,
                server_time_ms: 1_000_000,
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
                tier: Tier::Supported,
                tier_reason: None,
                acoustic_profile: None,
            };
            let s = serde_json::to_string(&msg).unwrap();
            let _: ClientMsg = serde_json::from_str(&s).unwrap();
        }
    }
}
