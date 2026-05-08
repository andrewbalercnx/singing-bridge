-- File: server/migrations/0013_variant_bar_coords.sql
-- Purpose: Add per-variant score bar coordinates column (from verovio SVG parsing).
-- Last updated: Sprint 26 (2026-05-07) -- initial migration
ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS score_bar_coords_json TEXT;
