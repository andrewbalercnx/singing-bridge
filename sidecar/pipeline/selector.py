#!/usr/bin/env python3
"""File: sidecar/pipeline/selector.py

Purpose: Parse a MusicXML score with music21, enumerate its parts,
and export one or more chosen parts as piano-voiced MIDI and MusicXML.

Role:
  Middle stage of the spike pipeline. Takes the MusicXML that
  Audiveris produced (or a hand-authored fixture), lists parts so
  the UI can render a multi-select picker, and writes a MIDI file
  and a MusicXML file for the selected parts with every instrument
  forced to Acoustic Grand Piano.

Exports:
  - PartInfo dataclass (index, name, instrument, has_notes)
  - list_parts(musicxml_path) -> list[PartInfo]
  - extract_parts_midi(musicxml_path, part_indices, out_path) -> Path
  - extract_parts_musicxml(musicxml_path, part_indices, out_path) -> Path

Depends on:
  - external: music21, mido

Invariants & gotchas:
  - `index` is the 0-based position of the part in the score as
    music21 parses it; the UI must round-trip these indices back.
  - We force program 0 (piano) on every exported part regardless of
    the original instrument, since the user's intent is accompaniment.
  - part_indices must be a non-empty list; duplicates are ignored.
  - MIDI sync strategy: canonical bar durations come from the time
    signature (ground truth).  Each bar's note positions are scaled by
    canonical_dur / actual_dur, so OMR errors (e.g. 5 beats in a 4/4
    bar) are corrected per bar and all parts hit every bar line at the
    same tick.

Last updated: Sprint 29 (2026-05-10) -- pass transpose to render_parts_to_svgs so score matches audio
"""
from __future__ import annotations

import copy
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import mido
from music21 import chord as m21chord
from music21 import converter, instrument
from music21 import note as m21note
from music21 import pitch as m21pitch
from music21 import stream
from music21 import tempo as m21tempo


@dataclass
class PartInfo:
    index: int
    name: str
    instrument: str
    has_notes: bool

    def to_dict(self) -> dict:
        return asdict(self)


def _score(musicxml_path: Path) -> stream.Score:
    score = converter.parse(str(musicxml_path))
    if not isinstance(score, stream.Score):
        wrapper = stream.Score()
        wrapper.append(score)
        score = wrapper
    _correct_key_signature_pitches(score)
    return score


