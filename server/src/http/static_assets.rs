// File: server/src/http/static_assets.rs
// Purpose: Serve /assets/* from `web/assets/` on disk (dev + release this sprint).
// Role: Embedding via rust-embed is deferred to Sprint 5 deploy work; for
//       now the deployment target mounts `web/` alongside the binary.
// Exports: routes
// Depends: tower-http ServeDir
// Invariants: no route overlaps handlers in http::mod.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::sync::Arc;

use axum::Router;
use tower_http::services::ServeDir;

use crate::config::Config;
use crate::state::AppState;

pub fn routes(config: &Config) -> Router<Arc<AppState>> {
    let assets_dir = config.static_dir.join("assets");
    Router::new().nest_service("/assets", ServeDir::new(assets_dir))
}
