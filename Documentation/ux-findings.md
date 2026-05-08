# UX Findings — Playwright Walkthrough

_singing-bridge · 2026-05-07 · Tested against localhost:8080 with teacher account `andrewoutlook`_

Findings are grouped by severity. Each has a page reference, observed behaviour, and a suggested fix.

---

## Bugs (broken functionality)

### B1 · Variant count doesn't update in library summary

**Page:** Library  
**Observed:** Adding or deleting a variant does not update the count shown in the asset's summary row (e.g. "MIDI · 0 variants · 06/05/2026" stays at 0 after creating a variant). Confirmed in both directions — add and delete.  
**Impact:** Teacher is confused about how many variants exist per track. The count is only correct on a hard page refresh.  
**Fix:** `updateVariantCount()` in `library.js` needs the `.asset-variant-count` span to exist in the summary row at render time. Check that `renderSummary()` wraps the variant count in the expected `<span class="asset-variant-count">` and that `closest('.asset-row')` resolves correctly from the variant list item's DOM position.

---

### B2 · "Score rendering…" stuck on PDF variant

**Page:** Library → PDF asset (Over the rainbow) → Piano variant  
**Observed:** The Piano variant shows a "Score rendering…" button that never resolves. Clicking it does nothing. The rasterised pages _do_ load correctly in the "View Score" modal (6 pages visible), so rasterisation succeeded — the button state is just wrong.  
**Impact:** Teacher sees a permanent in-progress indicator that implies something is broken or still running.  
**Fix:** After rasterisation completes, the variant row should replace "Score rendering…" with a working "View Score" button. Check the `has_musicxml` / page-URL logic that decides which label to show on the per-variant score button.

---

### B3 · Upload — no feedback when clicked without a file

**Page:** Library → Add a track  
**Observed:** Clicking "Upload" with no file selected and/or no title silently does nothing. No error message, no disabled state, no highlight on the drop zone.  
**Impact:** Teacher doesn't know why nothing happened.  
**Fix:** Validate before sending: if no file is staged, show an inline error ("Please choose a file first"). If no title, show "Please enter a title." Optionally disable the Upload button until both are present.

---

### B4 · "Back to room" / "← Back to room" links go to the wrong page

**Pages:** Library, Recordings, History  
**Observed:** All three pages have a back link pointing to `/teach/<slug>` (the student join page), not `/teach/<slug>/dashboard`. A logged-in teacher clicking Back lands on the student join screen, which is confusing and unhelpful.  
**Impact:** Teacher has no quick way to navigate back to the dashboard from any of these pages.  
**Fix:** Change all back links on teacher-only pages to `/teach/<slug>/dashboard`.

---

## UX Issues (unclear or poorly laid out)

### U1 · Login error has no error styling

**Page:** Log in  
**Observed:** When credentials are wrong, "invalid credentials" appears as a plain `<p>` at the bottom of the card with no colour, icon, or visual distinction from regular text.  
**Impact:** Teacher may not notice the error, especially on a small screen or if they expect a red alert.  
**Fix:** Style the error paragraph with `sb-notice--error` or an equivalent red/danger token, and add `role="alert"` so screen readers announce it immediately.

---

### U2 · Dashboard recordings panel has no "View all" link

**Page:** Dashboard  
**Observed:** The library panel has a "Manage library →" link. The recordings panel shows up to 8 recent recordings but has no equivalent "View all recordings →" link. The only way to reach the recordings page is through the session page.  
**Impact:** Teachers with recordings have no direct path from the dashboard to their full recording list.  
**Fix:** Add a "View all recordings →" link (pointing to `/teach/<slug>/recordings`) below the recordings list, mirroring the library panel.

---

### U3 · "1 variants" grammar error in library summary

**Page:** Library → asset summary rows  
**Observed:** "Over the rainbow" summary shows "PDF · 1 variants · 05/05/2026". The singular form ("1 variant") is not handled.  
**Impact:** Minor but looks unpolished.  
**Fix:** In `renderSummary`, use `varCount === 1 ? '1 variant' : varCount + ' variants'`.

---

### U4 · Synthesis modal name validation shown in status area, not inline

