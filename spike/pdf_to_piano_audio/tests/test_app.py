"""File: spike/pdf_to_piano_audio/tests/test_app.py

Purpose: Flask integration tests for the spike endpoints using the fixture.
         Tests the full request/response cycle without Audiveris or FluidSynth.

Last updated: 2026-04-20 -- initial tests
"""
from __future__ import annotations

import io
from pathlib import Path

import pytest

from spike.pdf_to_piano_audio.app import app as flask_app

FIXTURE = Path(__file__).parent.parent / "fixtures" / "two_part.musicxml"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SPIKE_SCRATCH", str(tmp_path))
    # Re-import SCRATCH_ROOT after monkeypatching env; reload the module-level value.
    import spike.pdf_to_piano_audio.app as app_module
    app_module.SCRATCH_ROOT = tmp_path / "pdf-piano"
    app_module.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


class TestHealthz:
    def test_ok(self, client):
        res = client.get("/healthz")
        assert res.status_code == 200
        assert res.get_json()["ok"] is True


class TestFixture:
    def test_fixture_returns_session(self, client):
        res = client.post("/fixture")
        assert res.status_code == 200
        data = res.get_json()
        assert "session_id" in data
        assert data["kind"] == "musicxml"
        assert data["fixture"] is True

    def test_fixture_then_omr(self, client):
        sid = client.post("/fixture").get_json()["session_id"]
        res = client.post(f"/{sid}/omr")
        assert res.status_code == 200
        data = res.get_json()
        assert len(data["parts"]) == 3

    def test_fixture_omr_part_shape(self, client):
        sid = client.post("/fixture").get_json()["session_id"]
        parts = client.post(f"/{sid}/omr").get_json()["parts"]
        for p in parts:
            assert {"index", "name", "instrument", "has_notes"} <= set(p.keys())

    def test_fixture_select_piano(self, client):
        sid = client.post("/fixture").get_json()["session_id"]
        parts = client.post(f"/{sid}/omr").get_json()["parts"]
        piano_idx = next(p["index"] for p in parts if p["name"] == "Piano" and p["has_notes"])
        res = client.post(f"/{sid}/select/{piano_idx}")
        assert res.status_code == 200
        data = res.get_json()
        assert "midi_url" in data

    def test_fixture_select_bad_index(self, client):
        sid = client.post("/fixture").get_json()["session_id"]
        client.post(f"/{sid}/omr")
        res = client.post(f"/{sid}/select/99")
        assert res.status_code == 400

    def test_fixture_midi_download(self, client):
        sid = client.post("/fixture").get_json()["session_id"]
        parts = client.post(f"/{sid}/omr").get_json()["parts"]
        piano_idx = next(p["index"] for p in parts if p["name"] == "Piano" and p["has_notes"])
        client.post(f"/{sid}/select/{piano_idx}")
        res = client.get(f"/{sid}/files/piano.mid")
        assert res.status_code == 200
        assert res.data[:4] == b"MThd"


class TestUpload:
    def test_upload_musicxml(self, client):
        data = {"file": (io.BytesIO(FIXTURE.read_bytes()), "score.musicxml")}
        res = client.post("/upload", data=data, content_type="multipart/form-data")
        assert res.status_code == 200
        body = res.get_json()
        assert body["kind"] == "musicxml"
        assert "session_id" in body

    def test_upload_unsupported_type(self, client):
        data = {"file": (io.BytesIO(b"garbage"), "score.mp3")}
        res = client.post("/upload", data=data, content_type="multipart/form-data")
        assert res.status_code == 400

    def test_upload_no_file(self, client):
        res = client.post("/upload")
        assert res.status_code == 400


class TestSessionGuards:
    def test_unknown_session_omr(self, client):
        res = client.post("/notasession/omr")
        assert res.status_code == 404

    def test_bad_session_id_slash(self, client):
        res = client.post("/../../etc/omr")
        # Flask routing will 404 before our guard in most cases
        assert res.status_code in (400, 404)

    def test_select_on_fixture_without_omr_succeeds(self, client):
        # Fixture copies the MusicXML into the session, so /select works
        # without /omr — the score file is already present.
        sid = client.post("/fixture").get_json()["session_id"]
        res = client.post(f"/{sid}/select/0")
        assert res.status_code == 200

    def test_render_before_select(self, client):
        sid = client.post("/fixture").get_json()["session_id"]
        client.post(f"/{sid}/omr")
        res = client.post(f"/{sid}/render")
        assert res.status_code == 400
