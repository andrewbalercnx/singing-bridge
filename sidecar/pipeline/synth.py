#!/usr/bin/env python3
"""File: sidecar/pipeline/synth.py

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
  - `tempo` is a BPM percentage (100 = original speed, 50 = half,
    200 = double). Tempo scaling is applied by rewriting set_tempo
    events in a temporary copy of the MIDI file (via mido) before
    handing off to FluidSynth — FluidSynth has no CLI tempo flag.

Last updated: Sprint 12a (2026-04-21) -- promoted from spike to production sidecar
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import mido


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


def _scale_midi_tempo(midi_path: Path, scale: float) -> Path:
    """Return a temp file with all set_tempo events scaled by `scale`."""
    mid = mido.MidiFile(str(midi_path))
    result = mido.MidiFile(type=mid.type, ticks_per_beat=mid.ticks_per_beat)
    for track in mid.tracks:
        new_track = mido.MidiTrack()
        for msg in track:
            if msg.type == "set_tempo":
                new_track.append(msg.copy(tempo=int(msg.tempo / scale)))
            else:
                new_track.append(msg)
        result.tracks.append(new_track)
    tmp = tempfile.NamedTemporaryFile(suffix=".mid", delete=False)
    result.save(tmp.name)
    return Path(tmp.name)


def _transpose_midi(midi_path: Path, semitones: int) -> Path:
    """Return a temp file with all note pitches shifted by `semitones`."""
    mid = mido.MidiFile(str(midi_path))
    result = mido.MidiFile(type=mid.type, ticks_per_beat=mid.ticks_per_beat)
    for track in mid.tracks:
        new_track = mido.MidiTrack()
        for msg in track:
            if msg.type in ("note_on", "note_off"):
                new_pitch = max(0, min(127, msg.note + semitones))
                new_track.append(msg.copy(note=new_pitch))
            else:
                new_track.append(msg)
        result.tracks.append(new_track)
    tmp = tempfile.NamedTemporaryFile(suffix=".mid", delete=False)
    result.save(tmp.name)
    return Path(tmp.name)


def midi_to_wav(
    midi_path: Path,
    out_path: Path,
    soundfont_path: Path,
    tempo: int = 100,
    transpose: int = 0,
) -> Path:
    midi_path = Path(midi_path)
    out_path = Path(out_path)
    soundfont_path = Path(soundfont_path)

    if not soundfont_path.is_file():
        raise FluidSynthMissing(
            f"SoundFont not found at {soundfont_path}. Download a piano .sf2 "
            "(e.g. FluidR3_GM.sf2) and point PIANO_SF2 at it."
        )

    tmp_paths: list[Path] = []
    render_midi = midi_path
    try:
        if tempo != 100:
            p = _scale_midi_tempo(render_midi, tempo / 100)
            tmp_paths.append(p)
            render_midi = p
        if transpose != 0:
            p = _transpose_midi(render_midi, transpose)
            tmp_paths.append(p)
            render_midi = p

        cmd = _find_fluidsynth()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                cmd, "-ni", "-g", "0.8", "-r", "44100",
                "-F", str(out_path),
                str(soundfont_path), str(render_midi),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    finally:
        for p in tmp_paths:
            if p.exists():
                p.unlink()

    return out_path
