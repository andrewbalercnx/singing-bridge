// File: web/assets/score-view.js
// Purpose: Score page viewer with per-bar highlight overlay.
//          Displays rasterised score pages and moves a highlight rect to the current bar.
// Role: Renders page images from token URLs; binary searches barCoords on seekToBar().
// Exports: window.sbScoreView.mount(container) → { teardown, seekToBar(n), updatePages(urls, coords) }
// Depends: DOM (createElement, img)
// Invariants: barCoords entries with invalid fractional fields (outside [0,1] or w/h=0) are skipped.
//             seekToBar before/after range clamps to first/last entry.
//             Highlight hidden (display:none) when no valid coord for current bar.
//             Page switch only when coord.page differs from current page.
//             naturalWidth=0 (image not loaded): highlight deferred to load event.
// Last updated: Sprint 14 (2026-04-23) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbScoreView = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isValidCoord(c) {
    if (!c) return false;
    return (
      typeof c.x_frac === 'number' && c.x_frac >= 0 && c.x_frac <= 1 &&
      typeof c.y_frac === 'number' && c.y_frac >= 0 && c.y_frac <= 1 &&
      typeof c.w_frac === 'number' && c.w_frac > 0 && c.w_frac <= 1 &&
      typeof c.h_frac === 'number' && c.h_frac > 0 && c.h_frac <= 1
    );
  }

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  // Binary search: find coord for bar n (exact match or clamp).
  // barCoords must be sorted ascending by bar.
  function findCoord(barCoords, bar) {
    if (!barCoords || barCoords.length === 0) return null;
    if (bar <= barCoords[0].bar) return barCoords[0];
    if (bar >= barCoords[barCoords.length - 1].bar) return barCoords[barCoords.length - 1];
    var lo = 0, hi = barCoords.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (barCoords[mid].bar === bar) return barCoords[mid];
      if (barCoords[mid].bar < bar) lo = mid + 1;
      else hi = mid - 1;
    }
    // Clamp to nearest lower.
    return barCoords[Math.max(0, hi)];
  }

  function mount(container) {
    var root = el('div', 'sb-score-view');
    root.style.display = 'none';
    container.appendChild(root);

    var pageContainer = el('div', 'sb-score-pages');
    root.appendChild(pageContainer);

    var highlight = el('div', 'sb-score-highlight');
    highlight.style.position = 'absolute';
    highlight.style.display = 'none';
    highlight.style.pointerEvents = 'none';
    // pageContainer is position:relative; highlight overlays within it.
    pageContainer.style.position = 'relative';
    pageContainer.appendChild(highlight);

    var pageImgs = [];
    var barCoords = null;
    var currentPage = -1;
    var pendingBar = null; // for deferred seek when image not loaded

    function applyHighlight(img, coord) {
      if (!img || !coord || !isValidCoord(coord)) {
        highlight.style.display = 'none';
        return;
      }
      if (img.naturalWidth === 0) {
        // Image not loaded yet — defer until load event fires.
        pendingBar = coord;
        return;
      }
      var x = coord.x_frac * img.naturalWidth;
      var y = coord.y_frac * img.naturalHeight;
      var w = coord.w_frac * img.naturalWidth;
      var h = coord.h_frac * img.naturalHeight;
      // Position relative to pageContainer.
      var imgRect = img.getBoundingClientRect();
      var containerRect = pageContainer.getBoundingClientRect();
      var scaleX = imgRect.width / img.naturalWidth;
      var scaleY = imgRect.height / img.naturalHeight;
      highlight.style.left = (imgRect.left - containerRect.left + x * scaleX) + 'px';
      highlight.style.top = (imgRect.top - containerRect.top + y * scaleY) + 'px';
      highlight.style.width = (w * scaleX) + 'px';
      highlight.style.height = (h * scaleY) + 'px';
      highlight.style.display = 'block';
    }

    function showPage(pageIndex) {
      if (pageIndex === currentPage) return;
      currentPage = pageIndex;
      for (var i = 0; i < pageImgs.length; i++) {
        pageImgs[i].style.display = i === pageIndex ? 'block' : 'none';
      }
    }

    function seekToBar(bar) {
      if (!barCoords || barCoords.length === 0) {
        highlight.style.display = 'none';
        return;
      }
      var coord = findCoord(barCoords, bar);
      if (!coord || !isValidCoord(coord)) {
        highlight.style.display = 'none';
        return;
      }
      showPage(coord.page);
      var img = pageImgs[coord.page];
      if (!img) {
        highlight.style.display = 'none';
        return;
      }
      applyHighlight(img, coord);
    }

    function updatePages(pageUrls, newBarCoords) {
      // Clear existing pages.
      while (pageContainer.firstChild && pageContainer.firstChild !== highlight) {
        pageContainer.removeChild(pageContainer.firstChild);
      }
      pageImgs = [];
      currentPage = -1;
      highlight.style.display = 'none';
      pendingBar = null;

      if (!pageUrls || pageUrls.length === 0) {
        root.style.display = 'none';
        barCoords = null;
        return;
      }

      // Filter out invalid bar coords.
      if (newBarCoords && newBarCoords.length > 0) {
        barCoords = newBarCoords.filter(function (c) {
          if (!isValidCoord(c)) {
            console.warn('[score-view] skipping malformed coord', c);
            return false;
          }
          return true;
        });
      } else {
        barCoords = null;
      }

      root.style.display = 'block';

      pageUrls.forEach(function (url, i) {
        var img = el('img', 'sb-score-page');
        img.src = url;
        img.alt = 'Score page ' + (i + 1);
        img.style.display = i === 0 ? 'block' : 'none';
        img.addEventListener('load', function () {
          if (pendingBar !== null) {
            applyHighlight(img, pendingBar);
            pendingBar = null;
          }
        });
        pageContainer.insertBefore(img, highlight);
        pageImgs.push(img);
      });

      currentPage = 0;
    }

    function teardown() {
      pageImgs = [];
      barCoords = null;
      if (container.contains(root)) {
        container.removeChild(root);
      }
    }

    return {
      teardown: teardown,
      seekToBar: seekToBar,
      updatePages: updatePages,
    };
  }

  return { mount: mount };
});
