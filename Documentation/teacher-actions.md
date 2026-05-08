# Teacher Actions — Page by Page

_singing-bridge · compiled 2026-05-07_

This document lists every action a teacher can take on every page. It is the reference spec for functional QA.

---

## 1. Home / Landing (`/`)

| Action | How | Expected result |
|--------|-----|----------------|
| Navigate to site | Browser → `/` | Two cards: "I'm a teacher" and "I'm a student" |
| Log in | Click "Log in" | → `/auth/login` |
| Create account | Click "Create an account" | → `/signup` |

---

## 2. Log In (`/auth/login`)

| Action | How | Expected result |
|--------|-----|----------------|
| Submit valid credentials | Fill email + password, click Sign in | Redirect → `/teach/<slug>/dashboard` |
| Submit wrong password | Fill email + bad password | Error message shown |
| Submit empty form | Click Sign in with empty fields | Validation error |

---

## 3. Dashboard (`/teach/<slug>/dashboard`)

| Action | How | Expected result |
|--------|-----|----------------|
| View room name | Page loads | Slug shown in UPPERCASE in nav |
| Enter room | Click "Enter Room" | → `/teach/<slug>/session` |
| Log out | Click "Log out" | POST `/auth/logout` → redirect to `/` |
| View session history | Click "View full history →" | → `/teach/<slug>/history` |
| View recordings panel | Page loads | Last ≤8 recordings: student email, date, duration |
| View library panel | Page loads | Last ≤5 library tracks: title, variant count |
| Navigate to full library | Click "Manage library →" | → `/teach/<slug>/library` |

---

## 4. Accompaniment Library (`/teach/<slug>/library`)

### 4a. Uploading assets

| Action | How | Expected result |
|--------|-----|----------------|
| Upload PDF (sheet music) | Enter title, drop/click .pdf file | Asset created; row appears; kind shown as PDF |
| Upload MIDI | Enter title, drop/click .mid/.midi | Asset created; kind shown as MIDI |
| Upload WAV | Enter title, drop/click .wav | Asset created; kind shown as WAV; variant auto-created |
| Upload MP3 | Enter title, drop/click .mp3 | Asset created; kind shown as MP3 |
| Upload without title | Drop file, no title | Validation error / upload blocked |
| Upload unsupported format | Drop .txt | Error shown |
| Record MIDI from keyboard | Select MIDI device, click Start recording, play notes, click Stop | MIDI file uploaded as new asset |

### 4b. Asset list — summary row

| Action | How | Expected result |
|--------|-----|----------------|
| Expand asset | Click title / expand arrow | Detail panel opens below |
| Collapse asset | Click title again | Detail panel closes |
| Delete asset | Click "Delete" | Confirmation → `DELETE` → row removed |

### 4c. PDF asset — OMR and synthesis flow

| Action | How | Expected result |
|--------|-----|----------------|
| Run OMR (optical music recognition) | Expand PDF asset; click "Run OMR" | Status → "OMR running…" → polls until complete → part picker appears |
| Select parts | Check/uncheck part checkboxes | Selected parts included in synthesis |
| Open synthesis modal | Click "New Variant" | Modal opens with blank label, 100% tempo, 0 semitones |
| Create variant (from MIDI) | Fill label, set tempo %, transpose; click "Create Backing Track" | Status → "Synthesizing…" → variant row appears with label and token; audio playable |
| Cancel synthesis | Click "Cancel" | Modal closes, no variant created |
| View score | Click "View Score" | Score modal opens with rasterized pages |

### 4d. MIDI asset

| Action | How | Expected result |
|--------|-----|----------------|
| Open synthesis modal | Expand MIDI asset; click "New Variant" | Modal opens |
| Create variant | Fill label, tempo, transpose; click "Create Backing Track" | Variant created; WAV audio playable immediately |
| Resynthesise variant | Click "Resynthesise" | Modal opens pre-filled; on submit new WAV generated |
| Play variant audio | Audio player in variant row | WAV streams from `/api/media/<token>` |

### 4e. WAV asset

| Action | How | Expected result |
|--------|-----|----------------|
| Expand | Click title | Variant auto-created on upload; shows label "original" |
| Play audio | Audio player | WAV streams |

### 4f. Variant management

| Action | How | Expected result |
|--------|-----|----------------|
| View variant list | Expand asset with variants | Each row: label, tempo %, transpose semitones |
| Update variant count display | Add or delete a variant | Count in summary row updates without page refresh |
| Delete variant | Click "Delete variant" | Confirmation → `DELETE` → row removed; count decrements |

### 4g. Score viewer modal

| Action | How | Expected result |
|--------|-----|----------------|
| Open score | Click "View Score" | Modal with stacked PDF pages / SVG score |
| Play audio | Click play in score modal | Audio plays; current bar highlighted |
| Switch variant | Select different variant in dropdown | Audio and bar highlighting update |
| Navigate pages | Scroll or page controls | Pages show in order |
| Close | Click close (×) | Modal closes |

