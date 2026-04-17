// File: web/assets/verify.js
// Purpose: Read the magic-link token from the URL fragment, POST it to
//          /auth/consume, and redirect. Exists as an external script so the
//          CSP stays at script-src 'self' with no 'unsafe-inline' (§4.3).
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

'use strict';

(async function () {
  const hash = location.hash;
  const m = hash.match(/^#token=([^&]+)$/);
  const status = document.getElementById('status');
  if (!m) {
    if (status) status.textContent = 'Missing token.';
    return;
  }
  const token = decodeURIComponent(m[1]);
  try {
    const res = await fetch('/auth/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      if (status) status.textContent = 'Link is invalid or expired.';
      return;
    }
    const body = await res.json();
    history.replaceState(null, '', '/auth/verify');
    location.href = body.redirect;
  } catch (_) {
    if (status) status.textContent = 'Network error.';
  }
})();
