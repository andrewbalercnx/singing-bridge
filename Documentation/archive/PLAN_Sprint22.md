# PLAN_Sprint22 — Azure Blob Storage

## Problem Statement

`DevBlobStore` writes files to `SB_DATA_DIR` (currently `/tmp` in production). Every
container restart or new revision wipes that directory, leaving orphaned DB rows whose
`pdf_blob_key`, `midi_blob_key`, `page_blob_keys_json`, and `wav_blob_key` columns point
to non-existent files. This also blocks Sprint 23 (single-pass OMR caching), which stores
MusicXML in blob — useless if the blob vanishes on restart.

## User Outcome

**Who benefits and what job are they doing?**
A teacher who has spent several minutes uploading PDFs, running OMR, extracting MIDI, and
synthesising WAV variants for tonight's lesson arrives the next day to find their library
intact. Currently that library silently disappears on every container restart.

**What does success look like from the user's perspective?**
The teacher's accompaniment library looks exactly the same after a server restart as it did
when they built it. No re-uploading, no re-running OMR, no re-synthesising.

**Why is this sprint the right next step?**
All Sprint 12–15 accompaniment work is effectively non-functional in production because the
files it produces don't persist. This is a blocking correctness issue, not an optimisation.
Sprint 23 (OMR caching) also depends on persistent blob storage.

## Current State

- `blob.rs`: `BlobStore` trait + `DevBlobStore` (flat files in a local dir)
- `BlobStore::get_url` returns a `/api/dev-blob/{key}` route (served only in dev/debug builds)
- `main.rs` always constructs `DevBlobStore`; no conditional
- No Azure SDK dependency in `Cargo.toml`
- `SB_DATA_DIR=/tmp` in the `sb-server` Container App → blobs in `/tmp/dev-blobs`
- `SB_AZURE_STORAGE_CONNECTION_STRING` / `SB_AZURE_STORAGE_CONTAINER` not yet wired

## Proposed Solution

Add `AzureBlobStore` behind the existing `BlobStore` trait. No handler changes — every
caller goes through the trait.

### Dependency choice

`object_store` crate (`v0.11`, feature `azure`) — maintained by Apache Arrow, used by DataFusion
and Delta Lake, well-tested Azure backend. Alternatives:
- `azure_storage_blobs` (azure-sdk-for-rust): official but heavier; async surface is less
  ergonomic with our `Pin<Box<dyn AsyncRead>>` trait signature.
- Raw `reqwest` + REST: works but reinvents auth, retries, and multipart.

`object_store` is the right call.

### Auth

Connection string (`AccountName=...;AccountKey=...`) stored as KV secret
`sb-blob-connection-string`, referenced via Container App secretRef. Managed identity is
preferred long-term but requires `DefaultAzureCredential` support in `object_store` which
is not yet stable.

### `BlobStore::get_url` for Azure

`DevBlobStore.get_url` routes through the server (`/api/dev-blob/{key}`). For Azure, the
cleanest equivalent is a **SAS URL** with TTL = `config.media_token_ttl_secs`. `object_store`
exposes `AzureClient::signed_url` (presigned GET). This keeps large file transfers (WAV,
recordings) off the server process entirely.

Recording-gate (`recording_gate.rs`) uses `get_url` today for session recordings. Library
assets use the media-token system (`/api/media/:token`) which proxies through the server
(acceptable for the blob sizes in the library). We do not change either of these call sites.

## Component Design

### `server/src/blob.rs`

Add `AzureBlobStore`:

```rust
pub struct AzureBlobStore {
    client: Arc<MicrosoftAzureBuilder>, // object_store Azure client
    container: String,
    sas_ttl: Duration,
}

impl AzureBlobStore {
    pub fn new(connection_string: &str, container: &str, sas_ttl: Duration) -> Result<Self, BlobError>
}
```

`BlobStore` impl:
- `put`: `object_store` multipart upload; returns bytes written
- `get_bytes`: `object_store` get → collect to `Bytes`
- `get_url`: generate SAS URL with `sas_ttl` TTL
- `delete`: `object_store` delete; not-found silently ignored