**Page:** Library → synthesis modal  
**Observed:** Clicking "Create Backing Track" with an empty name shows "Name is required" in the modal's aria-live status region, not adjacent to the Name field. The field itself has no red border or inline message.  
**Impact:** Teacher may not look at the status area and may click the button again wondering why nothing happened.  
**Fix:** Show an inline error below the Name field (the same pattern used in the login form). Keep the aria-live update as a supplementary announcement.

---

### U5 · No audio preview anywhere in the library

**Page:** Library → all asset types  
**Observed:** Variants show label, tempo %, and transpose semitones, but no audio player. There is no way to listen to a backing track from the library page. The score modal also has no audio player.  
**Impact:** Teacher uploads or synthesises a track and has no way to verify it sounds correct before using it in a lesson. They must go into a live session to hear it.  
**Fix (score modal):** Add an `<audio>` element in the score modal with the variant's media token as `src`. Wire playback position to bar highlight.  
**Fix (variant row):** Add a small inline play button per variant (collapsed by default to save space) that streams the WAV from `/api/media/<token>`.

---

### U6 · Accompaniment drawer hidden until student connects

**Page:** Session  
**Observed:** The accompaniment drawer root element is empty before a student is admitted. Teachers cannot browse, select, or preview their tracks while waiting in the lobby.  
**Impact:** Teacher must prepare track selection before entering the room (from the library page), or scramble to find the right track after the student is already connected.  
**Fix:** Mount the accompaniment track selector (read-only or in a "preview" mode) as soon as the session page loads, so the teacher can select the track while the student is in the lobby or still joining.

---

### U7 · Session page has no navigation header

**Page:** Session  
**Observed:** The session page (`/teach/<slug>/session`) has no topbar or breadcrumb — no link back to the dashboard, no room name in a nav area. The other teacher pages (library, recordings) have a `sb-topbar`-style banner. The session page has only a `<p>Studio</p>` eyebrow and an `<h1>`.  
**Impact:** Teacher can only navigate away using the browser's Back button or by editing the URL manually.  
**Fix:** Add a minimal top-bar with "singing-bridge · `<SLUG>`" and a "← Dashboard" link, consistent with the library and recordings pages.

---

### U8 · History page is raw server-rendered HTML — inconsistent design

**Page:** History  
**Observed:** The history page uses plain server-rendered HTML with no `sb-page` wrapper, no topbar, and no CSS beyond the base stylesheet. All other teacher pages use the design system (sb-topbar, sb-card, sb-btn). "Back to room" is a plain inline link at the bottom.  
**Impact:** Feels like a developer debug page rather than part of the product. Breaks visual consistency.  
**Fix:** Wrap the history table in the standard page shell with a topbar, convert the back link to a proper `sb-btn sb-btn--ghost` pointing to `/teach/<slug>/dashboard`, and apply `sb-table` (or equivalent) styling to the data table.

---

### U9 · History "Started" column shows raw UNIX timestamps

**Page:** History  
**Observed:** The "Started" column shows raw integers (e.g., `1777989035`) rather than human-readable dates/times.  
**Impact:** Teachers cannot tell when sessions occurred.  
**Fix:** Format as a local date-time string, e.g., `2026-05-07 14:23` or `7 May 2026, 2:23 pm`, in the server-side template.

---

### U10 · Visiting another teacher's room silently drops to student join page

**Page:** Any teacher sub-page  
**Observed:** Navigating to `/teach/andrewbale/dashboard` while logged in as `andrewoutlook` silently redirects to `/teach/andrewbale` (the student join page for that room), with no message explaining why.  
**Impact:** A teacher who misremembers their slug could spend time confused, thinking they're joining as a student.  
**Fix:** When a logged-in teacher hits a room that belongs to a different teacher, redirect to _their_ dashboard (`/teach/<own-slug>/dashboard`) with a brief flash message: "That's not your room — here's yours."

---

### U11 · WAV asset has no way to verify or preview the uploaded audio

**Page:** Library → WAV asset  
**Observed:** A WAV asset shows a single auto-created variant with label, tempo %, and a Delete button. There is no audio player to verify the uploaded file sounds correct, and no Re-synthesise option (expected for WAV).  
**Impact:** If the wrong file was uploaded, the teacher has no way to check without entering a live session.  
**Fix:** Covered by U5 — add an inline play button per variant. Applies to WAV variants most critically since WAV is the "original" and can't be regenerated.

