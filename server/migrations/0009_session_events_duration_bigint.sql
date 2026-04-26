-- File: server/migrations/0009_session_events_duration_bigint.sql
-- Purpose: Align session_events.duration_secs with session_log.duration_secs (both BIGINT).
-- Last updated: Sprint 19 (2026-04-26) -- migration 0007 missed session_events.duration_secs
ALTER TABLE session_events ALTER COLUMN duration_secs TYPE BIGINT;