Key validation: same `validate_key` rules as `DevBlobStore` (flat `{uuid}.ext`, no path traversal).

### `server/src/config.rs`

New optional fields:
```rust
pub azure_storage_connection_string: Option<SecretString>,
pub azure_storage_container: Option<String>,
```
Parsed from `SB_AZURE_STORAGE_CONNECTION_STRING` / `SB_AZURE_STORAGE_CONTAINER`.
Both must be set together; if only one is set, startup fails with a clear error.

`AzureBlobStore` selected when both are `Some`; `DevBlobStore` otherwise.

### `server/src/main.rs`

```rust
let blob: Arc<dyn BlobStore> = match &config.azure_storage_connection_string {
    Some(conn) => {
        let container = config.azure_storage_container.as_deref()
            .expect("SB_AZURE_STORAGE_CONTAINER must be set with connection string");
        Arc::new(AzureBlobStore::new(
            conn.expose(), container,
            Duration::from_secs(config.media_token_ttl_secs),
        )?)
    }
    None => {
        tokio::fs::create_dir_all(&config.dev_blob_dir).await.ok();
        Arc::new(DevBlobStore::new(&config.dev_blob_dir).await?)
    }
};
```

### Infra (Azure CLI — in sprint)

```bash
az storage account create \
  --name sbprodblobs \
  --resource-group sb-prod-rg \
  --sku Standard_LRS \
  --kind StorageV2 \
  --access-tier Hot

az storage container create \
  --name blobs \
  --account-name sbprodblobs

CONN=$(az storage account show-connection-string \
  --name sbprodblobs --resource-group sb-prod-rg \
  --query connectionString -o tsv)

az keyvault secret set \
  --vault-name rcnx-shared-kv \
  --name sb-blob-connection-string \
  --value "$CONN"
```

Container App: add `sb-blob-connection-string` secret ref and wire
`SB_AZURE_STORAGE_CONNECTION_STRING` + `SB_AZURE_STORAGE_CONTAINER=blobs` env vars
(same pattern as `sb-db-url`).

### `server/src/http/mod.rs`

`/api/dev-blob/:key` route stays compiled only in `#[cfg(debug_assertions)]` or when
`DevBlobStore` is active. No change needed — the route already exists and Azure responses
go via SAS URL, never through this route.

## Test Strategy

### Property / invariant coverage
- Round-trip: `put` → `get_bytes` returns identical bytes (existing `DevBlobStore` test)
- `get_url` not-found returns `BlobError::NotFound` for both backends
- Key validation rejects paths with `/`, `..`, empty string

### Failure-path coverage
- `get_bytes` on missing key → `BlobError::NotFound` (not a panic or internal error)
- `AzureBlobStore::new` with invalid connection string → returns `Err` at construction, not at first use
- `delete` on missing key → `Ok(())` (silent ignore)

### Regression guards
- `DevBlobStore` all existing tests pass unchanged
- `/healthz` blob probe passes (writes `_healthz_probe.bin`, reads back, deletes)

### Fixture reuse plan
- `AzureBlobStore` integration test: feature-gated, uses `AZURE_STORAGE_CONNECTION_STRING`
  env var; skipped in CI unless the secret is injected. Uses a `test-{uuid}` container
  prefix for isolation and cleans up on drop.

### Test runtime budget
- Unit tests (key validation, error mapping): < 100 ms
- `DevBlobStore` round-trip: < 500 ms
- Azure integration test (when env var set): < 10 s; not run in standard CI

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `object_store` Azure SAS generation API changes between minor versions | Pin `object_store = "0.11"` in Cargo.toml |
| Storage account name `sbprodblobs` already taken (globally unique) | Use `sbbridgeblobs` as fallback; confirm before running |
| Large recording uploads (100 MB+) slow under Azure multipart | `object_store` handles multipart automatically; no change to upload path |
| Existing prod blob files in `/tmp/dev-blobs` lost on switchover | Expected and acceptable — blobs were already ephemeral; DB cleanup handles orphaned keys |
| Connection string rotated — old string cached in env | Container App revision restart picks up new secretRef; acceptable rotation story for now |
