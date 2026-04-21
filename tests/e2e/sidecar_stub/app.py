# File: tests/e2e/sidecar_stub/app.py
# Purpose: Minimal Flask sidecar stub for E2E tests.
# Role: Returns hardcoded fixture responses; validates Bearer token if SIDECAR_SECRET is set.
# Depends: flask
# Last updated: Sprint 12a (2026-04-21) -- initial

import base64
import os

from flask import Flask, jsonify, request

app = Flask(__name__)

SECRET = os.environ.get("SIDECAR_SECRET", "")

STUB_MUSICXML = b"<score-partwise><part-list></part-list></score-partwise>"
STUB_MUSICXML_B64 = base64.b64encode(STUB_MUSICXML).decode()


def check_auth():
    if SECRET:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {SECRET}":
            return jsonify({"code": "UNAUTHORIZED", "error": "bad token"}), 401
    return None


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


@app.route("/omr", methods=["POST"])
def omr():
    err = check_auth()
    if err:
        return err
    return jsonify({"musicxml": STUB_MUSICXML_B64, "page_count": 1})


@app.route("/list-parts", methods=["POST"])
def list_parts():
    err = check_auth()
    if err:
        return err
    return jsonify([
        {"index": 0, "name": "Piano", "instrument": "Piano", "has_notes": True},
    ])


@app.route("/extract-midi", methods=["POST"])
def extract_midi():
    err = check_auth()
    if err:
        return err
    # Return a minimal valid MIDI header.
    return b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0", 200, {
        "Content-Type": "audio/midi"
    }


@app.route("/bar-timings", methods=["POST"])
def bar_timings():
    err = check_auth()
    if err:
        return err
    return jsonify({"timings": [{"bar": 1, "time_s": 0.0}]})


@app.route("/bar-coords", methods=["POST"])
def bar_coords():
    err = check_auth()
    if err:
        return err
    return jsonify({"coords": [
        {"bar": 1, "page": 0, "x_frac": 0.1, "y_frac": 0.1, "w_frac": 0.1, "h_frac": 0.1}
    ]})


@app.route("/rasterise", methods=["POST"])
def rasterise():
    err = check_auth()
    if err:
        return err
    # Return minimal valid empty ZIP (EOCD record, no entries).
    empty_zip = bytes([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    return empty_zip, 200, {"Content-Type": "application/zip"}


@app.route("/synthesise", methods=["POST"])
def synthesise():
    err = check_auth()
    if err:
        return err
    # Return a minimal WAV header as stub audio.
    stub_wav = b"RIFF\x00\x00\x00\x00WAVEstub"
    return stub_wav, 200, {"Content-Type": "audio/wav"}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5051))
    app.run(host="0.0.0.0", port=port)
