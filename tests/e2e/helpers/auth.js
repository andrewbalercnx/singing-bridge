// File: tests/e2e/helpers/auth.js
// Purpose: Auth helpers for E2E tests — password registration + cookie injection.
// Last updated: Sprint 28 (2026-05-08) -- migrated from magic-link to password auth

'use strict';

const { parse: parseCookieHeader } = require('set-cookie-parser');

const BASE_URL = 'http://localhost:8080';

/**
 * For fixed/stable accounts: try login first (never hits the signup rate limit),
 * fall back to register only when the account doesn't exist yet.
 */
async function loginOrRegister(page, context, { email, slug, password = 'test-passphrase-12' } = {}) {
  const login = await page.request.post(`${BASE_URL}/auth/login`, {
    data: { email, password },
  });
  if (login.ok()) {
    const rawCookie = login.headers()['set-cookie'];
    await injectCookie(context, rawCookie);
    return rawCookie;
  }
  // 401 = account doesn't exist yet — register it.
  const reg = await page.request.post(`${BASE_URL}/auth/register`, {
    data: { email, slug, password },
  });
  if (!reg.ok()) throw new Error(`register failed: ${reg.status()} ${await reg.text()}`);
  const rawCookie = reg.headers()['set-cookie'];
  await injectCookie(context, rawCookie);
  return rawCookie;
}

/**
 * Inject a raw Set-Cookie header value into a Playwright browser context.
 * Uses `url` instead of `domain` — Playwright rejects `localhost` as a domain.
 */
async function injectCookie(context, rawCookie) {
  const [parsed] = parseCookieHeader(rawCookie, { decodeValues: false });
  await context.addCookies([{
    name: parsed.name,
    value: parsed.value,
    url: BASE_URL,
    httpOnly: parsed.httpOnly ?? false,
    secure: parsed.secure ?? false,
  }]);
}

module.exports = { loginOrRegister, injectCookie };
