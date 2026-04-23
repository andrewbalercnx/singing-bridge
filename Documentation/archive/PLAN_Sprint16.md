# PLAN_Sprint16.md — Persistent Database

**Sprint:** 16
**Status:** DRAFT — awaiting council review (R2)

---

## Problem Statement

Azure Files Premium is mounted over SMB. SQLite's WAL journal mode requires POSIX
advisory locks (`fcntl F_SETLK`), which the SMB protocol does not implement. Even
DELETE journal mode is unreliable under SMB — the current Bicep explicitly comments
`SB_DATA_DIR=/tmp: Azure Files SMB deadlocks SQLite`. The workaround sets the DB
path to `/tmp`, making every deploy a full data wipe: teacher accounts, session
history, recording metadata, and the entire accompaniment library are lost on every
CI/CD push.

---

## User Outcome

**1. Who benefits and what job are they doing?**
Teachers using `singing.rcnx.io` for real lessons. A teacher who registers, uploads
accompaniment tracks, and builds a session history needs that work to survive routine
deploys. Right now it does not — the system is a demo, not a product.

**2. What does success look like from the user's perspective?**
A teacher registers, creates several accompaniment assets, runs two lessons. A new
version is deployed. The teacher logs back in and finds everything intact: account,
history, library. No action required on their part.

**3. Why is this sprint the right next step?**
Every sprint from 6 onward (recordings, session history, accompaniment library)
assumed durable storage. None of that value is reachable until the data persists.
This sprint closes that gap before any real usage begins.

---

## Options Analysis

All options evaluated against three axes for a small system (handful of teachers,
≤100 sessions/month initially).

| Option | Operational complexity | Robustness | Est. monthly cost |
|--------|----------------------|------------|-------------------|
| **A. Azure Files NFS v4.1** | Low-medium — one-time Bicep change (VNet + NFS); no Rust/SQL changes | Medium-high — durable, managed by Azure, region-local | ~$5–8 (Premium LRS + VNet overhead) |
| **B. Turso (libSQL cloud)** | Low-medium — Rust `libsql` client replaces `sqlx sqlite`; SQL dialect identical | Medium-high — managed, replicated, automatic backups | Free (9 GB tier) → $29/month Scaler |
| **C. Neon (serverless PostgreSQL)** | Medium — sqlx dialect change; SQL rewrites for `RETURNING`, `SERIAL`, JSON ops | High — PITR backups, HA option | Free (3 GB) → $19/month Launch |
| **D. Azure Database for PostgreSQL Flexible Server** | Medium — same as C | High — Azure-native, VNet-peerable | ~$14/month burstable B1ms |

**Rejected alternatives:**
- **Blob-backed backup/restore at startup** — still ephemeral between backups; unacceptable data-loss window for production
- **Azure Container Storage with Managed Disk** — no VNet needed but requires a subscription-level feature flag (`Microsoft.ContainerService/EnableAzureContainerStorage`) registered out-of-band before deploy

**Recommendation: Option A — Azure Files NFS v4.1**

Zero Rust code changes, zero SQL changes, zero new external services. The
infrastructure delta is a one-time Bicep addition (VNet + new NFS-capable storage
account + recreated Container App Environment). Turso or Neon remain the natural
upgrade path if multi-replica or cross-region replication is ever needed.

**Side effect:** moving `SB_DATA_DIR` from `/tmp` to `/data` also makes the Azure
Blob dev-blob store (`dev_blob_dir = data_dir.join("dev-blobs")`) persistent.
This is beneficial and intentional — it should be noted in the change log.

---

## Current State

Key files:

| File | Relevant state |
|------|---------------|
| `infra/bicep/container-app.bicep` | Azure Files SMB volume `sb-data` mounted at `/data`; `SB_DATA_DIR=/tmp` (line 130); comment notes the SMB deadlock |
| `server/src/db.rs` | `max_connections(1)`; WAL explicitly omitted (comment: "Azure Files SMB does not support…"); `PRAGMA synchronous=NORMAL`; `PRAGMA busy_timeout=30000` |
| `server/src/config.rs` | `db_url` derived as `sqlite:{SB_DATA_DIR}/singing-bridge.db?mode=rwc` in prod; dev uses `sqlite::memory:` |
| `server/migrations/` | 6 SQLite migrations; no non-SQLite SQL constructs |

