-- File: server/migrations/0008_musicxml_blob_key.sql
-- Purpose: Add musicxml_blob_key column so OMR MusicXML is cached in blob storage.
-- Last updated: Sprint 23 (2026-04-26) -- single-pass OMR caching

-- Migration 0008: store MusicXML blob key so OMR runs only once per PDF.
ALTER TABLE accompaniments ADD COLUMN IF NOT EXISTS musicxml_blob_key TEXT;
