# Student UI — Functional Requirements & UX Findings

_singing-bridge · 2026-05-07 · Tested against localhost:8080_

---

## Part 1: Functional Requirements

Every action a student can take, and every state they should see.

---

### 1. Home Page (`/`)

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| H1 | Visit `/` | Two-card layout: "I'm a teacher" and "I'm a student" |
| H2 | Student card | Heading, description, room-name input, "Go →" button |
| H3 | Pre-fill room name | Input pre-filled from `localStorage['sb-student-room']` if set |
| H4 | Submit valid room name | Normalised (lowercase, spaces stripped); navigates to `/teach/{slug}` |
| H5 | Submit empty input | Inline validation error shown; no navigation |
| H6 | Submit unknown slug | Server redirects to `/?room-not-found={slug}`; error notice shown on home page |
| H7 | Room-not-found notice | Shows "Room not found" message with escaped room name |
| H8 | Favicon present | `<link rel="icon">` wired; no 404 in browser |

---

### 2. Student Session Page — Join Screen (`/teach/{slug}`)

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| J1 | Page loads (valid slug) | Join form visible; lobby / session sections hidden |
| J2 | "Please wear headphones" notice | Visible with expandable details |
| J3 | Audio device picker | Microphone selector populated (requires getUserMedia permission) |
| J4 | Speaker selector | Shown if `setSinkId` supported (Chromium); hidden on Safari/Firefox |
| J5 | Email input | Present, required, type="email" |
| J6 | "Enter lobby" button | Enabled and visible |
| J7 | Unworkable browser | Red block notice; "Enter lobby" hidden or disabled |
| J8 | Degraded browser | Yellow warning notice; join still possible |
| J9 | iOS AEC note | Blue notice shown on iOS Safari |
| J10 | Self-check overlay | Camera/audio preview visible once media acquired |
| J11 | Headphones confirmation | Button in self-check overlay; clicking upgrades acoustic profile |

---

### 3. Lobby Wait State

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| L1 | After "Enter lobby" click | Join form hides; "Waiting to be admitted…" status shown |
| L2 | Self-check overlay | Remains visible while waiting |
| L3 | Teacher lobby message | Toast notification appears with message text |
| L4 | Rejection (normal) | Overlay / message: rejected by teacher; WS closes |
| L5 | Block | Red "blocked" banner shown; WS closes; join form does not reappear |

---

### 4. Active Session

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| S1 | Admission | Join/lobby sections hide; session section appears |
| S2 | Remote panel | Teacher video visible in large panel |
| S3 | Self-view PiP | Student's own camera shown in small overlay |
| S4 | Microphone toggle | Click mutes/unmutes own audio; aria-label and aria-pressed update |
| S5 | Video toggle | Click enables/disables own camera; aria-label and aria-pressed update |
| S6 | End call button | Confirmation dialog (or direct hang-up); WS closes cleanly |
| S7 | Elapsed timer | Time counter visible and ticking |
| S8 | Audio level meters | Left ("YOU") and right (teacher) meters animate during audio |
| S9 | Quality badge | Connection quality indicator visible (good / fair / poor / bad) |
| S10 | Chat: receive | Teacher messages appear in chat drawer |
| S11 | Chat: send | Student can type and send a message to teacher |
| S12 | Reconnect banner | "Reconnecting…" shown during ICE restart; hides on recovery |
| S13 | Peer disconnected | Session tears down; message shown: "Teacher disconnected." |

---

### 5. Recording Consent

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| R1 | Record request | Consent banner: "Your teacher wants to record this lesson." |
| R2 | Accept button | Sends `record_consent` granted=true; banner hides |
| R3 | Decline button | Sends `record_consent` granted=false; banner hides |
| R4 | Auto-decline countdown | 30 s timer shown; auto-declines on expiry |
| R5 | REC indicator | "REC" badge shown while recording active; hides on stop |

---

### 6. Accompaniment (Read-Only)

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| A1 | Track name | Current track/variant name shown |
| A2 | Play state | Playing / paused state reflected in UI |
| A3 | Position | Slider advances with playback position |
| A4 | No playback controls | Student cannot start, stop, seek, or change track |
| A5 | Speaker muting | If acoustic profile is speakers, audio auto-muted; banner shown |
| A6 | Score display | Rasterised score pages appear when accompaniment active |
| A7 | Bar highlight | Current bar highlighted in real time during playback |

---

### 7. Mobile / Responsive

