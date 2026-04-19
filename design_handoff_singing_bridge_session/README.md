# Handoff: Singing Bridge — Live Session UI (Variation A "The Warm Room")

## Overview

Singing Bridge is an online singing-lesson product from Rich Consultancy. This handoff covers the **live 1-on-1 session UI** — the screen both teacher and student see while a lesson is in progress.

The chosen direction is **Variation A — "The Warm Room"**: a conventional two-tile video call reimagined as a warm, editorial, paper-and-piano space. Ambient "breath ring" around the remote speaker pulses with their voice, self-preview as a small inset, discreet audio meter on a dotted baseline, and a compact control cluster at the foot.

Variations B (audio-first waveform) and C (live musical stave with pitch tracking) were explored and shelved, but specific ideas from them are planned for later sprints — see **Sprint 1 / Sprint 2 / Backlog** below.

## About the Design Files

The `mocks/` folder contains an HTML+React(Babel) prototype. It is a **design reference** — a visual and interaction spec, not production code to lift wholesale. Your job is to recreate these mocks inside Singing Bridge's actual codebase (or, if no codebase exists yet, pick the most appropriate framework: React + TypeScript + CSS Modules / Tailwind is a safe default for a web product, or React Native if mobile is in scope) and wire them to real audio/video transport.

The prototype uses **fake** audio levels (a sine-based oscillator in `hooks.jsx`) and **SVG portraits** instead of real video. Those are the first things to replace when you wire up real infrastructure.

## Fidelity

**High-fidelity.** Colours, typography, spacing, border-radii, and motion are intentional and should be reproduced exactly. Names of design tokens and the 8px spacing scale map cleanly to the CSS custom properties in `mocks/session-ui/index.html`.

---

## Sprint 1 — MVP Live Session (Variation A, as designed)

### Goal

A working 1-on-1 live singing lesson in the browser: real video + audio, the Variation-A chrome, working controls.

### Screens / Views

#### 1. Session (Live) — single screen, role-specialised

Both teacher and student see the **same layout**, with role-dependent labels and the "remote" portrait swapping. This is deliberate: it reduces cognitive load because both parties navigate identical chrome.

**Layout (frame = full session viewport; on desktop typically fills most of the window, on mobile fills screen):**

- Container: `position: absolute; inset: 0; display: flex; flex-direction: column; padding: 16px 16px 14px; background: #0F1720; color: #FBF6EF`
- **Remote video area** (`flex: 1 1 auto; border-radius: 20px; overflow: hidden; background: #000; min-height: 0`) — fills all available vertical space
  - Inner: real-time video feed of the OTHER party, full-bleed, `object-fit: cover`
  - Overlay: **breath ring** — `position: absolute; inset: 0; border-radius: 20px; box-shadow: inset 0 0 0 [4 + level*10]px rgba(225,127,139, [0.15 + level*0.35])` where `level` is the remote peer's 0..1 audio RMS. Transition: `box-shadow 0.08s ease-out`. `pointer-events: none; z-index: 2`.
  - Overlay: **name plate** — `position: absolute; left: 16px; top: 16px; z-index: 3; background: rgba(15,23,32,0.55); backdrop-filter: blur(6px); padding: 8px 14px; border-radius: 12px`
    - Line 1 (name): `font-family: Fraunces, serif; font-size: 17px; font-weight: 500; letter-spacing: -0.01em`. e.g. "Alex Price"
    - Line 2 (role/context): `font-size: 11px; opacity: 0.75; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 2px`. e.g. "STUDENT · LESSON 7" or "YOUR TEACHER"
  - Overlay: **headphones-confirmed badge** — `position: absolute; right: 16px; top: 16px; z-index: 3; background: rgba(111,154,122,0.9); color: #fff; padding: 6px 12px; border-radius: 999px; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 6px`
    - 6px white dot + text "Headphones on"
    - Only render when the peer has confirmed headphones (see State below). When not confirmed, replace with a warning chip in `#C8684F` reading "No headphones".

