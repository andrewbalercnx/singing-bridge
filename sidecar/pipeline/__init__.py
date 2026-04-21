"""File: sidecar/pipeline/__init__.py
Purpose: Pipeline stages for PDF → piano-audio processing.
Last updated: Sprint 12 (2026-04-21) -- promoted from spike to production sidecar
"""

from .audiveris import pdf_to_musicxml, rasterize_pdf_for_display, extract_measure_coords, AudiverisMissing
from .selector import list_parts, extract_parts_midi, extract_parts_musicxml, compute_bar_timings, PartInfo
from .synth import midi_to_wav, FluidSynthMissing

__all__ = [
    "pdf_to_musicxml",
    "rasterize_pdf_for_display",
    "extract_measure_coords",
    "AudiverisMissing",
    "list_parts",
    "extract_parts_midi",
    "extract_parts_musicxml",
    "compute_bar_timings",
    "PartInfo",
    "midi_to_wav",
    "FluidSynthMissing",
]
