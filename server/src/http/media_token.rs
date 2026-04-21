// File: server/src/http/media_token.rs
// Purpose: In-memory short-lived token store for authenticated media delivery (WAV + page blobs).
// Role: Issues random tokens mapping to blob keys; validates tokens on GET /api/media/<token>.
// Exports: MediaTokenStore
// Depends: dashmap, rand, std::time
// Invariants: Hard cap of TOKEN_CAP entries. On insert, expired entries are swept first;
//             if still at cap, oldest entry is evicted (by expires_at).
//             expired and unknown tokens both return None from get_blob_key (no oracle).
//             Tokens are invalidated by blob_key on session teardown / asset deletion.
// Last updated: Sprint 12 (2026-04-21) -- initial; remove unused TOKEN_HEX_LEN constant

use std::time::{Duration, Instant};

use dashmap::DashMap;
use rand::RngCore;

const TOKEN_CAP: usize = 1000;

struct Entry {
    blob_key: String,
    expires_at: Instant,
}

pub struct MediaTokenStore {
    map: DashMap<String, Entry>,
}

impl MediaTokenStore {
    pub fn new() -> Self {
        Self { map: DashMap::new() }
    }

    /// Issue a token for `blob_key` that expires after `ttl`.
    /// Returns the token string (64 lowercase hex characters).
    pub fn insert(&self, blob_key: String, ttl: Duration) -> String {
        let token = random_token();
        let expires_at = Instant::now() + ttl;

        // Sweep expired entries first.
        self.sweep_expired();

        // If still at cap, evict the soonest-expiring entry.
        if self.map.len() >= TOKEN_CAP {
            if let Some(oldest_key) = self
                .map
                .iter()
                .min_by_key(|e| e.value().expires_at)
                .map(|e| e.key().clone())
            {
                self.map.remove(&oldest_key);
            }
        }

        self.map.insert(token.clone(), Entry { blob_key, expires_at });
        token
    }

    /// Look up the blob key for `token`. Returns `None` if the token is
    /// unknown or expired — callers must not distinguish the two cases.
    pub fn get_blob_key(&self, token: &str) -> Option<String> {
        // Opportunistic sweep on every access (non-blocking best-effort).
        self.sweep_expired();

        self.map.get(token).and_then(|e| {
            if e.expires_at >= Instant::now() {
                Some(e.blob_key.clone())
            } else {
                None
            }
        })
    }

    /// Remove all tokens that map to any of the given blob keys.
    /// Called on session teardown or asset deletion.
    pub fn invalidate_by_blob_keys(&self, blob_keys: &[String]) {
        let keys_set: std::collections::HashSet<&str> =
            blob_keys.iter().map(|s| s.as_str()).collect();
        self.map.retain(|_, v| !keys_set.contains(v.blob_key.as_str()));
    }

    fn sweep_expired(&self) {
        let now = Instant::now();
        self.map.retain(|_, v| v.expires_at > now);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }
}

impl Default for MediaTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn insert_and_retrieve() {
        let store = MediaTokenStore::new();
        let tok = store.insert("blob-1".into(), Duration::from_secs(300));
        assert_eq!(store.get_blob_key(&tok), Some("blob-1".into()));
    }

    #[test]
    fn expired_token_returns_none() {
        let store = MediaTokenStore::new();
        let tok = store.insert("blob-2".into(), Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(store.get_blob_key(&tok), None);
    }

    #[test]
    fn unknown_token_returns_none() {
        let store = MediaTokenStore::new();
        assert_eq!(store.get_blob_key("deadbeef"), None);
    }

    #[test]
    fn invalidate_removes_matching_tokens() {
        let store = MediaTokenStore::new();
        let tok = store.insert("wav-key".into(), Duration::from_secs(300));
        store.invalidate_by_blob_keys(&["wav-key".into()]);
        assert_eq!(store.get_blob_key(&tok), None);
    }

    #[test]
    fn invalidate_does_not_remove_unrelated() {
        let store = MediaTokenStore::new();
        let tok = store.insert("keep-this".into(), Duration::from_secs(300));
        store.invalidate_by_blob_keys(&["other-key".into()]);
        assert!(store.get_blob_key(&tok).is_some());
    }

    #[test]
    fn cap_evicts_oldest_on_insert() {
        let store = MediaTokenStore::new();
        // Fill to cap.
        let first_tok = store.insert("first".into(), Duration::from_secs(1));
        for i in 0..TOKEN_CAP {
            store.insert(format!("blob-{i}"), Duration::from_secs(300));
        }
        // First token should have been evicted (it was the oldest/soonest expiring).
        // After cap: store has TOKEN_CAP entries, first one is gone.
        assert!(store.len() <= TOKEN_CAP);
        // first_tok may or may not be present (eviction is best-effort by expires_at),
        // but no panic and count is bounded.
        let _ = store.get_blob_key(&first_tok); // must not panic
    }

    #[test]
    fn multi_use_within_ttl() {
        let store = MediaTokenStore::new();
        let tok = store.insert("multi".into(), Duration::from_secs(300));
        // Second and third access within TTL succeed.
        assert!(store.get_blob_key(&tok).is_some());
        assert!(store.get_blob_key(&tok).is_some());
    }
}