def _correct_key_signature_pitches(score: stream.Score) -> None:
    """Fix notes whose pitch lost its key-signature accidental due to OMR errors.

    Three root causes handled here:

    1. Audiveris stops writing <alter> on notes after an explicit natural sign,
       relying on the reader to re-apply the key signature at the next bar line.
       music21 reads those notes as naturals (acc is None).

    2. music21 sometimes carries an Accidental object with displayStatus=False
       (a "courtesy" or "inherited" accidental) across a bar line, leaving the
       note with the wrong pitch even though no explicit sign was written.

    3. Audiveris mis-reads the key signature on some staves (e.g. reads 1 flat
       instead of 3 flats on the bass clef).  We build a consensus key signature
       across all parts — taking the one with the most alterations per measure —
       since OMR tends to under-detect flats/sharps rather than over-detect them.

    The rule: an accidental is only "explicit" if displayStatus is True — i.e.
    the original MusicXML contained a visible <accidental> element.  Everything
    else is either absent or a music21 internal artefact, and gets overridden by
    the consensus key-signature / within-bar state.

    Algorithm per measure, per part:
      - ks_alter: step → semitone from the consensus KeySignature (ground truth).
      - bar_state: records the alter for each step where an explicit accidental
        was seen in the current bar (resets at every bar line).
      - For each note:
          explicit  → record in bar_state, leave pitch unchanged.
          non-explicit in bar_state → apply bar_state carry-over.
          non-explicit, step in ks_alter → apply key signature.
          non-explicit, step not in ks_alter → natural (no change needed).
    """
    # Build a consensus KS map across all parts: for each measure number take
    # the KS with the most altered pitches.  OMR under-detects accidentals, so
    # the richest KS across staves is the closest to the ground truth.
    ref_ks: dict[int, dict[str, float]] = {}
    for part in score.parts:
        for measure in part.getElementsByClass(stream.Measure):
            ks = measure.getContextByClass("KeySignature")
            if ks is None:
                continue
            ks_alter: dict[str, float] = {p.step: p.alter for p in ks.alteredPitches}
            existing = ref_ks.get(measure.number)
            if existing is None or len(ks_alter) > len(existing):
                ref_ks[measure.number] = ks_alter

    for part in score.parts:
        for measure in part.getElementsByClass(stream.Measure):
            if measure.number not in ref_ks:
                continue  # no KS known for this measure (e.g. pickup bar) — leave as-is
            ks_alter = ref_ks[measure.number]

            bar_state: dict[str, float] = {}

            for el in measure.flatten().notes:
                for note in (el.notes if isinstance(el, m21chord.Chord) else [el]):
                    step = note.pitch.step
                    acc  = note.pitch.accidental

                    # An accidental is "explicit" only when the score printed it.
                    is_explicit = acc is not None and getattr(acc, "displayStatus", None) is True

                    if is_explicit:
                        bar_state[step] = acc.alter
                        continue  # pitch is already correct

                    # Determine the expected alteration from context.
                    current_alter = acc.alter if acc else 0
                    if step in bar_state:
                        expected = bar_state[step]
                    elif step in ks_alter:
                        expected = ks_alter[step]
                    else:
                        expected = 0  # natural — no key-sig alteration

                    if current_alter != expected:
                        if expected == 0:
                            note.pitch.accidental = None
                        else:
                            note.pitch.accidental = m21pitch.Accidental(expected)


def list_parts(musicxml_path: Path) -> list[PartInfo]:
    score = _score(Path(musicxml_path))
    parts: list[PartInfo] = []
    for idx, part in enumerate(score.parts):
        instr = part.getInstrument(returnDefault=True)
        instr_name = getattr(instr, "instrumentName", None) or instr.__class__.__name__
        name = part.partName or instr.partName or f"Part {idx + 1}"
        has_notes = bool(part.recurse().notes)
        parts.append(PartInfo(index=idx, name=name, instrument=instr_name, has_notes=has_notes))
    return parts


def _force_piano(part: stream.Part) -> None:
    for instr in list(part.recurse().getElementsByClass(instrument.Instrument)):
        instr.activeSite.remove(instr)
    part.insert(0, instrument.Piano())


def _get_score_bpm(score: stream.Score) -> float:
    for el in score.flatten():
        if isinstance(el, m21tempo.MetronomeMark) and el.number:
            return float(el.number)
    return 120.0


def _vel(el: m21note.Note) -> int:
    try:
        v = el.volume.velocity
        if v is not None:
            return max(1, min(127, int(v)))
    except AttributeError:
        pass
    return 64


def _expand_score(score: stream.Score) -> stream.Score:
    """Return a copy of the score with all repeat barlines and volta brackets expanded.

    Falls back to the original score if expansion fails (e.g. no repeats, or
    music21 cannot resolve the navigation symbols — D.C./D.S. may not expand).
    """
    try:
        expanded = score.expandRepeats()
        if isinstance(expanded, stream.Score) and expanded.parts:
            return expanded
    except Exception:
        pass
    return score


