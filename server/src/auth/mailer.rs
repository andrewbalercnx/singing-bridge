// File: server/src/auth/mailer.rs
// Purpose: Mailer trait + dev-mode file sink + Cloudflare Worker relay.
// Role: Decouples /signup from any particular delivery channel.
// Exports: Mailer, DevMailer, CloudflareWorkerMailer, MailerError
// Depends: async-trait, reqwest, serde_json, sha2, hex, url
// Invariants: dev sink files are 0600, directory 0700. Raw tokens appear in
//             the file content but are bounded by the TTL + single-use consume.
//             CloudflareWorkerMailer never sends `from` in the request body;
//             the Worker takes `from` from its own env config only.
// Last updated: Sprint 5 (2026-04-18) -- add CloudflareWorkerMailer, R1 fixes

use std::path::{Path, PathBuf};

use async_trait::async_trait;
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
}

// ---------------------------------------------------------------------------
// DevMailer
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct DevMailEntry<'a> {
    to: &'a str,
    url: &'a str,
    issued_at: i64,
}

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
        tracing::info!(%to, %url, "dev magic link");
        let entry = DevMailEntry {
            to,
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
// CloudflareWorkerMailer
// ---------------------------------------------------------------------------

const MAIL_SUBJECT: &str = "Your singing-bridge sign-in link";

pub struct CloudflareWorkerMailer {
    worker_url: Url,
    bearer_secret: SecretString,
    http: reqwest::Client,
}

impl CloudflareWorkerMailer {
    pub fn new(worker_url: Url, bearer_secret: SecretString) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client build");
        Self { worker_url, bearer_secret, http }
    }
}

#[async_trait]
impl Mailer for CloudflareWorkerMailer {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError> {
        let body = serde_json::json!({
            "to": to,
            "subject": MAIL_SUBJECT,
            "url": url.as_str(),
            // "from" is NOT included — the Worker reads MAIL_FROM from its own env config
        });
        let resp = self
            .http
            .post(self.worker_url.clone())
            .bearer_auth(self.bearer_secret.expose())
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(MailerError::Upstream(resp.status().as_u16()));
        }
        Ok(())
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

    async fn make_mailer(mock: &MockServer) -> CloudflareWorkerMailer {
        let url = Url::parse(&mock.uri()).unwrap().join("/send").unwrap();
        CloudflareWorkerMailer::new(url, SecretString::new("test-secret"))
    }

    #[tokio::test]
    async fn cf_worker_mailer_posts_expected_json() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/send"))
            .and(header("Authorization", "Bearer test-secret"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock).await;
        let link = Url::parse("https://singing.rcnx.io/verify?token=abc").unwrap();
        mailer.send_magic_link("user@example.com", &link).await.unwrap();

        mock.verify().await;
    }

    #[tokio::test]
    async fn upstream_500_maps_to_upstream_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock).await;
        let link = Url::parse("https://singing.rcnx.io/verify?token=abc").unwrap();
        let err = mailer.send_magic_link("user@example.com", &link).await.unwrap_err();
        assert!(matches!(err, MailerError::Upstream(500)));
    }

    #[tokio::test]
    async fn total_timeout_fires() {
        // Stalls response body for 11 s — exceeds the 10 s total timeout.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_secs(11)),
            )
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock).await;
        let link = Url::parse("https://singing.rcnx.io/verify?token=abc").unwrap();
        let err = mailer.send_magic_link("user@example.com", &link).await.unwrap_err();
        assert!(matches!(err, MailerError::Http(_)));
    }

    #[tokio::test]
    async fn body_does_not_contain_from_field() {
        // Verifies that the JSON body captured by the mock does not include `from`.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;

        let mailer = make_mailer(&mock).await;
        let link = Url::parse("https://singing.rcnx.io/verify?token=abc").unwrap();
        mailer.send_magic_link("user@example.com", &link).await.unwrap();

        let reqs = mock.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert!(body.get("from").is_none(), "body must not include `from`");
        assert_eq!(body["to"], "user@example.com");
        assert_eq!(body["subject"], MAIL_SUBJECT);
    }
}
