# PDF → Piano Audio (spike)

Prototype for a future sprint on teacher accompaniment. Lets a user
upload a sheet-music PDF and walk through four explicit steps until
they have a piano-voiced audio file they can play in the browser:

1. **Upload** a PDF (or MusicXML, to skip OMR).
2. **Recognise** notation via Audiveris → MusicXML.
3. **Select** which part is the piano accompaniment.
4. **Render** that part as WAV via FluidSynth + a piano SoundFont.

This is intentionally a standalone Flask app under `spike/`. It does
**not** touch the production Rust server or the lobby/WebRTC code. When
this graduates into a sprint, the `pipeline/` package moves intact; the
Flask shell is discarded in favour of an axum route.

## Layout

```
spike/pdf_to_piano_audio/
├── app.py                  # Flask app + step endpoints
├── pipeline/
│   ├── audiveris.py        # PDF  → MusicXML  (Audiveris subprocess)
│   ├── selector.py         # MusicXML → parts list + piano-voiced MIDI  (music21)
│   └── synth.py            # MIDI → WAV  (FluidSynth + .sf2)
├── templates/index.html    # single-page step UI
├── static/app.{js,css}     # client state machine + styling
├── fixtures/two_part.musicxml  # tiny Voice+Piano score for demoing without Audiveris
├── requirements.txt
└── README.md
```

## Install

### Python deps

```
python3 -m pip install -r spike/pdf_to_piano_audio/requirements.txt
```

### External tools

Two system binaries are needed for the **full** pipeline. The spike
degrades gracefully if they're missing — the endpoint returns a 503
with an "install X" message and the UI surfaces it.

| Tool         | Used for                     | Install (Debian/Ubuntu)                          | Install (macOS)          |
|--------------|------------------------------|--------------------------------------------------|--------------------------|
| Audiveris    | PDF → MusicXML OMR           | Download from <https://github.com/Audiveris/audiveris/releases>, unpack, add `bin/` to `PATH` | `brew install --cask audiveris` |
| FluidSynth   | MIDI → WAV synthesis         | `apt install fluidsynth fluid-soundfont-gm`      | `brew install fluid-synth` |

Environment overrides (useful when binaries aren't on `PATH`):

- `AUDIVERIS_CMD=/path/to/audiveris`
- `FLUIDSYNTH_CMD=/path/to/fluidsynth`
- `PIANO_SF2=/path/to/piano.sf2` (default: `/usr/share/sounds/sf2/FluidR3_GM.sf2`)

Recommended piano SoundFonts:
- **FluidR3_GM** — ships with `fluid-soundfont-gm` on Debian/Ubuntu; decent piano at program 0.
- **Salamander Grand Piano V3** — much better piano timbre; download from
  <https://sfzinstruments.github.io/pianos/salamander> (needs conversion to .sf2 or use with sfizz).

## Run

Two ways: native Python (fast iteration, needs system deps on the
host) or Docker (one command, everything self-contained).

### Local Docker (recommended for trialling the flow)

From this directory:

```
docker compose up --build
```

Then open <http://localhost:5173/>. First build is ~5–8 min (downloads
an Ubuntu base, JRE, Audiveris .deb, FluidSynth, SoundFont); rebuilds
are cached.

- Everything needed is in the image; nothing to install on the host.
- Upload a PDF, watch it flow upload → OMR → part select → render.
- Container exposes `:8080` internally, mapped to host `:5173` (change
  in `docker-compose.yml` if you want a different port).
- To swap in a nicer piano SoundFont (e.g. Salamander Grand), uncomment
  the `volumes:` block in `docker-compose.yml` and point `PIANO_SF2` at
  the mounted path.
- `docker compose down` to stop; scratch files are lost with the
  container, which is fine for a trial.

Bumping Audiveris: set `AUDIVERIS_VERSION` as a build arg, e.g.
`docker compose build --build-arg AUDIVERIS_VERSION=5.10.1`.

### Native Python (no Docker)

```
python3 -m spike.pdf_to_piano_audio.app
```

Then open <http://127.0.0.1:5173/>. The **"load two-part fixture"**
button skips the upload + OMR stages and is the easiest way to verify
the app works end-to-end without Audiveris installed on the host.

## Demoable without Audiveris/FluidSynth?

- **Without Audiveris**: yes. Upload `.xml`/`.musicxml`/`.mxl` directly,
  or click "load two-part fixture". OMR stage becomes a no-op.
- **Without FluidSynth**: steps 1–3 still work; you can download the
  MIDI from step 3 and render it in any DAW or MIDI player.

## Endpoints

| Method | Path                                  | Returns                                  |
|--------|---------------------------------------|------------------------------------------|
| GET    | `/`                                   | step-by-step HTML page                   |
| POST   | `/upload`                             | `{session_id, kind}`                     |
| POST   | `/fixture`                            | `{session_id, kind, fixture: true}`      |
| POST   | `/<session_id>/omr`                   | `{parts: [{index, name, instrument, has_notes}]}` |
| POST   | `/<session_id>/select/<part_index>`   | `{midi_url, part_index}`                 |
| POST   | `/<session_id>/render`                | `{audio_url}`                            |
| GET    | `/<session_id>/files/<name>`          | generated MIDI / WAV                     |

## Known limitations

- Piano staves split by music21: the fixture defines one piano part
  with two staves; music21 surfaces them as two parts in the picker
  (the empty-staff one is marked `(empty)` and disabled in the UI).
  Real-world scores from Audiveris don't usually hit this.
- No auth, no cleanup. Scratch dirs in `/tmp/pdf-piano/` grow until
  the process restarts.
- Audiveris is slow (tens of seconds per page) and blocks the request
  thread. Production will want a work queue.
- Tempo/dynamics from the original score are preserved; if the source
  has no tempo mark, MIDI defaults to 120 bpm.
