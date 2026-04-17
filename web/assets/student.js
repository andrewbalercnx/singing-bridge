// File: web/assets/student.js
// Purpose: Student join form + lobby/session UI driver.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  const form = document.getElementById('join-form');
  const lobbyStatus = document.getElementById('lobby-status');
  const sessionStatus = document.getElementById('session-status');
  const errEl = document.getElementById('error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(form).get('email');
    form.hidden = true;
    lobbyStatus.hidden = false;

    const handle = await window.signallingClient.connectStudent({
      slug,
      email,
      onAdmitted() {
        lobbyStatus.hidden = true;
      },
      onRejected(reason) {
        lobbyStatus.hidden = true;
        errEl.textContent = `Rejected: ${reason}`;
      },
      onPeerConnected({ dataChannel }) {
        sessionStatus.hidden = false;
        dataChannel.addEventListener('message', (ev) => {
          sessionStatus.textContent = `Teacher says: ${ev.data}`;
        });
        dataChannel.send(JSON.stringify({ hello: true, from: 'student' }));
      },
      onPeerDisconnected() {
        sessionStatus.textContent = 'Teacher disconnected.';
      },
    });
    window.addEventListener('beforeunload', () => handle.hangup());
  });
})();
