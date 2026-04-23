## Plan Review: Sprint 16 - Persistent database (R4)

**Round:** 4  
**Verdict:** APPROVED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Design Assessment
The core design is sound. The NFS-backed SQLite model, WAL settings, single-replica invariant, managed-identity backup flow, and restore path are coherent.

### Completeness
The plan covers the main migration, runtime, test, backup, and restore deliverables. Backup-job specification remains incomplete in storage, mount, and test-plan details.

### Findings
- **[Medium]** Backup job storage access is underspecified. The plan does not state that `backup-job.bicep` mounts the NFS share at `/data` or that `backup.py` opens `/data/singing-bridge.db`, so the job has no defined path to the live database file. (File: `PLAN_Sprint16.md`, Location: `Runbook update — Backup (consistent)`) (Source: domain)
- **[Medium]** Backup blob destination is undefined and its security posture is not specified. The plan names managed-identity RBAC for blob upload but does not define the separate blob-capable storage account or require `supportsHttpsTrafficOnly: true`, `minimumTlsVersion: 'TLS1_2'`, and a deny-by-default network policy. (File: `infra/bicep/backup-job.bicep`, Location: storage account resource) (Source: security)
- **[Low]** The test strategy omits coverage for `infra/backup-job/backup.py`. The new backup logic has offline-testable behavior and needs at least one smoke-test entry for the `VACUUM INTO` path. (File: `infra/backup-job/backup.py`, Location: Test Strategy) (Source: test_quality)
- **[Low]** File header specs for `infra/backup-job/Dockerfile` and `infra/backup-job/backup.py` are incomplete. Required `Role` fields are missing for both files, and `backup.py` also lacks `Depends`. (File: `PLAN_Sprint16.md`, Location: `File Header Updates`) (Source: code_quality)

### Excluded Findings
No findings excluded.

### Recommendations
Add a single backup-job subsection that defines all storage dependencies in one place. Keep the backup test offline and bounded to the local SQLite snapshot path.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Backup job specification | domain, security, test_quality | Backup path is incomplete across mount, destination storage, and verification |
| Documentation quality | code_quality | New file specs need to match established header conventions |