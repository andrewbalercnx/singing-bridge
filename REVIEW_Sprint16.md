## Code Review: Sprint 16 - Persistent database (R3)

**Round:** 3  
**Verdict:** CHANGES_REQUESTED  
**Review Method:** Council of Experts (4 reviewers + consolidator)

### Implementation Assessment
The implementation completes most planned work and resolves the earlier correctness and test gaps. Approval is blocked by unresolved storage-security issues and plan drift against the shipped configuration.

### Code Quality
The code is generally clear and the recent changes improve failure handling and operational clarity. Remaining issues are minor duplication, comment-style drift, and one small test-setup idiom issue.

### Test Coverage
Coverage is now materially stronger and includes the critical backup and multi-connection database paths. Remaining gaps are edge-case coverage around backup behavior and one missing assertion on a safety-sensitive upload parameter.

### Findings
- **[High]** Live authentication-bearing database state still traverses Azure Files NFS without transport encryption. This remains a blocking security issue in the chosen storage model. (File: `infra/bicep/container-app.bicep`, Location: lines 48-80) (Source: security)
- **[Medium]** The approved plan no longer matches the implementation for the container runtime security model. The document still describes `RootSquash` and an init-container ownership bootstrap, while the code uses `NoRootSquash` and per-container UID enforcement. (File: `PLAN_Sprint16.md`, Location: "Container runtime security"; File: `infra/bicep/container-app.bicep`, Location: line 80) (Source: domain)
- **[Medium]** `NoRootSquash` remains the enforcement model for the live database share. Storage-level protection is absent and the design still relies on container configuration discipline. (File: `infra/bicep/container-app.bicep`, Location: lines 69-80) (Source: security)
- **[Medium]** The backup storage account still permits `AzureServices` bypass, which weakens the deny-by-default network posture. (File: `infra/bicep/backup-job.bicep`, Location: lines 23-45) (Source: security)
- **[Medium]** The backup job has write-capable access to the live database share even though it only needs read access. (File: `infra/bicep/backup-job.bicep`, Location: lines 81-108) (Source: security)
- **[Low]** `test_run_backup_uploads_blob` does not assert that `upload_blob` is called with `overwrite=False`, so a silent overwrite regression would not be caught. (File: `infra/backup-job/test_backup.py`, Location: `test_run_backup_uploads_blob`) (Source: test_quality)
- **[Low]** No test covers `run_backup()` when the source database path does not exist. (File: `infra/backup-job/test_backup.py`) (Source: test_quality)
- **[Low]** `capturing_mkstemp` is duplicated verbatim across two tests instead of being extracted as shared test support. (File: `infra/backup-job/test_backup.py`, Location: lines 77-82 and 98-103) (Source: code_quality)
- **[Low]** Multi-line comment blocks in `server/src/db.rs` and `server/tests/common/mod.rs` violate the project’s one-line comment convention. (Files: `server/src/db.rs`, `server/tests/common/mod.rs`) (Source: code_quality)
- **[Low]** `open(dst_path, "w").close()` in test code should be replaced with an idiomatic context-managed or `Path.touch()` form. (File: `infra/backup-job/test_backup.py`, Location: line 43) (Source: code_quality)
- **[Low]** The plan status header is stale and still marked as draft/R2-era text. (File: `PLAN_Sprint16.md`, Location: line 4) (Source: domain)

### Excluded Findings
- Blob-backup accepted-risk documentation not confirmed in `knowledge/decisions/0001-mvp-architecture.md` — Reason: the reviewer explicitly could not verify the file content from the available evidence, so the finding is not sufficiently grounded for consolidation. (Source: domain)

### Required Changes (if CHANGES_REQUESTED)
1. **File**: `infra/bicep/container-app.bicep` and supporting design/docs as needed  
   **Location**: storage configuration for the live database  
   **Current behavior**: the live SQLite database, including auth/session-bearing state, remains on Azure Files NFS with `supportsHttpsTrafficOnly: false` as part of the active design.  
   **Required change**: remove live auth/session-bearing state from this unencrypted NFS path, or move the live database to a transport-encrypted storage model.  
   **Acceptance criteria**: deployed architecture no longer places authentication-bearing database state on unencrypted NFS transport; code and documentation describe the new storage model consistently.

2. **File**: `PLAN_Sprint16.md`  
   **Location**: "Container runtime security" section and status header  
   **Current behavior**: the plan still describes `RootSquash` plus an init-container `chown` flow and still carries stale draft/R2 status text.  
   **Required change**: update the plan to match the implemented security model exactly, including the actual `rootSquash` setting, the absence of the init container, the enforced UID/non-root invariant, the accepted risk statement, and the current review status.  
   **Acceptance criteria**: plan text matches the implementation with no contradictory runtime-security description and no stale status markers.

3. **File**: `infra/bicep/backup-job.bicep`  
   **Location**: storage account network ACLs  
   **Current behavior**: the backup storage account uses deny-by-default rules but still allows `AzureServices` bypass.  
   **Required change**: remove the broad bypass and keep only explicitly required network exceptions.  
   **Acceptance criteria**: `bypass` is set to `None`, or an equally narrow documented exception set is present and justified.

4. **File**: `infra/bicep/backup-job.bicep`  
   **Location**: backup job volume mount for the live database share  
   **Current behavior**: the backup job can write to the live database share.  
   **Required change**: mount the source database path read-only if the platform supports it, or introduce an equivalent narrower access path.  
   **Acceptance criteria**: backup execution cannot modify or delete the live database through its mounted access path.

### Recommendations
- Add the missing `overwrite=False` assertion and the nonexistent-source-db test in [infra/backup-job/test_backup.py](/Users/andrewbale/code/active/singing-bridge/infra/backup-job/test_backup.py).
- Extract shared `mkstemp` capture logic and clean up the minor test-style issues.
- Collapse the multi-line explanatory comments in [server/src/db.rs](/Users/andrewbale/code/active/singing-bridge/server/src/db.rs) and [server/tests/common/mod.rs](/Users/andrewbale/code/active/singing-bridge/server/tests/common/mod.rs) to single-line form.

### Expert Concordance
| Area | Experts Agreeing | Key Theme |
|------|-----------------|-----------|
| Storage security | Security, Consolidator | Live database storage model remains the approval blocker |
| Runtime security documentation | Domain, Security, Consolidator | Plan and implementation diverge on the NFS/root model |
| Backup hardening | Security, Test Quality, Consolidator | Backup path is improved but still needs tighter safeguards |
| Test/code polish | Test Quality, Code Quality, Consolidator | Remaining issues are low-severity coverage and maintainability gaps |