// File: server/src/auth/mailer.rs
// Purpose: Mailer trait + dev-mode file sink. Real SMTP lives in Sprint 5.
// Role: Decouples /signup from any particular delivery channel.
// Exports: Mailer, DevMailer, MailerError
// Depends: async-trait, serde, sha2, hex
// Invariants: dev sink files are 0600, directory 0700. Raw tokens appear in
//             the file content but are bounded by the TTL + single-use consume.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum MailerError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

#[async_trait]
pub trait Mailer: Send + Sync + 'static {
    async fn send_magic_link(&self, to: &str, url: &Url) -> Result<(), MailerError>;
}

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
