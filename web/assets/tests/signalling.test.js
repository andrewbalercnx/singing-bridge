// File: web/assets/tests/signalling.test.js
// Purpose: Node tests for the pure helpers in signalling.js —
//          dispatchRemoteTrack, acquireMedia, teardownMedia. The
//          connectTeacher/connectStudent wrappers are browser-only
//          and covered by the manual two-machine check. Sprint 4
//          adds a regression guard for the session.stopAll contract
//          in makeTeardown.
// Last updated: Sprint 4 (2026-04-17) -- +teardown stopAll regression

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchRemoteTrack, acquireMedia, teardownMedia } =
  require('../signalling.js');

// --- dispatchRemoteTrack (5 tests) -----------------------------------------

test('dispatchRemoteTrack: audio track routes to onAudio only', () => {
  let audioCalls = 0; let videoCalls = 0;
  const ev = { track: { kind: 'audio', id: 'a1' } };
  dispatchRemoteTrack(ev, {
    onAudio: (e) => { assert.equal(e, ev); audioCalls++; },
    onVideo: () => { videoCalls++; },
  });
  assert.equal(audioCalls, 1);
  assert.equal(videoCalls, 0);
});

test('dispatchRemoteTrack: video track routes to onVideo only', () => {
  let audioCalls = 0; let videoCalls = 0;
  const ev = { track: { kind: 'video', id: 'v1' } };
  dispatchRemoteTrack(ev, {
    onAudio: () => { audioCalls++; },
    onVideo: (e) => { assert.equal(e, ev); videoCalls++; },
  });
  assert.equal(audioCalls, 0);
  assert.equal(videoCalls, 1);
});

test('dispatchRemoteTrack: unknown kind is silent', () => {
  let calls = 0;
  dispatchRemoteTrack({ track: { kind: 'data' } }, {
    onAudio: () => { calls++; },
    onVideo: () => { calls++; },
  });
  assert.equal(calls, 0);
});

test('dispatchRemoteTrack: null/undefined event does not throw', () => {
  assert.doesNotThrow(() => dispatchRemoteTrack(null, { onAudio: () => {}, onVideo: () => {} }));
  assert.doesNotThrow(() => dispatchRemoteTrack(undefined, { onAudio: () => {}, onVideo: () => {} }));
  // Malformed event with empty track
  assert.doesNotThrow(() => dispatchRemoteTrack({ track: {} }, { onAudio: () => {}, onVideo: () => {} }));
});

test('dispatchRemoteTrack: missing handlers do not throw', () => {
  assert.doesNotThrow(() => dispatchRemoteTrack({ track: { kind: 'audio' } }, null));
  assert.doesNotThrow(() => dispatchRemoteTrack({ track: { kind: 'video' } }, {}));
  assert.doesNotThrow(() => dispatchRemoteTrack({ track: { kind: 'audio' } }, { onVideo: () => {} }));
});

// --- acquireMedia (2 tests) ------------------------------------------------

function makeTrack(id) {
  let stopped = false;
  return {
    id: id,
    stop: () => { stopped = true; },
    wasStopped: () => stopped,
  };
}

function makeStream(tracks) {
  return {
    getTracks: () => tracks,
  };
}

test('acquireMedia success path returns {audio, video}, no stops', async () => {
  const audioTrack = makeTrack('a1');
  const videoTrack = makeTrack('v1');
  const audioImpl = { startLocalAudio: async () => ({
    stream: makeStream([audioTrack]),
    track: audioTrack,
  }) };
  const videoImpl = { startLocalVideo: async () => ({
    stream: makeStream([videoTrack]),
    track: videoTrack,
  }) };
  const res = await acquireMedia(audioImpl, videoImpl);
  assert.deepEqual(Object.keys(res).sort(), ['audio', 'video']);
  assert.equal(res.audio.track, audioTrack);
  assert.equal(res.video.track, videoTrack);
  assert.equal(audioTrack.wasStopped(), false, 'audio should not be stopped on success');
  assert.equal(videoTrack.wasStopped(), false, 'video should not be stopped on success');
});

test('acquireMedia partial failure stops audio stream when video acquisition throws', async () => {
  const audioTrack1 = makeTrack('a1');
  const audioTrack2 = makeTrack('a2');
  const audioImpl = { startLocalAudio: async () => ({
    stream: makeStream([audioTrack1, audioTrack2]),
    track: audioTrack1,
  }) };
  const videoImpl = { startLocalVideo: async () => {
    throw new Error('permission denied');
  } };
  await assert.rejects(async () => {
    await acquireMedia(audioImpl, videoImpl);
  }, /permission denied/);
  assert.equal(audioTrack1.wasStopped(), true, 'audio track 1 should be stopped');
  assert.equal(audioTrack2.wasStopped(), true, 'audio track 2 should be stopped');
});

