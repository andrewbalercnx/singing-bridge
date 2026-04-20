#!/usr/bin/env python3
"""File: spike/pdf_to_piano_audio/app.py

Purpose: Minimal Flask web UI for the PDF -> piano-audio spike. Walks
the user through upload -> OMR -> part selection -> piano render on a
single page.

Role:
  Prototype only. Not wired into the production Rust server. One
  process, filesystem-backed per-session scratch dirs, no auth.
  When this graduates into a sprint, the pipeline module moves
  intact; the transport layer (axum route + WebRTC data channel to
  stream the WAV) replaces this Flask shell.

Exports:
  - Flask `app` (WSGI)
  - CLI entrypoint: python3 -m spike.pdf_to_piano_audio.app

Depends on:
  - external: flask, music21, optionally audiveris + fluidsynth + a
    piano .sf2 SoundFont (see README).

Invariants & gotchas:
  - Session ids are a url-safe 16-byte token; scratch dir is
    /tmp/pdf-piano-<token>. Nothing is cleaned up automatically;
    restart the process to clear state (acceptable for a spike).
  - File uploads are capped at 20 MB via MAX_CONTENT_LENGTH.
  - The `/fixture` endpoint loads the shipped two-part MusicXML so
    the UI is demoable without Audiveris installed.

Last updated: 2026-04-19 -- initial spike
"""
from __future__ import annotations

import os
import secrets
import shutil
import tempfile
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_from_directory, url_for

from .pipeline import (
    AudiverisMissing,
    FluidSynthMissing,
    extract_parts_midi,
    extract_parts_musicxml,
    list_parts,
    midi_to_wav,
    pdf_to_musicxml,
)

HERE = Path(__file__).parent
FIXTURE = HERE / "fixtures" / "two_part.musicxml"
SCRATCH_ROOT = Path(os.environ.get("SPIKE_SCRATCH", tempfile.gettempdir())) / "pdf-piano"
SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)

MUSICXML_SUFFIXES = {".xml", ".musicxml", ".mxl"}


def _score_path(scratch: Path) -> Path | None:
    for name in ("input.musicxml", "input.xml", "input.mxl"):
        p = scratch / name
        if p.is_file():
            return p
    return None

app = Flask(__name__, template_folder=str(HERE / "templates"), static_folder=str(HERE / "static"))
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


def _session_dir(session_id: str) -> Path:
    if not session_id or "/" in session_id or ".." in session_id:
        abort(400, "bad session id")
    path = SCRATCH_ROOT / session_id
    if not path.is_dir():
        abort(404, "unknown session")
    return path


def _new_session() -> tuple[str, Path]:
    session_id = secrets.token_urlsafe(12)
    path = SCRATCH_ROOT / session_id
    path.mkdir(parents=True, exist_ok=False)
    return session_id, path


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/healthz")
def healthz():
    return {"ok": True}, 200


@app.post("/upload")
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        abort(400, "no file")
    suffix = Path(file.filename).suffix.lower()

    session_id, scratch = _new_session()

    if suffix == ".pdf":
        pdf_path = scratch / "input.pdf"
        file.save(pdf_path)
        return jsonify({"session_id": session_id, "kind": "pdf"})

    if suffix in MUSICXML_SUFFIXES:
        normalised = ".musicxml" if suffix == ".xml" else suffix
        file.save(scratch / f"input{normalised}")
        return jsonify({"session_id": session_id, "kind": "musicxml"})

    shutil.rmtree(scratch, ignore_errors=True)
    abort(400, f"unsupported file type: {suffix}")


@app.post("/fixture")
def load_fixture():
    session_id, scratch = _new_session()
    shutil.copy(FIXTURE, scratch / "input.musicxml")
    return jsonify({"session_id": session_id, "kind": "musicxml", "fixture": True})


@app.post("/<session_id>/omr")
def run_omr(session_id: str):
    scratch = _session_dir(session_id)
    pdf_path = scratch / "input.pdf"
    score_path = _score_path(scratch)

    if score_path is None:
        if not pdf_path.is_file():
            abort(400, "no input in session")
        try:
            produced = pdf_to_musicxml(pdf_path, scratch / "omr")
        except AudiverisMissing as exc:
            return jsonify({"error": "audiveris_missing", "detail": str(exc)}), 503
        except Exception as exc:
            return jsonify({"error": "omr_failed", "detail": str(exc)}), 500
        score_path = scratch / "input.musicxml"
        shutil.copy(produced, score_path)

    parts = [p.to_dict() for p in list_parts(score_path)]
    return jsonify({"parts": parts})


@app.post("/<session_id>/select")
def select(session_id: str):
    scratch = _session_dir(session_id)
    score_path = _score_path(scratch)
    if score_path is None:
        abort(400, "run /omr first")

    body = request.get_json(silent=True) or {}
    part_indices = body.get("part_indices")
    if not part_indices or not isinstance(part_indices, list):
        abort(400, "part_indices must be a non-empty list")

    midi_path = scratch / "piano.mid"
    xml_path = scratch / "score.xml"
    try:
        extract_parts_midi(score_path, part_indices, midi_path)
        extract_parts_musicxml(score_path, part_indices, xml_path)
    except (IndexError, ValueError) as exc:
        return jsonify({"error": "bad_index", "detail": str(exc)}), 400

    return jsonify({
        "midi_url": url_for("serve_file", session_id=session_id, name="piano.mid"),
        "score_url": url_for("serve_file", session_id=session_id, name="score.xml"),
        "part_indices": part_indices,
    })


@app.post("/<session_id>/render")
def render(session_id: str):
    scratch = _session_dir(session_id)
    midi_path = scratch / "piano.mid"
    if not midi_path.is_file():
        abort(400, "select a part first")

    body = request.get_json(silent=True) or {}
    raw_tempo = body.get("tempo", 100)
    try:
        tempo = int(raw_tempo)
        if not (20 <= tempo <= 300):
            raise ValueError
    except (TypeError, ValueError):
        abort(400, "tempo must be an integer between 20 and 300")

    sf2 = Path(os.environ.get("PIANO_SF2", "/usr/share/sounds/sf2/FluidR3_GM.sf2"))
    wav_path = scratch / "piano.wav"

    try:
        midi_to_wav(midi_path, wav_path, sf2, tempo=tempo)
    except FluidSynthMissing as exc:
        return jsonify({"error": "fluidsynth_missing", "detail": str(exc)}), 503
    except Exception as exc:
        return jsonify({"error": "render_failed", "detail": str(exc)}), 500

    return jsonify({
        "audio_url": url_for("serve_file", session_id=session_id, name="piano.wav"),
    })


@app.get("/<session_id>/files/<name>")
def serve_file(session_id: str, name: str):
    scratch = _session_dir(session_id)
    if "/" in name or name.startswith("."):
        abort(400)
    if not (scratch / name).is_file():
        abort(404)
    return send_from_directory(scratch, name, as_attachment=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5173"))
    app.run(host="127.0.0.1", port=port, debug=True)
