-- File: server/migrations/0002_session_log.sql
-- Purpose: Session log table — start/end/peak metrics per admitted session.
--          No raw PII: email is pepper-hashed (sha256(lower(email)||pepper)),
--          peer IP is never stored.
-- Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; BYTEA, BIGINT

CREATE TABLE session_log (
  id                 BYTEA   PRIMARY KEY,          -- SessionLogId (UUID v4, 16 bytes)
  teacher_id         BIGINT  NOT NULL REFERENCES teachers(id),
  student_email_hash BYTEA   NOT NULL,             -- sha256(lower(email) || pepper); 32 bytes
  browser            TEXT    NOT NULL,
  device_class       TEXT    NOT NULL,
  tier               TEXT    NOT NULL,             -- 'supported'|'degraded'|'unworkable'
  started_at         INTEGER NOT NULL,             -- unix seconds
  ended_at           INTEGER,                      -- NULL while session is live
  duration_secs      INTEGER,                      -- MAX(0, ended_at - started_at); set on close
  peak_loss_bp       INTEGER NOT NULL DEFAULT 0,   -- basis points (×0.01 % each; 0–10000)
  peak_rtt_ms        INTEGER NOT NULL DEFAULT 0,
  ended_reason       TEXT                          -- 'hangup'|'floor_violation'|'disconnect'|'blocked'|'server_shutdown'
);

CREATE INDEX idx_session_log_teacher ON session_log(teacher_id, started_at);
CREATE INDEX idx_session_log_started ON session_log(started_at);
