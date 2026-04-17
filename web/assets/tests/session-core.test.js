// File: web/assets/tests/session-core.test.js
// Purpose: Node tests for the pure applyActions helper — the sole
//          setParameters mutation site. Covers §5.1 #30–#33.
// Last updated: Sprint 4 (2026-04-17) -- initial implementation

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyActions } = require('../session-core.js');

function makeSender() {
  const calls = [];
  return {
    calls: calls,
    setParameters: function (params) {
      calls.push(params);
      return Promise.resolve();
    },
  };
}

function trackedSender() {
  // Use a Proxy to assert `enabled` is never accessed.
  const inner = makeSender();
  const accesses = { enabled: 0 };
  const proxy = new Proxy(inner, {
    get: function (target, prop) {
      if (prop === 'enabled') accesses.enabled += 1;
      return target[prop];
    },
    set: function (target, prop, value) {
      if (prop === 'enabled') accesses.enabled += 1;
      target[prop] = value;
      return true;
    },
  });
  return { sender: proxy, accesses: accesses, inner: inner };
}

// --- §5.1 #30 Action-to-sender routing -------------------------------------

test('#30 setVideoEncoding routes to videoSender; audioSender not called', () => {
  const audio = makeSender();
  const video = makeSender();
  applyActions(
    [{ type: 'setVideoEncoding', params: { maxBitrate: 500000, scaleResolutionDownBy: 2.0, active: true } }],
    { audio: audio, video: video }
  );
  assert.equal(video.calls.length, 1);
  assert.equal(video.calls[0].encodings[0].maxBitrate, 500000);
  assert.equal(audio.calls.length, 0);
});

// --- §5.1 #31 Exact parameter forwarding -----------------------------------

test('#31 setAudioEncoding forwards maxBitrate exactly', () => {
  const audio = makeSender();
  const video = makeSender();
  applyActions(
    [{ type: 'setAudioEncoding', params: { maxBitrate: 96000 } }],
    { audio: audio, video: video }
  );
  assert.equal(audio.calls.length, 1);
  const enc = audio.calls[0].encodings[0];
  assert.equal(enc.maxBitrate, 96000);
  // The forwarded encoding should NOT carry fields beyond those the caller
  // supplied (no overwrites, no merges).
  assert.deepEqual(Object.keys(enc).sort(), ['maxBitrate']);
});

// --- §5.1 #32 Recovery after rejection -------------------------------------

test('#32 setParameters rejection is swallowed; next call succeeds', async () => {
  const audio = makeSender();
  let callCount = 0;
  const video = {
    calls: [],
    setParameters: function (p) {
      callCount += 1;
      this.calls.push(p);
      if (callCount === 1) return Promise.reject(new Error('fail-1'));
      return Promise.resolve();
    },
  };
  // Silence the expected warning during this test.
  const origWarn = console.warn;
  console.warn = function () {};
  try {
    applyActions(
      [{ type: 'setVideoEncoding', params: { maxBitrate: 500000 } }],
      { audio: audio, video: video }
    );
    // Let the rejection drain.
    await new Promise(function (r) { setTimeout(r, 0); });
    applyActions(
      [{ type: 'setVideoEncoding', params: { maxBitrate: 800000 } }],
      { audio: audio, video: video }
    );
  } finally {
    console.warn = origWarn;
  }
  assert.equal(video.calls.length, 2);
  assert.equal(video.calls[1].encodings[0].maxBitrate, 800000);
});

// --- §5.1 #33 track.enabled never accessed ---------------------------------

test('#33 applyActions never reads or writes .enabled on any sender', () => {
  const v = trackedSender();
  const a = trackedSender();
  applyActions(
    [
      { type: 'setVideoEncoding', params: { maxBitrate: 500000 } },
      { type: 'setAudioEncoding', params: { maxBitrate: 96000 } },
    ],
    { video: v.sender, audio: a.sender }
  );
  assert.equal(v.accesses.enabled, 0);
  assert.equal(a.accesses.enabled, 0);
});

// --- Additional robustness -------------------------------------------------

test('applyActions with empty actions array is a no-op', () => {
  const audio = makeSender();
  const video = makeSender();
  applyActions([], { audio: audio, video: video });
  assert.equal(audio.calls.length, 0);
  assert.equal(video.calls.length, 0);
});

test('applyActions with missing sender skips silently', () => {
  assert.doesNotThrow(() => {
    applyActions(
      [{ type: 'setVideoEncoding', params: { maxBitrate: 500000 } }],
      { audio: makeSender() } // no video sender
    );
  });
});

test('applyActions ignores floor_violation (caller handles it)', () => {
  const audio = makeSender();
  const video = makeSender();
  applyActions([{ type: 'floor_violation' }], { audio: audio, video: video });
  assert.equal(audio.calls.length, 0);
  assert.equal(video.calls.length, 0);
});
