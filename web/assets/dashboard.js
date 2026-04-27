// File: web/assets/dashboard.js
// Purpose: Teacher dashboard — fetch and render recordings and library summary;
//          wire room-name display and "Enter Room" button.
// Role: Standalone IIFE; no session-ui.js or WebRTC dependencies.
// Exports: (none — side-effects only)
// Depends: DOM (fetch, textContent), /api/recordings, /teach/:slug/library/assets
// Invariants: all server-supplied strings rendered via .textContent only (no innerHTML);
//             recording and library fetches are independent — one failure does not suppress the other.
// Last updated: Sprint 17 (2026-04-23) -- initial

(function () {
  'use strict';

  // Extract slug: /teach/<slug>/dashboard → ['', 'teach', '<slug>', 'dashboard']
  var slug = location.pathname.split('/')[2] || '';

  // Room name in nav
  var roomNameEl = document.getElementById('room-name');
  if (roomNameEl) roomNameEl.textContent = slug ? slug.toUpperCase() : '';

  // "Enter Room" → session page
  var enterBtn = document.getElementById('enter-room-btn');
  if (enterBtn) enterBtn.href = '/teach/' + slug + '/session';

  // History link
  var historyLink = document.getElementById('history-link');
  if (historyLink) historyLink.href = '/teach/' + slug + '/history';

  // ---- Recordings panel ----

  var recordingsList = document.getElementById('recordings-list');

  function renderRecordings(items) {
    if (!recordingsList) return;
    recordingsList.replaceChildren();
    if (!items || items.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'sb-dashboard-loading';
      empty.textContent = 'No recordings yet.';
      recordingsList.appendChild(empty);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'sb-list';
    items.slice(0, 8).forEach(function (rec) {
      var li = document.createElement('li');
      li.className = 'sb-list__item';
      var title = document.createElement('span');
      title.className = 'sb-list__title';
      title.textContent = rec.student_email || 'Unknown student';
      var meta = document.createElement('span');
      meta.className = 'sb-list__meta';
      var date = rec.created_at ? new Date(rec.created_at).toLocaleDateString() : '';
      var dur = rec.duration_s ? Math.round(rec.duration_s) + 's' : '';
      meta.textContent = [date, dur].filter(Boolean).join(' · ');
      var spacer = document.createElement('span');
      spacer.className = 'sb-list__spacer';
      li.append(title, meta, spacer);
      ul.appendChild(li);
    });
    if (items.length > 8) {
      var more = document.createElement('p');
      more.className = 'sb-dashboard-loading';
      more.textContent = '+' + (items.length - 8) + ' more — view all in Recordings.';
      recordingsList.append(ul, more);
    } else {
      recordingsList.appendChild(ul);
    }
  }

  function renderRecordingsError() {
    if (!recordingsList) return;
    var p = document.createElement('p');
    p.className = 'sb-dashboard-loading';
    p.textContent = 'Could not load recordings.';
    recordingsList.replaceChildren(p);
  }

  fetch('/api/recordings', { credentials: 'include' })
    .then(function (r) {
      if (!r.ok) throw new Error('recordings ' + r.status);
      return r.json();
    })
    .then(renderRecordings)
    .catch(renderRecordingsError);

  // ---- Library panel ----

  var librarySummary = document.getElementById('library-summary');
  var libraryLink = document.getElementById('library-link');
  if (libraryLink) libraryLink.href = '/teach/' + slug + '/library';

  function renderLibrary(items) {
    if (!librarySummary) return;
    librarySummary.replaceChildren();
    if (!items || items.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'sb-dashboard-loading';
      empty.textContent = 'No tracks in library yet.';
      librarySummary.appendChild(empty);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'sb-list';
    items.slice(0, 5).forEach(function (asset) {
      var li = document.createElement('li');
      li.className = 'sb-list__item';
      var title = document.createElement('span');
      title.className = 'sb-list__title';
      title.textContent = asset.title || 'Untitled';
      var meta = document.createElement('span');
      meta.className = 'sb-list__meta';
      var varCount = typeof asset.variant_count === 'number' ? asset.variant_count : 0;
      meta.textContent = varCount === 1 ? '1 variant' : varCount + ' variants';
      var spacer = document.createElement('span');
      spacer.className = 'sb-list__spacer';
      li.append(title, meta, spacer);
      ul.appendChild(li);
    });
    if (items.length > 5) {
      var more = document.createElement('p');
      more.className = 'sb-dashboard-loading';
      more.textContent = '+' + (items.length - 5) + ' more — manage in library.';
      librarySummary.append(ul, more);
    } else {
      librarySummary.appendChild(ul);
    }
  }

  function renderLibraryError() {
    if (!librarySummary) return;
    var p = document.createElement('p');
    p.className = 'sb-dashboard-loading';
    p.textContent = 'Could not load library.';
    librarySummary.replaceChildren(p);
  }

  if (slug) {
    fetch('/teach/' + slug + '/library/assets', { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('library ' + r.status);
        return r.json();
      })
      .then(renderLibrary)
      .catch(renderLibraryError);
  }
}());
