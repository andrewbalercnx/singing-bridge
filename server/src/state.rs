// File: server/src/state.rs
// Purpose: In-memory shared state — AppState, per-room RoomState, LobbyEntry,
//          ClientHandle. Room lookup goes through typed helpers so no
//          `DashMap::Ref` ever escapes an async scope.
// Role: Single source of truth for live connections and lobby membership.
// Exports: AppState, RoomState, LobbyEntry, ActiveSession, ClientHandle,
//          ConnectionId, SlugKey, BlockEntry, BLOCK_LIST_CAP
// Depends: tokio, dashmap, sqlx, tokio_util, async trait mailer, blob, sidecar, media_token
// Invariants: RoomState is `tokio::sync::RwLock`; callers MUST use
//             AppState::room / ::room_or_insert (no direct DashMap access
//             from async fns). BLOCK_LIST_CAP enforced on every block insert;
//             oldest entry evicted when cap is reached (FIFO).
// Last updated: Sprint 20 (2026-04-25) -- AcousticProfile replaces headphones_confirmed in LobbyEntry

use std::net::IpAddr;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use sqlx::PgPool;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::auth::mailer::Mailer;
use crate::blob::BlobStore;
use crate::auth::secret::SecretString;
use crate::config::Config;
use crate::http::media_token::MediaTokenStore;
#[cfg(debug_assertions)]
use crate::http::test_peer::TokenStore;
use crate::sidecar::{BarCoord, BarTiming, PartInfo, SidecarClient};
use crate::error::{AppError, Result};
use crate::ws::protocol::{AcousticProfile, EntryId, LobbyEntryView, PumpDirective, Tier};
use crate::ws::rate_limit::WsJoinBucket;
use crate::auth::magic_link::TeacherId;
use crate::ws::session_history::{SessionEventId, StudentId};
use crate::ws::session_log::SessionLogId;

/// Random per-connection identifier. Used to distinguish connections when
/// the teacher reconnects and the old socket is being torn down.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub struct ConnectionId(pub u64);

impl ConnectionId {
    pub fn new() -> Self {
        use rand::RngCore;
        Self(rand::thread_rng().next_u64())
    }
}

impl Default for ConnectionId {
    fn default() -> Self {
        Self::new()
    }
}

/// Normalised slug key. Constructed only via `SlugKey::new` which lowercases.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct SlugKey(String);

impl SlugKey {
    pub fn new(raw: &str) -> std::result::Result<Self, AppError> {
        let lower = crate::auth::slug::validate(raw)?;
        Ok(Self(lower))
    }

    /// Skip validation — used only when loading a previously validated slug
    /// from the DB.
    pub fn from_trusted(raw: String) -> Self {
        Self(raw.to_ascii_lowercase())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone)]
pub struct ClientHandle {
    pub id: ConnectionId,
    pub tx: mpsc::Sender<PumpDirective>,
}

pub struct LobbyEntry {
    pub id: EntryId,
    pub email: String,
    pub browser: String,
    pub device_class: String,
    pub tier: Tier,
    pub tier_reason: Option<String>,
    pub joined_at: Instant,
    pub joined_at_unix: i64,
    pub conn: ClientHandle,
    pub acoustic_profile: AcousticProfile,
}

impl LobbyEntry {
    pub fn view(&self) -> LobbyEntryView {
        LobbyEntryView {
            id: self.id,
            email: self.email.clone(),
            browser: self.browser.clone(),
            device_class: self.device_class.clone(),
            tier: self.tier,
            tier_reason: self.tier_reason.clone(),
            joined_at_unix: self.joined_at_unix,
            acoustic_profile: self.acoustic_profile,
        }
    }
}

/// In-memory state for an active accompaniment play session.
/// Stored in `ActiveSession`; `None` when stopped.
pub struct AccompanimentSnapshot {
    pub asset_id: i64,
    pub variant_id: i64,
    pub tempo_pct: i32,
    pub position_ms: u64,
    pub is_playing: bool,
    pub wav_blob_key: String,
    pub page_blob_keys: Vec<String>,
    pub wav_url: String,
    pub page_urls: Vec<String>,
    /// Sorted ascending by bar number before storage.
    pub bar_coords: Vec<BarCoord>,
    pub bar_timings: Vec<BarTiming>,
}