def _build_canonical_bar_map(score: stream.Score) -> list[tuple[float, float]]:
    """Return [(canonical_start_ql, canonical_duration_ql), ...] in measure order.

    Returns a list (not a dict keyed by measure number) because after
    expandRepeats() the same measure number can appear multiple times.

    Canonical durations come from the time signature — the ground truth —
    not from the actual note content, which may have OMR errors.
    """
    ref_part = score.parts[0]

    ts_changes: list[tuple[float, float]] = []
    for ts in ref_part.flatten().getElementsByClass("TimeSignature"):
        ts_changes.append((float(ts.offset), ts.barDuration.quarterLength))
    if not ts_changes:
        ts_changes = [(0.0, 4.0)]
    ts_changes.sort()

    def ts_ql_at(offset: float) -> float:
        ql = ts_changes[0][1]
        for ts_off, ts_dur in ts_changes:
            if ts_off <= offset + 1e-9:
                ql = ts_dur
        return ql

    result: list[tuple[float, float]] = []
    canonical_pos = 0.0
    for measure in ref_part.getElementsByClass(stream.Measure):
        ts_ql = ts_ql_at(float(measure.offset))
        result.append((canonical_pos, ts_ql))
        canonical_pos += ts_ql
    return result


def _part_to_midi_track_bar_aligned(
    part: stream.Part,
    canonical_bars: list[tuple[float, float]],
    ticks_per_beat: int,
    channel: int,
) -> mido.MidiTrack:
    """Build a MIDI track with per-bar OMR correction.

    For each bar:
      scale = canonical_duration / actual_duration
    Every note's position and duration within the bar are multiplied by
    `scale`, so the bar always occupies exactly canonical_duration ticks
    regardless of how many beats the OMR crammed into it.  This means
    all parts hit every bar line at the same tick even when different
    parts have different OMR errors in the same bar.

    Ties across bar lines are handled correctly: a tie-continuation note
    (tie.type == 'stop' or 'continue') suppresses the new note_on and
    extends the pending note_off for that pitch to the end of the
    continuation's duration (with the current bar's scale applied).
    """
    events: list[tuple[int, int, mido.Message]] = []
    events.append((0, 0, mido.Message("program_change", channel=channel, program=0, time=0)))

    # pitch → scheduled note_off tick for notes whose tie chain is still open.
    pending_tie_off: dict[int, int] = {}

    for i, measure in enumerate(part.getElementsByClass(stream.Measure)):
        if i >= len(canonical_bars):
            continue

        canonical_start, canonical_dur = canonical_bars[i]
        actual_dur = float(measure.quarterLength)
        if actual_dur <= 0 or canonical_dur <= 0:
            continue

        # How much to stretch or compress notes within this bar.
        scale = canonical_dur / actual_dur

        for el in measure.flatten().notesAndRests:
            if el.isRest:
                continue

            # el.offset is relative to the measure start (0 = bar line).
            pos_in_bar = float(el.offset)
            note_ql = float(el.duration.quarterLength)

            note_start_ql = canonical_start + pos_in_bar * scale
            note_end_ql = note_start_ql + note_ql * scale

            start_tick = int(round(note_start_ql * ticks_per_beat))
            end_tick = int(round(note_end_ql * ticks_per_beat))

            if isinstance(el, m21chord.Chord):
                note_list = list(el.notes)
            elif isinstance(el, m21note.Note):
                note_list = [el]
            else:
                continue

            for note in note_list:
                pitch = note.pitch.midi
                vel = _vel(note)
                tie_type = note.tie.type if note.tie is not None else None

                # A tie-stop or tie-continue means this note is a continuation
                # of a preceding tied note — don't start a new note_on.
                is_continuation = tie_type in ('stop', 'continue')
                # A tie-start or tie-continue means the note extends into the
                # next bar — don't close the note_off yet.
                is_open = tie_type in ('start', 'continue')

                if not is_continuation:
                    if end_tick <= start_tick:
                        continue
                    events.append((start_tick, 0,
                                   mido.Message("note_on",  channel=channel,
                                                note=pitch, velocity=vel, time=0)))
                    pending_tie_off[pitch] = end_tick
                else:
                    # Extend the pending note_off to this bar's scaled end.
                    pending_tie_off[pitch] = end_tick

                if not is_open:
                    off_tick = pending_tie_off.pop(pitch, end_tick)
                    events.append((off_tick, 1,
                                   mido.Message("note_off", channel=channel,
                                                note=pitch, velocity=0, time=0)))

    # Emit any note_offs still pending (malformed tie chains — shouldn't happen).
    for pitch, off_tick in pending_tie_off.items():
        events.append((off_tick, 1,
                       mido.Message("note_off", channel=channel,
                                    note=pitch, velocity=0, time=0)))

    # Sort by tick; note_off (priority 1) before note_on (0) at same tick
    # so that a note ending on the same tick another starts doesn't stick.
    events.sort(key=lambda e: (e[0], e[1]))

    track = mido.MidiTrack()
    prev = 0
    for abs_tick, _, msg in events:
        track.append(msg.copy(time=abs_tick - prev))
        prev = abs_tick
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def extract_parts_midi(
    musicxml_path: Path,
    part_indices: list[int],
    out_path: Path,
) -> Path:
    """Write selected parts to a synchronised Type-1 MIDI.

    Uses per-bar OMR correction: each bar's notes are scaled to the
    canonical duration from the time signature, guaranteeing that bar N
    starts at the same tick in every part regardless of OMR errors.
    """
    score = _score(Path(musicxml_path))
    score = _expand_score(score)
    n = len(score.parts)
    keep = dict.fromkeys(part_indices)
    for idx in keep:
        if idx < 0 or idx >= n:
            raise IndexError(f"part_index {idx} out of range (0..{n - 1})")

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    canonical_bars = _build_canonical_bar_map(score)

    TICKS_PER_BEAT = 480
    bpm = _get_score_bpm(score)
    us_per_beat = int(60_000_000 / bpm)

    merged = mido.MidiFile(type=1, ticks_per_beat=TICKS_PER_BEAT)

    tempo_track = mido.MidiTrack()
    tempo_track.append(mido.MetaMessage("set_tempo", tempo=us_per_beat, time=0))
    tempo_track.append(mido.MetaMessage("end_of_track", time=0))
    merged.tracks.append(tempo_track)

    for ch, idx in enumerate(keep):
        part = copy.deepcopy(score.parts[idx])
        _force_piano(part)
        merged.tracks.append(
            _part_to_midi_track_bar_aligned(part, canonical_bars, TICKS_PER_BEAT, ch % 16)
        )

    merged.save(str(out_path))
    return out_path


