## Code Review: Sprint 16 - Persistent database (R1)

**Round:** 1  
**Verdict:** PLAN_REVISION_REQUIRED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Implementation Assessment
The implementation does not safely realize the approved persistence design. Core deployment and recovery assumptions are invalid.

### Code Quality
The Rust changes are mostly direct and readable. Error handling and operational code still contain silent-failure and resource-management gaps. One frontend asset regresses an established CSP constraint.

### Test Coverage
Coverage is incomplete for the new recovery path and for connection-level database initialization guarantees. The current tests do not prove the full operational contract.

### Findings
- **[High]** Backup and restore cover only the SQLite file and omit the persistent accompaniment blob store, so the durable dataset is not recoverable. (File: `infra/backup-job/backup.py`, Location: backup flow) (Source: domain)
- **[High]** The NFS bootstrap is incompatible with `RootSquash`: the init container relies on `chown` as root, which Azure Files NFS root squash blocks, so `/data` can remain unwritable. (File: `infra/bicep/container-app.bicep`, Location: storage + init container configuration) (Source: domain)
- **[High]** The live SQLite database now contains authentication-bearing state on Azure Files NFS with `supportsHttpsTrafficOnly: false`, leaving the database transport intentionally non-TLS. (File: `infra/bicep/container-app.bicep`, Location: storage account config; File: `server/src/config.rs`, Location: data dir config; File: `server/migrations/0001_initial.sql`, Location: sessions table; File: `server/migrations/0003_recordings.sql`, Location: token hashes) (Source: security)
- **[High]** The root-capable init container runs from a mutable tag with no digest pin, creating a pre-start supply-chain execution risk. (File: `infra/bicep/container-app.bicep`, Location: init container image) (Source: security)
- **[High]** The backup job also runs from mutable, unpinned images while holding database read access and Blob write permissions. (File: `infra/bicep/backup-job.bicep`, Location: image parameter and job template; File: `infra/backup-job/Dockerfile`, Location: base image) (Source: security)
- **[High]** The backup script has no tests, despite being the only production recovery mechanism. The snapshot and upload contract are unverified. (File: `infra/backup-job/backup.py`, Location: entire script) (Source: test_quality)
- **[High]** `init_pool` discards the result of `PRAGMA journal_mode=WAL`, so WAL fallback is silent at startup instead of failing fast. (File: `server/src/db.rs`, Location: `init_pool` `after_connect`) (Source: test_quality)
- **[Medium]** The backup job identity is scoped to the entire storage account instead of the backup container. (File: `infra/bicep/backup-job.bicep`, Location: role assignment) (Source: security)
- **[Medium]** The backup storage account has no network restriction such as disabled public network access or deny-by-default ACLs. (File: `infra/bicep/backup-job.bicep`, Location: storage account config) (Source: security)
- **[Medium]** `backup.py` does not guard the SQLite connection with a context manager, so a failed `VACUUM INTO` leaks the connection. (File: `infra/backup-job/backup.py`, Location: backup execution path) (Source: code_quality)
- **[Medium]** `gallery.html` reintroduces Google Fonts and breaks the project’s CSP-compliant self-hosted font approach. (File: `web/assets/design_system/gallery.html`, Location: head links) (Source: code_quality)
- **[Medium]** Database tests do not verify session-scoped pragmas across every pool connection, and they do not cover the read-path `Sqlx -> 500` case. (File: `server/tests/db_pragmas.rs`, Location: pragma tests; File: `server/tests/db_error_500.rs`, Location: closed-pool test) (Source: test_quality)

### Excluded Findings
- `db_pool_allows_concurrent_connections` should also issue `SELECT 1` on both connections — Reason: weaker duplicate of the broader missing per-connection and behavioral DB test coverage finding. (Source: test_quality)
- `backup.py` should add an inline comment explaining the safe f-string for `VACUUM INTO` — Reason: no current security impact because the path is system-generated. (Source: test_quality)
- Missing negative test for unwritable `init_pool` path — Reason: lower-value test gap compared with the silent WAL misconfiguration and per-connection pragma coverage gaps. (Source: test_quality)
- Function-local `use` imports in `db_pragmas.rs` — Reason: style-only issue. (Source: code_quality)
- Missing file header in `gallery.html` — Reason: documentation convention issue, not material to this review outcome. (Source: code_quality)
- Missing `Role` field in `backup.py` header — Reason: documentation convention issue, not material to this review outcome. (Source: code_quality)

### Plan Revisions
- Redefine the persistence architecture so authentication-bearing SQLite data is not stored on non-TLS Azure Files NFS.
- Redefine the filesystem ownership strategy so it does not depend on `chown` under `RootSquash`.
- Redefine backup scope to include the entire durable dataset, not only `singing-bridge.db`.
- Require digest-pinned images for privileged init containers and backup jobs in the deployment plan.
- Add explicit acceptance criteria for WAL startup validation and recovery-path test coverage.

### Recommendations
- Scope Blob permissions to the backup container.
- Lock down backup storage network access.
- Wrap the backup SQLite connection in a context manager.
- Restore self-hosted fonts in `gallery.html`.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|------------------|-----------|
| Backup and recovery | Domain, Test Quality, Code Quality, Security | Recovery path is incomplete and insufficiently hardened |
| Database initialization | Test Quality | Startup should fail on WAL misconfiguration |
| Storage architecture | Domain, Security | Current NFS design breaks operational and security assumptions |
| Supply chain hardening | Security | Privileged and sensitive jobs must use pinned images |
| Frontend/code hygiene | Code Quality | One asset regresses established project standards |