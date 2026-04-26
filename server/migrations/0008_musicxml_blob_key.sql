-- Migration 0008: store MusicXML blob key so OMR runs only once per PDF.
ALTER TABLE accompaniments ADD COLUMN IF NOT EXISTS musicxml_blob_key TEXT;
