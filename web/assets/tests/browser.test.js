// File: web/assets/tests/browser.test.js
// Purpose: Node-run property + boundary + failure tests for the
//          browser/device/tier detector. Runs under `node --test`
//          in CI.
// Last updated: Sprint 3 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBrowser, BROWSER_FLOORS, BROWSER_UA_FIXTURES } =
  require('../browser.js');

const FEATURES_OK = { hasRTCPeerConnection: true, hasGetUserMedia: true };
const FEATURES_MISSING_RTC = { hasRTCPeerConnection: false, hasGetUserMedia: true };

const TIERS = new Set(['supported', 'degraded', 'unworkable']);

// --- Property tests ---------------------------------------------------------

test('tier is always one of supported/degraded/unworkable for every fixture', () => {
  for (const [name, ua] of Object.entries(BROWSER_UA_FIXTURES)) {
    const r = detectBrowser(ua, FEATURES_OK);
    assert.ok(TIERS.has(r.tier), `fixture ${name} -> ${r.tier}`);
  }
});

test('in-app WebView UAs all map to unworkable', () => {
  for (const key of ['facebook_inapp', 'instagram_inapp', 'tiktok_inapp']) {
    const r = detectBrowser(BROWSER_UA_FIXTURES[key], FEATURES_OK);
    assert.equal(r.tier, 'unworkable', `${key} should be unworkable`);
    assert.equal(r.isInAppWebView, true);
    assert.ok(r.reasons.length > 0, `${key} needs a reason`);
  }
});

test('iOS UAs always map to degraded regardless of Safari version', () => {
  const r1 = detectBrowser(BROWSER_UA_FIXTURES.safari_ios_17, FEATURES_OK);
  assert.equal(r1.tier, 'degraded');
  assert.equal(r1.isIOS, true);
  const r2 = detectBrowser(BROWSER_UA_FIXTURES.chrome_ios, FEATURES_OK);
  // CriOS on iPhone must degrade via iOS branch, not the Chrome-version branch.
  assert.equal(r2.tier, 'degraded');
  assert.equal(r2.isIOS, true);
  assert.equal(r2.name, 'Chrome');
});

test('feature-absent env is unworkable regardless of UA', () => {
  const r = detectBrowser(BROWSER_UA_FIXTURES.chrome_desktop_current, FEATURES_MISSING_RTC);
  assert.equal(r.tier, 'unworkable');
});

test('BROWSER_FLOORS exports are stable and present', () => {
  assert.equal(typeof BROWSER_FLOORS.chrome, 'number');
  assert.equal(typeof BROWSER_FLOORS.firefox, 'number');
  assert.equal(typeof BROWSER_FLOORS.safariDesktop, 'number');
  assert.ok(BROWSER_FLOORS.chrome >= 100);
  assert.ok(BROWSER_FLOORS.firefox >= 100);
  assert.ok(BROWSER_FLOORS.safariDesktop >= 15);
});

test('detectBrowser is pure — same input returns deep-equal output', () => {
  for (const [name, ua] of Object.entries(BROWSER_UA_FIXTURES)) {
    const a = detectBrowser(ua, FEATURES_OK);
    const b = detectBrowser(ua, FEATURES_OK);
    assert.deepEqual(a, b, `fixture ${name} not pure`);
  }
});

// --- Boundary tests (§5.1 item 7): floor-1, floor, floor+1 ------------------

function chromeUA(v) {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
}
function firefoxUA(v) {
  return `Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
}
function safariDesktopUA(v) {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0 Safari/605.1.15`;
}

test('Chrome boundary: floor-1 → degraded, floor → supported, floor+1 → supported', () => {
  const f = BROWSER_FLOORS.chrome;
  assert.equal(detectBrowser(chromeUA(f - 1), FEATURES_OK).tier, 'degraded');
  assert.equal(detectBrowser(chromeUA(f), FEATURES_OK).tier, 'supported');
  assert.equal(detectBrowser(chromeUA(f + 1), FEATURES_OK).tier, 'supported');
});

test('Firefox boundary: floor-1 → degraded, floor → supported, floor+1 → supported', () => {
  const f = BROWSER_FLOORS.firefox;
  assert.equal(detectBrowser(firefoxUA(f - 1), FEATURES_OK).tier, 'degraded');
  assert.equal(detectBrowser(firefoxUA(f), FEATURES_OK).tier, 'supported');
  assert.equal(detectBrowser(firefoxUA(f + 1), FEATURES_OK).tier, 'supported');
});

test('Safari-desktop boundary: floor-1 → degraded, floor → supported, floor+1 → supported', () => {
  const f = BROWSER_FLOORS.safariDesktop;
  assert.equal(detectBrowser(safariDesktopUA(f - 1), FEATURES_OK).tier, 'degraded');
  assert.equal(detectBrowser(safariDesktopUA(f), FEATURES_OK).tier, 'supported');
  assert.equal(detectBrowser(safariDesktopUA(f + 1), FEATURES_OK).tier, 'supported');
});

// --- Failure-path coverage (§5.2) ------------------------------------------

test('very old Chrome (far under floor) is degraded', () => {
  const r = detectBrowser(chromeUA(1), FEATURES_OK);
  assert.equal(r.tier, 'degraded');
  assert.ok(/older than the supported baseline/.test(r.reasons[0]));
});

test('Firefox Android is degraded with phone-specific reason', () => {
  const r = detectBrowser(BROWSER_UA_FIXTURES.firefox_android, FEATURES_OK);
  assert.equal(r.tier, 'degraded');
  assert.equal(r.device, 'phone');
  assert.ok(/Android Firefox/i.test(r.reasons[0]));
});

test('generic unknown UA is degraded (best-effort)', () => {
  const r = detectBrowser('SomeRandomBrowser/1.0', FEATURES_OK);
  assert.equal(r.tier, 'degraded');
  assert.equal(r.name, 'unknown');
});

test('truncated UA "Mozilla" falls through to unknown/degraded', () => {
  const r = detectBrowser('Mozilla', FEATURES_OK);
  assert.equal(r.tier, 'degraded');
  assert.equal(r.name, 'unknown');
});

test('empty UA string is degraded (unknown)', () => {
  const r = detectBrowser('', FEATURES_OK);
  assert.equal(r.tier, 'degraded');
  assert.equal(r.name, 'unknown');
});
