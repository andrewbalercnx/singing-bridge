-- File: server/migrations/0003_recordings.sql
-- Purpose: Session recording tables: recordings, recording_gate_attempts.
-- Last updated: Sprint 6 (2026-04-18) -- initial implementation
CREATE TABLE recordings (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id            INTEGER NOT NULL REFERENCES teachers(id),
    student_email         TEXT    NOT NULL,
    student_email_hash    BLOB    NOT NULL,
    created_at            INTEGER NOT NULL,
    duration_s            INTEGER,
    blob_key              TEXT    UNIQUE,      -- NULL once purged
    token_hash            BLOB    NOT NULL UNIQUE,
    token_hex             TEXT    NOT NULL UNIQUE, -- raw hex for resend without rotation
    failed_attempts       INTEGER NOT NULL DEFAULT 0,
    accessed_at           INTEGER,             -- NULL until first successful gate verify
    deleted_at            INTEGER
);

CREATE INDEX idx_recordings_teacher     ON recordings(teacher_id, created_at DESC);
CREATE INDEX idx_recordings_token_hash  ON recordings(token_hash);

-- Per-IP rate-limit log for the student access gate
CREATE TABLE recording_gate_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_ip       TEXT    NOT NULL,
    attempted_at  INTEGER NOT NULL
);

CREATE INDEX idx_gate_attempts_ip_t ON recording_gate_attempts(peer_ip, attempted_at);
