// File: server/src/config.rs
// Purpose: Runtime configuration — env-driven in prod, dev_default() in dev/tests.
// Role: Single source of truth for deployment-shape settings.
// Exports: Config, ConfigError, MailerKind
// Depends: url, serde, auth::secret
// Invariants: from_env() calls parse_env() then validate_prod_config() for SB_ENV=prod.
//             In prod: HTTPS required, secrets present, pepper ≥ 32 bytes,
//             SB_DATABASE_URL must include sslmode=verify-full and must not be localhost.
//             SB_DATABASE_URL is always required (no fallback) — server refuses to start without it.
//             Secure cookie flag only omitted when dev=true.
// Last updated: Sprint 22 (2026-04-26) -- add azure_storage_connection_string / azure_storage_container

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
    Acs,
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
    pub acs_connection_string: Option<SecretString>,
    // IP trust
    pub trust_forwarded_for: bool,
    // WS join rate limit
    pub ws_join_rate_limit_per_ip: usize,
    pub ws_join_rate_limit_window_secs: i64,
    // Block
    pub lobby_block_default_ttl_secs: i64,
    // Session log
    pub session_log_pepper: Option<SecretString>,
    // Recording
    pub dev_blob_dir: std::path::PathBuf,
    pub recording_max_bytes: u64,
    pub recording_link_ttl_secs: i64,
    pub gate_rate_limit_per_ip: usize,
    pub gate_rate_limit_window_secs: i64,
    // Password auth
    pub password_reset_enabled: bool,
    pub login_account_window_secs: i64,
    pub login_account_max_failures: u32,
    pub login_ip_window_secs: i64,
    pub login_ip_max_attempts: u32,
    // Blob storage — when set, AzureBlobStore is used; otherwise DevBlobStore.
    pub azure_storage_connection_string: Option<SecretString>,
    pub azure_storage_container: Option<String>,
    // Migrations — optional DDL-capable URL; when set, run sqlx migrations at startup.
    pub migrate_url: Option<String>,
    // Sidecar
    pub sidecar_url: Url,
    pub sidecar_secret: SecretString,
    /// Comma-separated list of exact host/IP strings allowed as sidecar hosts
    /// beyond loopback. Private IPs are blocked unless listed here.
    pub sidecar_host_allowlist: Vec<String>,
    // Accompaniment
    pub accomp_upload_max_bytes: u64,
    pub media_token_ttl_secs: u64,
}

