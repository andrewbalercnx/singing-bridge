// File: web/assets/recording-gate.js
// Purpose: Student recording access gate — email verification + player reveal.
// Exports: (none — immediately invoked)
// Depends: fetch API
// Last updated: Sprint 6 (2026-04-18) -- initial implementation

'use strict';

(function () {
  var token = location.pathname.split('/').pop();

  var gateSection = document.getElementById('gate-section');
  var gateForm = document.getElementById('gate-form');
  var gateEmailEl = document.getElementById('gate-email');
  var gateErrorEl = document.getElementById('gate-error');
  var playerSection = document.getElementById('player-section');
  var playerMessage = document.getElementById('player-message');
  var playerEl = document.getElementById('recording-player');
  var disabledNotice = document.getElementById('disabled-notice');

  gateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = gateEmailEl.value.trim();
    gateErrorEl.hidden = true;

    fetch('/recording/' + token + '/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    }).then(function (r) {
      if (r.status === 200) return r.json();
      if (r.status === 403) {
        return r.json().then(function (data) {
          if (data && data.error === 'wrong_email') {
            gateErrorEl.hidden = false;
            gateErrorEl.textContent = 'Incorrect email address. Please try again.';
          } else {
            // disabled (too many attempts or other 403)
            gateSection.hidden = true;
            disabledNotice.hidden = false;
          }
          return null;
        });
      }
      if (r.status === 429) {
        gateErrorEl.hidden = false;
        gateErrorEl.textContent = 'Too many attempts. Please wait a few minutes and try again.';
        return null;
      }
      throw new Error('Unexpected response: ' + r.status);
    }).then(function (data) {
      if (!data) return;
      gateSection.hidden = true;
      playerSection.hidden = false;
      playerMessage.hidden = true;
      playerEl.src = data.url;
    }).catch(function (err) {
      gateErrorEl.hidden = false;
      gateErrorEl.textContent = 'Error: ' + err.message;
    });
  });
}());
