-- Migration 0013: per-variant score bar coordinates (from verovio SVG parsing)
ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS score_bar_coords_json TEXT;