def compute_bar_timings(musicxml_path: Path) -> list[dict]:
    """Return [{idx, orig_bar_num, orig_written_pos, start_sec, dur_sec}, ...] in playback order.

    Repeats are expanded so the list matches what the MIDI actually plays.
    `orig_written_pos` is the 0-based position in the WRITTEN score — use it to
    index into bar_coords to find which measure to highlight on the PDF page.
    `start_sec` is at the score's own BPM (tempo=100%).
    """
    score = _score(Path(musicxml_path))

    # Record written order before expansion so we can map back after.
    written_measures = list(score.parts[0].getElementsByClass(stream.Measure))
    written_pos_by_num: dict[int, int] = {m.number: i for i, m in enumerate(written_measures)}

    score = _expand_score(score)
    canonical_bars = _build_canonical_bar_map(score)
    bpm = _get_score_bpm(score)

    result = []
    for i, measure in enumerate(score.parts[0].getElementsByClass(stream.Measure)):
        if i >= len(canonical_bars):
            break
        canonical_start, canonical_dur = canonical_bars[i]
        orig_pos = written_pos_by_num.get(measure.number, i % max(len(written_measures), 1))
        result.append({
            "idx": i,
            "orig_bar_num": measure.number,
            "orig_written_pos": orig_pos,
            "start_sec": round(canonical_start * 60.0 / bpm, 4),
            "dur_sec": round(canonical_dur * 60.0 / bpm, 4),
        })
    return result


