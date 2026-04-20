// File: server/src/auth/mailer.rs
// Purpose: Mailer trait + dev-mode file sink + Azure Communication Services mailer.
// Role: Decouples /signup from any particular delivery channel.
// Exports: Mailer, DevMailer, AcsMailer, MailerError
// Depends: async-trait, reqwest, serde_json, sha2, hex, hmac, base64, url
// Invariants: dev sink files are 0600, directory 0700. Raw tokens appear in
//             the file content but are bounded by the TTL + single-use consume.
//             AcsMailer derives HMAC-SHA256 request signature per ACS docs;
//             connection string is never logged.
// Last updated: Sprint 8 (2026-04-20) -- replace CF Worker mailer with AcsMailer

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::auth::secret::SecretString;

#[derive(Debug, thiserror::Error)]
pub enum MailerError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("upstream error {0}")]
    Upstream(u16),
}

#[async_trait]
pub trait Mailer: Send + Sync + 'static {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError>;
    async fn send_recording_link(&self, to: &str, url: &Url) -> Result<(), MailerError>;
    async fn send_token_disabled_notification(&self, to: &str, url: &Url) -> Result<(), MailerError>;
}

// ---------------------------------------------------------------------------
// DevMailer
// ---------------------------------------------------------------------------

pub struct DevMailer {
    dir: PathBuf,
}

impl DevMailer {
    pub async fn new(dir: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let dir = dir.as_ref().to_path_buf();
        tokio::fs::create_dir_all(&dir).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = tokio::fs::metadata(&dir).await?.permissions();
            p.set_mode(0o700);
            tokio::fs::set_permissions(&dir, p).await?;
        }
        Ok(Self { dir })
    }

    fn file_for(&self, to: &str) -> PathBuf {
        let mut h = Sha256::new();
        h.update(to.to_ascii_lowercase().as_bytes());
        let name = hex::encode(h.finalize());
        self.dir.join(format!("{name}.jsonl"))
    }
}

#[async_trait]
impl Mailer for DevMailer {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        self.write_entry(to, "magic_link", url).await
    }

    async fn send_recording_link(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        self.write_entry(to, "recording_link", url).await
    }

    async fn send_token_disabled_notification(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        self.write_entry(to, "token_disabled", url).await
    }
}

impl DevMailer {
    async fn write_entry(&self, to: &str, kind: &str, url: &Url) -> Result<(), MailerError> {
        tracing::info!(%to, %url, kind, "dev mail");
        #[derive(Serialize)]
        struct Entry<'a> {
            to: &'a str,
            kind: &'a str,
            url: &'a str,
            issued_at: i64,
        }
        let entry = Entry {
            to,
            kind,
            url: url.as_str(),
            issued_at: time::OffsetDateTime::now_utc().unix_timestamp(),
        };
        let line = format!("{}\n", serde_json::to_string(&entry)?);
        let path = self.file_for(to);
        let mut opts = tokio::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            opts.mode(0o600);
        }
        let mut f = opts.open(&path).await?;
        f.write_all(line.as_bytes()).await?;
        f.flush().await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// AcsMailer
// ---------------------------------------------------------------------------

const MAIL_SUBJECT_MAGIC: &str = "Your singing-bridge sign-in link";
const MAIL_SUBJECT_RECORDING: &str = "Your singing lesson recording";
const MAIL_SUBJECT_TOKEN_DISABLED: &str = "Recording access link disabled";

const MAIL_FROM: &str = "noreply@rcnx.io";
const MAIL_FROM_NAME: &str = "singing-bridge";

pub struct AcsMailer {
    endpoint: String,
    access_key: SecretString,
    http: reqwest::Client,
}

