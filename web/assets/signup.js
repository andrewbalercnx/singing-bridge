// File: web/assets/signup.js
// Purpose: Submit the register form via fetch to POST /auth/register.
//          Validates password match client-side; posts email+slug+password.
// Role: Browser-side form handler for /signup (teacher registration).
// Exports: (none — browser script, executes on load)
// Depends: DOM
// Invariants: all user-facing strings set via .textContent (no innerHTML).
// Last updated: Sprint 10 (2026-04-21) -- password + confirm fields; endpoint /auth/register

'use strict';

(function () {
  var form = document.getElementById('f');
  var status = document.getElementById('status');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = form.email.value.trim();
    var slug = form.slug.value.trim();
    var password = form.password.value;
    var confirm = form.confirm.value;

    if (password !== confirm) {
      status.textContent = 'Passwords do not match.';
      return;
    }

    status.textContent = 'Creating account…';

    fetch('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, slug: slug, password: password }),
    })
      .then(function (res) {
        if (res.ok) {
          return res.json().then(function (body) {
            window.location.href = body.redirect || '/';
          });
        }
        if (res.status === 409) {
          return res.json().then(function (j) {
            if (j.code === 'slug_taken') {
              status.textContent = (j.message || 'Slug taken') + '. Try: ' + (j.suggestions || []).join(', ');
            } else {
              status.textContent = j.message || 'That email is already registered.';
            }
          });
        }
        if (res.status === 429) {
          status.textContent = 'Too many attempts. Try again later.';
          return;
        }
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (j.code === 'password_too_short') {
            status.textContent = 'Password must be at least 12 characters.';
          } else if (j.code === 'password_too_long') {
            status.textContent = 'Password must be 128 characters or fewer.';
          } else {
            status.textContent = j.message || 'Registration failed.';
          }
        });
      })
      .catch(function () {
        status.textContent = 'Network error — please try again.';
      });
  });
}());
