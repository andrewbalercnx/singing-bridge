// File: web/assets/tests/ice.test.js
// Purpose: Unit tests for ice.js cache logic and fetch behaviour.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cacheValid, createFetcher } = require('../ice.js');

const STUN = [{ urls: 'stun:turn.example.com:3478' }];
const TURN = [
  { urls: 'stun:turn.example.com:3478' },
  { urls: ['turn:turn.example.com:3478?transport=udp'], username: 'u', credential: 'c', credentialType: 'password' },
];

function makeOk(iceServers, ttl) {
  return async () => ({ ok: true, json: async () => ({ iceServers, ttl }) });
}

test('cacheValid: false when cache is null', () => {
  assert.equal(cacheValid(null, 1000), false);
});

test('cacheValid: true when expiresAt > nowMs + 10000', () => {
  const cache = { iceServers: STUN, expiresAt: 20000 };
  assert.equal(cacheValid(cache, 1000), true); // 20000 > 11000
});

test('cacheValid: false when within 10 s of expiry', () => {
  const cache = { iceServers: STUN, expiresAt: 10500 };
  assert.equal(cacheValid(cache, 1000), false); // 10500 <= 11000
});

test('fetchIceServers: fetches when cache is empty', async () => {
  const fetch = createFetcher();
  let count = 0;
  const fakeFetch = async () => { count++; return { ok: true, json: async () => ({ iceServers: TURN, ttl: 600 }) }; };
  const result = await fetch({ fetch: fakeFetch, now: () => 0 });
  assert.deepEqual(result, TURN);
  assert.equal(count, 1);
});

test('fetchIceServers: returns cached result without re-fetching', async () => {
  const fetch = createFetcher();
  let count = 0;
  const fakeFetch = async () => { count++; return { ok: true, json: async () => ({ iceServers: STUN, ttl: 600 }) }; };
  await fetch({ fetch: fakeFetch, now: () => 0 });
  await fetch({ fetch: fakeFetch, now: () => 1 }); // still well within TTL
  assert.equal(count, 1);
});

test('fetchIceServers: re-fetches when within 10 s of expiry', async () => {
  const fetch = createFetcher();
  let count = 0;
  const fakeFetch = async () => { count++; return { ok: true, json: async () => ({ iceServers: STUN, ttl: 60 }) }; };
  // First call: cache set, expiresAt = 0 + 60000 = 60000.
  await fetch({ fetch: fakeFetch, now: () => 0 });
  // Second call: nowMs=50001, 60000 <= 50001+10000=60001 → cache invalid.
  await fetch({ fetch: fakeFetch, now: () => 50001 });
  assert.equal(count, 2);
});

test('fetchIceServers: throws on non-ok response', async () => {
  const fetch = createFetcher();
  const fakeFetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(
    () => fetch({ fetch: fakeFetch, now: () => 0 }),
    /turn-credentials fetch failed/
  );
});

test('ttl=0 causes immediate re-fetch on second call', async () => {
  const fetch = createFetcher();
  let count = 0;
  const fakeFetch = async () => {
    count++;
    return { ok: true, json: async () => ({ iceServers: STUN, ttl: 0 }) };
  };
  // expiresAt = 0 + 0 = 0; second call: cacheValid(cache, 1) = 0 > 1+10000 = false
  await fetch({ fetch: fakeFetch, now: () => 0 });
  await fetch({ fetch: fakeFetch, now: () => 1 });
  assert.equal(count, 2);
});