### 4h. Sidecar / processing errors

| Action | How | Expected result |
|--------|-----|----------------|
| OMR when sidecar unavailable | Click "Run OMR" with sidecar down | Error banner: "Sheet music tools unavailable. Upload and delete still work." |
| Dismiss sidecar banner | Click × on banner | Banner hides |

---

## 5. Session / Teacher Room (`/teach/<slug>/session`)

### 5a. Pre-session setup

| Action | How | Expected result |
|--------|-----|----------------|
| Open session page | Navigate to `/teach/<slug>/session` | Self-check modal appears: mic/camera permission request |
| Grant mic/camera | Click Allow in browser prompt | Permission granted; audio/video preview shown |
| Select audio device | Use device picker | Input/output device selected |

### 5b. Lobby

| Action | How | Expected result |
|--------|-----|----------------|
| View waiting students | Student joins lobby | Student row appears with email, browser, device, tier, acoustic profile |
| Admit student | Click "Admit" | WebRTC peer connection starts; session begins |
| Reject student | Click "Reject" | Student removed from lobby; shown rejection on their end |
| Reject and block | Click "Reject & block (10 min)" | Student blocked for 10 minutes |
| Send lobby message | Type in text box; click "Send" | Message delivered to student in lobby |
| Toggle acoustic profile | Click "Mark: Headphones" / "Mark: Speakers" | Profile flip; affects accompaniment muting |

### 5c. Active session

| Action | How | Expected result |
|--------|-----|----------------|
| Session status | Student admitted | Status → "Connected." |
| Start recording | Click "Record" | Button → "Waiting…" then "Stop recording"; REC indicator shown |
| Stop recording | Click "Stop recording" | Recording uploaded; "Send recording to student?" modal appears |
| Send recording | Fill email in modal; click "Send link" | POST `/api/recordings/:id/send`; "Sent!" shown; modal closes |
| Dismiss recording modal | Click "Dismiss" | Modal closes without sending |
| End session | Click "End session" | Connection closed; status resets |
| Chat mode: Auto | Click chat chip once | "Auto-listening" (VAD controls mic) |
| Chat mode: On | Click again | "Always on" |
| Chat mode: Off | Click again | "Demonstrating" / suppressed |
| Quality badge | Connection established | Good / warning / poor indicator |

### 5d. Accompaniment — in session

| Action | How | Expected result |
|--------|-----|----------------|
| Select track | Choose asset:variant from dropdown | Track loaded (duration shown) |
| Play accompaniment | Click Play | Audio starts; student hears it; position counter ticks |
| Pause accompaniment | Click Pause | Audio pauses; position frozen |
| Stop accompaniment | Click Stop | Audio stops; position resets to 0 |
| Switch track mid-play | Change dropdown | New track plays from start |
| View score in session | Click score toggle | Score view opens alongside accompaniment |
| Bar highlight sync | Play accompaniment | Current bar highlighted in real-time |
| Muting banner | Student has speakers | "Backing track playing on student's machine only" shown |

### 5e. Post-session

| Action | How | Expected result |
|--------|-----|----------------|
| View recordings | Click "View recordings →" | → `/teach/<slug>/recordings` |

---

## 6. Recordings (`/teach/<slug>/recordings`)

| Action | How | Expected result |
|--------|-----|----------------|
| View list | Page loads | All recordings: date, student, duration, status |
| Sort by date | Click "Date" | List sorted newest first |
| Sort by student | Click "Student" | List sorted A→Z by student email |
| Send recording link | Click "Send link" | Modal opens with email pre-filled |
| Confirm send | Fill email; click "Send" | POST → "Sent!"; modal closes |
| Re-send expired link | Click "Re-send link" | Same modal flow |
| Delete recording | Click "Delete" | Confirmation → DELETE → row removed |

---

## 7. Session History (`/teach/<slug>/history`)

| Action | How | Expected result |
|--------|-----|----------------|
| View history | Page loads | Table: ID, started, student email, duration, end reason, recording link |
| Follow recording link | Click recording link | → `/teach/<slug>/recordings` (filtered?) |

---

## 8. Auth flows (edge cases)

| Action | How | Expected result |
|--------|-----|----------------|
| Visit teacher page unauthenticated | Navigate to `/teach/:slug/dashboard` | Redirect → `/` |
| Visit non-existent slug | Navigate to `/teach/nonexistent-room` | Redirect → `/?room-not-found=nonexistent-room` with error shown |
| Session expired | Cookie expires mid-session | Next page load → redirect to `/` |

---

_Actions marked with ⚡ require the sidecar (PDF/OMR processing) to be running._
_Actions marked with 📡 require a live WebRTC peer connection (student in room)._
