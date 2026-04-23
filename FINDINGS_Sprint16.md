# Findings Tracker: Sprint 16 (code)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R3 | High | security | live-authentication-bearing-data | Live authentication-bearing database state still traverses Azure Files NFS without transport encryption. This remains... | OPEN |  | R3 |
| 2 | R3 | Medium | domain | approved-plan-no-longer | The approved plan no longer matches the implementation for the container runtime security model. The document still d... | OPEN |  | R3 |
| 3 | R3 | Medium | security | norootsquash-remains-enforcement | `NoRootSquash` remains the enforcement model for the live database share. Storage-level protection is absent and the ... | OPEN |  | R3 |
| 4 | R3 | Medium | security | backup-storage-account-still | The backup storage account still permits `AzureServices` bypass, which weakens the deny-by-default network posture. (... | OPEN |  | R3 |
| 5 | R3 | Medium | security | backup-job-has-write | The backup job has write-capable access to the live database share even though it only needs read access. (File: `inf... | OPEN |  | R3 |
| 6 | R3 | Low | test_quality | test-run-backup-uploads | `test_run_backup_uploads_blob` does not assert that `upload_blob` is called with `overwrite=False`, so a silent overw... | OPEN |  | R3 |
| 7 | R3 | Low | test_quality | no-test-covers-run | No test covers `run_backup()` when the source database path does not exist. (File: `infra/backup-job/test_backup.py`)... | OPEN |  | R3 |
| 8 | R3 | Low | code_quality | capturing-mkstemp-duplicated-ver | `capturing_mkstemp` is duplicated verbatim across two tests instead of being extracted as shared test support. (File:... | OPEN |  | R3 |
| 9 | R3 | Low | code_quality | multi-line-comment-blocks | Multi-line comment blocks in `server/src/db.rs` and `server/tests/common/mod.rs` violate the project’s one-line comme... | OPEN |  | R3 |
| 10 | R3 | Low | code_quality | open-dst-path-w | `open(dst_path, "w").close()` in test code should be replaced with an idiomatic context-managed or `Path.touch()` for... | OPEN |  | R3 |
| 11 | R3 | Low | domain | plan-status-header-stale | The plan status header is stale and still marked as draft/R2-era text. (File: `PLAN_Sprint16.md`, Location: line 4) (... | OPEN |  | R3 |
