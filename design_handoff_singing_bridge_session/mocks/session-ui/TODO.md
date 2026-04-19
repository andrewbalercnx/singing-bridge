# Session UI — TODO

## Direction
**Variation A — The Duet** is the chosen direction.

Two portraits (teacher + student) as the emotional centre; paired waveforms between
them carry the live musical signal. Editorial, classical tone. Both panes live.

Variations B and C are shelved but their ideas feed the roadmap below.

---

## Carry forward from B — The Score

Variation B treated the **sheet music** as the hero: teacher sees an annotated score,
student sees a clean version, annotations cross over in real time.

Pull into A:

- **Imported sheet music**
  - PDF / MusicXML / image upload per lesson
  - Auto-layout, page turns synced between teacher and student
  - OMR (optical music recognition) to get machine-readable bars — needed for
    everything below
- **Shared annotation layer**
  - Teacher can ink, circle, highlight, tap a bar to flag it
  - Annotations appear on student's score instantly
  - Persist per-lesson so student can revisit
- **Bar-level navigation**
  - "Go to bar 17" jumps both panes
  - Click a bar to loop it (A/B repeat for drilling)
- **Auto-scroll / follow the bouncing ball**
  - Playhead advances through the score at tempo
  - Student's current bar highlighted subtly; teacher's gaze bar stands out

## Carry forward from C — The Stave

Variation C turned the session INTO a live stave with real-time pitch tracking.

Pull into A:

- **Live pitch detection**
  - Mic → pitch (autocorrelation / YIN in a Web Audio worklet)
  - Cents deviation from target note, smoothed
- **Target-note awareness**
  - When student is on a given bar/beat, we know what note they SHOULD be
    singing — compare pitch to target, colour the waveform (green in tune,
    warm when flat/sharp)
- **Pitch ribbon in the duet layout**
  - Thin horizontal ribbon between the two waveforms showing pitch-vs-target
    over the last N seconds
  - Doesn't dominate — A is about the human connection, pitch is the
    supporting evidence
- **Post-lesson review**
  - Pitch trace + audio playback scrubbable against the score
  - "Here's where you went flat" moments flagged automatically

---

## Open questions

- How do we want chat / text to feel? Variation A didn't expose it. Options:
  drawer, margin column, or ephemeral bubble near the portrait.
- Do we need a separate "warmup" mode (scales, vowel exercises) distinct from
  "repertoire" mode (working on a piece)? They probably want different UIs.
- Recording consent — both parties need to opt in before pitch trace / audio
  are saved.
- Network quality indicator — latency matters for singing; where does it live
  without becoming noise?

## Nice to have (later)

- Metronome pulse shared between both panes (visual + optional audible click)
- Tempo + key controls teacher-side
- Lyrics pane for pieces with text (Caro mio ben, Schubert lieder, etc.)
- Multi-student mode (choir / group lesson) — probably a different product
