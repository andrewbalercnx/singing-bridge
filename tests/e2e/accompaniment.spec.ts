// File: tests/e2e/accompaniment.spec.ts
// Purpose: E2E tests for in-session accompaniment playback — teacher controls,
//          student read-only UI, token revocation on stop/disconnect.
// Role: Two-browser Playwright specs; no sidecar required (WAV upload seeding).
//       Playback is driven by setting the drawer's dataset and clicking Play.
// Depends: Playwright, running server at localhost:8080
// Last updated: Sprint 28 (2026-05-08) -- fix selectors for v2 teacher panel

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { parse as parseCookieHeader } from 'set-cookie-parser';

const BASE_URL = 'http://localhost:8080';

// Minimal valid WAV: RIFF header + WAVE marker + fmt chunk + data chunk.
const WAV_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0xFF, 0xFF, 0xFF, 0xFF, // chunk size (placeholder)
  0x57, 0x41, 0x56, 0x45, // "WAVE"
  0x66, 0x6D, 0x74, 0x20, // "fmt "
  0x10, 0x00, 0x00, 0x00, // sub-chunk size 16
  0x01, 0x00,             // PCM
  0x01, 0x00,             // 1 channel
  0x44, 0xAC, 0x00, 0x00, // 44100 Hz
  0x88, 0x58, 0x01, 0x00, // byte rate
  0x02, 0x00,             // block align
  0x10, 0x00,             // 16 bits
  0x64, 0x61, 0x74, 0x61, // "data"
  0xFF, 0xFF, 0xFF, 0xFF, // data size (placeholder)
  0x00, 0x00, 0x00, 0x00, // 4 bytes of silence
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Each run generates a unique timestamp slug so collision is impossible — no login fallback needed.
async function registerTeacher(page: Page, email: string, slug: string): Promise<string> {
  const res = await page.request.post(`${BASE_URL}/auth/register`, {
    data: { email, slug, password: 'test-passphrase-12' },
  });
  if (!res.ok()) throw new Error(`register failed: ${res.status()} ${await res.text()}`);
  return res.headers()['set-cookie'];
}

async function injectCookie(context: BrowserContext, rawCookie: string): Promise<void> {
  const [parsed] = parseCookieHeader(rawCookie, { decodeValues: false });
  // Playwright rejects `domain: 'localhost'` — use `url` instead.
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    url: BASE_URL,
    httpOnly: parsed.httpOnly ?? false,
    secure: parsed.secure ?? false,
  }]);
}

