// File: tests/e2e/session.spec.js
// Purpose: E2E tests for the teacher/student WebRTC session — covers signup,
//          lobby admission, and audio/video stream establishment.
// Last updated: Sprint 9 (2026-04-20) -- initial E2E test suite; slug-file persistence for worker recycling

'use strict';

const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { signupAndAuth } = require('./helpers/auth');
const path = require('path');

const AUTH_STATE_PATH = path.join(__dirname, '../../.e2e-auth-state.json');
// Written by test 1; read by all other tests including those in recycled workers.
const SLUG_PATH = path.join(__dirname, '../../.e2e-slug.txt');

// Read the current slug from disk. Throws if test 1 hasn't run yet.
function getSlug() {
  if (!fs.existsSync(SLUG_PATH)) throw new Error('SLUG_PATH not found — test 1 must run first');
  return fs.readFileSync(SLUG_PATH, 'utf8').trim();
}
function getStudentEmail() {
  return `e2e-student-${getSlug().replace('e2e-', '')}@test.invalid`;
}
function getTeacherEmail() {
  return `e2e-teacher-${getSlug().replace('e2e-', '')}@test.invalid`;
}

/**
 * Wait for the sb-self-check-overlay to appear (async, fires after getUserMedia),
 * then dismiss it by checking the headphones box and clicking Ready.
 * If the overlay never appears within the timeout, silently continue.
 */
async function dismissSelfCheck(page, { timeout = 6_000 } = {}) {
  try {
    const overlay = page.locator('.sb-self-check-overlay');
    await overlay.waitFor({ state: 'visible', timeout });
    await page.locator('.sb-self-check-hp-check').check();
    await page.locator('.sb-self-check-confirm').click();
    await overlay.waitFor({ state: 'detached', timeout: 5_000 });
  } catch {
    // Overlay never appeared — no self-check on this page or already skipped.
  }
}

// ---------------------------------------------------------------------------
// Signup + auth (runs once; state reused by later tests)
// ---------------------------------------------------------------------------

test('teacher signup and auth', async ({ page, context }) => {
  // Always mint a fresh slug so re-runs don't conflict (in-memory DB is wiped
  // between server restarts, but between tests within a run the slug persists).
  const runId = String(Date.now());
  const slug = `e2e-${runId}`;
  const email = `e2e-teacher-${runId}@test.invalid`;

  await signupAndAuth(page, { email, slug });
  await expect(page.locator('#room-heading')).toContainText(slug);
  await expect(page.locator('#lobby-empty')).toBeVisible();

  // Write slug to disk so recycled workers can find it.
  fs.writeFileSync(SLUG_PATH, slug, 'utf8');

  // Save auth cookies so subsequent tests can reuse without re-signing-in.
  await context.storageState({ path: AUTH_STATE_PATH });
});

// ---------------------------------------------------------------------------
// Teacher room view (authenticated)
// ---------------------------------------------------------------------------

test('teacher sees empty lobby and room heading', async ({ browser }) => {
  const slug = getSlug();
  const ctx = await browser.newContext({
    permissions: ['camera', 'microphone'],
    storageState: AUTH_STATE_PATH,
  });
  const page = await ctx.newPage();

  await page.goto(`/teach/${slug}`);
  await expect(page.locator('#room-heading')).toContainText(slug);
  await expect(page.locator('#lobby-empty')).toBeVisible();
  await ctx.close();
});

// ---------------------------------------------------------------------------
// Student join → lobby waiting state
// ---------------------------------------------------------------------------

