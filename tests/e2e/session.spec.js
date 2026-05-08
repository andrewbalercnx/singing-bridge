// File: tests/e2e/session.spec.js
// Purpose: E2E tests for the teacher/student WebRTC session — covers signup,
//          lobby admission, and audio/video stream establishment.
// Last updated: Sprint 28 (2026-05-08) -- migrated from magic-link to password auth

'use strict';

const { test, expect } = require('@playwright/test');
const { loginOrRegister, injectCookie } = require('./helpers/auth');

// Module-level state shared across sequential tests (workers=1 in playwright.config.js).
let sharedSlug = '';
let sharedCookieHeader = '';

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
// Signup + auth (runs once; cookie stored in module-level variable)
// ---------------------------------------------------------------------------

// Fixed credentials — register-or-login fallback keeps repeated runs below rate limit.
const E2E_SESSION_EMAIL = 'e2e-session@test.invalid';
const E2E_SESSION_SLUG  = 'e2e-session';
const E2E_STUDENT_EMAIL = 'e2e-session-student@test.invalid';

test('teacher signup and auth', async ({ page, context }) => {
  sharedSlug = E2E_SESSION_SLUG;
  sharedCookieHeader = await loginOrRegister(page, context, {
    email: E2E_SESSION_EMAIL,
    slug: sharedSlug,
  });

  await page.goto(`/teach/${sharedSlug}/session`);
  await expect(page.locator('#room-heading')).toBeVisible();
  await expect(page.locator('#lobby-empty')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Teacher room view (authenticated)
// ---------------------------------------------------------------------------

test('teacher sees empty lobby and room heading', async ({ browser }) => {
  if (!sharedSlug) test.skip();
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  try {
    await injectCookie(ctx, sharedCookieHeader);
    const page = await ctx.newPage();
    await page.goto(`/teach/${sharedSlug}/session`);
    await expect(page.locator('#room-heading')).toBeVisible();
    await expect(page.locator('#lobby-empty')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Student join → lobby waiting state
// ---------------------------------------------------------------------------

test('student join form enters lobby waiting state', async ({ page }) => {
  if (!sharedSlug) test.skip();
  await page.goto(`/teach/${sharedSlug}`);
  await expect(page.locator('#join')).toBeVisible();

  await page.fill('#join-form input[name="email"]', E2E_STUDENT_EMAIL);
  await page.click('#join-form button[type="submit"]');

  await expect(page.locator('#join')).toBeHidden();
  await expect(page.locator('#lobby-status')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Full session: teacher admits student → both sides get live streams
// ---------------------------------------------------------------------------

test('full session — remote audio/video streams established after admission', async ({ browser }) => {
  test.setTimeout(90_000);
  if (!sharedSlug) test.skip();
  const studentEmail = E2E_STUDENT_EMAIL;
  const ctxOpts = { permissions: ['camera', 'microphone'] };

  const teacherCtx = await browser.newContext(ctxOpts);
  const studentCtx = await browser.newContext(ctxOpts);

  try {
    await injectCookie(teacherCtx, sharedCookieHeader);
    const teacherPage = await teacherCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await teacherPage.goto(`/teach/${sharedSlug}/session`);
    await expect(teacherPage.locator('#room-heading')).toBeVisible();
    await dismissSelfCheck(teacherPage);

    await studentPage.goto(`/teach/${sharedSlug}`);
    await studentPage.fill('#join-form input[name="email"]', studentEmail);
    await studentPage.click('#join-form button[type="submit"]');
    await dismissSelfCheck(studentPage);
    await expect(studentPage.locator('#lobby-status')).toBeVisible();

    const admitBtn = teacherPage.locator('#lobby-list li button', { hasText: 'Admit' }).first();
    await expect(admitBtn).toBeVisible({ timeout: 15_000 });
    await admitBtn.click();

    await expect(teacherPage.locator('#session-root .sb-session-v2')).toBeVisible({ timeout: 30_000 });
    await expect(studentPage.locator('#session')).toBeVisible({ timeout: 30_000 });

    await teacherPage.waitForTimeout(8_000);

    const teacherVideoOk = await teacherPage.evaluate(() => {
      const vid = document.querySelector('.sb-remote-panel video');
      return !!(vid && vid.srcObject && vid.srcObject.getTracks().length > 0);
    });
    expect(teacherVideoOk, 'teacher remote video srcObject has tracks').toBe(true);

    const teacherAudioOk = await teacherPage.evaluate(() => {
      const aud = document.querySelector('.sb-remote-panel audio');
      return !!(aud && aud.srcObject && aud.srcObject.getTracks().length > 0);
    });
    expect(teacherAudioOk, 'teacher remote audio srcObject has tracks').toBe(true);

    const studentVideoOk = await studentPage.evaluate(() => {
      const vid = document.querySelector('.sb-remote-panel video');
      return !!(vid && vid.srcObject && vid.srcObject.getTracks().length > 0);
    });
    expect(studentVideoOk, 'student remote video srcObject has tracks').toBe(true);

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
  if (!sharedSlug) test.skip();
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  try {
    const page = await ctx.newPage();

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

    await page.goto(`/teach/${sharedSlug}`);
    await expect(page.locator('#join-form')).toBeVisible();
    await page.fill('#join-form input[name="email"]', E2E_STUDENT_EMAIL);
    await page.click('#join-form button[type="submit"]');
    await dismissSelfCheck(page);
    await expect(page.locator('#lobby-status')).toBeVisible();

    await page.waitForTimeout(800);
    await page.evaluate(() => { if (window.__lastWs) window.__lastWs.close(3000, 'test'); });

    await expect(page.locator('#error')).toContainText('Connection lost', { timeout: 8_000 });
  } finally {
    await ctx.close();
  }
});