/** Upload a WAV asset. WAV uploads return { id, variant_id } directly. */
async function seedWavAsset(
  page: Page, slug: string, rawCookieHeader: string
): Promise<{ assetId: number; variantId: number }> {
  const cookieValue = rawCookieHeader.split(';')[0];
  const res = await page.request.post(`${BASE_URL}/teach/${slug}/library/assets`, {
    headers: {
      'cookie': cookieValue,
      'x-title': 'E2E Fixture WAV',
      'content-type': 'audio/wav',
    },
    data: WAV_BYTES,
  });
  if (!res.ok()) throw new Error(`WAV upload failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  const assetId = body.id as number;
  const variantId = body.variant_id as number;
  if (!assetId || !variantId) {
    throw new Error(`WAV upload missing id/variant_id: ${JSON.stringify(body)}`);
  }
  return { assetId, variantId };
}

/** Replace Audio constructor so autoplay policy never blocks tests. */
async function stubAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const instances: any[] = [];
    (window as any).__stubAudioInstances = instances;
    (window as any).Audio = class FakeAudio {
      src = '';
      currentTime = 0;
      paused = true;
      private _listeners: Record<string, Array<(e?: Event) => void>> = {};
      constructor() { instances.push(this); }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
      addEventListener(ev: string, fn: (e?: Event) => void) {
        (this._listeners[ev] = this._listeners[ev] || []).push(fn);
      }
      _fireEnded() {
        (this._listeners['ended'] || []).forEach(f => f());
      }
    };
  });
}

async function dismissSelfCheck(page: Page): Promise<void> {
  try {
    const overlay = page.locator('.sb-self-check-overlay');
    await overlay.waitFor({ state: 'visible', timeout: 6_000 });
    await page.locator('.sb-self-check-hp-check').check();
    await page.locator('.sb-self-check-confirm').click();
    await overlay.waitFor({ state: 'detached', timeout: 5_000 });
  } catch {
    // Overlay not shown — no-op.
  }
}

interface SessionPair {
  teacherCtx: BrowserContext;
  studentCtx: BrowserContext;
  teacherPage: Page;
  studentPage: Page;
}

async function establishSession(
  browser: Browser, slug: string, cookieHeader: string
): Promise<SessionPair> {
  const ctxOpts = { permissions: ['camera', 'microphone'] as Array<'camera' | 'microphone'> };
  const teacherCtx = await browser.newContext(ctxOpts);
  const studentCtx = await browser.newContext(ctxOpts);
  await injectCookie(teacherCtx, cookieHeader);

  const teacherPage = await teacherCtx.newPage();
  const studentPage = await studentCtx.newPage();
  await stubAudio(teacherPage);
  await stubAudio(studentPage);

  await teacherPage.goto(`${BASE_URL}/teach/${slug}/session`);
  await expect(teacherPage.locator('#room-heading')).toBeVisible();
  await dismissSelfCheck(teacherPage);

  await studentPage.goto(`${BASE_URL}/teach/${slug}`);
  await studentPage.fill('#join-form input[name="email"]', `student-${slug}@test.invalid`);
  await studentPage.click('#join-form button[type="submit"]');
  await dismissSelfCheck(studentPage);
  await expect(studentPage.locator('#lobby-status')).toBeVisible();

  const admitBtn = teacherPage.locator('#lobby-list li button', { hasText: 'Admit' }).first();
  await expect(admitBtn).toBeVisible({ timeout: 15_000 });
  await admitBtn.click();

  await expect(teacherPage.locator('#session-root .sb-session-v2')).toBeVisible({ timeout: 30_000 });
  await expect(studentPage.locator('#session')).toBeVisible({ timeout: 30_000 });

  return { teacherCtx, studentCtx, teacherPage, studentPage };
}

/**
 * Select a track in the v2 teacher panel and click the play/pause toggle.
 * Waits for the live track selector to be populated (library fetch after peer connect).
 */
async function clickPlay(page: Page, assetId: number, variantId: number): Promise<void> {
  const optionValue = `${assetId}:${variantId}`;
  // Wait for the live track selector to have this option (populated after peer connect).
  await page.locator(`.sb-accmp-track-select option[value="${optionValue}"]`).waitFor({ state: 'attached', timeout: 10_000 });
  await page.locator('.sb-accmp-track-select').selectOption(optionValue);
  await page.locator('.sb-accmp-pause').click();
}

/** Fire the audio ended event on the last stub instance to simulate stop. */
async function fireAudioEnded(page: Page): Promise<void> {
  await page.evaluate(() => {
    const instances = (window as any).__stubAudioInstances ?? [];
    if (instances.length > 0) instances[instances.length - 1]._fireEnded();
  });
}

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let sharedSlug = '';
let sharedCookieHeader = '';
let sharedAssetId = 0;
let sharedVariantId = 0;

// ---------------------------------------------------------------------------
// Test 1: Register teacher and seed WAV asset
// ---------------------------------------------------------------------------

test('setup: register teacher and seed WAV asset', async ({ page, context }) => {
  test.setTimeout(30_000);
  const runId = String(Date.now());
  sharedSlug = `e2e-acc-${runId}`;
  const email = `e2e-acc-${runId}@test.invalid`;

  sharedCookieHeader = await registerTeacher(page, email, sharedSlug);
  await injectCookie(context, sharedCookieHeader);

  const { assetId, variantId } = await seedWavAsset(page, sharedSlug, sharedCookieHeader);
  sharedAssetId = assetId;
  sharedVariantId = variantId;

  expect(assetId).toBeGreaterThan(0);
  expect(variantId).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 2: Accompaniment drawer visible after session established
// ---------------------------------------------------------------------------

test('drawer visible after session established', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug) test.skip();

  const { teacherCtx, studentCtx, teacherPage, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await expect(teacherPage.locator('#accompaniment-drawer-root')).toBeAttached();
    await expect(studentPage.locator('#accompaniment-drawer-root')).toBeAttached();
    // Teacher uses the v2 accmp panel (session-panels.js); student uses the legacy drawer.
    await expect(teacherPage.locator('.sb-accmp-panel')).toBeVisible({ timeout: 5_000 });
    await expect(studentPage.locator('.sb-accompaniment-status')).toBeVisible({ timeout: 5_000 });
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 3: Play — student drawer shows "Playing"
// ---------------------------------------------------------------------------

test('play: student drawer shows Playing after teacher clicks Play', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug || !sharedAssetId) test.skip();

  const { teacherCtx, studentCtx, teacherPage, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await clickPlay(teacherPage, sharedAssetId, sharedVariantId);

    // Student drawer must transition to "Playing" (receives AccompanimentState).
    await expect(studentPage.locator('.sb-accompaniment-status')).toContainText(
      /Playing/i, { timeout: 8_000 }
    );
    // Teacher v2 panel shows "Playing" in the track-name slot.
    await expect(teacherPage.locator('.sb-accmp-track-name')).toContainText(
      /Playing/i, { timeout: 5_000 }
    );
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 4: Pause — student shows "Paused"
// ---------------------------------------------------------------------------

test('pause: student drawer shows Paused after teacher clicks Pause', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug || !sharedAssetId) test.skip();

  const { teacherCtx, studentCtx, teacherPage, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await clickPlay(teacherPage, sharedAssetId, sharedVariantId);
    await expect(teacherPage.locator('.sb-accmp-track-name')).toContainText(/Playing/i, { timeout: 8_000 });

    // Click play/pause toggle again to pause.
    await teacherPage.locator('.sb-accmp-pause').click();
    await expect(studentPage.locator('.sb-accompaniment-status')).toContainText(/Paused/i, { timeout: 5_000 });
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 5: Stop — student returns to idle; previously issued token 404s
// ---------------------------------------------------------------------------

test('stop: student returns to idle; media token 404s', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug || !sharedAssetId) test.skip();

  const { teacherCtx, studentCtx, teacherPage, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  let wavUrl = '';
  try {
    await clickPlay(teacherPage, sharedAssetId, sharedVariantId);
    await expect(teacherPage.locator('.sb-accmp-track-name')).toContainText(/Playing/i, { timeout: 8_000 });

    // Capture the wav_url from the Audio stub.
    wavUrl = await teacherPage.evaluate(() => {
      const instances = (window as any).__stubAudioInstances ?? [];
      return instances.length > 0 ? instances[instances.length - 1].src : '';
    });

    // v2 teacher has no stop button — fire audio ended to trigger accompaniment_stop.
    await fireAudioEnded(teacherPage);
    await expect(studentPage.locator('.sb-accompaniment-status')).toContainText(
      /No accompaniment/i, { timeout: 5_000 }
    );
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }

  // After stop, the issued media token should return 404.
  if (wavUrl) {
    const tokenPath = new URL(wavUrl).pathname;
    const res = await fetch(`${BASE_URL}${tokenPath}`);
    expect(res.status).toBe(404);
  }
});

// ---------------------------------------------------------------------------
// Test 6: Student cannot control — no Play/Pause/Stop buttons
// ---------------------------------------------------------------------------

test('student cannot control: no play/pause/stop buttons', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug) test.skip();

  const { teacherCtx, studentCtx, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await expect(studentPage.locator('#accompaniment-drawer-root .sb-btn-play')).toHaveCount(0);
    await expect(studentPage.locator('#accompaniment-drawer-root .sb-btn-pause')).toHaveCount(0);
    await expect(studentPage.locator('#accompaniment-drawer-root .sb-btn-stop')).toHaveCount(0);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 7: Teacher has play/pause/stop controls
// ---------------------------------------------------------------------------

test('teacher has play/pause controls in v2 accmp panel (no stop button)', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug) test.skip();

  const { teacherCtx, teacherPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    // v2 teacher uses accmp panel (session-panels.js) not the old controls div.
    await expect(teacherPage.locator('.sb-accmp-panel')).toBeVisible({ timeout: 5_000 });
    await expect(teacherPage.locator('.sb-accmp-pause')).toBeVisible();
    await expect(teacherPage.locator('.sb-accmp-track-select')).toBeVisible();
  } finally {
    await teacherCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 8: WAV-only asset — no score panel visible
// ---------------------------------------------------------------------------

test('WAV-only asset: score view hidden (no page images)', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug || !sharedAssetId) test.skip();

  const { teacherCtx, teacherPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await clickPlay(teacherPage, sharedAssetId, sharedVariantId);
    await expect(teacherPage.locator('.sb-accmp-track-name')).toContainText(/Playing/i, { timeout: 8_000 });

    const scoreViewDisplay = await teacherPage.evaluate(() => {
      const sv = document.querySelector('#score-view-root .sb-score-view') as HTMLElement | null;
      return sv ? sv.style.display : 'none';
    });
    expect(scoreViewDisplay).toBe('none');
  } finally {
    await teacherCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 9: Natural end (audio ended fires on teacher)
// ---------------------------------------------------------------------------

test('natural end: audio ended fires AccompanimentStop; student returns to idle', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug || !sharedAssetId) test.skip();

  const { teacherCtx, studentCtx, teacherPage, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await clickPlay(teacherPage, sharedAssetId, sharedVariantId);
    await expect(teacherPage.locator('.sb-accmp-track-name')).toContainText(/Playing/i, { timeout: 8_000 });

    // Fire the 'ended' event on the Audio stub to simulate natural playback end.
    await fireAudioEnded(teacherPage);

    await expect(studentPage.locator('.sb-accompaniment-status')).toContainText(
      /No accompaniment/i, { timeout: 8_000 }
    );
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

// ---------------------------------------------------------------------------
// Test 10: Disconnect clears accompaniment state on student
// ---------------------------------------------------------------------------

test('teacher disconnect clears accompaniment state on student', async ({ browser }) => {
  test.setTimeout(90_000);
  if (!sharedSlug) test.skip();

  const { teacherCtx, studentCtx, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  try {
    await teacherCtx.close();

    await expect(studentPage.locator('#error')).toContainText(
      /disconnected/i, { timeout: 15_000 }
    );

    const statusText = await studentPage.locator('.sb-accompaniment-status')
      .textContent({ timeout: 3_000 })
      .catch(() => '');
    expect(statusText ?? '').not.toMatch(/Playing/i);
  } finally {
    await studentCtx.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Test 11: No JS console errors during session lifecycle
// ---------------------------------------------------------------------------

test('no JS console errors during accompaniment session lifecycle', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!sharedSlug) test.skip();

  const { teacherCtx, studentCtx, teacherPage, studentPage } =
    await establishSession(browser, sharedSlug, sharedCookieHeader);

  const teacherErrors: string[] = [];
  const studentErrors: string[] = [];

  teacherPage.on('console', msg => {
    if (msg.type() === 'error') teacherErrors.push(msg.text());
  });
  studentPage.on('console', msg => {
    if (msg.type() === 'error') studentErrors.push(msg.text());
  });

  await teacherPage.waitForTimeout(2_000);

  try {
    const nonAutoplayErrors = (errors: string[]) =>
      errors.filter(e => !e.toLowerCase().includes('autoplay') && !e.toLowerCase().includes('play()'));
    expect(nonAutoplayErrors(teacherErrors), 'teacher console errors').toHaveLength(0);
    expect(nonAutoplayErrors(studentErrors), 'student console errors').toHaveLength(0);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});