---

## Proposed Solution

### Deployment model

The following two resources are **destructive replacements**, not in-place
modifications. The migration requires a planned maintenance window (estimated ~20
minutes of downtime):

1. **New storage account** — the existing SMB storage account has
   `supportsHttpsTrafficOnly: true`, which cannot be changed in place; NFS v4.1
   requires `supportsHttpsTrafficOnly: false`. A new storage account with NFS
   enabled must be created. The old SMB account is deleted after verification.

2. **New Container App Environment** — VNet integration cannot be added to an
   existing CAE. A new environment with VNet configuration must be created, and
   the Container App must be redeployed into it. The existing CAE is deleted after
   the app is running and healthy in the new environment.

**Cutover sequence:**
1. Deploy `vnet.bicep` → new VNet + subnets
2. Deploy new NFS storage account and file share
3. Deploy new VNet-integrated CAE (existing app still running in old CAE)
4. Deploy Container App into new CAE (new revision becomes healthy)
5. Update DNS / Cloudflare custom domain binding to new app FQDN
6. Verify health via `/healthz` and a teacher login
7. Delete old Container App + old CAE + old storage account

Estimated downtime: the DNS cutover window only (~2 minutes if using Cloudflare
proxied record with low TTL).

### Infrastructure changes (`infra/bicep/`)

**New: `infra/bicep/vnet.bicep`**
```
// File: infra/bicep/vnet.bicep
// Purpose: VNet, ACA subnet, and storage subnet for NFS Azure Files.
// Role: Network foundation for Container Apps VNet integration and NFS storage.
// Exports: vnetId, acaSubnetId, storageSubnetId
// Last updated: Sprint 16 (YYYY-MM-DD) -- initial
```
- VNet `sb-vnet` (`10.0.0.0/16`)
- Subnet `sb-aca-subnet` (`10.0.0.0/23`) delegated to `Microsoft.App/environments`
- Subnet `sb-storage-subnet` (`10.0.4.0/28`) with service endpoint `Microsoft.Storage`
- Outputs: `vnetId`, `acaSubnetId`, `storageSubnetId`

**New storage account and share (in `container-app.bicep`):**
- New storage account (separate from old SMB account): `Premium_LRS`, `FileStorage`
- `supportsHttpsTrafficOnly: false` (required for NFS v4.1)
- `minimumTlsVersion: 'TLS1_2'` retained on the account resource
- Network rule: `defaultAction: 'Deny'`; allow `sb-storage-subnet` service endpoint
- NFS file share: `enabledProtocols: 'NFS'`; `rootSquash: 'RootSquash'`; quota 32 GiB

**Container App Environment (new, VNet-integrated):**
- API version: `Microsoft.App/managedEnvironments@2024-03-01`
- `vnetConfiguration.infrastructureSubnetId` = `sb-aca-subnet`
- `vnetConfiguration.internal` = false (externally reachable via Cloudflare)

**Container Apps storage binding (new NFS shape):**
- API version: `Microsoft.App/managedEnvironments/storages@2024-03-01`
- `properties.nfsAzureFile.server` = `<nfsStorageAccount>.file.core.windows.net`
- `properties.nfsAzureFile.shareName` = `/sb-data`
- `properties.nfsAzureFile.accessMode` = `ReadWrite`
- Note: no `accountKey` — NFS uses network-rule-controlled access, not shared key

**Container App changes:**
- API version: `Microsoft.App/containerApps@2024-03-01`
- `SB_DATA_DIR` env var: `/tmp` → `/data`
- Volume: `storageType: 'NfsAzureFile'` (2024-03-01 API type)
- Add init container (see "Container runtime security" below)

### Container runtime security

The existing `Dockerfile` already runs as `USER 65532:65532` (distroless
`gcr.io/distroless/cc-debian12` convention). That UID/GID is used throughout — no
named-user dependency, no change to the distroless base image.

1. **Dockerfile**: no change to the runtime user. `USER 65532:65532` is already
   declared and must be retained.

