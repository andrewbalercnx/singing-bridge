# Singing Bridge — Design System Handoff

This folder is a drop-in design system for the `singing-bridge` web app. It unifies every page — auth, library, teacher landing, student join, in-session — behind one set of tokens and components.

## Contents

- **`theme.css`** — canonical design system. All tokens + every shared component. Load on every page alongside the existing `styles.css`.
- **`STYLE_GUIDE.md`** — how and when to use each component, principles to follow, what NOT to do. Read before adding any new page.
- **`gallery.html`** — visual reference showing every page in the system side-by-side. Open in a browser; this is the pixel spec for devs.

## What to do in the repo

### 1. Copy `theme.css` into the repo

Drop `theme.css` at `web/assets/theme.css` (replacing the existing one). The file is a **strict superset** of the tokens currently referenced in `web/assets/styles.css`, and preserves every legacy class (`.quality-badge`, `.reconnect-banner`, `.floor-violation`, `.tier-badge`, `.setup-note`) so nothing breaks.

### 2. Load it on every HTML page

Each of `login.html`, `signup.html`, `teacher.html`, `student.html`, `library.html`, `recordings.html`, `loopback.html`, `recording.html` should include — in this order, after the page’s meta tags:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/styles.css">
<link rel="stylesheet" href="/assets/theme.css">
```

Later: ship the Fraunces + Poppins WOFF2 files locally at `/assets/fonts/` and remove the Google Fonts dependency. The `@font-face` rules at the top of `theme.css` are already wired to the local paths.

### 3. Add `class="sb-page"` to `<body>`

This is the opt-in to the design system’s typography and background. Without it, pages render in browser defaults.

### 4. Migrate markup page by page

Replace existing ad-hoc class names with `.sb-*` equivalents per the gallery. Keys mappings:

| Old / ad-hoc                        | New                                |
|-------------------------------------|-------------------------------------|
| `<button>` unstyled                 | `.sb-btn` + variant                 |
| `.primary-btn`, `.cta`              | `.sb-btn` (default is primary)      |
| `.secondary-btn`                    | `.sb-btn .sb-btn--ghost`            |
| `<input>` unstyled                  | `.sb-input` inside `.sb-field`      |
| Card-like `<div>`                   | `.sb-card` / `.sb-card--paper`      |
| Status labels                       | `.sb-chip` + modifier               |
| Info boxes                          | `.sb-notice` + modifier             |
| `.quality-badge`, `.reconnect-banner`, etc. | **Unchanged** — kept as aliases |

The gallery shows exactly where each page lands.

### 5. Session UI uses `.sb-theme-dark`

Wrap the in-lesson layout in an element with `class="sb-theme-dark"`. All tokens flip automatically: ink ↔ paper, borders, accent. No per-page overrides needed.

## Conventions for new pages

1. Open `STYLE_GUIDE.md` first.
2. Start from one of the gallery pages as your template — don’t copy from an existing page that predates this handoff (they’ll be partly migrated for a while).
3. Never hard-code a hex, px padding, font-family, or box-shadow. If the token you need doesn’t exist, ADD IT to `theme.css`, then use it.
4. Keep the accent budget to two per screen. Rose = live voice only.
5. Run the page side-by-side with `gallery.html` before committing.

## File ownership

`theme.css` and `STYLE_GUIDE.md` are canonical. Changes to tokens or components go in these files and nowhere else. Page-level CSS (in `styles.css` or co-located) should contain only layout composition for that specific page — never new design primitives.

## Not in this handoff

- Component library as real framework components (React/Vue). If you migrate off plain HTML, the tokens stay the same but the components get rebuilt once in your chosen framework.
- Icon set beyond the session-controls icons shown in the gallery. Commission when you need a standard icon system.
- Illustration style for empty states, marketing, onboarding. TBD in a later sprint.
