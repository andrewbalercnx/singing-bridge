#!/usr/bin/env python3
"""File: spike/pdf_to_piano_audio/pipeline/audiveris.py

Purpose: Run Audiveris OMR on a PDF to produce MusicXML.

Role:
  Thin subprocess wrapper. Audiveris is a Java OMR engine that accepts
  PDFs natively and emits one .mxl (compressed MusicXML) per score.
  The spike uses it as a black box: pdf in, .musicxml out.

Exports:
  - pdf_to_musicxml(pdf_path, out_dir) -> Path
  - AudiverisMissing exception

Depends on:
  - external: `audiveris` on PATH (or AUDIVERIS_CMD env override)

Invariants & gotchas:
  - Audiveris writes <stem>.mxl; we unpack it to .musicxml for easy
    downstream parsing. If the PDF has multiple movements Audiveris
    emits <stem>.mvt1.mxl etc.; we return the first one found.
  - Long-running (tens of seconds per page). Caller should not block
    the request thread on this for production.

Last updated: 2026-04-19 -- initial spike
"""
from __future__ import annotations

import os
import shutil
import subprocess
import zipfile
from pathlib import Path


class AudiverisMissing(RuntimeError):
    """Raised when the `audiveris` binary cannot be located."""


def _find_audiveris() -> str:
    override = os.environ.get("AUDIVERIS_CMD")
    if override:
        return override
    found = shutil.which("audiveris")
    if not found:
        raise AudiverisMissing(
            "audiveris not found on PATH. Install from "
            "https://github.com/Audiveris/audiveris or set AUDIVERIS_CMD."
        )
    return found


def pdf_to_musicxml(pdf_path: Path, out_dir: Path) -> Path:
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = _find_audiveris()

    subprocess.run(
        [cmd, "-batch", "-export", "-output", str(out_dir), str(pdf_path)],
        check=True,
        capture_output=True,
        text=True,
    )

    mxl_files = sorted(out_dir.rglob("*.mxl"))
    if not mxl_files:
        xml_files = sorted(out_dir.rglob("*.xml")) + sorted(out_dir.rglob("*.musicxml"))
        if not xml_files:
            raise RuntimeError(f"Audiveris produced no MusicXML in {out_dir}")
        return xml_files[0]

    mxl = mxl_files[0]
    extracted = out_dir / (mxl.stem + ".musicxml")
    with zipfile.ZipFile(mxl) as zf:
        inner = next(
            (n for n in zf.namelist() if n.endswith(".xml") and not n.startswith("META-INF")),
            None,
        )
        if inner is None:
            raise RuntimeError(f"No score XML inside {mxl}")
        extracted.write_bytes(zf.read(inner))
    return extracted