2. **Init container** in `container-app.bicep`: a pinned Alpine image runs as
   root, `chown`s `/data` to `65532:65532`, then exits. This handles the
   first-mount case where the NFS share directory is owned by root.
   - Image: `alpine:3.19@sha256:<digest>` — pin by digest to prevent supply-chain
     risk on a root-capable init container. The digest must be resolved and
     committed at implementation time.

3. **NFS share**: `rootSquash: 'RootSquash'` — root in the container maps to
   `nobody` on the NFS server. UID 65532 in the container maps to UID 65532 on
   the server, which owns `/data` after the init container runs.

4. **`securityContext`** on the server container
   (`Microsoft.App/containerApps@2024-03-01`):
   `runAsNonRoot: true`, `runAsUser: 65532`, `runAsGroup: 65532`

### Rust server changes (`server/src/`)

**`server/src/db.rs`**
- Re-enable WAL: add `PRAGMA journal_mode=WAL` to `after_connect`
- Lift connection cap: `max_connections(4)`. WAL allows one serialised writer
  with concurrent readers; the pool increase serves read concurrency (history,
  library listing) without serialising on read paths.
- Retain `PRAGMA busy_timeout=30000` and `PRAGMA foreign_keys=ON`
- Update file header: remove the SMB constraint note; document NFS backing;
  note that `minReplicas=maxReplicas=1` is required (SQLite WAL single-writer)

**No other Rust changes.** `config.rs` already reads `SB_DATA_DIR` from the
environment.

### Data migration

No row migration needed. The `/tmp` database has never persisted. The NFS volume
starts empty; `sqlx::migrate!` runs all 6 migrations on first startup.

### Runbook update (`knowledge/runbook/deploy.md`)

Add or update:

1. **One-time bootstrap** — new step 1.5: deploy `vnet.bicep` before the CAE
2. **Cutover procedure** — the 7-step sequence documented above
3. **Backup (consistent):** the application container is distroless — no shell, no
   `sqlite3` binary. Backups use a **one-shot Container App Job** (`Microsoft.App/jobs`
   with `triggerType: 'Manual'`):
   - **Image:** a dedicated backup image built from `infra/backup-job/Dockerfile`
     and pushed to ACR as `singing-bridge-backup:latest`. The image:
     - `FROM python:3.12-slim` — includes sqlite3 bindings; no runtime package
       install needed
     - `RUN pip install azure-storage-blob azure-identity` at build time
     - `USER 65532:65532` — runs as the same UID/GID as the NFS volume owner;
       no root access required at runtime; compatible with `RootSquash`
     - `COPY infra/backup-job/backup.py /backup.py`; `CMD ["python", "/backup.py"]`
   - The backup script (`infra/backup-job/backup.py`) uses `sqlite3.connect().execute(
     "VACUUM INTO '/tmp/backup.db'")` then uploads via `azure.storage.blob` with
     `DefaultAzureCredential` (managed identity).
   - `VACUUM INTO` produces a clean, consistent single-file copy even while the app
     is running (does not require WAL checkpoint or app quiescence)
   - **Authentication:** the backup job has a system-assigned managed identity.
     A `Microsoft.Authorization/roleAssignment` resource in `backup-job.bicep`
     grants it `Storage Blob Data Contributor` on the backup storage container.
     Upload uses `--auth-mode login` / `DefaultAzureCredential`; no shared key
     or SAS token in the job definition.
   - **Image pinning:** both the backup image and any base image used in
     `backup-job/Dockerfile` must be pinned by digest in the Bicep and Dockerfile
     respectively at implementation time.
   - Job definition lives in `infra/bicep/backup-job.bicep`
4. **Operator restore path:** stop the Container App, mount the NFS share from a
   Container App Job (same Alpine image), overwrite `singing-bridge.db` with the
   restored file, restart the Container App.
5. **Backup encryption:** download the backup blob to a local machine and encrypt
   before long-term storage: `gpg --symmetric --cipher-algo AES256 backup.db`.
   Delete the plaintext after encrypting.
6. **Restore:** stop the Container App (scale to 0 replicas), upload the restored
   `.db` via a Container App Job that writes to `/data`, restart (scale to 1).
