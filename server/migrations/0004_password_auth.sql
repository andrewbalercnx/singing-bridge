-- File: server/migrations/0004_password_auth.sql
-- Purpose: Add password_hash column to teachers and create login_attempts table.
-- Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; BIGSERIAL, BIGINT

ALTER TABLE teachers ADD COLUMN password_hash TEXT;

-- teacher_id is nullable so unknown-email attempts can be recorded for IP throttling.
CREATE TABLE login_attempts (
  id           BIGSERIAL PRIMARY KEY,
  teacher_id   BIGINT  REFERENCES teachers(id),
  peer_ip      TEXT    NOT NULL,
  attempted_at INTEGER NOT NULL,
  succeeded    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_login_attempts_teacher_t ON login_attempts(teacher_id, attempted_at);
CREATE INDEX idx_login_attempts_ip_t      ON login_attempts(peer_ip, attempted_at);
