#!/usr/bin/env python3
"""File: spike/pdf_to_piano_audio/pipeline/selector.py

Purpose: Parse a MusicXML score with music21, enumerate its parts,
and export a chosen part as a piano-voiced MIDI file.

Role:
  Middle stage of the spike pipeline. Takes the MusicXML that
  Audiveris produced (or a hand-authored fixture), lists parts so
  the UI can render a picker, and writes a MIDI file for the
  selected part with its program forced to Acoustic Grand Piano.

Exports:
  - PartInfo dataclass (index, name, instrument, has_notes)
  - list_parts(musicxml_path) -> list[PartInfo]
  - extract_part_midi(musicxml_path, part_index, out_path) -> Path

Depends on:
  - external: music21

Invariants & gotchas:
  - `index` is the 0-based position of the part in the score as
    music21 parses it; the UI must round-trip this same index back.
  - We force program 0 (piano) on the exported MIDI regardless of
    the original instrument, since the user's intent is "play this
    line as piano".

Last updated: 2026-04-19 -- initial spike
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


def extract_part_midi(musicxml_path: Path, part_index: int, out_path: Path) -> Path:
    score = _score(Path(musicxml_path))
    score_parts = list(score.parts)
    if part_index < 0 or part_index >= len(score_parts):
        raise IndexError(f"part_index {part_index} out of range (0..{len(score_parts) - 1})")

    chosen = score_parts[part_index]
    voiced = stream.Score()
    piano = instrument.Piano()
    chosen_copy = chosen.flatten()
    chosen_copy.insert(0, piano)
    voiced.insert(0, chosen_copy)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    voiced.write("midi", fp=str(out_path))
    return out_path