impl AcsMailer {
    /// Parse an ACS connection string of the form
    /// `endpoint=https://...;accesskey=<base64>`
    pub fn from_connection_string(conn: &str) -> Result<Self, MailerError> {
        let mut endpoint = None;
        let mut access_key = None;
        for part in conn.split(';') {
            if let Some(v) = part.strip_prefix("endpoint=") {
                endpoint = Some(v.trim_end_matches('/').to_string());
            } else if let Some(v) = part.strip_prefix("accesskey=") {
                access_key = Some(v.to_string());
            }
        }
        let endpoint = endpoint.ok_or_else(|| {
            MailerError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ACS connection string missing endpoint",
            ))
        })?;
        let access_key = access_key.ok_or_else(|| {
            MailerError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ACS connection string missing accesskey",
            ))
        })?;
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("reqwest client build");
        Ok(Self { endpoint, access_key: SecretString::new(&access_key), http })
    }

    async fn send(&self, to: &str, subject: &str, body_text: &str) -> Result<(), MailerError> {
        let url = format!("{}/emails:send?api-version=2023-03-31", self.endpoint);

        let payload = serde_json::json!({
            "senderAddress": MAIL_FROM,
            "recipients": { "to": [{ "address": to, "displayName": to }] },
            "content": {
                "subject": subject,
                "plainText": body_text,
            },
            "replyTo": [{ "address": MAIL_FROM, "displayName": MAIL_FROM_NAME }],
        });
        let body_bytes = serde_json::to_vec(&payload)?;

        // ACS HMAC-SHA256 request signing
        // https://learn.microsoft.com/azure/communication-services/concepts/authentication
        let now = httpdate_now();
        let content_hash = B64.encode(Sha256::digest(&body_bytes));
        let path_and_query = "/emails:send?api-version=2023-03-31";
        let host = self.endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://");

        let string_to_sign = format!("POST\n{path_and_query}\n{now};{host};{content_hash}");

        let raw_key = B64.decode(self.access_key.expose()).map_err(|_| {
            MailerError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ACS access key is not valid base64",
            ))
        })?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&raw_key).expect("HMAC accepts any key size");
        mac.update(string_to_sign.as_bytes());
        let signature = B64.encode(mac.finalize().into_bytes());

        let authorization = format!(
            "HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature={signature}"
        );

        let resp = self.http
            .post(&url)
            .header("Authorization", authorization)
            .header("x-ms-date", &now)
            .header("x-ms-content-sha256", &content_hash)
            .header("host", host)
            .header("content-type", "application/json")
            .body(body_bytes)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(MailerError::Upstream(resp.status().as_u16()));
        }
        Ok(())
    }
}

fn httpdate_now() -> String {
    // ACS requires RFC 7231 date format: "Mon, 01 Jan 2024 00:00:00 GMT"
    let now = time::OffsetDateTime::now_utc();
    let weekday = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][now.weekday() as usize];
    let month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        [now.month() as usize - 1];
    format!(
        "{weekday}, {:02} {month} {} {:02}:{:02}:{:02} GMT",
        now.day(), now.year(), now.hour(), now.minute(), now.second()
    )
}

#[async_trait]
impl Mailer for AcsMailer {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        let body = format!(
            "Hello,\n\nSign in to singing-bridge by opening this link in the same browser:\n\n{url}\n\nThis link expires in 15 minutes.\n"
        );
        self.send(to, MAIL_SUBJECT_MAGIC, &body).await
    }

    async fn send_recording_link(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        let body = format!(
            "Hello,\n\nYour singing lesson recording is available. Open this link to download it:\n\n{url}\n\nThis link expires after first use.\n"
        );
        self.send(to, MAIL_SUBJECT_RECORDING, &body).await
    }

    async fn send_token_disabled_notification(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        let body = format!(
            "Hello,\n\nAccess to the following recording link has been disabled by your teacher:\n\n{url}\n"
        );
        self.send(to, MAIL_SUBJECT_TOKEN_DISABLED, &body).await
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // Fake connection string pointing at the mock server.
    fn make_mailer(mock: &MockServer) -> AcsMailer {
        // The mock URI is http://127.0.0.1:<port>; we need a base64 access key.
        let fake_key = B64.encode(b"test-signing-key-32-bytes-padded");
        let conn = format!("endpoint={};accesskey={fake_key}", mock.uri());
        AcsMailer::from_connection_string(&conn).unwrap()
    }

    #[tokio::test]
    async fn acs_mailer_posts_to_emails_send() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/emails:send"))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock);
        let link = Url::parse("https://singing.rcnx.io/auth/verify#token=abc").unwrap();
        mailer.send_magic_link("user@example.com", &link).await.unwrap();

        mock.verify().await;
    }

    #[tokio::test]
    async fn acs_mailer_includes_hmac_auth_header() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::header_exists("Authorization"))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock);
        let link = Url::parse("https://singing.rcnx.io/auth/verify#token=abc").unwrap();
        mailer.send_magic_link("user@example.com", &link).await.unwrap();

        let reqs = mock.received_requests().await.unwrap();
        let auth = reqs[0].headers.get("authorization").unwrap().to_str().unwrap();
        assert!(auth.starts_with("HMAC-SHA256 "), "expected HMAC-SHA256 auth, got: {auth}");
        mock.verify().await;
    }

    #[tokio::test]
    async fn upstream_error_maps_to_upstream_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock);
        let link = Url::parse("https://singing.rcnx.io/auth/verify#token=abc").unwrap();
        let err = mailer.send_magic_link("user@example.com", &link).await.unwrap_err();
        assert!(matches!(err, MailerError::Upstream(500)));
    }

    #[tokio::test]
    async fn payload_contains_sender_and_recipient() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock);
        let link = Url::parse("https://singing.rcnx.io/auth/verify#token=abc").unwrap();
        mailer.send_magic_link("user@example.com", &link).await.unwrap();

        let reqs = mock.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body["senderAddress"], MAIL_FROM);
        assert_eq!(body["recipients"]["to"][0]["address"], "user@example.com");
        assert_eq!(body["content"]["subject"], MAIL_SUBJECT_MAGIC);
    }
}
