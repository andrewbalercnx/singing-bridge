-- File: server/migrations/0001_initial.sql
-- Purpose: Initial schema for teachers, magic links, sessions, signup attempts.
-- Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; BIGSERIAL, BYTEA, CITEXT

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE teachers (
  id         BIGSERIAL PRIMARY KEY,
  email      CITEXT NOT NULL UNIQUE,
  slug       CITEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE magic_links (
  token_hash  BYTEA   PRIMARY KEY,
  teacher_id  BIGINT  NOT NULL REFERENCES teachers(id),
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE sessions (
  cookie_hash BYTEA   PRIMARY KEY,
  teacher_id  BIGINT  NOT NULL REFERENCES teachers(id),
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE signup_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        CITEXT  NOT NULL,
  peer_ip      TEXT    NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_teacher         ON sessions(teacher_id);
CREATE INDEX idx_magic_links_teacher      ON magic_links(teacher_id);
CREATE INDEX idx_signup_attempts_email_t  ON signup_attempts(email, attempted_at);
CREATE INDEX idx_signup_attempts_ip_t     ON signup_attempts(peer_ip, attempted_at);
