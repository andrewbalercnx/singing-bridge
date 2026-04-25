-- File: server/migrations/0006_accompaniments.sql
-- Purpose: Create accompaniments and accompaniment_variants tables for Sprint 12 library.
-- Last updated: Sprint 19 (2026-04-25) -- migrate SQLite → PostgreSQL; BIGSERIAL, BIGINT, DOUBLE PRECISION

-- Migration 0006: accompaniment library — assets + variants
-- Stores backing-track assets (PDF/MIDI + rasterised pages + bar data)
-- and WAV variants (tempo/transpose/repeats variants of a MIDI asset).

CREATE TABLE accompaniments (
  id                   BIGSERIAL PRIMARY KEY,
  teacher_id           BIGINT  NOT NULL REFERENCES teachers(id),
  title                TEXT    NOT NULL,
  pdf_blob_key         TEXT,
  midi_blob_key        TEXT,
  page_blob_keys_json  TEXT,   -- JSON array of blob keys, one per rasterised page
  bar_coords_json      TEXT,   -- [{bar, page, x_frac, y_frac, w_frac, h_frac}] fractional coords
  bar_timings_json     TEXT,   -- [{bar, time_s}] at tempo_pct=100
  created_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  CHECK (title != '')
);
CREATE INDEX idx_accomp_teacher ON accompaniments(teacher_id, created_at DESC);

CREATE TABLE accompaniment_variants (
  id                  BIGSERIAL PRIMARY KEY,
  accompaniment_id    BIGINT  NOT NULL REFERENCES accompaniments(id),
  label               TEXT    NOT NULL,
  wav_blob_key        TEXT    NOT NULL,
  tempo_pct           INTEGER NOT NULL DEFAULT 100
                        CHECK (tempo_pct >= 25 AND tempo_pct <= 300),
  transpose_semitones INTEGER NOT NULL DEFAULT 0
                        CHECK (transpose_semitones >= -12 AND transpose_semitones <= 12),
  respect_repeats     INTEGER NOT NULL DEFAULT 0
                        CHECK (respect_repeats IN (0, 1)),
  duration_s          DOUBLE PRECISION,
  created_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  CHECK (label != '')
);
CREATE INDEX idx_variant_accomp ON accompaniment_variants(accompaniment_id, created_at DESC);
