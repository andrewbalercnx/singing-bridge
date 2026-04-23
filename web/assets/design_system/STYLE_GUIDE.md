# Singing Bridge — Style Guide

> Canonical design system. Read this before adding any new page or component.
> Last updated: Sprint 15 (April 2026).

## The product in a sentence

Singing Bridge is an online, low-tech singing lesson platform. It should feel **warm, editorial, and musical** — closer to a well-made piano studio than a Zoom call. Avoid generic SaaS chrome.

## Design principles

1. **Paper + ink over black + white.** Surfaces are warm cream (`--sb-paper`) and deep ink (`--sb-ink`), never pure `#FFF` or `#000`.
2. **One serif moment per screen.** Fraunces is precious — use it for headings, italic ledes, and the elapsed-time in-session. Everything else is Poppins.
3. **Accents whisper.** Rose, amber, moss and clay are the only colours beyond ink/paper. Never stack more than two on one screen. Reserve rose for the "live voice" — the breathing ring, the speaking indicator, the audio-clipping pip. It should feel like the presence of sound.
4. **Dotted baselines, not hard rules.** Horizontal separators are the dotted-radial-gradient `.sb-dotted` pattern, echoing stave markings. Hard rules are a last resort for dense tables.
5. **Silence around controls.** Every button has generous breathing room. Cramped toolbars read as a loud DAW; we want a practice room.

## Tokens — where to find what

All tokens live in [`theme.css`](./theme.css) as CSS custom properties under `:root`. **Never hard-code a colour, font, radius, or shadow in a component file.** If a token is missing, add it to `theme.css` first.

- Colour palette, semantic aliases: `§2. Tokens`
- Type scale: `§2. Tokens — Type`
- Spacing (8px base): `§2. Tokens — Spacing`
- Dark scope (session UI): `.sb-theme-dark` — apply to any ancestor to flip ink/paper

## Components — when to use which

### Buttons (`.sb-btn`)
- **Primary** (default) — the one action per screen the user is there to take. Ink background.
- **`.sb-btn--ghost`** — secondary actions, "Cancel", "Back".
- **`.sb-btn--quiet`** — tertiary, inline, "Edit profile" in a list row.
- **`.sb-btn--accent`** — warm rose. Only for entering/continuing a LIVE session. Never for "Save" or "Continue" in forms.
- **`.sb-btn--danger`** — "End lesson", "Delete recording". Clay, not a saturated red.
- Size variants: `.sb-btn--sm`, `.sb-btn--lg`. Default size is the target.

### Cards
- `.sb-card` — standard raised surface on paper-page.
- `.sb-card--paper` — warm cream card for auth and focused flows (login, signup, pre-lesson lobby). Has more padding and softer shadow.
- `.sb-card--quiet` — sunken, for metadata groupings inside other cards.

### Forms
- Always pair `.sb-label` + `.sb-input` wrapped in `.sb-field`. Labels are small-caps, spaced — they should feel like stave dynamics markings.
- Use `.sb-help` for guidance below a field. Errors go in `.sb-help` with an extra class TBD; for now use `aria-invalid="true"` on the input.

### Chips
- `.sb-chip` — neutral metadata.
- `.sb-chip--success` — "Headphones on", "Payment received".
- `.sb-chip--warning` — "Poor network", "Mic muted".
- `.sb-chip--danger` — "Feedback detected", "Connection lost".
- `.sb-chip--live` — rose. Only while something is actively transmitting sound.

### Notices (`.sb-notice`)
- Full-width contextual message. Use when the page can't proceed until the user reads it (e.g. "Both parties must confirm headphones before starting").
- Avoid chaining notices. If you have three to show, something is wrong with the flow.

### Dropzone (`.sb-dropzone`)
- File-upload target (sheet music, recordings). Always offer a click-to-browse fallback.

### Session components (`.sb-session`, `.sb-breathring`, `.sb-nameplate`, `.sb-selfcard`, `.sb-meter`)
- Locked to the in-lesson UI. Don't repurpose elsewhere. The breath ring is especially distinctive — using it outside a session dilutes the meaning.

## Layouts

- **Auth pages** — `.sb-page` body, centred `.sb-container--narrow`, `.sb-card--paper`. No top bar.
- **App pages** (library, lesson lobby, profile) — `.sb-topbar` + `.sb-container` (wide for dashboards, default for single-column flows).
- **Session page** — no shell, no container; `.sb-session` fills the viewport. Add `.sb-theme-dark` to the root.
- **Marketing / waitlist** — not covered yet; follow auth patterns when needed.

## Motion

- All transitions are `var(--sb-dur-fast)` (120ms) for state changes, `var(--sb-dur-med)` (220ms) for panels sliding in, `var(--sb-dur-slow)` (420ms) for page transitions. Default easing `var(--sb-ease)`.
- Breath ring on the session stage transitions at 80ms — faster than `--sb-dur-fast` because it needs to track voice.
- No bounce or overshoot. This is a singing lesson, not a game.

## Copy tone

- Warm, human, confident. Addressed to the individual student or teacher, not to "users".
- Instruction-style, second-person. "Bring your headphones" not "Headphones are required".
- Use full sentences in helper text. Labels are fragments, in small caps.
- Never "users", rarely "please". Say "Your lesson begins in 2 minutes" not "Please wait for the lesson to begin".

## Accessibility

- Minimum body text 15px. Input fields 16px on mobile to avoid zoom.
- Focus visible: 3px outline, warm ink at 25% opacity. Don't remove outlines on interactive elements.
- Colour contrast: ink-on-paper is 14.5:1. Moss/amber/clay on paper/white all verified at AA for meta text. Never use rose for body text.
- The breath ring is a redundant cue — always pair with the audio meter and name-plate indicators. Hearing-impaired teachers and students must still understand who is speaking.
- All icon-only buttons carry `aria-label`. Meter pips carry `role="meter"` with `aria-valuenow`.

## Adding new components

1. Sketch it in a one-off mock first. Agree on behaviour and visual language with design.
2. Find an existing component or token that can be reused. Prefer a variant of an existing class (`.sb-btn--something`) over a whole new class.
3. Add it to `theme.css` under the appropriate `§`. Include a comment block saying what it's for and where it's used.
4. Update this guide with the "When to use which" entry.
5. Add a screenshot to `design_system/mocks/` so future agents have a visual reference.

## Don't

- Don't invent a new colour. Every accent you're tempted to add — teal, violet, bright-green — undermines the warm/editorial feel.
- Don't reach for material-design patterns (elevated FABs, snackbars, bottom navs). Singing Bridge is web, focused, desktop-first.
- Don't use emoji as icons. Use SVGs, optionally hand-drawn for session surfaces.
- Don't stack > 2 accents per screen.
- Don't hard-code pixel paddings. Use `var(--sb-space-n)`.
- Don't use pure black or pure white anywhere except inside the `.sb-session__stage` video surface.
