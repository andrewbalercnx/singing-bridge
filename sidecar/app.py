"""File: sidecar/app.py
Purpose: Production Flask sidecar — stateless HTTP service for OMR, MIDI extraction,
         WAV synthesis, PDF rasterisation, and bar-timing/coord computation.
Role: Internal service called only by the Rust server. Never internet-facing.
      All state lives in the caller; this service accepts bytes in, returns bytes/JSON out.
Exports: Flask app (WSGI entry point)
Depends: flask, pipeline, ghostscript (gs), Audiveris (Java), FluidSynth
Invariants: Every non-/healthz endpoint requires Authorization: Bearer <SIDECAR_SECRET>.
            SIDECAR_SECRET must be set at startup; missing → process exits.
            Upload size is capped at MAX_UPLOAD_BYTES before processing.
            All temp files are cleaned up even on error.
Last updated: Sprint 25 (2026-04-28) -- /omr returns 0-based bar_coords pages to match /bar_coords + server contract
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from functools import wraps
from pathlib import Path

from flask import Flask, Response, jsonify, request

from pipeline import (
    AudiverisMissing,
    FluidSynthMissing,
    compute_bar_timings,
    extract_measure_coords,
    extract_parts_midi,
    list_parts,
    midi_to_wav,
    pdf_to_musicxml,
    rasterize_pdf_for_display,
    render_parts_to_svgs,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_secret = os.environ.get("SIDECAR_SECRET", "")
if not _secret:
    if os.environ.get("SIDECAR_ALLOW_NO_SECRET") != "1":
        print("FATAL: SIDECAR_SECRET env var is not set", file=sys.stderr)
        sys.exit(1)

PIANO_SF2 = os.environ.get("PIANO_SF2", "/opt/sf2/piano.sf2")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_PAGES = 40
MAX_DPI = 300
MIN_DPI = 1
MAX_PART_INDICES = 32
TEMPO_PCT_MIN = 25
TEMPO_PCT_MAX = 300
TRANSPOSE_MIN = -12
TRANSPOSE_MAX = 12

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def error_resp(code: str, message: str, status: int) -> tuple[Response, int]:
    return jsonify({"error": message, "code": code}), status


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not _secret or not auth.startswith("Bearer ") or auth[7:] != _secret:
            return error_resp("UNAUTHORIZED", "Invalid or missing bearer token", 401)
        return f(*args, **kwargs)
    return decorated


def _get_file(field: str) -> bytes | None:
    f = request.files.get(field)
    if f is None:
        return None
    return f.read(MAX_UPLOAD_BYTES + 1)


def _require_file(field: str):
    data = _get_file(field)
    if data is None:
        return None, error_resp("INVALID_PARAMS", f"Missing field: {field}", 422)
    if len(data) > MAX_UPLOAD_BYTES:
        return None, error_resp("PAYLOAD_TOO_LARGE", "Upload exceeds 50 MB", 413)
    return data, None


def _int_field(field: str, default: int | None = None) -> tuple[int | None, tuple | None]:
    val = request.form.get(field)
    if val is None:
        if default is not None:
            return default, None
        return None, error_resp("INVALID_PARAMS", f"Missing field: {field}", 422)
    try:
        return int(val), None
    except ValueError:
        return None, error_resp("INVALID_PARAMS", f"{field} must be an integer", 422)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/ping", methods=["POST"])
@require_auth
def ping():
    """Authenticated liveness check — verifies SIDECAR_SECRET is correct."""
    return jsonify({"status": "ok"})


@app.route("/healthz")
def healthz():
    import shutil

    def _probe(cmd_env: str, *candidates: str) -> dict:
        override = os.environ.get(cmd_env)
        if override:
            found = shutil.which(override) or override
            return {"status": "ok", "path": found}
        for name in candidates:
            path = shutil.which(name)
            if path:
                return {"status": "ok", "path": path}
        return {"status": "missing", "candidates": list(candidates)}

    audiveris = _probe("AUDIVERIS_CMD", "audiveris")
    fluidsynth = _probe("", "fluidsynth")
    ghostscript = _probe("", "gs", "ghostscript")

    sf2_path = PIANO_SF2
    sf2 = {"status": "ok", "path": sf2_path} if Path(sf2_path).exists() else {"status": "missing", "path": sf2_path}

    all_ok = all(
        d["status"] == "ok"
        for d in [audiveris, fluidsynth, ghostscript, sf2]
    )
    return jsonify({
        "status": "ok" if all_ok else "degraded",
        "audiveris": audiveris,
        "fluidsynth": fluidsynth,
        "ghostscript": ghostscript,
        "sf2": sf2,
    }), 200


@app.route("/omr", methods=["POST"])
@require_auth
def omr():
    pdf_bytes, err = _require_file("pdf")
    if err:
        return err

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        pdf_path = tmp_path / "input.pdf"
        pdf_path.write_bytes(pdf_bytes)

        try:
            xml_path = pdf_to_musicxml(pdf_path, tmp_path / "omr_out")
        except AudiverisMissing as e:
            return error_resp("AUDIVERIS_MISSING", str(e), 503)
        except subprocess.CalledProcessError as e:
            detail = (e.stderr or e.output or "").strip()[-800:]
            app.logger.error("Audiveris stderr: %s", detail)
            return error_resp("OMR_FAILED", f"Audiveris exit {e.returncode}: {detail}", 422)
        except RuntimeError as e:
            app.logger.error("OMR runtime error: %s", e)
            return error_resp("OMR_FAILED", str(e), 422)

        musicxml_bytes = xml_path.read_bytes()
        page_count = _count_pdf_pages(pdf_path)

        # Extract parts (cheap — just parses MusicXML with music21).
        try:
            parts = [p.to_dict() for p in list_parts(xml_path)]
        except Exception as e:
            app.logger.warning("list_parts failed: %s", e)
            parts = []

        # Extract bar coords while the .omr file is still alive in the tempdir.
        omr_files = list((tmp_path / "omr_out").rglob("*.omr"))
        if omr_files:
            try:
                raw_coords = extract_measure_coords(omr_files[0])
                bar_coords = [
                    {
                        "bar": c["bar_seq"],
                        "page": c["page"] - 1,  # 0-based to match /bar_coords + the browser DOM
                        "x_frac": c["x_frac"],
                        "y_frac": c["y_frac"],
                        "w_frac": c["w_frac"],
                        "h_frac": c["h_frac"],
                    }
                    for c in raw_coords
                ]
            except Exception as e:
                app.logger.warning("extract_measure_coords failed: %s", e)
                bar_coords = []
        else:
            bar_coords = []

    return jsonify({
        "musicxml": base64.b64encode(musicxml_bytes).decode(),
        "page_count": page_count,
        "parts": parts,
        "bar_coords": bar_coords,
    })


@app.route("/list-parts", methods=["POST"])
@require_auth
def list_parts_route():
    xml_bytes, err = _require_file("musicxml")
    if err:
        return err

    with tempfile.TemporaryDirectory() as tmp:
        xml_path = Path(tmp) / "score.musicxml"
        xml_path.write_bytes(xml_bytes)

        try:
            parts = list_parts(xml_path)
        except Exception as e:
            return error_resp("INVALID_MUSICXML", f"Could not parse MusicXML: {e}", 422)

    return jsonify([p.to_dict() for p in parts])


@app.route("/extract-midi", methods=["POST"])
@require_auth
def extract_midi():
    xml_bytes, err = _require_file("musicxml")
    if err:
        return err

    raw_indices = request.form.get("part_indices")
    if not raw_indices:
        return error_resp("INVALID_PART_INDICES", "Missing part_indices", 422)
    try:
        part_indices = json.loads(raw_indices)
        if not isinstance(part_indices, list) or not part_indices:
            raise ValueError("empty")
        if len(part_indices) > MAX_PART_INDICES:
            raise ValueError("too many")
        part_indices = [int(i) for i in part_indices]
    except (ValueError, TypeError) as e:
        return error_resp("INVALID_PART_INDICES", f"Invalid part_indices: {e}", 422)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        xml_path = tmp_path / "score.musicxml"
        xml_path.write_bytes(xml_bytes)
        midi_path = tmp_path / "output.mid"

        try:
            extract_parts_midi(xml_path, part_indices, midi_path)
        except IndexError as e:
            return error_resp("INVALID_PART_INDICES", str(e), 422)
        except Exception as e:
            return error_resp("INVALID_MUSICXML", f"Could not extract MIDI: {e}", 422)

        midi_bytes = midi_path.read_bytes()

    return Response(midi_bytes, mimetype="audio/midi")


@app.route("/render-score", methods=["POST"])
@require_auth
def render_score():
    xml_bytes, err = _require_file("musicxml")
    if err:
        return err

    raw_indices = request.form.get("part_indices")
    if not raw_indices:
        return error_resp("INVALID_PART_INDICES", "Missing part_indices", 422)
    try:
        part_indices = json.loads(raw_indices)
        if not isinstance(part_indices, list) or not part_indices:
            raise ValueError("empty or non-list")
        if len(part_indices) > MAX_PART_INDICES:
            raise ValueError("too many")
        part_indices = [int(i) for i in part_indices]
    except (ValueError, TypeError) as e:
        return error_resp("INVALID_PART_INDICES", f"Invalid part_indices: {e}", 422)

    with tempfile.TemporaryDirectory() as tmp:
        xml_path = Path(tmp) / "score.musicxml"
        xml_path.write_bytes(xml_bytes)

        try:
            svgs = render_parts_to_svgs(xml_path, part_indices)
        except ImportError as e:
            return error_resp("VEROVIO_MISSING", str(e), 503)
        except IndexError as e:
            return error_resp("INVALID_PART_INDICES", str(e), 422)
        except Exception as e:
            return error_resp("INVALID_MUSICXML", f"Could not render score: {e}", 422)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, svg_str in enumerate(svgs):
                zf.writestr(f"page_{i + 1:04d}.svg", svg_str.encode("utf-8"))
        zip_bytes = buf.getvalue()

    return Response(zip_bytes, mimetype="application/zip")


@app.route("/bar-timings", methods=["POST"])
@require_auth
def bar_timings():
    midi_bytes, err = _require_file("midi")
    if err:
        return err

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        # bar_timings works from musicxml (via compute_bar_timings), but we
        # need to extract timing from the MIDI's embedded tempo. Use mido to
        # compute timings directly from the MIDI tick structure.
        midi_path = tmp_path / "input.mid"
        midi_path.write_bytes(midi_bytes)

        try:
            timings = _midi_to_bar_timings(midi_path)
        except Exception as e:
            return error_resp("INVALID_MIDI", f"Could not parse MIDI: {e}", 422)

    return jsonify({"timings": timings})


@app.route("/bar-coords", methods=["POST"])
@require_auth
def bar_coords():
    pdf_bytes, err = _require_file("pdf")
    if err:
        return err

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        pdf_path = tmp_path / "input.pdf"
        pdf_path.write_bytes(pdf_bytes)

        page_count = _count_pdf_pages(pdf_path)
        if page_count > MAX_PAGES:
            return error_resp("PAGE_COUNT_EXCEEDED", f"PDF has {page_count} pages (max {MAX_PAGES})", 422)

        try:
            pdf_to_musicxml(pdf_path, tmp_path / "omr_out")
        except AudiverisMissing as e:
            return error_resp("AUDIVERIS_MISSING", str(e), 503)
        except subprocess.CalledProcessError as e:
            detail = (e.stderr or e.output or "").strip()[-800:]
            app.logger.error("Audiveris stderr (bar-coords): %s", detail)
            return error_resp("OMR_FAILED", f"Audiveris exit {e.returncode}: {detail}", 422)
        except RuntimeError as e:
            app.logger.error("OMR runtime error (bar-coords): %s", e)
            return error_resp("OMR_FAILED", str(e), 422)

        omr_files = list((tmp_path / "omr_out").rglob("*.omr"))
        if not omr_files:
            return error_resp("OMR_FAILED", "Audiveris produced no .omr file", 422)

        try:
            raw_coords = extract_measure_coords(omr_files[0])
        except Exception as e:
            return error_resp("OMR_FAILED", f"Could not extract coords: {e}", 422)

    coords = [
        {
            "bar": c["bar_seq"],
            "page": c["page"] - 1,  # 0-based
            "x_frac": c["x_frac"],
            "y_frac": c["y_frac"],
            "w_frac": c["w_frac"],
            "h_frac": c["h_frac"],
        }
        for c in raw_coords
    ]
    return jsonify({"coords": coords, "dpi": 150})


@app.route("/rasterise", methods=["POST"])
@require_auth
def rasterise():
    pdf_bytes, err = _require_file("pdf")
    if err:
        return err

    dpi, err = _int_field("dpi", default=150)
    if err:
        return err
    if dpi <= 0:
        return error_resp("INVALID_PARAMS", "dpi must be positive", 422)
    if dpi > MAX_DPI:
        return error_resp("DPI_EXCEEDED", f"DPI {dpi} exceeds maximum {MAX_DPI}", 422)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        pdf_path = tmp_path / "input.pdf"
        pdf_path.write_bytes(pdf_bytes)

        page_count = _count_pdf_pages(pdf_path)
        if page_count > MAX_PAGES:
            return error_resp("PAGE_COUNT_EXCEEDED", f"PDF has {page_count} pages (max {MAX_PAGES})", 422)

        pages_dir = tmp_path / "pages"
        pages_dir.mkdir()
        try:
            pages = _rasterise_pdf(pdf_path, pages_dir, dpi)
        except RuntimeError as e:
            return error_resp("OMR_FAILED", str(e), 503)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for page_path in sorted(pages):
                zf.write(page_path, page_path.name)
        zip_bytes = buf.getvalue()

    return Response(zip_bytes, mimetype="application/zip")


@app.route("/synthesise", methods=["POST"])
@require_auth
def synthesise():
    midi_bytes, err = _require_file("midi")
    if err:
        return err

    tempo_pct, err = _int_field("tempo_pct", default=100)
    if err:
        return err
    if not (TEMPO_PCT_MIN <= tempo_pct <= TEMPO_PCT_MAX):
        return error_resp("INVALID_PARAMS", f"tempo_pct must be {TEMPO_PCT_MIN}–{TEMPO_PCT_MAX}", 422)

    transpose, err = _int_field("transpose_semitones", default=0)
    if err:
        return err
    if not (TRANSPOSE_MIN <= transpose <= TRANSPOSE_MAX):
        return error_resp("INVALID_PARAMS", f"transpose_semitones must be {TRANSPOSE_MIN}–{TRANSPOSE_MAX}", 422)

    respect_repeats_raw, err = _int_field("respect_repeats", default=0)
    if err:
        return err
    if respect_repeats_raw not in (0, 1):
        return error_resp("INVALID_PARAMS", "respect_repeats must be 0 or 1", 422)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        midi_path = tmp_path / "input.mid"
        midi_path.write_bytes(midi_bytes)
        wav_path = tmp_path / "output.wav"

        try:
            midi_to_wav(
                midi_path,
                wav_path,
                Path(PIANO_SF2),
                tempo=tempo_pct,
                transpose=transpose,
            )
        except FluidSynthMissing as e:
            return error_resp("FLUIDSYNTH_MISSING", str(e), 503)
        except subprocess.CalledProcessError as e:
            return error_resp("FLUIDSYNTH_MISSING", f"FluidSynth failed: {e}", 503)

        wav_bytes = wav_path.read_bytes()

    return Response(wav_bytes, mimetype="audio/wav")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _count_pdf_pages(pdf_path: Path) -> int:
    import shutil
    gs = shutil.which("gs") or shutil.which("ghostscript")
    if gs is None:
        return 1  # can't count; let downstream fail if actually too large
    result = subprocess.run(
        [gs, "-dNOPAUSE", "-dBATCH", "-sDEVICE=nullpage", str(pdf_path)],
        capture_output=True, text=True,
    )
    # gs prints "Page N" for each page; count them
    pages = result.stderr.count("Page ")
    return pages if pages > 0 else 1


def _rasterise_pdf(pdf_path: Path, out_dir: Path, dpi: int) -> list[Path]:
    import shutil
    gs = shutil.which("gs") or shutil.which("ghostscript")
    if gs is None:
        raise RuntimeError("ghostscript not found; cannot rasterise PDF")
    pattern = str(out_dir / "page_%04d.png")
    subprocess.run(
        [gs, "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m",
         f"-r{dpi}", f"-sOutputFile={pattern}", str(pdf_path)],
        check=True, capture_output=True, text=True,
    )
    return sorted(out_dir.glob("page_*.png"))


def _midi_to_bar_timings(midi_path: Path) -> list[dict]:
    """Compute bar start times from MIDI tick structure and tempo events."""
    import mido

    try:
        mid = mido.MidiFile(str(midi_path))
    except Exception as e:
        raise ValueError(f"Cannot parse MIDI: {e}") from e

    ticks_per_beat = mid.ticks_per_beat
    if ticks_per_beat <= 0:
        raise ValueError("Invalid ticks_per_beat")

    # Collect tempo changes from all tracks (type 0/1 have tempo in track 0).
    tempo_map: list[tuple[int, int]] = []  # (abs_tick, us_per_beat)
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.type == "set_tempo":
                tempo_map.append((abs_tick, msg.tempo))

    tempo_map.sort(key=lambda x: x[0])
    if not tempo_map:
        tempo_map = [(0, 500000)]  # 120 BPM default

    def ticks_to_seconds(tick: int) -> float:
        t = 0.0
        prev_tick = 0
        prev_tempo = tempo_map[0][1]
        for t_tick, t_tempo in tempo_map:
            if t_tick >= tick:
                break
            t += (min(t_tick, tick) - prev_tick) * prev_tempo / (ticks_per_beat * 1_000_000)
            prev_tick = t_tick
            prev_tempo = t_tempo
        t += (tick - prev_tick) * prev_tempo / (ticks_per_beat * 1_000_000)
        return t

    # Collect time signature changes.
    ts_map: list[tuple[int, int, int]] = []  # (abs_tick, numerator, denominator)
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.type == "time_signature":
                ts_map.append((abs_tick, msg.numerator, msg.denominator))
    ts_map.sort(key=lambda x: x[0])
    if not ts_map:
        ts_map = [(0, 4, 4)]

    def ts_at(tick: int) -> tuple[int, int]:
        num, den = ts_map[0][1], ts_map[0][2]
        for t_tick, t_num, t_den in ts_map:
            if t_tick <= tick:
                num, den = t_num, t_den
        return num, den

    # Walk through bars.
    end_tick = max(
        sum(msg.time for msg in track)
        for track in mid.tracks
    ) if mid.tracks else 0

    timings: list[dict] = []
    bar = 1
    current_tick = 0
    while current_tick <= end_tick + ticks_per_beat:
        num, den = ts_at(current_tick)
        bar_ticks = int(ticks_per_beat * num * 4 / den)
        timings.append({
            "bar": bar,
            "time_s": round(ticks_to_seconds(current_tick), 4),
        })
        current_tick += bar_ticks
        bar += 1
        if bar > 2000:  # safety cap
            break

    return timings


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(413)
def payload_too_large(e):
    return error_resp("PAYLOAD_TOO_LARGE", "Upload exceeds 50 MB", 413)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050)
