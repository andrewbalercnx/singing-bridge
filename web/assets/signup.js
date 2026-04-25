// File: web/assets/signup.js
// Purpose: Submit the register form via fetch to POST /auth/register.
//          Validates password match client-side; posts email+slug+password.
//          Auto-suggests slug from email local-part; inline slug validation.
// Role: Browser-side form handler for /signup (teacher registration).
// Exports: (none — browser script, executes on load)
// Depends: DOM
// Invariants: all user-facing strings set via .textContent (no innerHTML).
// Last updated: Sprint 20 (2026-04-25) -- email→slug suggestion; inline slug validation

'use strict';

(function () {
  var form = document.getElementById('f');
  var status = document.getElementById('status');
  if (!form) return;

  var slugHint = document.getElementById('slug-hint');
  var SLUG_RE = /^[a-z][a-z0-9\-]{1,30}[a-z0-9]$/;

  function validateSlug(val) {
    if (!slugHint) return;
    if (val.length === 0) {
      slugHint.textContent = 'Appears in your lesson URL, e.g. /teach/your-name';
      slugHint.className = 'sb-help';
      return;
    }
    if (SLUG_RE.test(val)) {
      slugHint.textContent = '\u2713 Your lesson URL: singing.rcnx.io/teach/' + val;
      slugHint.className = 'sb-help sb-help--ok';
    } else {
      slugHint.textContent = val !== val.toLowerCase()
        ? 'Slug must be lowercase — try: ' + val.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/^-+|-+$/g, '')
        : 'Lowercase letters, numbers, and hyphens only; 3\u201332 chars; start and end with a letter or number.';
      slugHint.className = 'sb-help sb-help--error';
    }
  }

  // Auto-suggest slug from email local-part while slug field is still empty.
  form.email.addEventListener('input', function () {
    if (form.slug.value.length > 0) return;
    var local = (form.email.value.split('@')[0] || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    if (local.length >= 3 && /^[a-z]/.test(local) && /[a-z0-9]$/.test(local)) {
      form.slug.value = local;
      validateSlug(local);
    }
  });

  // Inline validation on every keystroke.
  form.slug.addEventListener('input', function () {
    validateSlug(form.slug.value);
  });

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