impl AccompanimentSnapshot {
    /// Returns all blob keys: WAV first, then pages in order.
    pub fn all_blob_keys(&self) -> Vec<String> {
        let mut keys = vec![self.wav_blob_key.clone()];
        keys.extend(self.page_blob_keys.iter().cloned());
        keys
    }
}

pub struct ActiveSession {
    pub student: LobbyEntry,
    pub started_at: Instant,
    /// Transiently None until open_row succeeds; record_peak/close_row
    /// short-circuit when None so the session proceeds without logging on
    /// DB failure.
    pub log_id: Option<SessionLogId>,
    /// Transiently None until open_event succeeds (best-effort history).
    pub session_event_id: Option<SessionEventId>,
    /// Transiently None until upsert_student succeeds (best-effort history).
    pub session_student_id: Option<StudentId>,
    /// Teacher who owns this session — set at admit time, stable thereafter.
    pub session_teacher_id: Option<TeacherId>,
    pub peak_loss_bp: AtomicU16,
    pub peak_rtt_ms: AtomicU16,
    pub accompaniment: Option<AccompanimentSnapshot>,
}

// ---------------------------------------------------------------------------
// OMR background job store
// ---------------------------------------------------------------------------

pub enum OmrJobState {
    Running,
    Done(Vec<PartInfo>),
    Failed(String),
}

pub struct OmrJob {
    pub teacher_id: i64,
    pub asset_id: i64,
    pub state: OmrJobState,
    pub created_at: Instant,
}

pub const BLOCK_LIST_CAP: usize = 256;

pub struct BlockEntry {
    pub ip: IpAddr,
    pub until: Instant,
}

#[derive(Default)]
pub struct RoomState {
    pub teacher_conn: Option<ClientHandle>,
    pub lobby: Vec<LobbyEntry>,
    pub active_session: Option<ActiveSession>,
    pub blocked: Vec<BlockEntry>,
    pub recording_active: bool,
    pub consent_pending: bool,
}

impl RoomState {
    pub fn lobby_view(&self) -> Vec<LobbyEntryView> {
        self.lobby.iter().map(LobbyEntry::view).collect()
    }

    /// Check whether an IP is blocked. Also sweeps expired entries.
    pub fn is_blocked(&mut self, ip: IpAddr) -> bool {
        let now = Instant::now();
        self.blocked.retain(|b| b.until > now);
        self.blocked.iter().any(|b| b.ip == ip)
    }

    /// Add a block entry. If BLOCK_LIST_CAP is reached, evict the oldest entry
    /// (FIFO). Sweeps expired entries first.
    pub fn block_ip(&mut self, ip: IpAddr, until: Instant) {
        let now = Instant::now();
        self.blocked.retain(|b| b.until > now);
        if self.blocked.len() >= BLOCK_LIST_CAP {
            self.blocked.remove(0); // FIFO eviction
        }
        self.blocked.push(BlockEntry { ip, until });
    }

    /// Remove an entry by connection id from either lobby or active_session.
    /// Returns true if the entry was in the active session (caller should
    /// notify the peer).
    pub fn remove_by_connection(&mut self, conn: ConnectionId) -> Option<RemovalKind> {
        if let Some(pos) = self.lobby.iter().position(|e| e.conn.id == conn) {
            // Stable `remove` so disconnect-driven lobby updates preserve
            // the teacher's visible entry order (R2 code-review #81).
            self.lobby.remove(pos);
            return Some(RemovalKind::FromLobby);
        }
        if self
            .active_session
            .as_ref()
            .map(|s| s.student.conn.id == conn)
            .unwrap_or(false)
        {
            self.active_session = None;
            return Some(RemovalKind::FromActiveSession);
        }
        None
    }
}

pub enum RemovalKind {
    FromLobby,
    FromActiveSession,
}