7. **Single-replica constraint:** `minReplicas=maxReplicas=1` is mandatory while
   SQLite is the database engine. WAL locks are node-local; a second replica would
   corrupt the database. Document this in the runbook header and as a Bicep comment.

### Accepted risk: NFS transport encryption

NFS v4.1 traffic between the Container App and Azure Files is carried over the
Azure backbone network within the region (not the public internet). It is not
TLS-encrypted at the NFS protocol layer. The database contains:
- Argon2id password hashes (not plaintext passwords)
- SHA-256 email hashes (PII-adjacent but not plaintext emails for most tables)
- HMAC session tokens (high-value; compromise allows session hijack)

**Decision:** accepted for MVP. The traffic stays within the Azure region VNet;
Azure's network layer provides isolation. Mitigations in place: short session TTL
(30 days), `HttpOnly; Secure; SameSite=Strict` cookies, no plaintext credentials
in the DB. This must be revisited before the system scales beyond a single region
or if regulatory requirements change. Recorded in this plan and in the ADR.

---

## File Header Updates

The following file headers must be updated as part of implementation:

| File | Required header change |
|------|----------------------|
| `infra/bicep/vnet.bicep` | New file — add full header (see template above) |
| `infra/bicep/container-app.bicep` | Remove SMB/ephemeral note from `Role`; update `Invariants` to document NFS backing, `SB_DATA_DIR=/data`, and `minReplicas=maxReplicas=1` constraint |
| `server/src/db.rs` | Remove SMB constraint comment; add NFS note; update `Invariants` to list WAL mode, `busy_timeout=30000`, `foreign_keys=ON`, `synchronous=NORMAL` |
| `infra/bicep/backup-job.bicep` | New file — header: `// File: infra/bicep/backup-job.bicep` / `// Purpose: Manual Container App Job for consistent SQLite backup to Azure Blob Storage.` / `// Role: Ops tooling — triggered manually or by CI; not in the critical path.` / `// Exports: jobName, jobId` |
| `infra/backup-job/Dockerfile` | New file — header: `# File: infra/backup-job/Dockerfile` / `# Purpose: Backup image with sqlite3 + azure-storage-blob, runs as UID 65532.` |
| `infra/backup-job/backup.py` | New file — header: `# File: infra/backup-job/backup.py` / `# Purpose: VACUUM INTO backup of singing-bridge.db → Azure Blob Storage via managed identity.` |

---

## Test Strategy

### Property / invariant coverage

New test file: `server/tests/db_pragmas.rs` (file-backed pool, not `:memory:`).

- **`db_pragma_journal_mode_is_wal`** — asserts `PRAGMA journal_mode` returns `wal`
  after `init_pool`. Regression guard: fails if WAL is re-disabled.
- **`db_pragma_foreign_keys_on`** — asserts `PRAGMA foreign_keys` returns `1`.
  Corrects the R1 plan claim of existing coverage (none existed).
- **`db_pragma_busy_timeout`** — asserts `PRAGMA busy_timeout` returns `30000`.
- **`db_pragma_synchronous`** — asserts `PRAGMA synchronous` returns `1`
  (NORMAL = 1).

### Failure-path coverage

- **`db_error_returns_500`** — new integration test in `server/tests/`. Spin up
  the test app with a valid pool, then **close the pool** (`pool.close().await`)
  before making a request to a DB-backed endpoint (e.g., `GET /teach/some-slug`).
  A closed pool returns `PoolClosed` immediately from `pool.acquire()`, which
  propagates as `AppError::Internal` → HTTP 500. Assert response status == 500
  and that the server did not panic. This exercises the existing `AppError`
  propagation path with a deterministic, reproducible failure mode.

### Regression guards

- **Sprint 5 — WAL disabled for SMB:** `db_pragma_journal_mode_is_wal` fails if
  WAL is re-disabled.
- **Sprint 5 — single-connection cap:** `db_pool_allows_concurrent_connections`
  (see below) fails if `max_connections` is reverted to 1.

### `db_pool_allows_concurrent_connections` (replacing the timing-based test)

The concurrency guard must fail structurally when `max_connections` is 1, not by
timing. The correct invariant: the pool must be able to hand out at least 2
connections simultaneously. With `max_connections(1)` the second `acquire()` blocks
indefinitely; the 100 ms timeout makes it deterministically fail.