test('student join form enters lobby waiting state', async ({ page }) => {
  const slug = getSlug();
  await page.goto(`/teach/${slug}`);
  await expect(page.locator('#join')).toBeVisible();

  await page.fill('#join-form input[name="email"]', getStudentEmail());
  await page.click('#join-form button[type="submit"]');

  await expect(page.locator('#join')).toBeHidden();
  await expect(page.locator('#lobby-status')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Full session: teacher admits student → both sides get live streams
// ---------------------------------------------------------------------------

test('full session — remote audio/video streams established after admission', async ({ browser }) => {
  test.setTimeout(90_000);
  const slug = getSlug();
  const studentEmail = getStudentEmail();
  const ctxOpts = { permissions: ['camera', 'microphone'] };

  const teacherCtx = await browser.newContext({ ...ctxOpts, storageState: AUTH_STATE_PATH });
  const studentCtx = await browser.newContext(ctxOpts);

  try {
    const teacherPage = await teacherCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Teacher opens room and dismisses self-check overlay.
    await teacherPage.goto(`/teach/${slug}`);
    await expect(teacherPage.locator('#room-heading')).toContainText(slug);
    await dismissSelfCheck(teacherPage);

    // Student enters lobby (self-check shown after submit — dismiss it too).
    await studentPage.goto(`/teach/${slug}`);
    await studentPage.fill('#join-form input[name="email"]', studentEmail);
    await studentPage.click('#join-form button[type="submit"]');
    await dismissSelfCheck(studentPage);
    await expect(studentPage.locator('#lobby-status')).toBeVisible();

    // Teacher sees student in lobby and admits.
    const admitBtn = teacherPage.locator('#lobby-list li button', { hasText: 'Admit' }).first();
    await expect(admitBtn).toBeVisible({ timeout: 15_000 });
    await admitBtn.click();

    // Both sides: session UI mounts.
    await expect(teacherPage.locator('#session-root .sb-session')).toBeVisible({ timeout: 30_000 });
    await expect(studentPage.locator('#session')).toBeVisible({ timeout: 30_000 });

    // Give WebRTC ICE time to connect and tracks to flow.
    await teacherPage.waitForTimeout(8_000);

    // Teacher: remote video has a live srcObject with tracks.
    const teacherVideoOk = await teacherPage.evaluate(() => {
      const vid = document.querySelector('.sb-remote-panel video');
      return !!(vid && vid.srcObject && vid.srcObject.getTracks().length > 0);
    });
    expect(teacherVideoOk, 'teacher remote video srcObject has tracks').toBe(true);

    // Teacher: remote audio has a live srcObject with tracks.
    const teacherAudioOk = await teacherPage.evaluate(() => {
      const aud = document.querySelector('.sb-remote-panel audio');
      return !!(aud && aud.srcObject && aud.srcObject.getTracks().length > 0);
    });
    expect(teacherAudioOk, 'teacher remote audio srcObject has tracks').toBe(true);

    // Student: remote video has a live srcObject with tracks.
    const studentVideoOk = await studentPage.evaluate(() => {
      const vid = document.querySelector('.sb-remote-panel video');
      return !!(vid && vid.srcObject && vid.srcObject.getTracks().length > 0);
    });
    expect(studentVideoOk, 'student remote video srcObject has tracks').toBe(true);

    // Student: remote audio has a live srcObject with tracks.
    const studentAudioOk = await studentPage.evaluate(() => {
      const aud = document.querySelector('.sb-remote-panel audio');
      return !!(aud && aud.srcObject && aud.srcObject.getTracks().length > 0);
    });
    expect(studentAudioOk, 'student remote audio srcObject has tracks').toBe(true);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

// ---------------------------------------------------------------------------
// WebSocket disconnect → student sees error message
// ---------------------------------------------------------------------------

test('student sees connection-lost message when WebSocket drops', async ({ browser }) => {
  const slug = getSlug();
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  try {
    const page = await ctx.newPage();

    // Intercept the WebSocket constructor so we can force-close it later.
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
        window.__lastWs = ws;
        return ws;
      };
      Object.setPrototypeOf(window.WebSocket, OrigWS);
      window.WebSocket.prototype = OrigWS.prototype;
      window.WebSocket.CONNECTING = OrigWS.CONNECTING;
      window.WebSocket.OPEN = OrigWS.OPEN;
      window.WebSocket.CLOSING = OrigWS.CLOSING;
      window.WebSocket.CLOSED = OrigWS.CLOSED;
    });

    await page.goto(`/teach/${slug}`);
    await expect(page.locator('#join-form')).toBeVisible();
    await page.fill('#join-form input[name="email"]', getStudentEmail());
    await page.click('#join-form button[type="submit"]');
    await dismissSelfCheck(page);
    await expect(page.locator('#lobby-status')).toBeVisible();

    // Wait for WS to be fully open, then force-close it so the close event
    // fires immediately without waiting for a TCP keepalive timeout.
    await page.waitForTimeout(800);
    await page.evaluate(() => { if (window.__lastWs) window.__lastWs.close(3000, 'test'); });

    // The close/error listener in signalling.js fires → onWsClose callback →
    // errEl.textContent = 'Connection lost — please refresh the page and try again.'
    await expect(page.locator('#error')).toContainText('Connection lost', { timeout: 8_000 });
  } finally {
    await ctx.close();
  }
});
