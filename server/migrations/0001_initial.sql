-- File: server/migrations/0001_initial.sql
-- Purpose: Initial schema for teachers, magic links, sessions, signup attempts.
-- Last updated: Sprint 1 (2026-04-17) -- initial implementation

CREATE TABLE teachers (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE magic_links (
  token_hash  BLOB PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id),
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE sessions (
  cookie_hash BLOB PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id),
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE signup_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL COLLATE NOCASE,
  peer_ip      TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_teacher         ON sessions(teacher_id);
CREATE INDEX idx_magic_links_teacher      ON magic_links(teacher_id);
CREATE INDEX idx_signup_attempts_email_t  ON signup_attempts(email, attempted_at);
CREATE INDEX idx_signup_attempts_ip_t     ON signup_attempts(peer_ip, attempted_at);
