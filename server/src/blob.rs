// File: server/src/blob.rs
// Purpose: BlobStore trait + DevBlobStore (flat temp-dir files).
// Role: Decouples recording upload/download from any particular storage backend.
// Exports: BlobStore, DevBlobStore, BlobError
// Depends: async-trait, tokio, tokio-util, futures, url
// Invariants: DevBlobStore keys are flat "{uuid}.webm" — no slashes, no dots-dot.
//             get_url returns a /api/dev-blob/{key} path (dev only).
//             AzureBlobStore (prod) is a future Sprint 5+ addition outside this file.
// Last updated: Sprint 6 (2026-04-18) -- initial implementation

use std::path::{Path, PathBuf};
use std::pin::Pin;

use async_trait::async_trait;
use tokio::io::AsyncRead;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("key rejected: {0}")]
    InvalidKey(&'static str),
    #[error("not found")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, BlobError>;

#[async_trait]
pub trait BlobStore: Send + Sync + 'static {
    /// Store `data` under `key`; returns bytes written.
    async fn put(&self, key: &str, data: Pin<Box<dyn AsyncRead + Send>>) -> Result<u64>;
    /// Return a URL from which the blob can be read.
    async fn get_url(&self, key: &str, base_url: &Url) -> Result<Url>;
    /// Delete the blob. Not-found is silently ignored.
    async fn delete(&self, key: &str) -> Result<()>;
}

// ---------------------------------------------------------------------------
// DevBlobStore
// ---------------------------------------------------------------------------

pub struct DevBlobStore {
    dir: PathBuf,
}

impl DevBlobStore {
    pub async fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        tokio::fs::create_dir_all(&dir).await?;
        Ok(Self { dir })
    }

    fn validate_key(key: &str) -> Result<()> {
        if key.contains("..") {
            return Err(BlobError::InvalidKey("key contains '..'"));
        }
        if key.contains('/') {
            return Err(BlobError::InvalidKey("key contains '/'"));
        }
        Ok(())
    }

    fn path_for(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }
}

#[async_trait]
impl BlobStore for DevBlobStore {
    async fn put(&self, key: &str, mut data: Pin<Box<dyn AsyncRead + Send>>) -> Result<u64> {
        Self::validate_key(key)?;
        let path = self.path_for(key);
        let mut file = tokio::fs::File::create(&path).await?;
        let bytes_written = tokio::io::copy(&mut data, &mut file).await?;
        Ok(bytes_written)
    }

    async fn get_url(&self, key: &str, base_url: &Url) -> Result<Url> {
        Self::validate_key(key)?;
        let path = self.path_for(key);
        if !path.exists() {
            return Err(BlobError::NotFound);
        }
        let url = base_url
            .join(&format!("api/dev-blob/{key}"))
            .map_err(|_| BlobError::InvalidKey("url join failed"))?;
        Ok(url)
    }

    async fn delete(&self, key: &str) -> Result<()> {
        Self::validate_key(key)?;
        let path = self.path_for(key);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(BlobError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    async fn make_store() -> (DevBlobStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = DevBlobStore::new(dir.path()).await.unwrap();
        (store, dir)
    }

    fn box_reader(data: &[u8]) -> Pin<Box<dyn AsyncRead + Send>> {
        Box::pin(std::io::Cursor::new(data.to_vec()))
    }

    #[tokio::test]
    async fn put_and_get_url_roundtrip() {
        let (store, _dir) = make_store().await;
        let base = Url::parse("http://localhost:8080/").unwrap();
        let data = b"\x1A\x45\xDF\xA3 hello webm";
        store.put("test.webm", box_reader(data)).await.unwrap();
        let url = store.get_url("test.webm", &base).await.unwrap();
        assert!(url.as_str().ends_with("api/dev-blob/test.webm"));
    }

    #[tokio::test]
    async fn delete_removes_file() {
        let (store, dir) = make_store().await;
        store.put("del.webm", box_reader(b"data")).await.unwrap();
        store.delete("del.webm").await.unwrap();
        assert!(!dir.path().join("del.webm").exists());
    }

    #[tokio::test]
    async fn delete_not_found_is_ok() {
        let (store, _dir) = make_store().await;
        store.delete("nonexistent.webm").await.unwrap();
    }

    #[tokio::test]
    async fn get_url_not_found_errors() {
        let (store, _dir) = make_store().await;
        let base = Url::parse("http://localhost:8080/").unwrap();
        let err = store.get_url("missing.webm", &base).await.unwrap_err();
        assert!(matches!(err, BlobError::NotFound));
    }

    #[tokio::test]
    async fn key_with_dotdot_rejected() {
        let (store, _dir) = make_store().await;
        let err = store.put("../escape.webm", box_reader(b"x")).await.unwrap_err();
        assert!(matches!(err, BlobError::InvalidKey(_)));
    }

    #[tokio::test]
    async fn key_with_slash_rejected() {
        let (store, _dir) = make_store().await;
        let err = store.put("sub/dir.webm", box_reader(b"x")).await.unwrap_err();
        assert!(matches!(err, BlobError::InvalidKey(_)));
    }

    #[tokio::test]
    async fn put_preserves_bytes() {
        let (store, dir) = make_store().await;
        let payload: Vec<u8> = (0u8..=255).cycle().take(1024).collect();
        store.put("payload.webm", box_reader(&payload)).await.unwrap();
        let mut f = tokio::fs::File::open(dir.path().join("payload.webm")).await.unwrap();
        let mut got = Vec::new();
        f.read_to_end(&mut got).await.unwrap();
        assert_eq!(got, payload);
    }
}
