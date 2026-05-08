// File: web/assets/home.js
// Purpose: Home page JS — student room-join form, room-not-found query param handling,
//          and last-used room persistence via localStorage.
// Last updated: Sprint 26 (2026-05-07) -- persist last room name in localStorage

var ROOM_KEY = 'sb-student-room';

(function () {
  var form = document.getElementById('student-join-form');
  var input = document.getElementById('room-input');

  // Pre-fill from last visit (unless overridden by room-not-found param below)
  if (input) {
    try {
      var saved = localStorage.getItem(ROOM_KEY);
      if (saved) input.value = saved;
    } catch (_) {}
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var errEl = document.getElementById('room-error');
      var room = input.value.trim().toLowerCase().replace(/\s+/g, '');
      if (!room) {
        errEl.textContent = 'Please enter a room name.';
        errEl.hidden = false;
        input.focus();
        return;
      }
      errEl.hidden = true;
      try { localStorage.setItem(ROOM_KEY, room); } catch (_) {}
      window.location.href = '/teach/' + encodeURIComponent(room);
    });
  }
}());

(function () {
  var params = new URLSearchParams(window.location.search);
  var notFound = params.get('room-not-found');
  if (notFound) {
    var input = document.getElementById('room-input');
    var errEl = document.getElementById('room-error');
    if (input) input.value = notFound;
    if (errEl) {
      errEl.textContent = '\u201c' + notFound + '\u201d was not found. Check the room name with your teacher.';
      errEl.hidden = false;
    }
    history.replaceState(null, '', '/');
    if (input) input.focus();
  }
})();
