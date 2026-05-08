// File: tests/e2e/library.spec.ts
// Purpose: E2E smoke test for the authenticated teacher library page.
// Last updated: Sprint 28 (2026-05-08) -- stable known account; register-or-login fallback

import { test, expect } from '@playwright/test';
import { parse as parseCookieHeader } from 'set-cookie-parser'; // npm: set-cookie-parser

// Use a stable known account so repeated dev runs don't accumulate registrations
// and hit the signup rate limit. Falls back to login if already registered.
const E2E_LIB_EMAIL = 'e2e-lib@test.invalid';
const E2E_LIB_SLUG = 'e2e-lib-room';
const E2E_LIB_PASS = 'test-passphrase-12';

test('library page loads for authenticated teacher', async ({ page, context }) => {
  let rawCookie: string;

  // Login first — avoids signup rate limit on repeated dev runs.
  // Falls back to register only if the account doesn't exist yet.
  const login = await page.request.post('/auth/login', {
    data: { email: E2E_LIB_EMAIL, password: E2E_LIB_PASS },
  });
  if (login.ok()) {
    rawCookie = login.headers()['set-cookie'];
  } else {
    const reg = await page.request.post('/auth/register', {
      data: { email: E2E_LIB_EMAIL, slug: E2E_LIB_SLUG, password: E2E_LIB_PASS },
    });
    expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
    rawCookie = reg.headers()['set-cookie'];
  }

  // Playwright rejects `domain: 'localhost'` — use `url` instead.
  const [parsed] = parseCookieHeader(rawCookie, { decodeValues: false });
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    url: 'http://localhost:8080',
    httpOnly: parsed.httpOnly ?? false,
    secure: parsed.secure ?? false,
  }]);

  await page.goto(`/teach/${E2E_LIB_SLUG}/library`);
  await expect(page).toHaveTitle(/Library/);
});
