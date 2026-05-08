-- File: server/migrations/0012_per_variant_parts.sql
-- Purpose: Move MIDI/part/score data to per-variant; cache parts list on asset.
-- Last updated: Sprint 26 (2026-05-06)

ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS midi_blob_key TEXT;
ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS bar_timings_json TEXT;
ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS part_indices_json TEXT;
ALTER TABLE accompaniment_variants ADD COLUMN IF NOT EXISTS score_page_blob_keys_json TEXT;
ALTER TABLE accompaniments ADD COLUMN IF NOT EXISTS parts_json TEXT;
