// File: server/src/blob.rs
// Purpose: BlobStore trait + DevBlobStore (local files) + AzureBlobStore (Azure Blob Storage).
// Role: Decouples recording upload/download from any particular storage backend.
// Exports: BlobStore, DevBlobStore, AzureBlobStore, BlobError
// Depends: async-trait, tokio, tokio-util, futures, url, bytes, object_store
// Invariants: Keys are flat "{uuid}.ext" — no slashes, no dots-dot.
//             DevBlobStore.get_url returns /api/dev-blob/{key} (dev only).
//             AzureBlobStore.get_url returns a short-lived SAS URL.
//             get_bytes reads the full blob into memory (use only for sidecar payloads).
// Last updated: Sprint 22 (2026-04-26) -- AzureBlobStore via object_store crate

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use object_store::azure::{MicrosoftAzure, MicrosoftAzureBuilder};
use object_store::{ObjectStore, path::Path as OsPath};
use object_store::signer::Signer;
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
    /// Read the full blob into memory. Use only for sidecar payloads where
    /// the entire content must be in memory anyway.
    async fn get_bytes(&self, key: &str) -> Result<Bytes>;
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

    fn path_for(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }
}

#[async_trait]
impl BlobStore for DevBlobStore {
    async fn put(&self, key: &str, mut data: Pin<Box<dyn AsyncRead + Send>>) -> Result<u64> {
        validate_key(key)?;
        let path = self.path_for(key);
        let mut file = tokio::fs::File::create(&path).await?;
        let bytes_written = tokio::io::copy(&mut data, &mut file).await?;
        Ok(bytes_written)
    }

    async fn get_bytes(&self, key: &str) -> Result<Bytes> {
        validate_key(key)?;
        let path = self.path_for(key);
        match tokio::fs::read(&path).await {
            Ok(data) => Ok(Bytes::from(data)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(BlobError::NotFound),
            Err(e) => Err(BlobError::Io(e)),
        }
    }

    async fn get_url(&self, key: &str, base_url: &Url) -> Result<Url> {
        validate_key(key)?;
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
        validate_key(key)?;
        let path = self.path_for(key);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(BlobError::Io(e)),
        }
    }
}

// ---------------------------------------------------------------------------
// AzureBlobStore
// ---------------------------------------------------------------------------

pub struct AzureBlobStore {
    store: Arc<MicrosoftAzure>,
    sas_ttl: Duration,
}

impl AzureBlobStore {
    /// Build from an Azure Storage connection string
    /// (`DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;...`).
    pub fn new(connection_string: &str, container: &str, sas_ttl: Duration) -> Result<Self> {
        let (account, key) = parse_connection_string(connection_string)?;
        let store = MicrosoftAzureBuilder::new()
            .with_account(account)
            .with_access_key(key)
            .with_container_name(container)
            .build()
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?;
        Ok(Self { store: Arc::new(store), sas_ttl })
    }

    fn os_path(key: &str) -> OsPath {
        OsPath::from(key)
    }
}

#[async_trait]
impl BlobStore for AzureBlobStore {
    async fn put(&self, key: &str, mut data: Pin<Box<dyn AsyncRead + Send>>) -> Result<u64> {
        validate_key(key)?;
        let mut buf = Vec::new();
        tokio::io::copy(&mut data, &mut buf).await?;
        let len = buf.len() as u64;
        self.store
            .put(&Self::os_path(key), buf.into())
            .await
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?;
        Ok(len)
    }

    async fn get_bytes(&self, key: &str) -> Result<Bytes> {
        validate_key(key)?;
        match self.store.get(&Self::os_path(key)).await {
            Ok(result) => result
                .bytes()
                .await
                .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string()))),
            Err(object_store::Error::NotFound { .. }) => Err(BlobError::NotFound),
            Err(e) => Err(BlobError::Io(std::io::Error::other(e.to_string()))),
        }
    }

    async fn get_url(&self, key: &str, _base_url: &Url) -> Result<Url> {
        validate_key(key)?;
        // Verify existence before issuing a SAS URL.
        match self.store.head(&Self::os_path(key)).await {
            Err(object_store::Error::NotFound { .. }) => return Err(BlobError::NotFound),
            Err(e) => return Err(BlobError::Io(std::io::Error::other(e.to_string()))),
            Ok(_) => {}
        }
        let sas = self.store
            .signed_url(http::Method::GET, &Self::os_path(key), self.sas_ttl)
            .await
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?;
        Url::parse(sas.as_str())
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))
    }

    async fn delete(&self, key: &str) -> Result<()> {
        validate_key(key)?;
        match self.store.delete(&Self::os_path(key)).await {
            Ok(()) => Ok(()),
            Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(BlobError::Io(std::io::Error::other(e.to_string()))),
        }
    }
}

/// Parse `AccountName` and `AccountKey` from an Azure connection string.
fn parse_connection_string(s: &str) -> Result<(String, String)> {
    let mut account = None;
    let mut key = None;
    for part in s.split(';') {
        if let Some(v) = part.strip_prefix("AccountName=") {
            account = Some(v.to_owned());
        } else if let Some(v) = part.strip_prefix("AccountKey=") {
            key = Some(v.to_owned());
        }
    }
    match (account, key) {
        (Some(a), Some(k)) => Ok((a, k)),
        _ => Err(BlobError::InvalidKey(
            "connection string missing AccountName or AccountKey",
        )),
    }
}

// ---------------------------------------------------------------------------
// Shared key validation
// ---------------------------------------------------------------------------

fn validate_key(key: &str) -> Result<()> {
    if key.contains("..") {
        return Err(BlobError::InvalidKey("key contains '..'"));
    }
    if key.contains('/') {
        return Err(BlobError::InvalidKey("key contains '/'"));
    }
    Ok(())
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
