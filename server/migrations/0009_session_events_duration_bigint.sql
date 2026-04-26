-- File: server/migrations/0009_session_events_duration_bigint.sql
-- Purpose: Align session_events.duration_secs with session_log.duration_secs (both BIGINT).
-- Migration 0007 changed session_log.duration_secs to BIGINT but missed session_events.
ALTER TABLE session_events ALTER COLUMN duration_secs TYPE BIGINT;
