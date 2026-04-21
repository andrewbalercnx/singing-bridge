// File: server/src/lib.rs
// Purpose: Library surface so integration tests can reach internals without
//          going through the binary. Re-exports the module tree.
// Role: One-line facade for the binary + tests.
// Exports: auth, blob, cleanup, config, db, error, http, sidecar, state, ws
// Last updated: Sprint 12a (2026-04-21) -- add sidecar module

pub mod auth;
pub mod blob;
pub mod cleanup;
pub mod config;
pub mod db;
pub mod error;
pub mod http;
pub mod sidecar;
pub mod state;
pub mod ws;