- **Dotted baseline strip** (`padding: 12px 4px 10px`)
  - When audio meter is ON: show a row — `display: flex; align-items: center; justify-content: space-between; gap: 14px` — with
    - Left: `MeterBar` showing YOUR mic level, label "YOU"
    - Centre: elapsed session time in `Fraunces italic 15px`, colour `rgba(251,246,239,0.85)`
    - Right: `MeterBar` showing REMOTE level, label = remote's first name uppercased (e.g. "ALEX")
  - When audio meter is OFF: just a dotted horizontal line with the elapsed time centred
    - Line: `background-image: radial-gradient(circle, rgba(251,246,239,0.35) 1.2px, transparent 1.4px); background-size: 12px 6px; background-repeat: repeat-x`
  - **MeterBar component**: 14 vertical pips, each `width: 3px`, height tapers from `6px` to `~22px` (height = `6 + i * 1.2` px). `gap: 2px`. Pips "on" when `i < round(level * 14)`. Colour: first 60% `#F3ECE0`, next 25% `#E3A950` (amber warning), final 15% `#E17F8B` (rose, clipping). Off colour: `rgba(251,246,239,0.15)`. Right-side meter is `flex-direction: row-reverse`.

- **Bottom row** (`display: flex; justify-content: space-between; align-items: flex-end; gap: 12px`)
  - **Controls cluster** (`display: flex; gap: 8px`): 5 buttons, left-to-right
    1. **Mic** — icon: mic outline (24×24, stroke 1.6). Label "Muted"/"Unmuted". Default state inactive (not muted).
    2. **Video** — icon: camera outline. Label "Video". Default active.
    3. **Note** — icon: two joined quarter-notes. Label "Note". Toggles a notes sidebar (Sprint 2).
    4. **Say/Chat** — icon: speech bubble. Label "Say". Toggles chat drawer (Sprint 2).
    5. **End** — icon: phone-down. Label "End". `background: #C8684F; color: #fff; border-color: #C8684F`.
    - Each button: `width: 56px; height: 56px; border-radius: 16px; flex-direction: column; gap: 4px`. Inactive: `background: rgba(251,246,239,0.06); border: 1px solid rgba(251,246,239,0.12); color: #FBF6EF`. Active: `background: #FBF6EF; color: #0F1720; border-color: #FBF6EF`. Label below icon: `font-size: 11px; font-weight: 500; letter-spacing: 0.04em`.
  - **Self preview card** (`width: 110px; height: 130px; border-radius: 14px; background: #000; position: relative; overflow: hidden; box-shadow: 0 6px 20px rgba(0,0,0,0.4); border: 1px solid rgba(251,246,239,0.12)`)
    - Shows local camera feed, `object-fit: cover`
    - Overlay label bottom-left: `position: absolute; left: 8px; bottom: 8px; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; background: rgba(15,23,32,0.65); padding: 3px 8px; border-radius: 999px`. Text: "You"
    - Optional: mirror horizontally (`transform: scaleX(-1)`) for natural self-view, standard in video call products

### Interactions & Behavior