def render_parts_to_svgs(
    musicxml_path: Path,
    part_indices: list[int],
    transpose_semitones: int = 0,
) -> list[str]:
    """Render selected parts to a list of SVG strings (one per page).

    Uses verovio to typeset the filtered MusicXML. Each element of the returned
    list is a complete SVG document string for one page of the score.
    If transpose_semitones is non-zero the score is transposed before rendering
    so the notation matches the synthesised audio.

    Raises ImportError if verovio is not installed.
    Raises IndexError if any part_index is out of range.
    """
    try:
        import verovio
    except ImportError:
        raise ImportError("verovio is required for score rendering; pip install verovio")

    with tempfile.TemporaryDirectory() as tmp:
        filtered_xml = extract_parts_musicxml(musicxml_path, part_indices, Path(tmp) / "filtered.musicxml")
        if transpose_semitones != 0:
            from music21 import interval as m21interval
            transposed = converter.parse(str(filtered_xml))
            transposed = transposed.transpose(m21interval.ChromaticInterval(transpose_semitones))
            transposed.write("musicxml", fp=str(filtered_xml))
        tk = verovio.toolkit()
        tk.setOptions({
            "pageWidth": 2100,
            "pageHeight": 2970,
            "scale": 40,
            "adjustPageHeight": True,
            "breaks": "auto",
        })
        with open(filtered_xml) as f:
            xml_str = f.read()
        tk.loadData(xml_str)
        pages = []
        for i in range(1, tk.getPageCount() + 1):
            pages.append(tk.renderToSVG(i))
        return pages


def extract_bar_coords_from_svgs(svg_strings: list[str]) -> list[dict]:
    """Extract measure bounding boxes from a list of verovio-rendered SVG strings.

    Parses each page's SVG, walks the page-margin → system → measure hierarchy,
    applies accumulated translate() transforms, and collects bounding boxes from
    path elements (Verovio 6.x uses paths, not rects, for staff lines and barlines).

    The page-margin element lives inside a nested <svg class="definition-scale">,
    not as a direct child of the root SVG — so we search the full tree.

    Returns [{bar, page, x_frac, y_frac, w_frac, h_frac}, ...] where bar is a
    1-based sequential index across all pages (matching bar_timings and PDF
    bar_coords) and fractions are relative to the SVG viewBox dimensions.
    """
    import re
    import xml.etree.ElementTree as ET

    def parse_translate(t: str) -> tuple[float, float]:
        m = re.search(r'translate\(\s*([-\d.]+)(?:[,\s]\s*([-\d.]+))?\s*\)', t or '')
        if not m:
            return 0.0, 0.0
        return float(m.group(1)), float(m.group(2) or '0')

    def elem_classes(elem) -> list[str]:
        return (elem.get('class') or '').split()

    def parse_path_points(d: str) -> list[tuple[float, float]]:
        """Extract (x, y) pairs from M and L path commands."""
        points = []
        for m in re.finditer(r'[ML]\s*([-\d.]+)\s+([-\d.]+)', d):
            try:
                points.append((float(m.group(1)), float(m.group(2))))
            except ValueError:
                pass
        return points

    def collect_positions(elem, tx: float, ty: float) -> tuple[list[float], list[float]]:
        etx, ety = parse_translate(elem.get('transform', ''))
        tx, ty = tx + etx, ty + ety

        xs: list[float] = []
        ys: list[float] = []
        tag = elem.tag.split('}')[1] if '}' in elem.tag else elem.tag

        if tag == 'path':
            for x, y in parse_path_points(elem.get('d', '')):
                xs.append(tx + x)
                ys.append(ty + y)
        elif tag == 'rect':
            try:
                x = tx + float(elem.get('x', 0))
                y = ty + float(elem.get('y', 0))
                w = float(elem.get('width', 0))
                h = float(elem.get('height', 0))
                if w > 0 and h > 0:
                    xs += [x, x + w]
                    ys += [y, y + h]
            except (ValueError, TypeError):
                pass

        for child in elem:
            cxs, cys = collect_positions(child, tx, ty)
            xs += cxs
            ys += cys

        return xs, ys

    def find_all_with_class(elem, cls: str) -> list:
        """Recursively find all elements whose class list contains cls."""
        result = []
        if cls in elem_classes(elem):
            result.append(elem)
        for child in elem:
            result.extend(find_all_with_class(child, cls))
        return result

    coords: list[dict] = []
    bar_idx = 1  # 1-based to match bar_timings and PDF bar_coords from extract_measure_coords

    for page_idx, svg_str in enumerate(svg_strings):
        try:
            root = ET.fromstring(svg_str)
        except ET.ParseError:
            continue

        # Verovio 6.x wraps content in <svg class="definition-scale"> whose viewBox
        # is 10× the page dimensions (e.g. 21000×29700 for a 2100×2970 page).
        # Coordinates in path elements use that inner SVG's coordinate space.
        # Find the definition-scale SVG and use its viewBox; fall back to outer SVG.
        def find_coord_svg(elem):
            """Return the SVG element that contains page-margin (definition-scale)."""
            tag = elem.tag.split('}')[1] if '}' in elem.tag else elem.tag
            if tag == 'svg' and 'definition-scale' in elem_classes(elem):
                return elem
            for child in elem:
                result = find_coord_svg(child)
                if result is not None:
                    return result
            return None

        coord_svg = find_coord_svg(root) or root
        vb = (coord_svg.get('viewBox') or root.get('viewBox') or '0 0 21000 29700').split()
        try:
            vb_w, vb_h = float(vb[2]), float(vb[3])
        except (IndexError, ValueError):
            vb_w, vb_h = 21000.0, 29700.0

        # Search the full tree for page-margin elements (inside definition-scale).
        for page_margin in find_all_with_class(root, 'page-margin'):
            pm_tx, pm_ty = parse_translate(page_margin.get('transform', ''))

            for system in page_margin:
                if 'system' not in elem_classes(system):
                    continue
                sys_tx, sys_ty = parse_translate(system.get('transform', ''))

                for measure in system:
                    if 'measure' not in elem_classes(measure):
                        continue

                    xs, ys = collect_positions(measure, pm_tx + sys_tx, pm_ty + sys_ty)

                    if xs and ys:
                        min_x, max_x = min(xs), max(xs)
                        min_y, max_y = min(ys), max(ys)
                        if max_x > min_x and max_y > min_y:
                            coords.append({
                                'bar': bar_idx,
                                'page': page_idx,
                                'x_frac': round(max(0.0, min_x / vb_w), 6),
                                'y_frac': round(max(0.0, min_y / vb_h), 6),
                                'w_frac': round((max_x - min_x) / vb_w, 6),
                                'h_frac': round((max_y - min_y) / vb_h, 6),
                            })

                    bar_idx += 1

    return coords


