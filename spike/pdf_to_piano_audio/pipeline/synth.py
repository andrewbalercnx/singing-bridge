#!/usr/bin/env python3
"""File: spike/pdf_to_piano_audio/pipeline/synth.py

Purpose: Render a MIDI file to a WAV using FluidSynth + a piano SoundFont.

Role:
  Final stage of the spike pipeline. FluidSynth is a standard,
  fast, deterministic software synthesiser; with a piano SoundFont
  (FluidR3_GM or the Salamander Grand Piano SF2) it produces an
  acceptable acoustic-piano voice.

Exports:
  - midi_to_wav(midi_path, out_path, soundfont_path, tempo=100) -> Path
  - FluidSynthMissing exception

Depends on:
  - external: `fluidsynth` on PATH (or FLUIDSYNTH_CMD env override)
  - external: a .sf2 SoundFont file at `soundfont_path`

Invariants & gotchas:
  - Sample rate is fixed at 44.1 kHz, gain at 0.8.
  - `tempo` is a BPM percentage (100 = original speed, 50 = half speed,
    200 = double speed). FluidSynth's -T flag accepts a ratio; we
    convert: ratio = tempo / 100.

Last updated: 2026-04-20 -- add tempo parameter
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


class FluidSynthMissing(RuntimeError):
    """Raised when `fluidsynth` or the SoundFont cannot be located."""


def _find_fluidsynth() -> str:
    override = os.environ.get("FLUIDSYNTH_CMD")
    if override:
        return override
    found = shutil.which("fluidsynth")
    if not found:
        raise FluidSynthMissing(
            "fluidsynth not found on PATH. Install via your system package manager "
            "(apt install fluidsynth / brew install fluid-synth) or set FLUIDSYNTH_CMD."
        )
    return found


def midi_to_wav(
    midi_path: Path,
    out_path: Path,
    soundfont_path: Path,
    tempo: int = 100,
) -> Path:
    midi_path = Path(midi_path)
    out_path = Path(out_path)
    soundfont_path = Path(soundfont_path)

    if not soundfont_path.is_file():
        raise FluidSynthMissing(
            f"SoundFont not found at {soundfont_path}. Download a piano .sf2 "
            "(e.g. FluidR3_GM.sf2) and point PIANO_SF2 at it."
        )

    cmd = _find_fluidsynth()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # -T: MIDI tempo multiplier as a ratio (100 bpm% → 1.0 = original speed)
    tempo_ratio = f"{tempo / 100:.3f}"
    subprocess.run(
        [
            cmd, "-ni", "-g", "0.8", "-r", "44100",
            "-T", tempo_ratio,
            "-F", str(out_path),
            str(soundfont_path), str(midi_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return out_path
