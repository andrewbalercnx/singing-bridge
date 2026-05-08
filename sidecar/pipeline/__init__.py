"""File: sidecar/pipeline/__init__.py
Purpose: Pipeline stages for PDF → piano-audio processing.
Last updated: Sprint 26 (2026-05-06) -- export extract_bar_coords_from_svgs
"""

from .audiveris import pdf_to_musicxml, rasterize_pdf_for_display, extract_measure_coords, AudiverisMissing
from .selector import list_parts, extract_parts_midi, extract_parts_musicxml, compute_bar_timings, render_parts_to_svgs, extract_bar_coords_from_svgs, PartInfo
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
    "render_parts_to_svgs",
    "extract_bar_coords_from_svgs",
    "PartInfo",
    "midi_to_wav",
    "FluidSynthMissing",
]
