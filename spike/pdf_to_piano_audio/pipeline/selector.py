#!/usr/bin/env python3
"""File: spike/pdf_to_piano_audio/pipeline/selector.py

Purpose: Parse a MusicXML score with music21, enumerate its parts,
and export one or more chosen parts as a piano-voiced MIDI file.

Role:
  Middle stage of the spike pipeline. Takes the MusicXML that
  Audiveris produced (or a hand-authored fixture), lists parts so
  the UI can render a multi-select picker, and writes a MIDI file
  for the selected parts with every instrument forced to Acoustic
  Grand Piano.

Exports:
  - PartInfo dataclass (index, name, instrument, has_notes)
  - list_parts(musicxml_path) -> list[PartInfo]
  - extract_parts_midi(musicxml_path, part_indices, out_path) -> Path

Depends on:
  - external: music21

Invariants & gotchas:
  - `index` is the 0-based position of the part in the score as
    music21 parses it; the UI must round-trip these indices back.
  - We force program 0 (piano) on every exported part regardless of
    the original instrument, since the user's intent is accompaniment.
  - part_indices must be a non-empty list; duplicates are ignored.

Last updated: 2026-04-20 -- accept multiple part indices
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

from music21 import converter, instrument, stream


@dataclass
class PartInfo:
    index: int
    name: str
    instrument: str
    has_notes: bool

    def to_dict(self) -> dict:
        return asdict(self)


def _score(musicxml_path: Path) -> stream.Score:
    score = converter.parse(str(musicxml_path))
    if not isinstance(score, stream.Score):
        wrapper = stream.Score()
        wrapper.append(score)
        return wrapper
    return score


def list_parts(musicxml_path: Path) -> list[PartInfo]:
    score = _score(Path(musicxml_path))
    parts: list[PartInfo] = []
    for idx, part in enumerate(score.parts):
        instr = part.getInstrument(returnDefault=True)
        instr_name = getattr(instr, "instrumentName", None) or instr.__class__.__name__
        name = part.partName or instr.partName or f"Part {idx + 1}"
        has_notes = bool(part.recurse().notes)
        parts.append(PartInfo(index=idx, name=name, instrument=instr_name, has_notes=has_notes))
    return parts


def extract_parts_midi(
    musicxml_path: Path,
    part_indices: list[int],
    out_path: Path,
) -> Path:
    if not part_indices:
        raise ValueError("part_indices must be non-empty")

    score = _score(Path(musicxml_path))
    score_parts = list(score.parts)
    n = len(score_parts)

    voiced = stream.Score()
    for idx in dict.fromkeys(part_indices):  # preserve order, drop duplicates
        if idx < 0 or idx >= n:
            raise IndexError(f"part_index {idx} out of range (0..{n - 1})")
        part_copy = score_parts[idx].flatten()
        part_copy.insert(0, instrument.Piano())
        voiced.insert(0, part_copy)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    voiced.write("midi", fp=str(out_path))
    return out_path
