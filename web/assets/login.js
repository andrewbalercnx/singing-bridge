// File: web/assets/login.js
// Purpose: Email + password login form handler for /auth/login.
// Role: Posts credentials to POST /auth/login; redirects on success;
//       shows lockout message on 429.
// Exports: (none — browser script, executes on load)
// Depends: DOM
// Invariants: all user-facing strings set via .textContent (no innerHTML).
// Last updated: Sprint 10 (2026-04-21) -- initial implementation

(function () {
  'use strict';
  var form = document.getElementById('f');
  var status = document.getElementById('status');

  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = form.email.value.trim();
    var password = form.password.value;
    status.textContent = 'Logging in…';
    status.className = '';

    fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    })
      .then(function (r) {
        if (r.ok) {
          return r.json().then(function (body) {
            window.location.href = body.redirect || '/';
          });
        }
        if (r.status === 429) {
          status.textContent = 'Too many attempts — please wait a few minutes before trying again.';
          status.className = 'sb-help--error';
          return;
        }
        return r.json().then(function (body) {
          status.textContent = body.message || 'Invalid email or password.';
          status.className = 'sb-help--error';
        });
      })
      .catch(function () {
        status.textContent = 'Network error — please try again.';
        status.className = 'sb-help--error';
      });
  });
}());
