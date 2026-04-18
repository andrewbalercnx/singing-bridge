// File: server/src/config.rs
// Purpose: Runtime configuration — env-driven in prod, dev_default() in dev/tests.
// Role: Single source of truth for deployment-shape settings.
// Exports: Config, ConfigError, MailerKind
// Depends: url, serde, auth::secret
// Invariants: from_env() calls parse_env() then validate_prod_config() for SB_ENV=prod.
//             In prod: HTTPS required, secrets present, pepper ≥ 32 bytes.
//             Secure cookie flag only omitted when dev=true.
// Last updated: Sprint 5 (2026-04-18) -- env-driven config, turn/mailer/session-log fields
#![allow(dead_code)]

use std::net::SocketAddr;

use url::Url;

use crate::auth::secret::SecretString;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required env var: {0}")]
    Missing(&'static str),
    #[error("invalid value for {0}: {1}")]
    Invalid(&'static str, String),
    #[error("secret too short: {0} must be at least {1} bytes")]
    TooShort(&'static str, usize),
    #[error("prod requires HTTPS base URL")]
    HttpsRequired,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailerKind {
    Dev,
    CloudflareWorker,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub base_url: Url,
    pub db_url: String,
    pub dev: bool,
    pub data_dir: std::path::PathBuf,
    pub max_active_rooms: usize,
    pub lobby_cap_per_room: usize,
    pub magic_link_ttl_secs: i64,
    pub session_ttl_secs: i64,
    pub dev_mail_dir: std::path::PathBuf,
    pub static_dir: std::path::PathBuf,
    pub signup_rate_limit_per_email: usize,
    pub signup_rate_limit_per_ip: usize,
    pub signup_rate_limit_window_secs: i64,
    // TURN
    pub turn_host: Option<String>,
    pub turn_shared_secret: Option<SecretString>,
    pub turn_ttl_secs: i64,
    pub turn_cred_rate_limit_per_ip: usize,
    pub turn_cred_rate_limit_window_secs: i64,
    // Mailer
    pub mailer_kind: MailerKind,
    pub cf_worker_url: Option<String>,
    pub cf_worker_secret: Option<SecretString>,
    // IP trust
    pub trust_forwarded_for: bool,
    // WS join rate limit
    pub ws_join_rate_limit_per_ip: usize,
    pub ws_join_rate_limit_window_secs: i64,
    // Block
    pub lobby_block_default_ttl_secs: i64,
    // Session log
    pub session_log_pepper: Option<SecretString>,
}

impl Config {
    pub fn dev_default() -> Self {
        Self {
            bind: "127.0.0.1:8080".parse().expect("static addr"),
            base_url: Url::parse("http://localhost:8080").expect("static url"),
            db_url: "sqlite::memory:".to_string(),
            dev: true,
            data_dir: std::path::PathBuf::from("data"),
            max_active_rooms: 1024,
            lobby_cap_per_room: 10,
            magic_link_ttl_secs: 15 * 60,
            session_ttl_secs: 30 * 24 * 60 * 60,
            dev_mail_dir: std::path::PathBuf::from("dev-mail"),
            static_dir: std::path::PathBuf::from("web"),
            signup_rate_limit_per_email: 3,
            signup_rate_limit_per_ip: 10,
            signup_rate_limit_window_secs: 10 * 60,
            turn_host: None,
            turn_shared_secret: None,
            turn_ttl_secs: 600,
            turn_cred_rate_limit_per_ip: 10,
            turn_cred_rate_limit_window_secs: 60,
            mailer_kind: MailerKind::Dev,
            cf_worker_url: None,
            cf_worker_secret: None,
            trust_forwarded_for: false,
            ws_join_rate_limit_per_ip: 20,
            ws_join_rate_limit_window_secs: 60,
            lobby_block_default_ttl_secs: 600,
            session_log_pepper: None, // dev: use compile-time constant in session_log.rs
        }
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        let c = Self::parse_env()?;
        if !c.dev {
            validate_prod_config(&c)?;
        }
        Ok(c)
    }

    fn parse_env() -> Result<Self, ConfigError> {
        let dev = std::env::var("SB_ENV").unwrap_or_default() != "prod";

        let bind: SocketAddr = std::env::var("SB_BIND")
            .unwrap_or_else(|_| if dev { "127.0.0.1:8080".into() } else { "0.0.0.0:8080".into() })
            .parse()
            .map_err(|e| ConfigError::Invalid("SB_BIND", format!("{e}")))?;

        let base_url = std::env::var("SB_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:8080".into());
        let base_url = Url::parse(&base_url)
            .map_err(|e| ConfigError::Invalid("SB_BASE_URL", format!("{e}")))?;

        let data_dir = std::path::PathBuf::from(
            std::env::var("SB_DATA_DIR").unwrap_or_else(|_| "data".into()),
        );
        let db_url = if dev {
            "sqlite::memory:".to_string()
        } else {
            format!("sqlite:{}/singing-bridge.db?mode=rwc", data_dir.display())
        };
        let static_dir = std::path::PathBuf::from(
            std::env::var("SB_STATIC_DIR").unwrap_or_else(|_| "web".into()),
        );
        let dev_mail_dir = data_dir.join("dev-mail");

        let turn_host = std::env::var("SB_TURN_HOST").ok();
        let turn_shared_secret = std::env::var("SB_TURN_SHARED_SECRET")
            .ok()
            .map(SecretString::new);
        let turn_ttl_secs: i64 = std::env::var("SB_TURN_TTL_SECS")
            .unwrap_or_else(|_| "600".into())
            .parse()
            .map_err(|e| ConfigError::Invalid("SB_TURN_TTL_SECS", format!("{e}")))?;

        let mailer_kind = if dev {
            MailerKind::Dev
        } else {
            MailerKind::CloudflareWorker
        };
        let cf_worker_url = std::env::var("SB_CF_WORKER_URL").ok();
        let cf_worker_secret = std::env::var("SB_CF_WORKER_SECRET")
            .ok()
            .map(SecretString::new);

        let session_log_pepper = std::env::var("SB_SESSION_LOG_PEPPER")
            .ok()
            .map(SecretString::new);

        let ws_join_rate_limit_per_ip: usize = std::env::var("SB_WS_JOIN_RATE_LIMIT_PER_IP")
            .unwrap_or_else(|_| "20".into())
            .parse()
            .map_err(|e| ConfigError::Invalid("SB_WS_JOIN_RATE_LIMIT_PER_IP", format!("{e}")))?;
        let ws_join_rate_limit_window_secs: i64 =
            std::env::var("SB_WS_JOIN_RATE_LIMIT_WINDOW_SECS")
                .unwrap_or_else(|_| "60".into())
                .parse()
                .map_err(|e| {
                    ConfigError::Invalid("SB_WS_JOIN_RATE_LIMIT_WINDOW_SECS", format!("{e}"))
                })?;

        Ok(Self {
            bind,
            base_url,
            db_url,
            dev,
            data_dir,
            max_active_rooms: 1024,
            lobby_cap_per_room: 10,
            magic_link_ttl_secs: 15 * 60,
            session_ttl_secs: 30 * 24 * 60 * 60,
            dev_mail_dir,
            static_dir,
            signup_rate_limit_per_email: 3,
            signup_rate_limit_per_ip: 10,
            signup_rate_limit_window_secs: 10 * 60,
            turn_host,
            turn_shared_secret,
            turn_ttl_secs,
            turn_cred_rate_limit_per_ip: 10,
            turn_cred_rate_limit_window_secs: 60,
            mailer_kind,
            cf_worker_url,
            cf_worker_secret,
            trust_forwarded_for: !dev,
            ws_join_rate_limit_per_ip,
            ws_join_rate_limit_window_secs,
            lobby_block_default_ttl_secs: 600,
            session_log_pepper,
        })
    }

    pub fn require_secure_cookie(&self) -> bool {
        !self.dev && self.base_url.scheme() == "https"
    }
}

fn validate_prod_config(c: &Config) -> Result<(), ConfigError> {
    if c.base_url.scheme() != "https" {
        return Err(ConfigError::HttpsRequired);
    }
    let secret = c
        .turn_shared_secret
        .as_ref()
        .ok_or(ConfigError::Missing("SB_TURN_SHARED_SECRET"))?;
    if secret.len() < 32 {
        return Err(ConfigError::TooShort("SB_TURN_SHARED_SECRET", 32));
    }
    let _worker_url = c
        .cf_worker_url
        .as_ref()
        .ok_or(ConfigError::Missing("SB_CF_WORKER_URL"))?;
    let _worker_secret = c
        .cf_worker_secret
        .as_ref()
        .ok_or(ConfigError::Missing("SB_CF_WORKER_SECRET"))?;
    let pepper = c
        .session_log_pepper
        .as_ref()
        .ok_or(ConfigError::Missing("SB_SESSION_LOG_PEPPER"))?;
    if pepper.len() < 32 {
        return Err(ConfigError::TooShort("SB_SESSION_LOG_PEPPER", 32));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_default_lobby_cap_is_10() {
        assert_eq!(Config::dev_default().lobby_cap_per_room, 10);
    }

    #[test]
    fn dev_default_is_dev() {
        assert!(Config::dev_default().dev);
    }

    #[test]
    fn prod_missing_turn_secret_errors() {
        let mut c = Config::dev_default();
        c.dev = false;
        c.base_url = Url::parse("https://singing.rcnx.io").unwrap();
        c.turn_shared_secret = None;
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Missing("SB_TURN_SHARED_SECRET")));
    }

    #[test]
    fn prod_short_turn_secret_errors() {
        let mut c = Config::dev_default();
        c.dev = false;
        c.base_url = Url::parse("https://singing.rcnx.io").unwrap();
        c.turn_shared_secret = Some(SecretString::new("a".repeat(31)));
        c.cf_worker_url = Some("https://mail.example.com".into());
        c.cf_worker_secret = Some(SecretString::new("x".repeat(32)));
        c.session_log_pepper = Some(SecretString::new("y".repeat(32)));
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::TooShort("SB_TURN_SHARED_SECRET", 32)));
    }

    #[test]
    fn prod_valid_32_byte_secret_passes() {
        let mut c = Config::dev_default();
        c.dev = false;
        c.base_url = Url::parse("https://singing.rcnx.io").unwrap();
        c.turn_shared_secret = Some(SecretString::new("a".repeat(32)));
        c.cf_worker_url = Some("https://mail.example.com".into());
        c.cf_worker_secret = Some(SecretString::new("x".repeat(32)));
        c.session_log_pepper = Some(SecretString::new("y".repeat(32)));
        assert!(validate_prod_config(&c).is_ok());
    }

    #[test]
    fn prod_missing_pepper_errors() {
        let mut c = Config::dev_default();
        c.dev = false;
        c.base_url = Url::parse("https://singing.rcnx.io").unwrap();
        c.turn_shared_secret = Some(SecretString::new("a".repeat(32)));
        c.cf_worker_url = Some("https://mail.example.com".into());
        c.cf_worker_secret = Some(SecretString::new("x".repeat(32)));
        c.session_log_pepper = None;
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Missing("SB_SESSION_LOG_PEPPER")));
    }

    #[test]
    fn prod_http_base_url_errors() {
        let c = Config::dev_default();
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::HttpsRequired));
    }
}
