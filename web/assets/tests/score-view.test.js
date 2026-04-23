// File: web/assets/tests/score-view.test.js
// Purpose: Unit tests for score-view.js: pixel highlight positioning, page switching,
//          bar clamping, malformed coord filtering, and null/empty state handling.
// Last updated: Sprint 14 (2026-04-23) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// DOM stubs — installed before module load
// ---------------------------------------------------------------------------

var createdImgs = [];

function makeImgEl() {
  var listeners = {};
  var img = {
    tagName: 'IMG',
    className: '',
    alt: '',
    src: '',
    naturalWidth: 0,
    naturalHeight: 0,
    style: {},
    getBoundingClientRect: function () {
      return {
        left: 0, top: 0,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    },
    addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire: function (ev, arg) { (listeners[ev] || []).forEach(function (f) { f(arg || {}); }); },
  };
  return img;
}

function makeDivEl() {
  var _children = [];
  var _style = {};
  var el = {
    tagName: 'DIV',
    className: '',
    style: _style,
    appendChild: function (c) { _children.push(c); return c; },
    insertBefore: function (c, ref) {
      var idx = _children.indexOf(ref);
      if (idx === -1) _children.push(c);
      else _children.splice(idx, 0, c);
      return c;
    },
    removeChild: function (c) { _children = _children.filter(function (x) { return x !== c; }); return c; },
    contains: function (c) { return _children.indexOf(c) !== -1; },
    get firstChild() { return _children[0] || null; },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 0, height: 0 }; },
    _children: _children,
  };
  return el;
}

globalThis.document = {
  createElement: function (tag) {
    if (tag === 'img') {
      var img = makeImgEl();
      createdImgs.push(img);
      return img;
    }
    return makeDivEl();
  },
};

const sv = require('../score-view.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer() {
  return makeDivEl();
}

// After updatePages, access the img stubs created for this mount.
function simulateLoad(imgEl, naturalWidth, naturalHeight) {
  imgEl.naturalWidth = naturalWidth;
  imgEl.naturalHeight = naturalHeight;
  imgEl._fire('load');
}

// Traverse to highlight element: container > root > pageContainer > last child (highlight).
function getHighlight(container) {
  var root = container._children[0];
  var pc = root._children[0];
  return pc._children[pc._children.length - 1];
}

// Traverse to pageContainer: container > root > pageContainer.
function getPageContainer(container) {
  var root = container._children[0];
  return root._children[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('seekToBar: correct pixel positions for known coord on 1000×800 image', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  var coord = { bar: 3, page: 0, x_frac: 0.1, y_frac: 0.2, w_frac: 0.5, h_frac: 0.1 };
  handle.updatePages(['http://example.com/p1.png'], [coord]);

  // Simulate image load with natural dimensions 1000×800.
  var img = createdImgs[0];
  handle.seekToBar(3);

  // naturalWidth=0 at this point → deferred to load event.
  simulateLoad(img, 1000, 800);

  var hl = getHighlight(container);
  // imgRect = {left:0, top:0, w:1000, h:800}, containerRect = {left:0, top:0}
  // scaleX=1, scaleY=1 → left = x_frac*w, top = y_frac*h, etc.
  assert.strictEqual(hl.style.left, '100px',    'highlight left');
  assert.strictEqual(hl.style.top, '160px',     'highlight top');
  assert.strictEqual(hl.style.width, '500px',   'highlight width');
  assert.strictEqual(hl.style.height, '80px',   'highlight height');
  assert.strictEqual(hl.style.display, 'block', 'highlight visible');
});

test('seekToBar: bar on page 2 → second page img shown', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  var coords = [
    { bar: 1, page: 0, x_frac: 0.1, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 },
    { bar: 5, page: 1, x_frac: 0.1, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 },
  ];
  handle.updatePages(['http://example.com/p1.png', 'http://example.com/p2.png'], coords);

  var img2 = createdImgs[1];
  simulateLoad(img2, 1000, 800);

  // Seek to page 0 first, then to bar 5 on page 1.
  handle.seekToBar(5);

  var pc = getPageContainer(container);
  var pageImgs = pc._children.filter(function (c) { return c.tagName === 'IMG'; });
  assert.strictEqual(pageImgs[1].style.display, 'block', 'page 2 shown');
  assert.strictEqual(pageImgs[0].style.display, 'none',  'page 1 hidden');
});

test('seekToBar before first entry: clamps to first bar', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  var coords = [{ bar: 5, page: 0, x_frac: 0.1, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 }];
  handle.updatePages(['http://example.com/p1.png'], coords);

  var img = createdImgs[0];
  simulateLoad(img, 500, 500);

  // Seek to bar 1 which is before the first coord entry (bar 5).
  handle.seekToBar(1);
  var hl = getHighlight(container);
  assert.strictEqual(hl.style.display, 'block', 'highlight shown at first bar');
});

test('seekToBar after last entry: clamps to last bar', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  var coords = [
    { bar: 1, page: 0, x_frac: 0.1, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 },
    { bar: 3, page: 0, x_frac: 0.4, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 },
  ];
  handle.updatePages(['http://example.com/p1.png'], coords);

  var img = createdImgs[0];
  simulateLoad(img, 500, 500);

  handle.seekToBar(999);
  var hl = getHighlight(container);
  assert.strictEqual(hl.style.display, 'block', 'highlight shown at last bar');
});

test('seekToBar with no coord for exact bar: highlight hidden; no throw', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  // Provide barCoords=null so no matching coord exists.
  handle.updatePages(['http://example.com/p1.png'], null);

  assert.doesNotThrow(function () { handle.seekToBar(3); });
  var hl = getHighlight(container);
  assert.strictEqual(hl.style.display, 'none', 'highlight hidden when no bar coords');
});

test('malformed coord (x_frac=1.5) skipped; no crash', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  var coords = [
    { bar: 1, page: 0, x_frac: 1.5, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 }, // invalid
    { bar: 2, page: 0, x_frac: 0.1, y_frac: 0.1, w_frac: 0.2, h_frac: 0.1 }, // valid
  ];
  assert.doesNotThrow(function () {
    handle.updatePages(['http://example.com/p1.png'], coords);
  });

  var img = createdImgs[0];
  simulateLoad(img, 500, 500);

  // seekToBar(1) — bar 1 was skipped (invalid). Falls through to bar 2 (clamped).
  // After filter, barCoords only has bar 2. seekToBar(1) clamps to bar 2.
  assert.doesNotThrow(function () { handle.seekToBar(1); });
});

test('updatePages([], []): component hidden; seekToBar is no-op', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  handle.updatePages([], []);
  var root = container._children[0];
  assert.strictEqual(root.style.display, 'none', 'root hidden');
  assert.doesNotThrow(function () { handle.seekToBar(1); });
});

test('updatePages(null, null): component hidden; no crash', function () {
  createdImgs = [];
  var container = makeContainer();
  var handle = sv.mount(container);

  assert.doesNotThrow(function () {
    handle.updatePages(null, null);
  });
  var root = container._children[0];
  assert.strictEqual(root.style.display, 'none', 'root hidden');
});