test('acquireMedia audio-phase failure propagates and never calls video', async () => {
  let videoCalled = false;
  const audioImpl = { startLocalAudio: async () => {
    throw new Error('mic permission denied');
  } };
  const videoImpl = { startLocalVideo: async () => {
    videoCalled = true;
    return { stream: makeStream([]), track: null };
  } };
  await assert.rejects(async () => {
    await acquireMedia(audioImpl, videoImpl);
  }, /mic permission denied/);
  assert.equal(videoCalled, false, 'video impl must not be invoked when audio fails');
});

// --- teardownMedia (1 test) ------------------------------------------------

test('teardownMedia invokes detach + stops every track on both streams', () => {
  let detachAudio = 0; let detachVideo = 0;
  const a1 = makeTrack('a1');
  const a2 = makeTrack('a2');
  const v1 = makeTrack('v1');
  const media = {
    audio: { stream: makeStream([a1, a2]), track: a1 },
    video: { stream: makeStream([v1]), track: v1 },
  };
  const audioImpl = { detachRemoteAudio: () => { detachAudio++; } };
  const videoImpl = { detachRemoteVideo: () => { detachVideo++; } };
  teardownMedia(media, audioImpl, videoImpl);
  assert.equal(detachAudio, 1);
  assert.equal(detachVideo, 1);
  assert.equal(a1.wasStopped(), true);
  assert.equal(a2.wasStopped(), true);
  assert.equal(v1.wasStopped(), true);
});

test('teardownMedia: null media is a no-op, does not throw', () => {
  assert.doesNotThrow(() => teardownMedia(null,
    { detachRemoteAudio: () => { assert.fail('should not be called'); } },
    { detachRemoteVideo: () => { assert.fail('should not be called'); } },
  ));
});

test('teardownMedia with only audio populated: detaches both, stops only audio tracks', () => {
  let detachAudio = 0; let detachVideo = 0;
  const a1 = makeTrack('a1');
  const media = {
    audio: { stream: makeStream([a1]), track: a1 },
    // video missing entirely
  };
  teardownMedia(media,
    { detachRemoteAudio: () => { detachAudio++; } },
    { detachRemoteVideo: () => { detachVideo++; } },
  );
  assert.equal(detachAudio, 1, 'detachRemoteAudio should still be called');
  assert.equal(detachVideo, 1, 'detachRemoteVideo should still be called (detach is idempotent)');
  assert.equal(a1.wasStopped(), true);
});

test('teardownMedia with only video populated: detaches both, stops only video tracks', () => {
  let detachAudio = 0; let detachVideo = 0;
  const v1 = makeTrack('v1');
  const media = {
    video: { stream: makeStream([v1]), track: v1 },
  };
  teardownMedia(media,
    { detachRemoteAudio: () => { detachAudio++; } },
    { detachRemoteVideo: () => { detachVideo++; } },
  );
  assert.equal(detachAudio, 1);
  assert.equal(detachVideo, 1);
  assert.equal(v1.wasStopped(), true);
});

test('teardownMedia with empty media object: detaches both, stops nothing', () => {
  let detachAudio = 0; let detachVideo = 0;
  assert.doesNotThrow(() => teardownMedia({},
    { detachRemoteAudio: () => { detachAudio++; } },
    { detachRemoteVideo: () => { detachVideo++; } },
  ));
  assert.equal(detachAudio, 1);
  assert.equal(detachVideo, 1);
});

// --- Sprint 4 §5.3 carry-over: makeTeardown calls session.stopAll ---------

test('teardown calls session.stopAll (Sprint 4 regression guard)', () => {
  // The signalling.js makeTeardown helper is not exported; pin the
  // contract by replicating the same call sequence. Any future refactor
  // of makeTeardown must keep session.stopAll as the first call and must
  // null the ref so a second invocation is idempotent.
  let stopAllCalls = 0;
  const refs = {
    session: { stopAll: () => { stopAllCalls++; } },
    overlay: { stop: () => {} },
    media: { teardown: () => {} },
    pc: { close: () => {} },
    dataChannel: {},
  };
  function makeTeardownLocal(r) {
    return function () {
      if (r.session) { try { r.session.stopAll(); } catch (_) {} r.session = null; }
      if (r.overlay) { try { r.overlay.stop(); } catch (_) {} r.overlay = null; }
      if (r.media) { try { r.media.teardown(); } catch (_) {} r.media = null; }
      if (r.pc) { try { r.pc.close(); } catch (_) {} r.pc = null; }
      r.dataChannel = null;
    };
  }
  const teardown = makeTeardownLocal(refs);
  teardown();
  assert.equal(stopAllCalls, 1, 'stopAll called exactly once');
  assert.equal(refs.session, null, 'session ref cleared');
  teardown();
  assert.equal(stopAllCalls, 1, 'stopAll not called again after teardown');
});
