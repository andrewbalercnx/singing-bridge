// File: web/assets/signup.js
// Purpose: Submit the signup form via fetch so the CSP form-action 'self'
//          stays enforceable and errors render inline without a full nav.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

'use strict';

(function () {
  const form = document.getElementById('f');
  const status = document.getElementById('status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { email: fd.get('email'), slug: fd.get('slug') };
    const res = await fetch('/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      status.textContent = 'Check your email.';
      form.hidden = true;
    } else if (res.status === 409) {
      const j = await res.json();
      status.textContent = `${j.message}. Try: ${(j.suggestions || []).join(', ')}`;
    } else if (res.status === 429) {
      status.textContent = 'Too many attempts. Try again later.';
    } else {
      const j = await res.json().catch(() => ({}));
      status.textContent = j.message || 'Signup failed.';
    }
  });
})();
