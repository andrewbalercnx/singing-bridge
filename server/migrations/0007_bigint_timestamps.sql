-- File: server/migrations/0007_bigint_timestamps.sql
-- Purpose: Widen all unix-timestamp columns from INT4 to INT8 (BIGINT).
-- Last updated: Sprint 20 (2026-04-26) -- fix INT4/INT8 mismatch after SQLite→PostgreSQL migration

-- Migrations 0001-0006 used INTEGER (INT4) for unix-second timestamps because SQLite
-- treats all integers uniformly. PostgreSQL enforces the distinction, and sqlx maps
-- Rust i64 strictly to INT8. Any SELECT returning these columns into i64 fails at
-- runtime with "not compatible with SQL type INT4".
--
-- Covers every table that has integer timestamp or duration columns. Columns used
-- only in WHERE-clause bindings are included for schema correctness (INT4 overflows
-- in 2038 regardless of whether they are currently returned in SELECT results).

ALTER TABLE teachers                ALTER COLUMN created_at     TYPE BIGINT;

ALTER TABLE magic_links             ALTER COLUMN issued_at      TYPE BIGINT;
ALTER TABLE magic_links             ALTER COLUMN expires_at     TYPE BIGINT;
ALTER TABLE magic_links             ALTER COLUMN consumed_at    TYPE BIGINT;

ALTER TABLE sessions                ALTER COLUMN issued_at      TYPE BIGINT;
ALTER TABLE sessions                ALTER COLUMN expires_at     TYPE BIGINT;

ALTER TABLE signup_attempts         ALTER COLUMN attempted_at   TYPE BIGINT;

ALTER TABLE session_log             ALTER COLUMN started_at     TYPE BIGINT;
ALTER TABLE session_log             ALTER COLUMN ended_at       TYPE BIGINT;
ALTER TABLE session_log             ALTER COLUMN duration_secs  TYPE BIGINT;

ALTER TABLE recordings              ALTER COLUMN created_at     TYPE BIGINT;
ALTER TABLE recordings              ALTER COLUMN duration_s     TYPE BIGINT;
ALTER TABLE recordings              ALTER COLUMN accessed_at    TYPE BIGINT;
ALTER TABLE recordings              ALTER COLUMN deleted_at     TYPE BIGINT;

ALTER TABLE recording_gate_attempts ALTER COLUMN attempted_at   TYPE BIGINT;

ALTER TABLE login_attempts          ALTER COLUMN attempted_at   TYPE BIGINT;

ALTER TABLE students                ALTER COLUMN first_seen_at  TYPE BIGINT;

ALTER TABLE session_events          ALTER COLUMN started_at     TYPE BIGINT;
ALTER TABLE session_events          ALTER COLUMN ended_at       TYPE BIGINT;

ALTER TABLE recording_sessions      ALTER COLUMN created_at     TYPE BIGINT;

ALTER TABLE accompaniments          ALTER COLUMN created_at     TYPE BIGINT;
ALTER TABLE accompaniments          ALTER COLUMN deleted_at     TYPE BIGINT;

ALTER TABLE accompaniment_variants  ALTER COLUMN created_at     TYPE BIGINT;
ALTER TABLE accompaniment_variants  ALTER COLUMN deleted_at     TYPE BIGINT;