def extract_parts_musicxml(
    musicxml_path: Path,
    part_indices: list[int],
    out_path: Path,
) -> Path:
    # Build a fresh Score by appending deepcopied parts individually.
    # Avoids the voice-ID inconsistencies that arise when removing parts
    # from a full deepcopy (music21's makeTies crashes on missing voice IDs).
    score = _score(Path(musicxml_path))
    n = len(score.parts)
    keep = dict.fromkeys(part_indices)
    for idx in keep:
        if idx < 0 or idx >= n:
            raise IndexError(f"part_index {idx} out of range (0..{n - 1})")

    fresh = stream.Score()
    for idx in keep:
        part = copy.deepcopy(score.parts[idx])
        for instr in list(part.recurse().getElementsByClass(instrument.Instrument)):
            instr.activeSite.remove(instr)
        part.insert(0, instrument.Piano())
        # Explicitly mark accidentals before export so bar-line resets are
        # correct even when the makeNotation=False fallback path is taken.
        try:
            part.makeAccidentals(inPlace=True, cautionaryNotImmediateRepeat=False)
        except Exception:
            pass
        fresh.append(part)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fresh.write("musicxml", fp=str(out_path))
    except Exception:
        # music21's makeTies crashes on inconsistent voice IDs (common in
        # Audiveris output). Skip notation post-processing as a fallback.
        fresh.write("musicxml", fp=str(out_path), makeNotation=False)
    return out_path
