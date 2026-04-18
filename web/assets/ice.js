// File: web/assets/ice.js
// Purpose: TURN credential fetcher with early-refresh caching.
// Role: Fetches /turn-credentials once, caches with 10 s pre-expiry margin,
//       returns iceServers array ready for RTCPeerConnection config.
// Exports: window.sbIce.fetchIceServers (browser);
//          { cacheValid, createFetcher } (Node/UMD pure core).
// Depends: fetch (browser); injectable in tests via opts.fetch.
// Invariants: cache is refreshed when expiresAt <= nowMs + 10_000.
//             A failed fetch throws; caller decides whether to fall back.
//             Browser singleton _cache survives across calls within a page load.
//             createFetcher() returns an independent instance for unit tests.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    // Browser singleton — share one cache across the page lifetime.
    var _singleton = mod.createFetcher();
    window.sbIce = {
      fetchIceServers: function (opts) {
        return _singleton(opts || {});
      },
      cacheValid: mod.cacheValid,
    };
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cacheValid(cache, nowMs) {
    return cache !== null && cache.expiresAt > nowMs + 10000;
  }

  function createFetcher() {
    var _cache = null;

    return async function fetchIceServers(opts) {
      var now = (opts && opts.now) ? opts.now() : Date.now();
      if (cacheValid(_cache, now)) {
        return _cache.iceServers;
      }
      var fetcher = (opts && opts.fetch) ? opts.fetch
        : (typeof fetch !== 'undefined' ? fetch : null);
      if (!fetcher) throw new Error('fetch not available');
      var r = await fetcher('/turn-credentials', { cache: 'no-store' });
      if (!r.ok) {
        throw new Error('turn-credentials fetch failed: ' + r.status);
      }
      var body = await r.json();
      _cache = { iceServers: body.iceServers, expiresAt: now + body.ttl * 1000 };
      return body.iceServers;
    };
  }

  return { cacheValid: cacheValid, createFetcher: createFetcher };
}));
