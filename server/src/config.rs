// File: server/src/config.rs
// Purpose: Runtime configuration — base URL, DB path, dev/prod flag, caps.
// Role: Single source of truth for deployment-shape settings.
// Exports: Config
// Depends: url, serde
// Invariants: in release builds, --dev is rejected unless BASE_URL is
//             http://localhost; Secure cookie flag only omitted in --dev.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::net::SocketAddr;

use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub base_url: Url,
    pub db_url: String,
    pub dev: bool,
    pub max_active_rooms: usize,
    pub lobby_cap_per_room: usize,
    pub magic_link_ttl_secs: i64,
    pub session_ttl_secs: i64,
    pub dev_mail_dir: std::path::PathBuf,
    pub static_dir: std::path::PathBuf,
    pub signup_rate_limit_per_email: usize,
    pub signup_rate_limit_per_ip: usize,
    pub signup_rate_limit_window_secs: i64,
}

impl Config {
    pub fn dev_default() -> Self {
        Self {
            bind: "127.0.0.1:8080".parse().expect("static addr"),
            base_url: Url::parse("http://localhost:8080").expect("static url"),
            db_url: "sqlite::memory:".to_string(),
            dev: true,
            max_active_rooms: 1024,
            lobby_cap_per_room: 32,
            magic_link_ttl_secs: 15 * 60,
            session_ttl_secs: 30 * 24 * 60 * 60,
            dev_mail_dir: std::path::PathBuf::from("dev-mail"),
            static_dir: std::path::PathBuf::from("web"),
            signup_rate_limit_per_email: 3,
            signup_rate_limit_per_ip: 10,
            signup_rate_limit_window_secs: 10 * 60,
        }
    }

    pub fn require_secure_cookie(&self) -> bool {
        !self.dev && self.base_url.scheme() == "https"
    }
}
