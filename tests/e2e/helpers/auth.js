// File: tests/e2e/helpers/auth.js
// Purpose: Auth helpers for E2E tests — signup, read magic link from dev mail
//          dir, consume token, return authenticated browser context.
// Last updated: Sprint 9 (2026-04-20) -- initial E2E test suite

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../../data/dev-mail');
const BASE_URL = 'http://localhost:8080';

/**
 * Return the path to the dev-mail JSONL file for a given email address.
 * DevMailer names files by SHA256(lowercase email) + .jsonl
 */
function mailFilePath(email) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  return path.join(DATA_DIR, `${hash}.jsonl`);
}

/**
 * Poll the dev-mail file for a magic_link entry newer than `since` (ms timestamp).
 * Returns the token string extracted from the URL fragment.
 */
async function waitForMagicLink(email, since, { retries = 20, intervalMs = 500 } = {}) {
  const filePath = mailFilePath(email);
  for (let i = 0; i < retries; i++) {
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines.reverse()) {
        const entry = JSON.parse(line);
        // issued_at is whole seconds; allow 2s tolerance for server clock truncation.
        if (entry.kind === 'magic_link' && entry.issued_at * 1000 >= since - 2000) {
          // URL fragment: #token=<JWT>
          const fragment = new URL(entry.url).hash;
          return fragment.replace('#token=', '');
        }
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Magic link for ${email} not found after ${retries * intervalMs}ms`);
}

/**
 * Sign up a teacher, follow the magic link, and return the page
 * (which will be on /teach/<slug> with a valid session cookie).
 */
async function signupAndAuth(page, { email, slug }) {
  const since = Date.now();

  // POST /signup
  const res = await page.request.post(`${BASE_URL}/signup`, {
    data: { email, slug },
  });
  if (!res.ok()) throw new Error(`POST /signup failed: ${res.status()}`);

  const token = await waitForMagicLink(email, since);

  // Navigate to /auth/verify (the page JS will extract the token from the fragment
  // and POST to /auth/consume, then redirect to /teach/<slug>).
  await page.goto(`${BASE_URL}/auth/verify#token=${token}`);
  await page.waitForURL(`**/teach/${slug}`, { timeout: 10_000 });
}

module.exports = { signupAndAuth, waitForMagicLink };
