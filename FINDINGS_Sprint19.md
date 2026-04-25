# Findings Tracker: Sprint 19 (plan)

Editor: Update the **Status** and **Resolution** columns after addressing each finding.
Status values: `OPEN` | `ADDRESSED` | `VERIFIED` | `WONTFIX` | `REOPENED`

| # | Round | Severity | Lens | Tag | Finding | Status | Resolution | Routed |
|---|-------|----------|------|-----|---------|--------|------------|--------|
| 1 | R1 | High | test_quality | plan-omits-mandatory-test | The plan omits the mandatory `## Test Strategy` section required for plan approval. (File: `PLAN_Sprint19.md`, Locati... | ADDRESSED | ADDRESSED | R3 |
| 2 | R1 | High | test_quality | plan-deletes-sprint-16 | The plan deletes Sprint 16 database-behavior regression coverage without defining equivalent PostgreSQL regression gu... | ADDRESSED | ADDRESSED | R3 |
| 3 | R1 | High | code_quality | proposed-phase-7-harness | The proposed Phase 7 harness uses `PgConnectOptions::to_url_lossy()`, which does not exist in `sqlx` 0.8 and will not... | ADDRESSED | ADDRESSED | R3 |
| 4 | R1 | High | security | plan-does-not-enforce | The plan does not enforce authenticated PostgreSQL TLS at runtime. It preserves `sslmode=require` semantics and adds ... | ADDRESSED | ADDRESSED | R3 |
| 5 | R1 | High | domain | plan-keeps-startup-run | The plan keeps startup-run migrations in the application path even though the runtime role model does not permit DDL ... | ADDRESSED | ADDRESSED | R3 |
| 6 | R1 | High | domain | plan-removes-durable-blob | The plan removes durable blob-backed storage without providing a replacement, so the stated persistence outcome for t... | ADDRESSED | ADDRESSED | R3 |
| 7 | R1 | Medium | test_quality | testapp-cleanup-not-specified | `TestApp` cleanup is not specified as panic-safe, so failed tests can leak per-test PostgreSQL databases. (File: `PLA... | ADDRESSED | ADDRESSED | R3 |
| 8 | R1 | Medium | test_quality | plan-does-not-define | The plan does not define coverage for PostgreSQL `CITEXT` behavior even though it relies on it for case-insensitive l... | ADDRESSED | ADDRESSED | R3 |
| 9 | R1 | Medium | domain | plan-assumes-citext-available | The plan assumes `CITEXT` is available in every new database, but the extension is per-database and must be provision... | ADDRESSED | ADDRESSED | R3 |
| 10 | R1 | Medium | test_quality | exit-criteria-internally-inconsi | Exit criteria are internally inconsistent about the expected test surface, so approval cannot be checked unambiguousl... | ADDRESSED | ADDRESSED | R3 |
| 11 | R1 | Low | test_quality | proposed-100-ms-connection | The proposed 100 ms connection-acquire timeout is CI-fragile and should be increased. (File: `PLAN_Sprint19.md`, Loca... | ADDRESSED | ADDRESSED | R3 |
| 12 | R1 | Low | code_quality | plan-raises-max-connections | The plan raises `max_connections` to 10 without documenting the shared-server connection budget. (File: `PLAN_Sprint1... | ADDRESSED | ADDRESSED | R3 |
| 13 | R1 | Low | code_quality | phase-3-documentation-names | Phase 3 documentation names `dev_mail_dir` but omits `dev_blob_dir`, leaving the config impact incomplete. (File: `PL... | ADDRESSED | ADDRESSED | R3 |
| 14 | R1 | Low | test_quality | plan-leaves-execution-policy | The plan leaves the execution policy for Postgres-dependent inline tests in `cleanup.rs` undefined. (File: `PLAN_Spri... | ADDRESSED | ADDRESSED | R3 |
| 15 | R1 | Low | security | proposed-dev-default-hardcodes | The proposed dev default hardcodes local database credentials in application code. (File: `PLAN_Sprint19.md`, Locatio... | ADDRESSED | ADDRESSED | R3 |
| 16 | R2 | High | test_quality | mandatory-test-planning-missing | Mandatory test planning is missing, and critical regression/security-of-behavior checks are not codified. The plan la... | ADDRESSED | ADDRESSED | R3 |
| 17 | R2 | High | test_quality | plan-permits-cleanup | The plan permits `cleanup.rs` database tests to be marked `#[ignore]`, which removes CI coverage from the only schedu... | ADDRESSED | ADDRESSED | R3 |
| 18 | R2 | High | code_quality | sql-placeholder-rewrite-scope | The SQL placeholder rewrite scope is incomplete. Three production files using `?` placeholders are omitted, and the `... | ADDRESSED | ADDRESSED | R3 |
| 19 | R2 | High | domain | migration-plan-omits-recording | The migration plan omits the `recording_sessions.session_event_id` type change required to keep the foreign key compa... | ADDRESSED | ADDRESSED | R3 |
| 20 | R2 | High | domain | plan-uses-one-sb | The plan uses one `SB_DATABASE_URL` for both migrations and runtime access, which conflicts with ADR 0002’s `sbmigrat... | ADDRESSED | ADDRESSED | R3 |
| 21 | R2 | High | security | production-database-tls-remains | Production database TLS remains at `sslmode=require`, so hostname and certificate verification stay disabled. With `t... | ADDRESSED | ADDRESSED | R3 |
| 22 | R2 | Medium | security | production-configuration-path-st | The production configuration path still allows a localhost fallback DSN with embedded credentials when `SB_DATABASE_U... | ADDRESSED | ADDRESSED | R3 |
| 23 | R2 | Medium | test_quality | test-database-cleanup-remains | Test database cleanup remains unresolved between explicit per-test cleanup and an automatic wrapper strategy. The pla... | ADDRESSED | ADDRESSED | R3 |
| 24 | R2 | Medium | code_quality | plan-does-not-specify | The plan does not specify exact replacement defaults for `dev_mail_dir` and `dev_blob_dir` after decoupling from `dat... | ADDRESSED | ADDRESSED | R3 |
| 25 | R3 | Medium | test_quality | plan-does-not-define | The plan does not define how `server/src/cleanup.rs` inline tests will obtain create/migrate/drop database access fro... | OPEN |  | R3 |
| 26 | R3 | Medium | test_quality | exit-criterion-session-persisten | The exit criterion for session persistence across server restart has no corresponding test specification. The test st... | OPEN |  | R3 |
| 27 | R3 | Low | security | production-sslmode-verify-full | Production `sslmode=verify-full` validation uses whole-string substring matching. This can accept URLs where the lite... | OPEN |  | R3 |
| 28 | R3 | Low | security | production-localhost-rejection-i | Production localhost rejection is incomplete because it does not cover IPv6 loopback forms such as `[::1]`. Extend th... | OPEN |  | R3 |
| 29 | R3 | Low | test_quality | per-test-database-naming | Per-test database naming is process-local. Parallel `cargo test` processes can generate identical database names and ... | OPEN |  | R3 |
| 30 | R3 | Low | test_quality | fk-regression-guard-not | The FK regression guard is not verifiable as written because no planned test deletes a teacher record. Add a concrete... | OPEN |  | R3 |
| 31 | R3 | Low | code_quality | test-db-url-drops | `test_db_url` drops query parameters from `DATABASE_TEST_URL` when constructing per-test URLs. This breaks TLS-requir... | OPEN |  | R3 |
| 32 | R3 | Low | domain | optional-migrate-subcommand-fall | The optional migrate subcommand falls back to `SB_DATABASE_URL`, which is the DML-only application credential. The fa... | OPEN |  | R3 |
| 33 | R3 | Low | domain | phase-5-description-0006 | The Phase 5 description of `0006_accompaniments.sql` incorrectly places `duration_s` on `accompaniments` instead of `... | OPEN |  | R3 |
