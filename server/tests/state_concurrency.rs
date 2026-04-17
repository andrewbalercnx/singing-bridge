// File: server/tests/state_concurrency.rs
// Purpose: Concurrency tests — MAX_ACTIVE_ROOMS cap holds under parallel
//          insertion (R1 code-review finding #46).
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

mod common;

use std::sync::atomic::Ordering;

use common::{spawn_app_with, TestOpts};
use singing_bridge_server::state::SlugKey;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn room_cap_holds_under_concurrent_inserts() {
    let opts = TestOpts {
        max_active_rooms: 4,
        ..Default::default()
    };
    let app = spawn_app_with(opts).await;

    let mut tasks = Vec::new();
    for i in 0..32 {
        let state = app.state.clone();
        tasks.push(tokio::spawn(async move {
            let key = SlugKey::new(&format!("room-{i}")).unwrap();
            state.room_or_insert(key).is_ok()
        }));
    }

    let mut wins = 0;
    for t in tasks {
        if t.await.unwrap() {
            wins += 1;
        }
    }
    assert_eq!(wins, 4, "exactly max_active_rooms wins expected");
    assert_eq!(app.state.active_rooms.load(Ordering::Acquire), 4);
    assert_eq!(app.state.rooms.len(), 4);

    app.shutdown().await;
}