impl Config {
    pub fn dev_default() -> Self {
        Self {
            bind: "127.0.0.1:8080".parse().expect("static addr"),
            base_url: Url::parse("http://localhost:8080").expect("static url"),
            db_url: "postgres://localhost:5432/singing_bridge".to_string(),
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
            acs_connection_string: None,
            trust_forwarded_for: false,
            ws_join_rate_limit_per_ip: 20,
            ws_join_rate_limit_window_secs: 60,
            lobby_block_default_ttl_secs: 600,
            session_log_pepper: None, // dev: use compile-time constant in session_log.rs
            dev_blob_dir: std::path::PathBuf::from("dev-blobs"),
            recording_max_bytes: 512 * 1024 * 1024,
            recording_link_ttl_secs: 900,
            gate_rate_limit_per_ip: 10,
            gate_rate_limit_window_secs: 300,
            password_reset_enabled: false,
            login_account_window_secs: 900,
            login_account_max_failures: 10,
            login_ip_window_secs: 300,
            login_ip_max_attempts: 20,
            azure_storage_connection_string: None,
            azure_storage_container: None,
            migrate_url: None,
            sidecar_url: Url::parse("http://127.0.0.1:5050").expect("static sidecar url"),
            sidecar_secret: SecretString::new("dev-sidecar-secret"),
            sidecar_host_allowlist: vec![],
            accomp_upload_max_bytes: 50 * 1024 * 1024,
            media_token_ttl_secs: 300,
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
        let db_url = std::env::var("SB_DATABASE_URL")
            .map_err(|_| ConfigError::Missing("SB_DATABASE_URL"))?;
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

        let mailer_kind = if dev { MailerKind::Dev } else { MailerKind::Acs };
        let acs_connection_string = std::env::var("SB_ACS_CONNECTION_STRING")
            .ok()
            .map(|s| SecretString::new(&s));

        let session_log_pepper = std::env::var("SB_SESSION_LOG_PEPPER")
            .ok()
            .map(SecretString::new);

        let azure_storage_connection_string = std::env::var("SB_AZURE_STORAGE_CONNECTION_STRING")
            .ok()
            .map(|s| SecretString::new(&s));
        let azure_storage_container = std::env::var("SB_AZURE_STORAGE_CONTAINER").ok();
        if azure_storage_connection_string.is_some() != azure_storage_container.is_some() {
            return Err(ConfigError::Invalid(
                "SB_AZURE_STORAGE_CONNECTION_STRING / SB_AZURE_STORAGE_CONTAINER",
                "both must be set together or neither set".into(),
            ));
        }

        let migrate_url = std::env::var("SB_MIGRATE_URL").ok();

        let sidecar_url_str = std::env::var("SIDECAR_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:5050".into());
        let sidecar_url = Url::parse(&sidecar_url_str)
            .map_err(|e| ConfigError::Invalid("SIDECAR_URL", format!("{e}")))?;

        let sidecar_secret = SecretString::new(
            std::env::var("SIDECAR_SECRET").unwrap_or_else(|_| "dev-sidecar-secret".into()),
        );

        let sidecar_host_allowlist: Vec<String> = std::env::var("SIDECAR_HOST_ALLOWLIST")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

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

        let dev_blob_dir = data_dir.join("dev-blobs");
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
            acs_connection_string,
            trust_forwarded_for: !dev,
            ws_join_rate_limit_per_ip,
            ws_join_rate_limit_window_secs,
            lobby_block_default_ttl_secs: 600,
            session_log_pepper,
            dev_blob_dir,
            recording_max_bytes: 512 * 1024 * 1024,
            recording_link_ttl_secs: 900,
            gate_rate_limit_per_ip: 10,
            gate_rate_limit_window_secs: 300,
            password_reset_enabled: false,
            login_account_window_secs: 900,
            login_account_max_failures: 10,
            login_ip_window_secs: 300,
            login_ip_max_attempts: 20,
            azure_storage_connection_string,
            azure_storage_container,
            migrate_url,
            sidecar_url,
            sidecar_secret,
            sidecar_host_allowlist,
            accomp_upload_max_bytes: 50 * 1024 * 1024,
            media_token_ttl_secs: 300,
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
    // Reject libpq DSN-style strings (e.g. "host=... sslmode=require") — these
    // are not URLs and the rest of the validation assumes URL form.
    if !c.db_url.starts_with("postgres://") && !c.db_url.starts_with("postgresql://") {
        return Err(ConfigError::Invalid(
            "SB_DATABASE_URL",
            "must be a URL starting with postgres:// or postgresql://, not a libpq DSN string".into(),
        ));
    }
    // Require verified TLS for production database connections.
    // Parse sslmode as a complete query parameter to avoid substring false-positives.
    let has_verify_full = c.db_url.find('?').map_or(false, |idx| {
        c.db_url[idx + 1..].split('&').any(|p| p == "sslmode=verify-full")
    });
    if !has_verify_full {
        return Err(ConfigError::Invalid(
            "SB_DATABASE_URL",
            "production database URL must include sslmode=verify-full".into(),
        ));
    }
    // Reject loopback database connections (catches test DB misconfiguration).
    if c.db_url.contains("localhost")
        || c.db_url.contains("127.0.0.1")
        || c.db_url.contains("[::1]")
    {
        return Err(ConfigError::Invalid(
            "SB_DATABASE_URL",
            "production database URL must not point at localhost".into(),
        ));
    }
    let secret = c
        .turn_shared_secret
        .as_ref()
        .ok_or(ConfigError::Missing("SB_TURN_SHARED_SECRET"))?;
    if secret.len() < 32 {
        return Err(ConfigError::TooShort("SB_TURN_SHARED_SECRET", 32));
    }
    c.acs_connection_string
        .as_ref()
        .ok_or(ConfigError::Missing("SB_ACS_CONNECTION_STRING"))?;
    let pepper = c
        .session_log_pepper
        .as_ref()
        .ok_or(ConfigError::Missing("SB_SESSION_LOG_PEPPER"))?;
    if pepper.len() < 32 {
        return Err(ConfigError::TooShort("SB_SESSION_LOG_PEPPER", 32));
    }
    // Sidecar secret must be at least 32 bytes in prod.
    if c.sidecar_secret.len() < 32 {
        return Err(ConfigError::TooShort("SIDECAR_SECRET", 32));
    }
    // Sidecar URL must point at loopback or an explicitly allowlisted host.
    validate_sidecar_url(&c.sidecar_url, &c.sidecar_host_allowlist)?;
    Ok(())
}

/// Validates that `url` points at a loopback address or is explicitly
/// allowlisted. Blocks private/link-local IPs unless allowlisted.
pub fn validate_sidecar_url(url: &Url, allowlist: &[String]) -> Result<(), ConfigError> {
    let host = url
        .host_str()
        .ok_or_else(|| ConfigError::Invalid("SIDECAR_URL", "missing host".into()))?;

    // Loopback is always allowed.
    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return Ok(());
    }

    // Check against exact allowlist entries.
    for entry in allowlist {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        // Parse as a URL to extract the host_str for comparison.
        if let Ok(probe) = Url::parse(&format!("http://{entry}/")) {
            if probe.host_str() == Some(host) {
                return Ok(());
            }
        }
        // Also accept bare IP/hostname match.
        if entry == host {
            return Ok(());
        }
    }

    // Block private/link-local IPs not in the allowlist.
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_private_or_link_local(ip) {
            return Err(ConfigError::Invalid(
                "SIDECAR_URL",
                format!("private/link-local IP {ip} not in SIDECAR_HOST_ALLOWLIST"),
            ));
        }
    }