| ID | Action / State | Expected behaviour |
|----|---------------|--------------------|
| M1 | Viewport 390 × 844 (iPhone 14) | Join form readable; inputs not clipped; button reachable |
| M2 | Room-name input on mobile | Keyboard appears; input is touch-friendly |
| M3 | Session on mobile | Remote panel fills screen; controls reachable at bottom |
| M4 | iOS AEC notice | Shown on mobile Safari UA |
| M5 | Speaker selector on mobile | Hidden on iOS/Firefox (no setSinkId); does not break layout |
| M6 | Device picker on mobile | Mic selector visible; labelled correctly |
| M7 | Chat on mobile | Chat drawer accessible; text input reachable above keyboard |
| M8 | Consent modal on mobile | Fits viewport; buttons reachable |

---

## Part 2: Playwright Test Findings

_Tested 2026-05-07 · localhost:8080 · Laptop (1280 × 720) and Mobile (390 × 844 / iPhone 14)_

---

### Bugs (broken functionality)

#### F1 · No home/back link — student stranded on wrong-room page

**Page:** `/teach/{slug}` join screen  
**Observed:** No link back to the home page (`/`). If a student arrives at the wrong room, they must use the browser back button or manually edit the URL.  
**Impact:** High friction on mobile; students with a fresh browser session have no recovery path.  
**Fix:** Add a "Wrong room? Go back" link to `/` below the lede paragraph.

---

#### F2 · Room slug not shown — student cannot confirm they are in the right room

**Page:** `/teach/{slug}` join screen  
**Observed:** The eyebrow text is the generic "Your lesson room". No room identifier appears anywhere on the page. The page `<title>` is "singing-bridge — join" regardless of slug.  
**Impact:** A student navigating to the wrong link has no visual cue to notice the error.  
**Fix:** Set the eyebrow to the slug (e.g. "andrewbale"), and update `document.title` to `{slug} — singing-bridge`.

---

#### F3 · `#blocked-notice` uses wrong CSS class — inherits connection-drop styling

**Page:** `/teach/{slug}` join screen (blocked state)  
**Observed:** `#blocked-notice` has `class="floor-violation"` — a copy-paste of the nearby floor-violation section. The floor-violation class applies connection-drop styling; the blocked state is semantically different (teacher action, not network failure).  
**Impact:** Blocked students see the connection-drop visual treatment instead of a distinct "blocked" error style.  
**Fix:** Change class to `sb-notice sb-notice--danger sb-mt-6` to match the design system danger notice pattern.

---

#### F4 · Email validation shows native browser popup, not inline styled error

**Page:** `/teach/{slug}` join screen  
**Observed:** Submitting the join form with no email triggers a native browser validation popup (OS-rendered tooltip) rather than an inline styled error. No `sb-help--error` paragraph appears.  
**Impact:** The native popup is inconsistent with the design system error patterns used elsewhere (login form). On some browsers/OS combinations it is easy to miss.  
**Fix:** Remove reliance on native `required` validation popup; add a hidden `<p id="join-email-error" class="sb-help--error">` under the email field; intercept submit and show it with a human-readable message before proceeding.

---

### UX Notes (not broken, but noted)

#### N1 · Mobile layout — clean, no issues

At 390 × 844 (iPhone 14 emulation), the join form is fully readable: label and input not clipped, "Enter lobby" button reachable without scrolling, headphones note and "Why?" disclosure legible. No issues found.

---

### Not testable from Playwright

| Item | Reason |
|------|--------|
| Lobby admit / reject flow | Requires two independent browser contexts |
| Active session (S1–S13) | Requires admitted peer connection |
| Recording consent (R1–R5) | Requires active peer connection + real media |
| Accompaniment read-only display (A1–A7) | Requires admitted student |
| iOS AEC notice | Requires real iOS Safari UA |
| Self-check overlay | Requires getUserMedia + real camera |

---

## Resolution Table

_Updated 2026-05-07 — fixes implemented in same session._

| ID | Status | Resolution |
|----|--------|------------|
| F1 | **FIXED** | Added `<a id="wrong-room-link" href="/">Wrong room? Go back</a>` in `web/student.html`; `student.js` sets `href='/'` (no-op but explicit). |
| F2 | **FIXED** | `student.js` now sets `document.getElementById('room-eyebrow').textContent = slug` and `document.title = slug + ' — singing-bridge'` immediately on load. |
| F3 | **FIXED** | `#blocked-notice` class changed from `floor-violation` to `sb-notice sb-notice--danger sb-mt-6` in `web/student.html`. |
| F4 | **FIXED** | Added `<p id="join-email-error" class="sb-help--error" hidden>` in form; `student.js` intercepts submit, validates `emailInput.validity.valid`, shows inline message and returns early without hiding the form. |
| N1 | **NO ACTION** | Mobile layout verified clean at 390 × 844. |
