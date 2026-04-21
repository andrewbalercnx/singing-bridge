"""File: sidecar/tests/test_app.py
Purpose: Integration tests for the production sidecar Flask app.
         All external binaries (Audiveris, FluidSynth, ghostscript) are
         stubbed via env vars so tests run in CI without external dependencies.
Last updated: Sprint 12 (2026-04-21) -- initial sidecar test suite
"""
import base64
import json
import os
import sys
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

# Allow running tests from the sidecar/ directory.
sys.path.insert(0, str(Path(__file__).parent.parent))

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TWO_PART_XML = FIXTURE_DIR / "two_part.musicxml"

SECRET = "test-secret-for-sidecar-tests"


@pytest.fixture(autouse=True)
def set_env(monkeypatch):
    monkeypatch.setenv("SIDECAR_SECRET", SECRET)
    monkeypatch.setenv("SIDECAR_ALLOW_NO_SECRET", "1")
    # Stub external binaries
    monkeypatch.setenv("AUDIVERIS_CMD", "false")   # always fails → OMR_FAILED
    monkeypatch.setenv("FLUIDSYNTH_CMD", "true")   # succeeds but produces no file


@pytest.fixture()
def client(set_env):
    import importlib
    import app as sidecar_app
    importlib.reload(sidecar_app)
    sidecar_app.app.config["TESTING"] = True
    with sidecar_app.app.test_client() as c:
        yield c


def auth_headers():
    return {"Authorization": f"Bearer {SECRET}"}


def no_auth_headers():
    return {}


def wrong_auth_headers():
    return {"Authorization": "Bearer wrong-secret"}


# ---------------------------------------------------------------------------
# /healthz — no auth required
# ---------------------------------------------------------------------------

def test_healthz_no_auth(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json["status"] == "ok"


# ---------------------------------------------------------------------------
# Auth enforcement on every protected endpoint
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path,method", [
    ("/omr", "POST"),
    ("/list-parts", "POST"),
    ("/extract-midi", "POST"),
    ("/bar-timings", "POST"),
    ("/bar-coords", "POST"),
    ("/rasterise", "POST"),
    ("/synthesise", "POST"),
])
def test_missing_auth_returns_401(client, path, method):
    r = client.open(path, method=method, headers=no_auth_headers())
    assert r.status_code == 401
    assert r.json["code"] == "UNAUTHORIZED"


@pytest.mark.parametrize("path,method", [
    ("/omr", "POST"),
    ("/list-parts", "POST"),
])
def test_wrong_auth_returns_401(client, path, method):
    r = client.open(path, method=method, headers=wrong_auth_headers())
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# /omr
# ---------------------------------------------------------------------------