- **Breath ring**: drive by remote peer's RMS audio level sampled at ~60fps from a Web Audio `AnalyserNode`. Smooth with a 1-pole low-pass (attack ~20ms, release ~200ms) before feeding into the ring thickness/opacity formula, otherwise it looks jittery.
- **MeterBar**: drive from the same RMS level; no smoothing (jitter is useful feedback here).
- **Mic toggle**: when muted, add a mic-slashed icon and a subtle dimming of the self-preview border. Show a full-width banner "You are muted" at the top for ~3s when someone tries to talk into a muted mic.
- **End call**: open a confirmation popover (don't immediately drop the call). Popover: "End this lesson?" + "End" (clay) / "Cancel" (ghost).
- **Note** and **Say**: in Sprint 1, stub these buttons to do nothing but log intent; the full panels ship in Sprint 2.
- **Responsive**: below 600px wide, drop the self-preview to `80×100` and shrink control buttons to `48×48`. The pair-of-panes (teacher/student side-by-side) in the prototype is just for reviewing the design — in production each user only ever sees ONE pane, full-screen.

### State Management

State this screen needs, roughly:

```ts
type SessionState = {
  role: 'teacher' | 'student';
  remote: {
    name: string;           // "Alex Price"
    roleLabel: string;      // "Student · Lesson 7" or "Your teacher"
    headphonesConfirmed: boolean;
    videoStream: MediaStream | null;
    audioLevel: number;     // 0..1, RMS, 60fps
  };
  self: {
    name: string;
    videoStream: MediaStream | null;
    audioLevel: number;
    micEnabled: boolean;
    videoEnabled: boolean;
  };
  session: {
    elapsedSeconds: number;
    showMeter: boolean;     // user preference
    status: 'connecting' | 'live' | 'ended';
  };
};
```

- Transport layer is your call — WebRTC direct (simplest for 1-on-1) or a SFU like LiveKit/Daily/Twilio.
- **Critical audio-engine note**: this is a **singing** lesson, not a speech call. You MUST disable the default voice-optimised processing that WebRTC does by default:
  - `echoCancellation: false`
  - `noiseSuppression: false`
  - `autoGainControl: false`
  - Opus codec configured with `maxaveragebitrate: 510000; stereo=1; useinbandfec=1` and ideally in "music" mode (`application=audio` for recent Opus builds, or set `mediaType` appropriately on your SFU).
  - Encourage (ideally require) headphones — AEC off + no headphones = feedback loop. The "Headphones confirmed" chip should gate "Start lesson" until both parties tick a pre-lesson confirm dialog.

### Assets / Dependencies

- **Fonts**: Fraunces (display, weights 400/500/600) and Poppins (UI, weights 300/400/500/600/700/800). Ship via `next/font` / `@fontsource` / equivalent — do not load from Google Fonts in production.
- **Icons**: the mock uses hand-drawn SVGs for the 5 control icons (mic, video, note, chat, end). These are specific to the brand — do NOT swap for Lucide/Heroicons. Copy the SVG paths from `mocks/session-ui/variation-a.jsx` → `IconGlyph` component.
- **Portraits**: the SVG portraits in `mocks/session-ui/portraits.jsx` are **placeholders only**. Replace entirely with the real `<video>` stream.

---

## Sprint 2 — Essentials Around the Session

Features that were referenced in the design but stubbed in Sprint 1.

1. **Notes panel** (driven by the Note button): slide-over from the right, 360px wide, paper background `#FBF6EF`, lets teacher jot timestamped notes the student sees after the lesson.
2. **Chat drawer** ("Say" button): slim drawer from the bottom, ~140px tall. Italic Fraunces for the header "Say".
3. **Pre-lesson lobby**: camera/mic/headphones check screen. Both parties must confirm headphones-on before the session can begin.
4. **Recording consent + capture**: opt-in from BOTH parties. Store audio + video to cloud, surface in post-lesson review.
5. **Post-lesson summary**: a recap screen with session length, the teacher's notes, and a link to the recording.
6. **Network quality indicator**: a small chip that lives next to the headphones chip when latency > 150ms or packet loss > 2%. Uses the amber/clay accents — never the rose.

---

## Sprint 3+ / Backlog — Score & Pitch (from Variations B and C)

These are deferred but important. They make Singing Bridge more than a re-skinned Zoom.

### From Variation B — "The Score"

Variation B treated **sheet music** as the centrepiece. Fold into A as a toggleable mode.

- **Import sheet music** per lesson (PDF, MusicXML, or image upload).
- **OMR** (Optical Music Recognition) to get machine-readable bars. Recommended library: [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) renders MusicXML; use a service like Audiveris or a hosted OMR API to convert PDFs/images to MusicXML.
- **Shared annotation layer**: teacher can ink, circle, highlight, or tap a bar to flag it; annotations appear on the student's score instantly. Persist per-lesson so the student can revisit after the lesson.
- **Bar-level navigation**: "Go to bar 17" jumps both panes. Click a bar to loop it (A/B repeat for drilling a phrase).
- **Auto-scroll playhead**: advances through the score at tempo. Student's current bar highlighted subtly; teacher's gaze-bar stands out brighter.

When score mode is on, the Variation-A remote video shrinks to a "passport frame" in the top-right of the score surface; the breath ring still renders around it.

### From Variation C — "The Stave"

Variation C turned the session into a live stave with real-time pitch tracking. Fold the **tracking** into A as an optional overlay; skip the stave-as-whole-UI idea.

- **Live pitch detection**: mic → pitch via an AudioWorklet running YIN or CREPE-Tiny (WASM). Smooth with a median filter over a 50ms window.
- **Target-note awareness**: once score import is live, we know what note the student SHOULD be singing at any given beat. Compare detected pitch to target, express as cents deviation.
- **Pitch ribbon**: a thin horizontal ribbon that appears **between** the video and the dotted-baseline strip in the Variation-A layout. Shows pitch-vs-target over the last ~6 seconds. Green when in tune (±10¢), warm rose when flat/sharp (>10¢). 40px tall, never dominates.
- **Post-lesson review**: pitch trace + audio playback scrubbable against the score. "Here's where you went flat" moments flagged automatically (sustained deviations > 30¢ for > 500ms).

---

## Design Tokens

Copy these into your app's token file. Naming matches `mocks/session-ui/index.html`.

### Colors

```css
--sb-ink:        #0F1720;   /* default text, dark surfaces */
--sb-ink-2:      #3F4651;
--sb-ink-3:      #6E7684;
--sb-paper:      #FBF6EF;   /* warm cream — light surface */
--sb-paper-2:    #F3ECE0;
--sb-paper-3:    #E9DFD0;
--sb-line:       rgba(15,23,32,0.10);
--sb-line-soft:  rgba(15,23,32,0.06);

--sb-navy:       #1A60AE;   /* inherited Rich Consultancy navy */
--sb-navy-deep:  #0D3563;
--sb-cyan:       #00AEEF;   /* inherited RC cyan — use SPARINGLY, only for live-audio signalling */
--sb-rose:       #E17F8B;   /* warm accent — breath / inhale */
--sb-amber:      #E3A950;   /* warm accent — sustain / warning */
--sb-moss:       #6F9A7A;   /* calm confirm — "headphones on", "in tune" */
--sb-clay:       #C8684F;   /* alert / destructive (warmer than red) */
```

### Typography

```css
--sb-font-display: 'Fraunces', 'Poppins', serif;  /* display + italic callouts */
--sb-font-ui:      'Poppins', system-ui, sans-serif;  /* UI, buttons, meters */
```

Type scale used in this screen:

| Role                      | Family   | Size | Weight | Tracking   | Notes              |
|---------------------------|----------|-----:|-------:|------------|--------------------|
| Remote name plate         | Fraunces | 17px |    500 | -0.01em    |                    |
| Remote role/context       | Poppins  | 11px |    400 |  0.08em    | uppercase          |
| Headphones chip           | Poppins  | 11px |    500 |  normal    |                    |
| Elapsed time (centre)     | Fraunces | 15px |    400 |  normal    | italic             |
| MeterBar label            | Poppins  | 10px |    600 |  0.14em    | uppercase          |
| Control button label      | Poppins  | 11px |    500 |  0.04em    |                    |
| Self preview "You" pill   | Poppins  | 10px |    600 |  0.1em     |                    |

### Radii

```css
--sb-r-sm: 10px;
--sb-r-md: 16px;
--sb-r-lg: 24px;
--sb-r-xl: 32px;
```

### Shadows

```css
--sb-shadow-card: 0 1px 2px rgba(15,23,32,0.04), 0 12px 30px rgba(15,23,32,0.06);
--sb-shadow-deep: 0 2px 6px rgba(15,23,32,0.08), 0 30px 60px rgba(15,23,32,0.14);
```

### Spacing

8px base. Screen uses 16px (container padding), 12px (baseline strip vertical), 8px (control gap), 20px (section gap).

---

## Files

In this bundle:

- `README.md` — this document
- `mocks/session-ui/index.html` — entry HTML with all CSS variables + inlined JSX
- `mocks/session-ui/app.jsx` — chrome, variation tabs, side-by-side review frame, tweaks panel (review-only)
- `mocks/session-ui/variation-a.jsx` — **the direction you're implementing**
- `mocks/session-ui/variation-b.jsx` — **reference only** for Sprint 3 (score)
- `mocks/session-ui/variation-c.jsx` — **reference only** for Sprint 3 (pitch)
- `mocks/session-ui/hooks.jsx` — fake audio oscillator + elapsed-time hook (do NOT port — replace with real Web Audio integration)
- `mocks/session-ui/portraits.jsx` — SVG placeholder portraits (do NOT port — replace with real `<video>` elements)
- `mocks/session-ui/TODO.md` — the original direction doc feeding Sprints 2 and 3

---

## Open Questions to Resolve Before Starting

1. **Transport**: WebRTC peer-to-peer (cheap, no infra) vs SFU (Daily / LiveKit / Twilio — better for recording, network quality, future group lessons). Recommendation: LiveKit self-hosted or Daily.
2. **Recording**: cloud (server-side via SFU egress) or local (MediaRecorder into Blob, upload at end)? Server-side is more reliable.
3. **Scheduling / payments**: out of scope for this handoff. Assume the session URL already resolves to a known lesson and both parties are authenticated.
4. **Mobile**: is day-1 mobile web a requirement, or is desktop web enough? If mobile, the self-preview card needs to shrink and the control cluster may need to wrap.
5. **Warmup vs repertoire modes**: TODO.md flags these as potentially different UIs. Do not design for this in Sprint 1 — treat every session as a single repertoire mode.
