// File: web/assets/tests/signalling.test.js
// Purpose: Node tests for the pure helpers in signalling.js —
//          dispatchRemoteTrack, acquireMedia, teardownMedia, Signalling.
//          connectTeacher/connectStudent wrappers are browser-only
//          and covered by the manual two-machine check. Sprint 4
//          adds a regression guard for the session.stopAll contract
//          in makeTeardown. Sprint 8 adds playoutDelayHint=0 regression guard.
//          Sprint 9: Signalling frame-ordering regression guard.
// Last updated: Sprint 9 (2026-04-19) -- Signalling exported; frame-ordering tests

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchRemoteTrack, acquireMedia, teardownMedia, makeTeardown, Signalling } =
  require('../signalling.js');

// --- dispatchRemoteTrack (5 tests) -----------------------------------------

// Sprint 8 regression guard: ADR-0001 minimum playout latency
test('dispatchRemoteTrack: sets receiver.playoutDelayHint = 0 on every track event', () => {
  let hint;
  const receiver = { set playoutDelayHint(v) { hint = v; } };
  dispatchRemoteTrack({ track: { kind: 'audio' }, receiver }, { onAudio: () => {} });
  assert.equal(hint, 0, 'playoutDelayHint must be set to 0 on audio track receiver');

  hint = undefined;
  dispatchRemoteTrack({ track: { kind: 'video' }, receiver }, { onVideo: () => {} });
  assert.equal(hint, 0, 'playoutDelayHint must be set to 0 on video track receiver');
});

test('dispatchRemoteTrack: missing receiver does not throw', () => {
  assert.doesNotThrow(() =>
    dispatchRemoteTrack({ track: { kind: 'audio' } }, { onAudio: () => {} }));
});

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
// Exercises the REAL production makeTeardown (exported from signalling.js),
// not a replica — a deliberate regression in the production function must
// flip these assertions.

test('makeTeardown (real): calls session.stopAll exactly once and clears ref', () => {
  let stopAllCalls = 0;
  const refs = {
    session: { stopAll: () => { stopAllCalls++; } },
    overlay: { stop: () => {} },
    media: { teardown: () => {} },
    pc: { close: () => {} },
    dataChannel: {},
  };
  const teardown = makeTeardown(refs);
  teardown();
  assert.equal(stopAllCalls, 1, 'stopAll called exactly once');
  assert.equal(refs.session, null, 'session ref cleared');
  teardown();
  assert.equal(stopAllCalls, 1, 'stopAll not called again after teardown');
});

test('makeTeardown (real): call order is session → overlay → media → pc', () => {
  const order = [];
  const refs = {
    session: { stopAll: () => order.push('session') },
    overlay: { stop: () => order.push('overlay') },
    media: { teardown: () => order.push('media') },
    pc: { close: () => order.push('pc') },
    dataChannel: {},
  };
  makeTeardown(refs)();
  assert.deepEqual(order, ['session', 'overlay', 'media', 'pc']);
  assert.equal(refs.dataChannel, null);
});

test('makeTeardown (real): rethrowing session.stopAll does not block the rest', () => {
  let overlayStopped = false, mediaTorn = false, pcClosed = false;
  const refs = {
    session: { stopAll: () => { throw new Error('boom'); } },
    overlay: { stop: () => { overlayStopped = true; } },
    media: { teardown: () => { mediaTorn = true; } },
    pc: { close: () => { pcClosed = true; } },
    dataChannel: {},
  };
  assert.doesNotThrow(() => makeTeardown(refs)());
  assert.equal(overlayStopped, true);
  assert.equal(mediaTorn, true);
  assert.equal(pcClosed, true);
});

// --- Signalling frame-ordering regression guard (Sprint 9) -----------------
// These tests prove the WS wrapper preserves send order and that the
// headphones_confirmed message can only follow lobby_join once the socket
// is ready — guarding the student.js race-condition fix.

function makeFakeSocket(readyState) {
  const sent = [];
  return {
    readyState: readyState,
    sent,
    send(data) { sent.push(JSON.parse(data)); },
    close() {},
    addEventListener(ev, fn) { this['_' + ev] = fn; },
    _fireOpen() { if (this._open) this._open(); },
    _fireMessage(data) { if (this._message) this._message({ data: JSON.stringify(data) }); },
  };
}

test('Signalling: send queues frames when socket is not open, flushes in order on open', () => {
  const sock = makeFakeSocket(0); // CONNECTING
  const sig = new Signalling(sock);
  sig.send({ type: 'lobby_join', slug: 'test' });
  sig.send({ type: 'headphones_confirmed' });
  assert.equal(sock.sent.length, 0, 'no frames sent yet — socket not open');
  sock.readyState = 1;
  sock._fireOpen();
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[0].type, 'lobby_join', 'lobby_join must be first');
  assert.equal(sock.sent[1].type, 'headphones_confirmed', 'headphones_confirmed must follow');
});

test('Signalling: send emits immediately when socket is already open', () => {
  const sock = makeFakeSocket(1); // OPEN
  const sig = new Signalling(sock);
  sig.send({ type: 'lobby_join', slug: 'test' });
  sig.send({ type: 'headphones_confirmed' });
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[0].type, 'lobby_join');
  assert.equal(sock.sent[1].type, 'headphones_confirmed');
});

test('Signalling: on + message dispatch routes to the correct handler', () => {
  const sock = makeFakeSocket(1);
  const sig = new Signalling(sock);
  const received = [];
  sig.on('lobby_state', (m) => received.push(m));
  sock._fireMessage({ type: 'lobby_state', entries: [] });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].entries, []);
});

test('Signalling: sendHeadphonesConfirmed handle sends correct frame type', () => {
  const sock = makeFakeSocket(1);
  const sig = new Signalling(sock);
  // Mimic what the connectStudent handle does.
  const handle = { sendHeadphonesConfirmed() { sig.send({ type: 'headphones_confirmed' }); } };
  sig.send({ type: 'lobby_join', slug: 'test' });
  handle.sendHeadphonesConfirmed();
  assert.equal(sock.sent[0].type, 'lobby_join');
  assert.equal(sock.sent[1].type, 'headphones_confirmed');
});

