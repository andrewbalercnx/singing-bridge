// File: web/assets/browser.js
// Purpose: Pure browser/device/tier detection. Given a UA string and
//          a feature-probe object, classifies the client into one of
//          supported / degraded / unworkable and reports human-readable
//          reasons. Used by the student landing page to gate the join
//          flow and by the signalling module to surface tier to the
//          teacher via lobby_join.
// Role: The only UA-sniffing + feature-gating site in the client.
// Exports: detectBrowser, BROWSER_FLOORS, BROWSER_UA_FIXTURES
// Depends: none
// Invariants: no DOM access; no network; pure function of (ua, features).
// Exports: detectBrowser, BROWSER_FLOORS, BROWSER_UA_FIXTURES
//          detectBrowser return shape adds: iosAecForced (bool — true on all iOS browsers)
// Last updated: Sprint 20 (2026-04-25) -- iOS reclassified supported; iosAecForced flag

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.sbBrowser = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Version floors anchored to a conservative 2026-Q1 baseline
  // (last 2 majors for Chrome/Firefox/Safari-desktop). Changing a
  // floor must update the boundary tests in browser.test.js.
  var BROWSER_FLOORS = Object.freeze({
    chrome: 112,
    firefox: 115,
    safariDesktop: 16,
  });

  // In-app WebView markers. First match wins.
  var INAPP_MARKERS = [
    'FBAN', 'FBAV',       // Facebook
    'Instagram',
    'TikTok', 'musical_ly', // TikTok (older UAs)
    'Line/',
    '; wv)',              // Android WebView
  ];

  function isInAppWebView(ua) {
    for (var i = 0; i < INAPP_MARKERS.length; i++) {
      if (ua.indexOf(INAPP_MARKERS[i]) !== -1) return true;
    }
    return false;
  }

  // iPad on iOS 13+ reports as Mac Safari unless we detect touch;
  // the UA still contains "iPad" on most variants, and iPadOS Safari
  // sometimes masquerades as desktop. Conservative: treat anything
  // with iPhone/iPad/iPod OR "CriOS"/"FxiOS" as iOS.
  function isIOS(ua) {
    return /iPhone|iPad|iPod/.test(ua) ||
           /CriOS|FxiOS/.test(ua);
  }

  function detectDevice(ua) {
    if (/iPad/.test(ua) ||
        (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
    if (/iPhone|iPod/.test(ua) ||
        /Android.*Mobile/.test(ua) ||
        /CriOS|FxiOS/.test(ua)) return 'phone';
    return 'desktop';
  }

  // Extract {name, version} from a UA. Order matters — Edg and CriOS
  // must be tested before Chrome/Safari because their UAs also
  // contain those tokens.
  function detectNameVersion(ua) {
    var m;
    if ((m = /Edg\/(\d+)/.exec(ua))) return { name: 'Edge', version: parseInt(m[1], 10) };
    if ((m = /CriOS\/(\d+)/.exec(ua))) return { name: 'Chrome', version: parseInt(m[1], 10) };
    if ((m = /FxiOS\/(\d+)/.exec(ua))) return { name: 'Firefox', version: parseInt(m[1], 10) };
    if ((m = /Firefox\/(\d+)/.exec(ua))) return { name: 'Firefox', version: parseInt(m[1], 10) };
    if ((m = /Chrome\/(\d+)/.exec(ua))) return { name: 'Chrome', version: parseInt(m[1], 10) };
    if ((m = /Version\/(\d+).*Safari/.exec(ua))) return { name: 'Safari', version: parseInt(m[1], 10) };
    return { name: 'unknown', version: null };
  }

  function detectBrowser(userAgent, features) {
    var ua = typeof userAgent === 'string' ? userAgent : '';
    var feat = features || {};
    var inapp = isInAppWebView(ua);
    var ios = isIOS(ua);
    var device = detectDevice(ua);
    var nv = detectNameVersion(ua);
    var reasons = [];
    var tier = 'supported';

    // Tier decision tree — see §4.2 of PLAN_Sprint3.md.
    if (inapp) {
      tier = 'unworkable';
      reasons.push('In-app browsers cannot run the lesson tool. Open the link in Chrome, Firefox, Safari, or Edge.');
    } else if (feat.hasRTCPeerConnection === false || feat.hasGetUserMedia === false) {
      tier = 'unworkable';
      reasons.push('This browser is missing WebRTC support required for the lesson tool.');
    } else if (nv.name === 'Firefox' && device === 'phone') {
      tier = 'degraded';
      reasons.push('Android Firefox audio processing differs from the desktop version.');
    } else if (nv.name === 'Chrome' && nv.version !== null && nv.version < BROWSER_FLOORS.chrome) {
      tier = 'degraded';
      reasons.push('This Chrome version is older than the supported baseline; please update.');
    } else if (nv.name === 'Firefox' && nv.version !== null && nv.version < BROWSER_FLOORS.firefox) {
      tier = 'degraded';
      reasons.push('This Firefox version is older than the supported baseline; please update.');
    } else if (nv.name === 'Safari' && device === 'desktop' && nv.version !== null && nv.version < BROWSER_FLOORS.safariDesktop) {
      tier = 'degraded';
      reasons.push('This Safari version is older than the supported baseline; please update.');
    } else if (nv.name === 'unknown') {
      tier = 'degraded';
      reasons.push('This browser is not recognised; the lesson tool will run on a best-effort basis.');
    }

    return {
      name: nv.name,
      version: nv.version,
      tier: tier,
      reasons: reasons,
      device: device,
      isIOS: ios,
      isInAppWebView: inapp,
      iosAecForced: ios,
    };
  }

  // Frozen UA fixtures for test reuse. Kept beside the module so the
  // test file can require() them without duplicating string constants.
  var BROWSER_UA_FIXTURES = Object.freeze({
    chrome_desktop_current:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    chrome_android_current:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    chrome_ios: // CriOS — iOS forces voice processing on all browsers; degraded
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1',
    firefox_desktop_current:
      'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
    firefox_android:
      'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
    safari_desktop_17:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    safari_ios_17:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    edge_desktop_current:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    facebook_inapp:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/444.0.0.28.113]',
    instagram_inapp:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.0 (iPhone; iOS 17_0)',
    tiktok_inapp:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_30.0.0 JsSdk/2.0',
    chrome_desktop_old_110: // below floor (112) → degraded
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    android_webview:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36',
    android_tablet:
      'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    empty: '',
  });

  return {
    detectBrowser: detectBrowser,
    BROWSER_FLOORS: BROWSER_FLOORS,
    BROWSER_UA_FIXTURES: BROWSER_UA_FIXTURES,
  };
});
