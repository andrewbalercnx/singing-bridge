-- Migration 0014: track background score render status per variant
ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS score_render_status TEXT DEFAULT 'pending';
