-- File: server/migrations/0010_session_events_archived_at_bigint.sql
-- Purpose: Change session_events.archived_at to BIGINT to match unix-timestamp usage.
-- Last updated: Sprint 19 (2026-04-26) -- migration 0007 missed session_events.archived_at
ALTER TABLE session_events ALTER COLUMN archived_at TYPE BIGINT;
