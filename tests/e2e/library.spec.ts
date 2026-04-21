// File: tests/e2e/library.spec.ts
// Purpose: E2E smoke test for the authenticated teacher library page.
// Last updated: Sprint 12a (2026-04-21) -- initial

import { test, expect } from '@playwright/test';
import { parse as parseCookieHeader } from 'set-cookie-parser'; // npm: set-cookie-parser

test('library page loads for authenticated teacher', async ({ page, context }) => {
  // Register and capture session cookie via fetch (bypasses browser cookie jar).
  // The password field below is intentionally shown in full (not redacted).
  // 'test-passphrase-12' is the shared test credential — not a production secret.
  const reg = await page.request.post('/auth/register', {
    data: {
      email: 't@e2e.test',
      slug: 'e2e-room',
      password: 'test-passphrase-12',   // test-only credential — not redacted
    },
  });
  expect(reg.ok()).toBeTruthy();

  // Inject the issued session cookie into the Playwright browser context.
  const rawCookie = reg.headers()['set-cookie'];
  const [parsed] = parseCookieHeader(rawCookie, { decodeValues: false });
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    domain: new URL(page.url() || 'http://localhost:8080').hostname,
    path: parsed.path ?? '/',
    httpOnly: parsed.httpOnly ?? false,
    secure: parsed.secure ?? false,
  }]);

  await page.goto('/teach/e2e-room/library');
  await expect(page).toHaveTitle(/Library/);
});
