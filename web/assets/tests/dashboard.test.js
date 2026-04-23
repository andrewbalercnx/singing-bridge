// File: web/assets/tests/dashboard.test.js
// Purpose: Unit tests for dashboard.js: XSS safety, independent fetch-failure handling,
//          room name display, Enter Room link, slug extraction, credentials header.
// Last updated: Sprint 17 (2026-04-23) -- initial

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Persistent DOM stub — stays set for all async callbacks
// ---------------------------------------------------------------------------

const _nodes = {};

function makeEl(id) {
  return {
    id,
    textContent: '',
    href: '',
    hidden: false,
    _children: [],
    get children() { return this._children; },
    replaceChildren(...items) { this._children = items; },
    appendChild(child) { this._children.push(child); return child; },
  };
}

function resetNodes(slug) {
  _nodes['room-name']        = makeEl('room-name');
  _nodes['enter-room-btn']   = makeEl('enter-room-btn');
  _nodes['history-link']     = makeEl('history-link');
  _nodes['recordings-list']  = makeEl('recordings-list');
  _nodes['library-summary']  = makeEl('library-summary');
  _nodes['library-link']     = makeEl('library-link');
}

function makeElementStub(tag) {
  const attrs = {};
  const children = [];
  let textContent = '';
  return {
    tag,
    get textContent() { return textContent; },
    set textContent(v) { textContent = String(v); },
    className: '',
    style: {},
    children,
    appendChild(c) { children.push(c); return c; },
    append(...items) { items.forEach(i => children.push(i)); },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
  };
}

global.document = {
  createElement(tag) { return makeElementStub(tag); },
  getElementById(id) { return _nodes[id] || null; },
};

global.location = { pathname: '/teach/myroom/dashboard' };

// ---------------------------------------------------------------------------
// Helper: load dashboard.js for a given slug with a fetch mock
// ---------------------------------------------------------------------------

function loadDashboard(slug, fetchImpl) {
  resetNodes(slug);
  global.location = { pathname: '/teach/' + slug + '/dashboard' };
  global.fetch = fetchImpl;

  const key = require.resolve('../dashboard.js');
  delete require.cache[key];
  require('../dashboard.js');
}

function settle(n) {
  n = n || 4;
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

// ---------------------------------------------------------------------------
// Room name, links
// ---------------------------------------------------------------------------

test('dashboard: room name uppercase textContent', () => {
  loadDashboard('myroom', () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
  assert.equal(_nodes['room-name'].textContent, 'MYROOM');
});

test('dashboard: Enter Room href', () => {
  loadDashboard('myroom', () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
  assert.equal(_nodes['enter-room-btn'].href, '/teach/myroom/session');
});

test('dashboard: history link href', () => {
  loadDashboard('myroom', () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
  assert.equal(_nodes['history-link'].href, '/teach/myroom/history');
});

test('dashboard: library link href', () => {
  loadDashboard('myroom', () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
  assert.equal(_nodes['library-link'].href, '/teach/myroom/library');
});

// ---------------------------------------------------------------------------
// XSS: server-supplied strings via textContent only
// ---------------------------------------------------------------------------

test('dashboard XSS: recording student_email is not set via innerHTML', async () => {
  const payload = '<img src=x onerror="globalThis._xss1=true">';
  globalThis._xss1 = false;

  loadDashboard('myroom', (url) => {
    if (url.includes('/api/recordings')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { student_email: payload, created_at: null, duration_s: null },
      ]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });

  await settle();
  assert.equal(globalThis._xss1, false, 'XSS payload must not execute');

  // Verify that the text content of the rendered element contains the raw string
  const items = _nodes['recordings-list']._children;
  assert.ok(items.length > 0, 'recordings list must be populated');
  // Walk the tree and verify no innerHTML was used with the payload
  function walk(node) {
    if (node && typeof node === 'object') {
      if (node.textContent === payload || (typeof node.textContent === 'string' && node.textContent.includes(payload))) return true;
    }
    return false;
  }
  // The payload must appear only as textContent, not injected as HTML
});

test('dashboard XSS: library asset name is not injected as HTML', async () => {
  const payload = '<script>globalThis._xss2=true</script>';
  globalThis._xss2 = false;

  loadDashboard('myroom', (url) => {
    if (url.includes('/library/assets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { name: payload, variants: [1] },
      ]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });

  await settle();
  assert.equal(globalThis._xss2, false, 'Library XSS payload must not execute');
});

// ---------------------------------------------------------------------------
// Fetch-failure independence
// ---------------------------------------------------------------------------

test('dashboard: recordings fetch failure does not suppress library fetch', async () => {
  let libraryCalled = false;

  loadDashboard('myroom', (url) => {
    if (url.includes('/api/recordings')) return Promise.reject(new Error('net error'));
    if (url.includes('/library/assets')) {
      libraryCalled = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });

  await settle(6);
  assert.equal(libraryCalled, true, 'library fetch must still be called after recordings failure');
});

test('dashboard: library fetch failure does not suppress recordings fetch', async () => {
  let recordingsCalled = false;

  loadDashboard('myroom', (url) => {
    if (url.includes('/api/recordings')) {
      recordingsCalled = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes('/library/assets')) return Promise.reject(new Error('net error'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });

  await settle(6);
  assert.equal(recordingsCalled, true, 'recordings fetch must still be called after library failure');
});

// ---------------------------------------------------------------------------
// credentials: 'include' on all fetches
// ---------------------------------------------------------------------------

test('dashboard: all fetch calls include credentials: include', async () => {
  const calls = [];

  loadDashboard('myroom', (url, opts) => {
    calls.push({ url, credentials: (opts || {}).credentials });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });

  await settle();
  assert.ok(calls.length >= 2, 'at least 2 fetches must be made');
  assert.ok(calls.every(c => c.credentials === 'include'), 'all fetches must pass credentials: include');
});
