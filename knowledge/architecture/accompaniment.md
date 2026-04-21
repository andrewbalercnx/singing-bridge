# Accompaniment library architecture

**Last updated:** Sprint 12A (2026-04-21)

## Overview

The accompaniment library lets teachers upload backing tracks (PDF sheet music, MIDI, or WAV) and manage synthesised WAV variants. It sits entirely behind the teacher session cookie — no anonymous access.

## Upload pipeline

```
POST /teach/:slug/library/assets
  │
  ├─ Step 1: Parse X-Title header (≤255 bytes)
  ├─ Step 2: Content-Length early check → 413 if > 50 MB (no body read)
  ├─ Step 3: Read exactly 12 bytes for magic detection
  ├─ Step 4: detect_file_type(magic, declared_ct) → FileKind | ContentTypeMismatch | UnsupportedFileType
  ├─ Step 5: store_asset_blob → blob key
  └─ Step 6: db_insert_accompaniment → (accompaniment_id, variant_id?)
```

WAV upload auto-creates one `accompaniment_variants` row (`tempo_pct=100, transpose_semitones=0`). The two DB inserts run inside a SQLite transaction; the blob is deleted on rollback.

## Magic byte detection

| Bytes 0–3 | Bytes 8–11 | Kind |
|-----------|-----------|------|
| `%PDF` | any | PDF |
| `MThd` | any | MIDI |
| `RIFF` | `WAVE` | WAV |
| `RIFF` | other | UnsupportedFileType |
| other | — | UnsupportedFileType |

Declared `Content-Type` is checked only when it is one of `application/pdf`, `audio/midi`, or `audio/wav`. Mismatch → `ContentTypeMismatch` (422). MIME parameters are stripped before comparison.

## Sidecar (Python, `sidecar/`)

Stateless Flask service on port 5050. All endpoints require `Authorization: Bearer <SIDECAR_SECRET>`.

Error codes → AppError mapping:
- `AUDIVERIS_MISSING` / `FLUIDSYNTH_MISSING` → `SidecarUnavailable` (503)
- All other codes → `SidecarBadInput` (422); raw message logged server-side, not exposed in HTTP response

## Media tokens

`GET /api/media/:token` is public — the 64-hex-char token is the auth. Tokens are issued by `GET /teach/:slug/library/assets/:id` and invalidated on asset/variant delete. Both unknown and expired tokens return 404 (no oracle).

## SSRF protection

`SIDECAR_URL` host is validated at startup:
- Loopback always allowed
- Non-loopback must appear in `SIDECAR_HOST_ALLOWLIST` (comma-separated, exact string equality on parsed hostname, no wildcards)
- Private/link-local IPs not on the allowlist → startup error
