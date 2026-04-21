-- Migration 0005: session history — students + session_events + recording_sessions
-- Adds plain-email student records (teacher-visible) and session event history.

CREATE TABLE students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES teachers(id),
  email         TEXT    NOT NULL COLLATE NOCASE,
  first_seen_at INTEGER NOT NULL,
  UNIQUE(teacher_id, email)
);
CREATE INDEX idx_students_teacher ON students(teacher_id);

CREATE TABLE session_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES teachers(id),
  student_id    INTEGER NOT NULL REFERENCES students(id),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  duration_secs INTEGER,
  recording_id  INTEGER REFERENCES recordings(id),
  ended_reason  TEXT,
  archived_at   INTEGER
);
CREATE INDEX idx_session_events_teacher ON session_events(teacher_id, started_at DESC);
CREATE INDEX idx_session_events_student ON session_events(student_id);

-- One durable slot per teacher linking consent to the upload that follows.
CREATE TABLE recording_sessions (
  teacher_id       INTEGER PRIMARY KEY REFERENCES teachers(id),
  session_event_id INTEGER NOT NULL REFERENCES session_events(id),
  created_at       INTEGER NOT NULL
);
