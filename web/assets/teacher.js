// File: web/assets/teacher.js
// Purpose: Teacher UI wiring. Student-supplied strings rendered via
//          textContent only (R4 recommendation — no innerHTML to prevent XSS).
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

'use strict';

(function () {
  const slug = location.pathname.replace(/^\/teach\//, '');
  document.getElementById('room-heading').textContent = `Your room: ${slug}`;

  const listEl = document.getElementById('lobby-list');
  const emptyEl = document.getElementById('lobby-empty');
  const statusEl = document.getElementById('session-status');
  const hangupBtn = document.getElementById('hangup');

  window.signallingClient.connectTeacher({
    slug,
    onLobbyUpdate(entries) {
      listEl.replaceChildren();
      emptyEl.hidden = entries.length > 0;
      for (const entry of entries) {
        const li = document.createElement('li');
        const meta = document.createElement('span');
        meta.textContent = `${entry.email} · ${entry.browser} · ${entry.device_class}`;
        const admit = document.createElement('button');
        admit.type = 'button';
        admit.textContent = 'Admit';
        admit.addEventListener('click', () => handle.admit(entry.id));
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.textContent = 'Reject';
        reject.addEventListener('click', () => handle.reject(entry.id));
        li.append(meta, admit, reject);
        listEl.append(li);
      }
    },
    onPeerConnected({ dataChannel }) {
      statusEl.textContent = 'Connected.';
      hangupBtn.hidden = false;
      dataChannel.addEventListener('message', (e) => {
        statusEl.textContent = `Student says: ${e.data}`;
      });
      dataChannel.send(JSON.stringify({ hello: true, from: 'teacher' }));
    },
    onPeerDisconnected() {
      statusEl.textContent = 'Student disconnected.';
      hangupBtn.hidden = true;
    },
  }).then((h) => {
    window._handle = h;
    hangupBtn.addEventListener('click', () => h.hangup());
    const handle = h;
    // Bind for the closures above.
    window.__admit = handle.admit;
    window.__reject = handle.reject;
  });

  // Provide `handle.admit` / `handle.reject` to the list items via a proxy.
  const handle = {
    admit(id) { if (window._handle) window._handle.admit(id); },
    reject(id) { if (window._handle) window._handle.reject(id); },
  };
  window._teacherHandle = handle;
})();
