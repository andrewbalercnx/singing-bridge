// File: server/src/lib.rs
// Purpose: Library surface so integration tests can reach internals without
//          going through the binary. Re-exports the module tree.
// Role: One-line facade for the binary + tests.
// Exports: auth, blob, cleanup, config, db, error, http, state, ws
// Last updated: Sprint 6 (2026-04-18) -- add blob, cleanup modules

pub mod auth;
pub mod blob;
pub mod cleanup;
pub mod config;
pub mod db;
pub mod error;
pub mod http;
pub mod state;
pub mod ws;
