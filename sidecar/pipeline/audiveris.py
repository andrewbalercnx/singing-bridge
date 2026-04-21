#!/usr/bin/env python3
"""File: sidecar/pipeline/audiveris.py

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

Last updated: Sprint 12 (2026-04-21) -- promoted from spike to production sidecar
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
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


def _page_dims_pts(pdf_path: Path) -> tuple[float, float]:
    """Return the largest (width, height) in points across all pages."""
    gs = shutil.which("gs") or shutil.which("ghostscript")
    if gs is None:
        return 595.0, 842.0  # A4 fallback
    result = subprocess.run(
        [gs, "-dNOPAUSE", "-dBATCH", "-sDEVICE=bbox", str(pdf_path)],
        capture_output=True, text=True,
    )
    max_w = max_h = 0.0
    for line in (result.stdout + result.stderr).splitlines():
        if line.startswith("%%BoundingBox:"):
            parts = line.split()
            if len(parts) == 5:
                w = float(parts[3]) - float(parts[1])
                h = float(parts[4]) - float(parts[2])
                max_w, max_h = max(max_w, w), max(max_h, h)
    return (max_w or 595.0, max_h or 842.0)


def _downsample_pdf(pdf_path: Path, out_dir: Path) -> Path:
    """Render PDF pages at reduced resolution so Audiveris stays under its 20MP limit.

    Audiveris renders PDFs at ~300 DPI based on page dimensions in points
    (not the embedded image pixels).  Downsampling the image alone does not
    help; we must also reduce the page dimensions in the output PDF.

    Strategy:
      1. Render pages as PNG at RENDER_DPI (good enough for OMR).
      2. Save the PDF with save_dpi = RENDER_DPI / scale, where scale shrinks
         the page dimensions so Audiveris's 300-DPI render stays under 18 MP.
    """
    import math
    from PIL import Image

    gs = shutil.which("gs") or shutil.which("ghostscript")
    if gs is None:
        raise RuntimeError("ghostscript not found; cannot downsample oversized PDF")

    AUDIVERIS_DPI   = 300     # Audiveris renders PDFs at this DPI
    AUDIVERIS_MAX   = 18_000_000
    RENDER_DPI      = 150     # quality we render pages at

    page_w, page_h = _page_dims_pts(pdf_path)
    # Current pixel count Audiveris would see:
    audiveris_px = (page_w * AUDIVERIS_DPI / 72) * (page_h * AUDIVERIS_DPI / 72)
    scale = math.sqrt(AUDIVERIS_MAX / audiveris_px)  # < 1 when oversized

    # save_dpi: tells Pillow how many pixels = 1 inch, shrinking page dims by scale
    save_dpi = int(math.ceil(RENDER_DPI / scale))

    png_pattern = str(out_dir / "page_%04d.png")
    subprocess.run(
        [gs, "-dNOPAUSE", "-dBATCH", "-sDEVICE=pnggray",
         f"-r{RENDER_DPI}", f"-sOutputFile={png_pattern}", str(pdf_path)],
        check=True, capture_output=True, text=True,
    )

    pages = sorted(out_dir.glob("page_*.png"))
    if not pages:
        raise RuntimeError("ghostscript produced no PNG pages")

    Image.MAX_IMAGE_PIXELS = None  # safe: we generated these images ourselves
    imgs = [Image.open(p).convert("L") for p in pages]
    out_path = out_dir / "input_resampled.pdf"
    imgs[0].save(
        str(out_path), "PDF", resolution=save_dpi,
        save_all=True, append_images=imgs[1:],
    )
    for p in pages:
        p.unlink()
    return out_path


def _run_audiveris(cmd: str, pdf_path: Path, out_dir: Path) -> None:
    result = subprocess.run(
        [cmd, "-batch", "-export", "-output", str(out_dir), str(pdf_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        combined = result.stdout + result.stderr
        raise subprocess.CalledProcessError(
            result.returncode,
            cmd,
            output=result.stdout,
            stderr=combined,
        )


def extract_measure_coords(omr_path: Path) -> list[dict]:
    """Parse an Audiveris .omr file and return normalised bounding boxes for every
    measure (MeasureStack) in page order.

    Returns [{page, bar_seq, x_frac, y_frac, w_frac, h_frac}, ...] where all
    coords are fractions of the OMR image dimensions (0–1).  Multiply by the
    display PNG pixel dimensions in the browser to get screen coordinates.

    Because the fractions are relative to the physical page, they remain valid
    whether the .omr came from the original PDF or from a downsampled copy.
    """
    results: list[dict] = []
    bar_seq = 0

    with zipfile.ZipFile(omr_path) as zf:
        sheet_names = sorted(
            n for n in zf.namelist()
            if re.match(r"sheet#\d+/sheet#\d+\.xml$", n)
        )
        for sheet_name in sheet_names:
            page_num = int(re.search(r"sheet#(\d+)", sheet_name).group(1))
            root = ET.fromstring(zf.read(sheet_name).decode())

            pic = root.find("picture")
            if pic is None:
                continue
            omr_w = int(pic.get("width", "1"))
            omr_h = int(pic.get("height", "1"))

            for page_el in root.iter("page"):
                for system_el in page_el.findall("system"):
                    stacks = system_el.findall("stack")
                    if not stacks:
                        continue

                    # Barlines live inside this system's <sig>, not at the root.
                    barlines: list[tuple[int, int]] = []  # (top_y, bot_y)
                    sig = system_el.find("sig")
                    if sig is not None:
                        inters = sig.find("inters")
                        if inters is not None:
                            for el in inters:
                                if el.tag == "barline":
                                    b = el.find("bounds")
                                    if b is not None:
                                        by = int(b.get("y", 0))
                                        bh = int(b.get("h", 0))
                                        barlines.append((by, by + bh))

                    if barlines:
                        raw_top = min(by for by, _ in barlines)
                        raw_bot = max(bt for _, bt in barlines)
                    else:
                        raw_top, raw_bot = 0, omr_h

                    # 25% padding covers stems, dynamics and ledger lines.
                    pad = int((raw_bot - raw_top) * 0.25)
                    sys_top = max(0, raw_top - pad)
                    sys_bot = min(omr_h, raw_bot + pad)

                    for stack_el in stacks:
                        sx0 = int(stack_el.get("left", 0))
                        sx1 = int(stack_el.get("right", omr_w))
                        # Skip the tiny "final barline" stub that Audiveris emits
                        # as a near-zero-width trailing stack.
                        if (sx1 - sx0) / omr_w < 0.04:
                            continue
                        bar_seq += 1
                        results.append({
                            "page": page_num,
                            "bar_seq": bar_seq,
                            "x_frac": sx0 / omr_w,
                            "y_frac": sys_top / omr_h,
                            "w_frac": (sx1 - sx0) / omr_w,
                            "h_frac": (sys_bot - sys_top) / omr_h,
                        })

    return results


def rasterize_pdf_for_display(pdf_path: Path, out_dir: Path) -> list[Path]:
    """Rasterize every page of a PDF to a colour PNG for browser display.

    Uses ghostscript.  DPI is chosen so the output is ~1400 px wide —
    enough for readable notation without serving oversized images.
    Idempotent: returns existing pages without re-rendering.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(out_dir.glob("page_*.png"))
    if existing:
        return existing

    gs = shutil.which("gs") or shutil.which("ghostscript")
    if gs is None:
        raise RuntimeError("ghostscript not found; cannot rasterise PDF for display")

    page_w, _ = _page_dims_pts(pdf_path)
    dpi = max(36, min(150, int(1400 * 72 / max(page_w, 1))))

    pattern = str(out_dir / "page_%04d.png")
    subprocess.run(
        [gs, "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m",
         f"-r{dpi}", f"-sOutputFile={pattern}", str(pdf_path)],
        check=True, capture_output=True, text=True,
    )
    return sorted(out_dir.glob("page_*.png"))


def pdf_to_musicxml(pdf_path: Path, out_dir: Path) -> Path:
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = _find_audiveris()

    try:
        _run_audiveris(cmd, pdf_path, out_dir)
    except subprocess.CalledProcessError as exc:
        if "Too large image" in (exc.stderr or ""):
            pdf_path = _downsample_pdf(pdf_path, out_dir)
            _run_audiveris(cmd, pdf_path, out_dir)
        else:
            raise

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