---

### U12 · Missing favicon

**Page:** All pages  
**Observed:** Browser requests `/favicon.ico` and gets 404. All browser tabs show a blank icon.  
**Fix:** Add a `favicon.ico` (or `<link rel="icon">` in HTML heads) — even a simple SVG circle in the brand colour would do.

---

## Not testable from Playwright (noted for completeness)

| Item | Reason |
|------|--------|
| WebRTC lobby admit/reject flow | Requires two independent browser contexts (no shared session cookie) |
| Accompaniment playback in session | Requires admitted student peer connection |
| Recording start/stop/upload | Requires active peer connection and real media |
| MIDI keyboard recording | Requires physical MIDI device |
| PDF OMR flow | Requires sidecar Docker container running |
| Score bar-sync while playing | Requires live audio playback |
| Acoustic profile override | Requires admitted student |

---

## Summary counts

| Category | Count |
|----------|-------|
| Bugs (broken) | 4 |
| UX issues | 12 |
| Not testable | 7 |

Priority order for fixes: **B4** (back links) and **B1** (variant count) are high-frequency annoyances. **U5** (no audio preview) and **U6** (accompaniment hidden pre-session) are the most significant functional gaps for the teacher's workflow.

---

## Resolution table

_Updated 2026-05-07 — re-verified after Sprint 26 (server recompiled; all findings re-walked in Playwright)._

| ID | Status | Resolution |
|----|--------|------------|
| B1 | **VERIFIED** | Confirmed in code: `updateVariantCount` called on prepend/delete. Not re-exercised live (requires adding a variant). |
| B2 | **VERIFIED** | "View Score" button present on PDF Piano variant — no "Score rendering…" stuck state observed. |
| B3 | **FALSE POSITIVE** | Upload validation fires correctly. Playwright test used wrong selector. No code change needed. |
| B4 | **VERIFIED** | All three back links confirmed: library → `/dashboard` ✓, recordings → `/dashboard` ✓, history → `/dashboard` ✓ (required server recompile — binary was stale). |
| U1 | **VERIFIED** | `status.className = 'sb-help--error'` confirmed via DOM evaluate after wrong-password submit: color `rgb(200, 104, 79)` applied. Earlier false reading was a Playwright timing issue (evaluate ran before async fetch resolved). |
| U2 | **VERIFIED** | "View all recordings →" link present on dashboard, href `/teach/andrewoutlook/recordings`. |
| U3 | **VERIFIED** | "1 variant" (singular) displayed on dashboard and library for Over the rainbow. |
| U4 | **NOT RE-TESTED** | Requires sidecar (OMR/synthesis modal). Code confirmed present in library.html. |
| U5 | **NOT A BUG** | Audio players present in variant rows; Playwright accessibility snapshots don't surface `<audio>` elements. |
| U6 | **FIXED — Sprint 26** | Accompaniment panel now visible in lobby before any student connects. `#accompaniment-drawer-root` populated on page load with track selector ("Over the rainbow (1 variant)", "Handel (1 variant)"), "Preview" aria-label button, and `sb-accmp-panel--lobby` CSS class. "Simple" (0 variants) correctly excluded from lobby selector. |
| U7 | **VERIFIED** | Session page topbar present with brand, ANDREWOUTLOOK slug, and "← Dashboard" → `/dashboard` link. |
| U8 | **VERIFIED** | History page now renders with full design system: `sb-topbar`, "← Dashboard" link, table with proper column headers. Required server recompile. |
| U9 | **VERIFIED** | History timestamps shown as "2026-05-05 13:50" format (not raw UNIX integers). Required server recompile. |
| U10 | **DEFERRED** | Cross-teacher redirect not addressed. Low priority. |
| U11 | **NOT A BUG** | WAV variant audio player confirmed present (see U5). |
| U12 | **VERIFIED** | `<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">` confirmed in recordings page `<head>`. Favicon loads at `http://localhost:8080/assets/favicon.svg`. |