def test_omr_bad_pdf_returns_omr_failed(client):
    data = {"pdf": (BytesIO(b"not a pdf"), "bad.pdf")}
    r = client.post("/omr", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    # AUDIVERIS_CMD=false → non-zero exit → OMR_FAILED
    assert r.status_code == 422
    assert r.json["code"] == "OMR_FAILED"


def test_omr_missing_file_returns_422(client):
    r = client.post("/omr", data={}, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /list-parts
# ---------------------------------------------------------------------------

def test_list_parts_valid_musicxml(client):
    xml_bytes = TWO_PART_XML.read_bytes()
    data = {"musicxml": (BytesIO(xml_bytes), "score.musicxml")}
    r = client.post("/list-parts", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 200
    parts = r.json
    assert isinstance(parts, list)
    assert len(parts) >= 1
    assert "index" in parts[0]
    assert "name" in parts[0]
    assert "has_notes" in parts[0]


def test_list_parts_malformed_returns_422(client):
    data = {"musicxml": (BytesIO(b"<not valid xml>"), "bad.xml")}
    r = client.post("/list-parts", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "INVALID_MUSICXML"


def test_list_parts_missing_file(client):
    r = client.post("/list-parts", data={}, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /extract-midi
# ---------------------------------------------------------------------------

def test_extract_midi_valid(client):
    xml_bytes = TWO_PART_XML.read_bytes()
    data = {
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[0]",
    }
    r = client.post("/extract-midi", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 200
    assert r.content_type == "audio/midi"
    assert len(r.data) > 0


def test_extract_midi_empty_indices_returns_422(client):
    xml_bytes = TWO_PART_XML.read_bytes()
    data = {
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[]",
    }
    r = client.post("/extract-midi", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "INVALID_PART_INDICES"


def test_extract_midi_out_of_range_index_returns_422(client):
    xml_bytes = TWO_PART_XML.read_bytes()
    data = {
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[999]",
    }
    r = client.post("/extract-midi", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "INVALID_PART_INDICES"


def test_extract_midi_malformed_xml_returns_422(client):
    data = {
        "musicxml": (BytesIO(b"<bad>"), "bad.xml"),
        "part_indices": "[0]",
    }
    r = client.post("/extract-midi", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "INVALID_MUSICXML"


# ---------------------------------------------------------------------------
# /bar-timings
# ---------------------------------------------------------------------------

def test_bar_timings_valid_midi(client):
    # First produce a real MIDI from the fixture
    xml_bytes = TWO_PART_XML.read_bytes()
    extract_r = client.post("/extract-midi", data={
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[0]",
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert extract_r.status_code == 200

    r = client.post("/bar-timings", data={
        "midi": (BytesIO(extract_r.data), "piano.mid"),
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert r.status_code == 200
    body = r.json
    assert "timings" in body
    assert isinstance(body["timings"], list)
    # May be empty for a degenerate MIDI, but no error
    for entry in body["timings"]:
        assert "bar" in entry
        assert "time_s" in entry


def test_bar_timings_malformed_midi_returns_422(client):
    data = {"midi": (BytesIO(b"not a midi"), "bad.mid")}
    r = client.post("/bar-timings", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "INVALID_MIDI"


def test_bar_timings_empty_midi_returns_empty_list(client):
    """A valid MIDI with no notes returns empty timings — not an error."""
    import mido
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(track)
    buf = BytesIO()
    mid.save(file=buf)
    buf.seek(0)

    r = client.post("/bar-timings", data={
        "midi": (buf, "empty.mid"),
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert r.status_code == 200
    assert isinstance(r.json["timings"], list)


# ---------------------------------------------------------------------------
# /rasterise
# ---------------------------------------------------------------------------

def test_rasterise_dpi_exceeds_max(client, monkeypatch):
    data = {
        "pdf": (BytesIO(b"%PDF-1.4 test"), "test.pdf"),
        "dpi": "301",
    }
    r = client.post("/rasterise", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "DPI_EXCEEDED"


def test_rasterise_dpi_zero_returns_422(client):
    data = {
        "pdf": (BytesIO(b"%PDF-1.4 test"), "test.pdf"),
        "dpi": "0",
    }
    r = client.post("/rasterise", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == "INVALID_PARAMS"


# ---------------------------------------------------------------------------
# /synthesise — parameter boundary tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tempo_pct,expect_code", [
    (0, "INVALID_PARAMS"),
    (24, "INVALID_PARAMS"),
    (301, "INVALID_PARAMS"),
])
def test_synthesise_invalid_tempo_pct(client, tempo_pct, expect_code):
    xml_bytes = TWO_PART_XML.read_bytes()
    # Get a real MIDI first
    midi_r = client.post("/extract-midi", data={
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[0]",
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert midi_r.status_code == 200

    data = {
        "midi": (BytesIO(midi_r.data), "piano.mid"),
        "tempo_pct": str(tempo_pct),
        "transpose_semitones": "0",
        "respect_repeats": "0",
    }
    r = client.post("/synthesise", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == expect_code


@pytest.mark.parametrize("transpose,expect_code", [
    (-13, "INVALID_PARAMS"),
    (13, "INVALID_PARAMS"),
])
def test_synthesise_invalid_transpose(client, transpose, expect_code):
    xml_bytes = TWO_PART_XML.read_bytes()
    midi_r = client.post("/extract-midi", data={
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[0]",
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert midi_r.status_code == 200

    data = {
        "midi": (BytesIO(midi_r.data), "piano.mid"),
        "tempo_pct": "100",
        "transpose_semitones": str(transpose),
        "respect_repeats": "0",
    }
    r = client.post("/synthesise", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.status_code == 422
    assert r.json["code"] == expect_code


@pytest.mark.parametrize("tempo_pct", [25, 100, 300])
def test_synthesise_valid_tempo_pct_calls_fluidsynth(client, monkeypatch, tempo_pct):
    """Valid tempo_pct should reach FluidSynth. FLUIDSYNTH_CMD=true succeeds
    but writes no file, so we expect FLUIDSYNTH_MISSING (no output) rather than
    INVALID_PARAMS. This proves validation passed."""
    xml_bytes = TWO_PART_XML.read_bytes()
    midi_r = client.post("/extract-midi", data={
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[0]",
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert midi_r.status_code == 200

    data = {
        "midi": (BytesIO(midi_r.data), "piano.mid"),
        "tempo_pct": str(tempo_pct),
        "transpose_semitones": "0",
        "respect_repeats": "0",
    }
    r = client.post("/synthesise", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    # Should NOT be INVALID_PARAMS — validation passed; FluidSynth stub fails at runtime
    assert r.json.get("code") != "INVALID_PARAMS"


@pytest.mark.parametrize("transpose", [-12, 0, 12])
def test_synthesise_valid_transpose_passes_validation(client, transpose):
    xml_bytes = TWO_PART_XML.read_bytes()
    midi_r = client.post("/extract-midi", data={
        "musicxml": (BytesIO(xml_bytes), "score.musicxml"),
        "part_indices": "[0]",
    }, headers=auth_headers(), content_type="multipart/form-data")
    assert midi_r.status_code == 200

    data = {
        "midi": (BytesIO(midi_r.data), "piano.mid"),
        "tempo_pct": "100",
        "transpose_semitones": str(transpose),
        "respect_repeats": "0",
    }
    r = client.post("/synthesise", data=data, headers=auth_headers(),
                    content_type="multipart/form-data")
    assert r.json.get("code") != "INVALID_PARAMS"