    // Non-loopback, non-allowlisted host.
    Err(ConfigError::Invalid(
        "SIDECAR_URL",
        format!("host '{host}' not in SIDECAR_HOST_ALLOWLIST; set the allowlist or use loopback"),
    ))
}

fn is_private_or_link_local(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local() || v4.is_loopback()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local
        }
    }
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

    fn prod_base(acs: bool) -> Config {
        let mut c = Config::dev_default();
        c.dev = false;
        c.base_url = Url::parse("https://singing.rcnx.io").unwrap();
        c.db_url = "postgres://sbapp:pass@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full".to_string();
        c.turn_shared_secret = Some(SecretString::new("a".repeat(32)));
        c.session_log_pepper = Some(SecretString::new("y".repeat(32)));
        c.sidecar_secret = SecretString::new("s".repeat(32));
        if acs {
            c.acs_connection_string = Some(SecretString::new(
                "endpoint=https://sb.uk.communication.azure.com/;accesskey=dGVzdA==",
            ));
        }
        c
    }

    #[test]
    fn prod_short_turn_secret_errors() {
        let mut c = prod_base(true);
        c.turn_shared_secret = Some(SecretString::new("a".repeat(31)));
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::TooShort("SB_TURN_SHARED_SECRET", 32)));
    }

    #[test]
    fn prod_valid_config_passes() {
        assert!(validate_prod_config(&prod_base(true)).is_ok());
    }

    #[test]
    fn prod_missing_acs_errors() {
        let c = prod_base(false);
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Missing("SB_ACS_CONNECTION_STRING")));
    }

    #[test]
    fn prod_missing_pepper_errors() {
        let mut c = prod_base(true);
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

    #[test]
    fn prod_missing_verify_full_errors() {
        let mut c = prod_base(true);
        c.db_url = "postgres://sbapp:pass@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require".to_string();
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Invalid("SB_DATABASE_URL", _)));
    }

    #[test]
    fn prod_localhost_db_errors() {
        let mut c = prod_base(true);
        c.db_url = "postgres://sbapp:pass@localhost:5432/singing_bridge?sslmode=verify-full".to_string();
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Invalid("SB_DATABASE_URL", _)));
    }

    #[test]
    fn prod_ipv6_loopback_db_errors() {
        let mut c = prod_base(true);
        c.db_url = "postgres://sbapp:pass@[::1]:5432/singing_bridge?sslmode=verify-full".to_string();
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Invalid("SB_DATABASE_URL", _)));
    }

    #[test]
    fn prod_verify_full_substring_not_enough() {
        let mut c = prod_base(true);
        c.db_url = "postgres://sbapp:pass@vvp-postgres.postgres.database.azure.com/singing_bridge_sslmode=verify-full".to_string();
        let err = validate_prod_config(&c).unwrap_err();
        assert!(matches!(err, ConfigError::Invalid("SB_DATABASE_URL", _)));
    }

    #[test]
    fn prod_dsn_style_url_errors() {
        let mut c = prod_base(true);
        c.db_url = "host=vvp-postgres.postgres.database.azure.com dbname=singing_bridge sslmode=verify-full".to_string();
        let err = validate_prod_config(&c).unwrap_err();
        assert!(
            matches!(err, ConfigError::Invalid("SB_DATABASE_URL", _)),
            "DSN-style string must be rejected with a clear message"
        );
    }

    /// Verify that `from_env()` returns `Missing("SB_DATABASE_URL")` when the
    /// variable is absent. Uses `remove_var` which is process-global — this test
    /// must run in isolation (unit tests are single-threaded by default with
    /// `cargo test -- --test-threads=1`, or rely on no concurrent test touching
    /// the same var).
    #[test]
    fn parse_env_missing_database_url_errors() {
        let saved = std::env::var("SB_DATABASE_URL").ok();
        let saved_env = std::env::var("SB_ENV").ok();
        // SAFETY: single-threaded unit test context; no other thread reads these vars.
        unsafe {
            std::env::remove_var("SB_DATABASE_URL");
            std::env::remove_var("SB_ENV");
        }

        let result = Config::from_env();

        unsafe {
            if let Some(v) = saved { std::env::set_var("SB_DATABASE_URL", v); }
            if let Some(v) = saved_env { std::env::set_var("SB_ENV", v); }
        }

        assert!(
            matches!(result, Err(ConfigError::Missing("SB_DATABASE_URL"))),
            "expected Missing(SB_DATABASE_URL), got {result:?}"
        );
    }
}