pub struct AppState {
    pub db: PgPool,
    pub config: Config,
    pub mailer: Arc<dyn Mailer>,
    pub blob: Arc<dyn BlobStore>,
    pub sidecar: Arc<SidecarClient>,
    pub media_tokens: Arc<MediaTokenStore>,
    pub omr_jobs: DashMap<uuid::Uuid, OmrJob>,
    pub rooms: DashMap<SlugKey, Arc<RwLock<RoomState>>>,
    /// Authoritative counter for the room cap. Incremented inside the
    /// single-winner `Entry::Vacant` branch of `room_or_insert`; we compare-
    /// and-rollback on overshoot so no concurrent path ever observes a
    /// count > max_active_rooms. Kept separate from `rooms.len()`, which is
    /// only eventually consistent under concurrent inserts across shards.
    pub active_rooms: AtomicUsize,
    pub shutdown: CancellationToken,
    pub ws_join_rate_limits: Arc<DashMap<IpAddr, WsJoinBucket>>,
    /// Owned here; aborted in main.rs on shutdown.
    pub ws_join_rate_sweeper: JoinHandle<()>,
    pub turn_cred_rate_limits: Arc<DashMap<IpAddr, WsJoinBucket>>,
    /// Pepper for session log email hashing. None in dev (DEV_PEPPER used).
    pub session_log_pepper: Option<SecretString>,
    /// Active bot subprocesses — keyed by slug. Checked before spawning to
    /// prevent duplicate bots. Cleared when the subprocess exits.
    pub active_bots: Arc<DashMap<String, ()>>,
    #[cfg(debug_assertions)]
    pub token_store: Arc<TokenStore>,
}

impl AppState {
    /// Look up an existing room. Returns the `Arc<RwLock<RoomState>>` with
    /// no lingering DashMap guard.
    pub fn room(&self, slug: &SlugKey) -> Option<Arc<RwLock<RoomState>>> {
        self.rooms.get(slug).map(|r| Arc::clone(r.value()))
    }

    /// Look up or insert a room. Enforces MAX_ACTIVE_ROOMS atomically across
    /// concurrent insertions of distinct slugs (R1 code-review finding #46).
    pub fn room_or_insert(&self, slug: SlugKey) -> Result<Arc<RwLock<RoomState>>> {
        match self.rooms.entry(slug) {
            Entry::Occupied(e) => Ok(Arc::clone(e.get())),
            Entry::Vacant(e) => {
                // Atomically reserve a slot. Rollback if over-cap.
                let prev = self.active_rooms.fetch_add(1, Ordering::AcqRel);
                if prev >= self.config.max_active_rooms {
                    self.active_rooms.fetch_sub(1, Ordering::AcqRel);
                    return Err(AppError::ServiceUnavailable);
                }
                let arc = Arc::new(RwLock::new(RoomState::default()));
                e.insert(Arc::clone(&arc));
                Ok(arc)
            }
        }
    }

    /// Effective pepper for session log email hashing.
    pub fn session_log_pepper_bytes(&self) -> &[u8] {
        self.session_log_pepper
            .as_ref()
            .map(|s| s.expose().as_bytes())
            .unwrap_or(crate::ws::session_log::DEV_PEPPER)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_key_is_lowercase_by_construction() {
        let a = SlugKey::new("Alice").unwrap();
        let b = SlugKey::new("alice").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.as_str(), "alice");
    }

    #[test]
    fn slug_key_rejects_invalid() {
        assert!(SlugKey::new("bad slug").is_err());
        assert!(SlugKey::new("admin").is_err());
    }

    #[test]
    fn block_ip_cap_enforces_fifo_eviction() {
        let mut rs = RoomState::default();
        let far_future = Instant::now() + std::time::Duration::from_secs(86400);
        // Insert first IP, then fill to cap, then one more — first should be evicted.
        let first_ip: IpAddr = "10.0.0.1".parse().unwrap();
        rs.block_ip(first_ip, far_future);
        for i in 2u32..=(BLOCK_LIST_CAP as u32) {
            let ip: IpAddr = format!("10.0.{}.{}", i / 256, i % 256).parse().unwrap();
            rs.block_ip(ip, far_future);
        }
        assert_eq!(rs.blocked.len(), BLOCK_LIST_CAP);
        // Add one more — the first IP should now be evicted.
        let extra_ip: IpAddr = "10.1.0.1".parse().unwrap();
        rs.block_ip(extra_ip, far_future);
        assert_eq!(rs.blocked.len(), BLOCK_LIST_CAP);
        assert!(!rs.blocked.iter().any(|b| b.ip == first_ip));
    }

    #[test]
    fn is_blocked_sweeps_expired() {
        let mut rs = RoomState::default();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        // Add an already-expired entry.
        rs.blocked.push(BlockEntry {
            ip,
            until: Instant::now() - std::time::Duration::from_secs(1),
        });
        assert!(!rs.is_blocked(ip)); // expired → not blocked
        assert!(rs.blocked.is_empty()); // swept
    }
}
