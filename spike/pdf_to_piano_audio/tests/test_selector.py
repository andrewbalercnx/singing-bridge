"""File: spike/pdf_to_piano_audio/tests/test_selector.py

Purpose: Unit tests for the selector pipeline stage using the bundled fixture.

Last updated: 2026-04-20 -- initial tests
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from spike.pdf_to_piano_audio.pipeline.selector import (
    PartInfo,
    extract_part_midi,
    list_parts,
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "two_part.musicxml"


class TestListParts:
    def test_returns_correct_count(self):
        parts = list_parts(FIXTURE)
        # Fixture: Voice + Piano (two staves → two music21 parts = 3 total)
        assert len(parts) == 3

    def test_part_indices_are_sequential(self):
        parts = list_parts(FIXTURE)
        assert [p.index for p in parts] == list(range(len(parts)))

    def test_voice_part_has_notes(self):
        parts = list_parts(FIXTURE)
        voice = next(p for p in parts if p.name == "Voice")
        assert voice.has_notes is True

    def test_piano_part_has_notes(self):
        parts = list_parts(FIXTURE)
        piano_with_notes = [p for p in parts if p.name == "Piano" and p.has_notes]
        assert len(piano_with_notes) == 1

    def test_empty_piano_staff_detected(self):
        parts = list_parts(FIXTURE)
        piano_empty = [p for p in parts if p.name == "Piano" and not p.has_notes]
        assert len(piano_empty) == 1

    def test_to_dict_roundtrip(self):
        parts = list_parts(FIXTURE)
        d = parts[0].to_dict()
        assert set(d.keys()) == {"index", "name", "instrument", "has_notes"}
        assert d["index"] == 0


class TestExtractPartMidi:
    def test_writes_midi_file(self, tmp_path):
        out = tmp_path / "out.mid"
        extract_part_midi(FIXTURE, 1, out)
        assert out.is_file()
        assert out.stat().st_size > 0

    def test_midi_starts_with_mthd_header(self, tmp_path):
        out = tmp_path / "out.mid"
        extract_part_midi(FIXTURE, 1, out)
        assert out.read_bytes()[:4] == b"MThd"

    def test_out_of_range_raises_index_error(self, tmp_path):
        out = tmp_path / "out.mid"
        with pytest.raises(IndexError):
            extract_part_midi(FIXTURE, 99, out)

    def test_negative_index_raises_index_error(self, tmp_path):
        out = tmp_path / "out.mid"
        with pytest.raises(IndexError):
            extract_part_midi(FIXTURE, -1, out)

    def test_creates_parent_dirs(self, tmp_path):
        out = tmp_path / "nested" / "deep" / "out.mid"
        extract_part_midi(FIXTURE, 1, out)
        assert out.is_file()

    def test_voice_part_also_extracts(self, tmp_path):
        out = tmp_path / "voice.mid"
        extract_part_midi(FIXTURE, 0, out)
        assert out.is_file()
        assert out.stat().st_size > 0