```rust
// Pseudo-code
async fn db_pool_allows_concurrent_connections() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("test.db");
    let pool = init_pool(&format!("sqlite:{}?mode=rwc", path.display())).await.unwrap();

    // Acquire two connections simultaneously.
    // With max_connections(1) the second acquire blocks until the first is dropped.
    let conn1 = timeout(Duration::from_millis(100), pool.acquire()).await
        .expect("first acquire timed out").unwrap();
    let conn2 = timeout(Duration::from_millis(100), pool.acquire()).await
        .expect("second acquire blocked — max_connections is likely 1").unwrap();

    drop(conn1);
    drop(conn2);
    // TempDir cleanup is automatic on drop
}
```

This fails against `max_connections(1)` (second acquire times out) and passes
against `max_connections(4)` (both acquires succeed immediately). No timing
sensitivity beyond the 100 ms short-circuit.

### Fixture reuse plan

All existing integration tests use `sqlite::memory:` via `Config::dev_default()`.
This continues to work unchanged — WAL is a no-op on `:memory:`. The pragma and
pool-concurrency tests use `tempfile::TempDir` for isolation (auto-cleaned on
drop); no manual cleanup language needed.

### Test runtime budget

New pragma tests: < 500 ms each. `db_pool_allows_concurrent_connections`: < 1 s.
`db_error_returns_500`: < 1 s. Total test suite budget unchanged (< 2 min).
No flaky policy changes (NFS is not exercised in CI).

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| NFS mount latency perceptibly higher than block storage | Low | Low | Azure Files Premium NFS is SSD-backed; SQLite DB at this scale is < 10 MB; latency difference is < 1 ms per query |
| VNet integration breaks Cloudflare IP allowlist | Medium | High | Container App Environment is external (`internal: false`); `ipSecurityRestrictions` on ingress are unchanged; tested during cutover before DNS switch |
| Multiple replicas deployed accidentally corrupt the SQLite WAL | Low | Critical | `minReplicas=maxReplicas=1` hardcoded in Bicep; scale constraint documented in runbook header and as a Bicep comment; the single-writer WAL constraint is an invariant until the DB engine is replaced |
| WAL sidecar files (`-wal`, `-shm`) cause partial backup | Medium | Medium | Runbook prescribes `VACUUM INTO` for online backup (produces a clean single-file copy); stop-the-app procedure for offline restore |
| Operator cannot access NFS share for emergency restore | Medium | High | Runbook defines the temporary-IP-allow procedure; time-limited to < 1 hour; IP rule removed immediately after |
| NFS transport carries HMAC session tokens without TLS | Low | Medium | Accepted risk (see "Accepted risk" section above); mitigated by Azure backbone isolation, short session TTLs |

---

## Files Changed Summary

| File | Change |
|------|--------|
| `infra/bicep/vnet.bicep` | New — VNet + subnets |
| `infra/bicep/container-app.bicep` | New NFS storage account; new VNet-integrated CAE; `nfsAzureFile` storage binding; `SB_DATA_DIR=/data`; init container; non-root `securityContext`; API versions bumped to `2024-03-01` |
| `Dockerfile` | No change needed — already `USER 65532:65532`; update header `Last updated` to Sprint 16 |
| `infra/bicep/backup-job.bicep` | New — Container App Job for consistent SQLite backup; managed identity; pinned image |
| `infra/backup-job/Dockerfile` | New — Python 3.12 slim image with sqlite3 + azure-storage-blob; `USER 65532:65532` |
| `infra/backup-job/backup.py` | New — `VACUUM INTO` + blob upload via `DefaultAzureCredential` |
| `server/src/db.rs` | Re-enable WAL; `max_connections(4)`; update header |
| `server/tests/db_pragmas.rs` | New — pragma assertions and concurrency test |
| `server/tests/db_error_500.rs` | New — DB-error → HTTP 500 integration test |
| `knowledge/runbook/deploy.md` | VNet deploy step; cutover procedure; backup/restore with encryption note; single-replica constraint |
| `knowledge/decisions/0001-mvp-architecture.md` | Add NFS transport accepted-risk note under storage section |
