-- File: server/migrations/0005_session_history.sql
-- Purpose: Create students, session_events, and recording_sessions tables for Sprint 11 session history.
-- Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; BIGSERIAL, BIGINT, CITEXT

-- Migration 0005: session history — students + session_events + recording_sessions
-- Adds plain-email student records (teacher-visible) and session event history.

CREATE TABLE students (
  id            BIGSERIAL PRIMARY KEY,
  teacher_id    BIGINT  NOT NULL REFERENCES teachers(id),
  email         CITEXT  NOT NULL,
  first_seen_at INTEGER NOT NULL,
  UNIQUE(teacher_id, email)
);
CREATE INDEX idx_students_teacher ON students(teacher_id);

CREATE TABLE session_events (
  id            BIGSERIAL PRIMARY KEY,
  teacher_id    BIGINT  NOT NULL REFERENCES teachers(id),
  student_id    BIGINT  NOT NULL REFERENCES students(id),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  duration_secs INTEGER,
  recording_id  BIGINT  REFERENCES recordings(id),
  ended_reason  TEXT,
  archived_at   INTEGER
);
CREATE INDEX idx_session_events_teacher ON session_events(teacher_id, started_at DESC);
CREATE INDEX idx_session_events_student ON session_events(student_id);

-- One durable slot per teacher linking consent to the upload that follows.
CREATE TABLE recording_sessions (
  teacher_id       BIGINT PRIMARY KEY REFERENCES teachers(id),
  session_event_id BIGINT NOT NULL REFERENCES session_events(id),
  created_at       INTEGER NOT NULL
);
