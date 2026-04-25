-- File: server/migrations/0003_recordings.sql
-- Purpose: Session recording tables: recordings, recording_gate_attempts.
-- Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; BIGSERIAL, BYTEA, BIGINT

CREATE TABLE recordings (
    id                    BIGSERIAL PRIMARY KEY,
    teacher_id            BIGINT  NOT NULL REFERENCES teachers(id),
    student_email         TEXT    NOT NULL,
    student_email_hash    BYTEA   NOT NULL,
    created_at            INTEGER NOT NULL,
    duration_s            INTEGER,
    blob_key              TEXT    UNIQUE,      -- NULL once purged
    token_hash            BYTEA   NOT NULL UNIQUE,
    failed_attempts       INTEGER NOT NULL DEFAULT 0,
    accessed_at           INTEGER,             -- NULL until first successful gate verify
    deleted_at            INTEGER
);

CREATE INDEX idx_recordings_teacher     ON recordings(teacher_id, created_at DESC);
CREATE INDEX idx_recordings_token_hash  ON recordings(token_hash);

-- Per-IP rate-limit log for the student access gate
CREATE TABLE recording_gate_attempts (
    id            BIGSERIAL PRIMARY KEY,
    peer_ip       TEXT    NOT NULL,
    attempted_at  INTEGER NOT NULL
);

CREATE INDEX idx_gate_attempts_ip_t ON recording_gate_attempts(peer_ip, attempted_at);
