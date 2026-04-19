"""File: spike/pdf_to_piano_audio/pipeline/__init__.py

Purpose: Pipeline stages for the PDF -> piano-audio spike.

Last updated: 2026-04-19 -- initial spike
"""

from .audiveris import pdf_to_musicxml, AudiverisMissing
from .selector import list_parts, extract_part_midi, PartInfo
from .synth import midi_to_wav, FluidSynthMissing

__all__ = [
    "pdf_to_musicxml",
    "AudiverisMissing",
    "list_parts",
    "extract_part_midi",
    "PartInfo",
    "midi_to_wav",
    "FluidSynthMissing",
]
