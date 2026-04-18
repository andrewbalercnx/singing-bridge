// File: server/src/ws/rate_limit.rs
// Purpose: Per-IP sliding-window rate limiting for WS join and TURN creds.
// Role: Provides WsJoinBucket and check_and_inc; AppState holds the DashMap.
// Exports: WsJoinBucket, check_and_inc
// Depends: dashmap, std::net::IpAddr
// Invariants: check_and_inc acquires the DashMap shard lock, mutates the
//             bucket, and releases it — never holds a lock across .await.
//             Per-IP bucket is inserted lazily. 0 limit = disabled (all pass).
// Last updated: Sprint 5 (2026-04-18) -- initial implementation, R1 fixes

use std::net::IpAddr;

use dashmap::DashMap;

pub struct WsJoinBucket {
    count: u32,
    window_start_unix: i64,
}

impl Default for WsJoinBucket {
    fn default() -> Self {
        Self { count: 0, window_start_unix: 0 }
    }
}

/// Check and increment the per-IP rate limit bucket. Returns true if the
/// request is over-limit (should be rejected). Limit=0 means disabled.
///
/// The DashMap shard lock is acquired and released within this function —
/// never held across an .await boundary.
pub fn check_and_inc(
    map: &DashMap<IpAddr, WsJoinBucket>,
    ip: IpAddr,
    limit: usize,
    window_secs: i64,
    now_unix: i64,
) -> bool {
    if limit == 0 {
        return false; // disabled
    }
    let mut entry = map.entry(ip).or_default();
    let bucket = entry.value_mut();
    if now_unix - bucket.window_start_unix >= window_secs {
        bucket.window_start_unix = now_unix;
        bucket.count = 0;
    }
    bucket.count += 1;
    bucket.count > limit as u32
}

/// Sweep stale entries older than 2× the window. Called by the background sweeper.
pub fn sweep_stale(map: &DashMap<IpAddr, WsJoinBucket>, now_unix: i64, window_secs: i64) {
    map.retain(|_, bucket| now_unix - bucket.window_start_unix < 2 * window_secs);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn ip() -> IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    #[test]
    fn first_request_is_allowed() {
        let map = DashMap::new();
        assert!(!check_and_inc(&map, ip(), 5, 60, 1000));
    }

    #[test]
    fn at_limit_is_allowed_over_is_rejected() {
        let map = DashMap::new();
        for _ in 0..5 {
            assert!(!check_and_inc(&map, ip(), 5, 60, 1000));
        }
        // 6th request is over limit
        assert!(check_and_inc(&map, ip(), 5, 60, 1000));
    }

    #[test]
    fn window_reset_allows_again() {
        let map = DashMap::new();
        for _ in 0..6 {
            check_and_inc(&map, ip(), 5, 60, 1000);
        }
        // Advance time past the window
        assert!(!check_and_inc(&map, ip(), 5, 60, 1061));
    }

    #[test]
    fn limit_zero_always_passes() {
        let map = DashMap::new();
        for _ in 0..1000 {
            assert!(!check_and_inc(&map, ip(), 0, 60, 1000));
        }
    }

    #[test]
    fn sweep_removes_stale_entries() {
        let map: DashMap<IpAddr, WsJoinBucket> = DashMap::new();
        check_and_inc(&map, ip(), 5, 60, 1000);
        assert_eq!(map.len(), 1);
        // 2× window has passed
        sweep_stale(&map, 1121, 60);
        assert_eq!(map.len(), 0);
    }

    #[test]
    fn sweep_keeps_fresh_entries() {
        let map: DashMap<IpAddr, WsJoinBucket> = DashMap::new();
        check_and_inc(&map, ip(), 5, 60, 1000);
        // Only 1× window has passed — entry should remain
        sweep_stale(&map, 1060, 60);
        assert_eq!(map.len(), 1);
    }
}
