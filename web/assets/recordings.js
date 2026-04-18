// File: web/assets/recordings.js
// Purpose: Teacher recording library page — load, sort, send link, delete.
// Exports: (none — immediately invoked)
// Depends: fetch API
// Last updated: Sprint 6 (2026-04-18) -- initial implementation

'use strict';

(function () {
  var slug = location.pathname.replace(/^\/teach\//, '').replace(/\/recordings$/, '');
  document.getElementById('back-link').href = '/teach/' + slug;

  var listEl = document.getElementById('recordings-list');
  var emptyEl = document.getElementById('recordings-empty');
  var errorEl = document.getElementById('recordings-error');
  var modal = document.getElementById('send-modal');
  var sendForm = document.getElementById('send-form');
  var sendEmailEl = document.getElementById('send-email');
  var sendErrorEl = document.getElementById('send-error');
  var sendCancelBtn = document.getElementById('send-cancel');

  var currentSort = 'date';
  var pendingSendId = null;

  document.getElementById('sort-date').addEventListener('click', function () {
    setSort('date');
  });
  document.getElementById('sort-student').addEventListener('click', function () {
    setSort('student');
  });

  function setSort(sort) {
    currentSort = sort;
    document.getElementById('sort-date').setAttribute('aria-pressed', sort === 'date' ? 'true' : 'false');
    document.getElementById('sort-date').className = sort === 'date' ? 'sort-active' : '';
    document.getElementById('sort-student').setAttribute('aria-pressed', sort === 'student' ? 'true' : 'false');
    document.getElementById('sort-student').className = sort === 'student' ? 'sort-active' : '';
    loadRecordings();
  }

  function loadRecordings() {
    fetch('/api/recordings?sort=' + currentSort)
      .then(function (r) { return r.json(); })
      .then(function (recordings) {
        listEl.replaceChildren();
        emptyEl.hidden = recordings.length > 0;
        recordings.forEach(function (rec) {
          listEl.appendChild(renderRow(rec));
        });
      })
      .catch(function (err) {
        errorEl.hidden = false;
        errorEl.textContent = 'Failed to load recordings: ' + err.message;
      });
  }

  function renderRow(rec) {
    var li = document.createElement('li');
    li.className = 'recording-row';

    var date = new Date(rec.created_at * 1000).toLocaleDateString();
    var duration = rec.duration_s != null ? formatDuration(rec.duration_s) : '—';

    var info = document.createElement('span');
    info.className = 'recording-info';
    info.textContent = date + ' · ' + rec.student_email + ' · ' + duration;

    var statusBadge = document.createElement('span');
    statusBadge.className = 'recording-status ' + rec.status;
    statusBadge.textContent = rec.status === 'link_disabled' ? 'link disabled' : '';

    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = rec.status === 'link_disabled' ? 'Re-send link' : 'Send link';
    sendBtn.addEventListener('click', function () {
      openSendModal(rec.id, rec.student_email);
    });

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'delete-btn';
    deleteBtn.addEventListener('click', function () {
      if (confirm('Delete this recording? It will be removed after 24 hours.')) {
        doDelete(rec.id, li);
      }
    });

    li.append(info, ' ', statusBadge, ' ', sendBtn, ' ', deleteBtn);
    return li;
  }

  function openSendModal(id, defaultEmail) {
    pendingSendId = id;
    sendEmailEl.value = defaultEmail;
    sendErrorEl.hidden = true;
    modal.showModal();
  }

  sendCancelBtn.addEventListener('click', function () {
    modal.close();
    pendingSendId = null;
  });

  sendForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pendingSendId == null) return;
    var email = sendEmailEl.value.trim();
    sendErrorEl.hidden = true;
    fetch('/api/recordings/' + pendingSendId + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override_email: email }),
    }).then(function (r) {
      if (!r.ok) throw new Error('send failed: ' + r.status);
      modal.close();
      pendingSendId = null;
      loadRecordings();
    }).catch(function (err) {
      sendErrorEl.hidden = false;
      sendErrorEl.textContent = err.message;
    });
  });

  function doDelete(id, li) {
    fetch('/api/recordings/' + id, { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) throw new Error('delete failed: ' + r.status);
        li.remove();
        if (listEl.children.length === 0) emptyEl.hidden = false;
      })
      .catch(function (err) {
        errorEl.hidden = false;
        errorEl.textContent = 'Delete failed: ' + err.message;
      });
  }

  function formatDuration(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  loadRecordings();
}());
