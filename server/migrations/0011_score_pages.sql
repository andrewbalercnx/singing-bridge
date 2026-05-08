-- File: server/migrations/0011_score_pages.sql
-- Purpose: Store selected part indices and rendered score SVG pages per asset.
-- Last updated: Sprint 26 (2026-05-05)

ALTER TABLE accompaniments ADD COLUMN IF NOT EXISTS part_indices_json TEXT;
ALTER TABLE accompaniments ADD COLUMN IF NOT EXISTS score_page_blob_keys_json TEXT;
