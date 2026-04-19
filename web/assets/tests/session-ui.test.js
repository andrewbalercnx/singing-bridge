// File: web/assets/tests/session-ui.test.js
// Purpose: Unit tests for session-ui.js: fmtTime, deriveToggleView,
//          buildBaselineStrip (setElapsed, setLevels), buildMutedBanner
//          (checkAndUpdate), runAudioLoop onFrame contract, mount lifecycle.
// Last updated: Sprint 8 (2026-04-19) -- tests call actual shipped functions

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// DOM stubs — minimal surface that session-ui.js needs in Node
// ---------------------------------------------------------------------------

let rafIdCounter = 0;
global.requestAnimationFrame = function (cb) {
  const id = ++rafIdCounter;
  setImmediate(cb);
  return id;
};
global.cancelAnimationFrame = function () {};

function makeEl(tag) {
  const attrs = {};
  const children = [];
  let textContent = '';
  const style = {};
  const el = {
    tag,
    get textContent() { return textContent; },
    set textContent(v) { textContent = String(v); },
    get hidden() { return attrs.hidden === true; },
    set hidden(v) { attrs.hidden = v; },
    className: '',
    style,
    children,
    parentNode: null,
    innerHTML: '',
    appendChild(child) {
      if (child && typeof child === 'object') child.parentNode = el;
      children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
    },
    append(...items) { for (const item of items) children.push(item); },
    replaceChildren(...items) { children.length = 0; for (const item of items) children.push(item); },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
    addEventListener(ev, fn) { (attrs['_ev_' + ev] = attrs['_ev_' + ev] || []).push(fn); },
    removeEventListener() {},
    dispatchClick() { (attrs['_ev_click'] || []).forEach(fn => fn()); },
    close() {},
    showModal() { attrs.open = true; },
    play() { return Promise.resolve(); },
  };
  return el;
}

global.document = {
  createElement(tag) { return makeEl(tag); },
  createElementNS(_ns, tag) { return makeEl(tag); },
  createTextNode(text) { return { textContent: text, tag: '#text' }; },
};

global.clearTimeout = clearTimeout;
global.setTimeout = setTimeout;
global.setInterval = setInterval;
global.clearInterval = clearInterval;

global.AudioContext = class {
  constructor() { this.closeCalls = 0; }
  createAnalyser() {
    return {
      frequencyBinCount: 4,
      getByteTimeDomainData(buf) { buf.fill(128); },
      disconnect() {},
    };
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  close() { this.closeCalls++; }
};

const mod = require('../session-ui.js');

// ---------------------------------------------------------------------------
// fmtTime
// ---------------------------------------------------------------------------

test('fmtTime: 0 → "0:00"', () => assert.equal(mod.fmtTime(0), '0:00'));
test('fmtTime: 65 → "1:05"', () => assert.equal(mod.fmtTime(65), '1:05'));
test('fmtTime: 3661 → "1:01:01"', () => assert.equal(mod.fmtTime(3661), '1:01:01'));
test('fmtTime: -5 → "0:00" (clamp negative)', () => assert.equal(mod.fmtTime(-5), '0:00'));
test('fmtTime: NaN → "0:00" (clamp non-finite)', () => assert.equal(mod.fmtTime(NaN), '0:00'));
test('fmtTime: Infinity → "0:00"', () => assert.equal(mod.fmtTime(Infinity), '0:00'));

// ---------------------------------------------------------------------------
// deriveToggleView (relocated from controls.js)
// ---------------------------------------------------------------------------

test('deriveToggleView: enabled=true → onLabel, ariaPressed=false', () => {
  assert.deepEqual(mod.deriveToggleView(true, 'Mute', 'Unmute'), { label: 'Mute', ariaPressed: 'false' });
});
test('deriveToggleView: enabled=false → offLabel, ariaPressed=true', () => {
  assert.deepEqual(mod.deriveToggleView(false, 'Mute', 'Unmute'), { label: 'Unmute', ariaPressed: 'true' });
});
test('deriveToggleView: null treated as disabled', () => {
  const v = mod.deriveToggleView(null, 'On', 'Off');
  assert.equal(v.ariaPressed, 'true');
  assert.equal(v.label, 'Off');
});

// ---------------------------------------------------------------------------
// buildBaselineStrip: setElapsed integration test (calls actual shipped function)
// ---------------------------------------------------------------------------

test('buildBaselineStrip.setElapsed(65) renders "1:05" in elapsed text node', () => {
  const strip = mod.buildBaselineStrip();
  strip.setElapsed(65);
  // midEl is the second child of meterRow (first child of strip.node)
  const meterRow = strip.node.children[0];
  const midEl = meterRow.children[1];
  assert.equal(midEl.textContent, '1:05');
});

test('buildBaselineStrip.setElapsed(0) renders "0:00"', () => {
  const strip = mod.buildBaselineStrip();
  strip.setElapsed(0);
  const midEl = strip.node.children[0].children[1];
  assert.equal(midEl.textContent, '0:00');
});

// ---------------------------------------------------------------------------
// buildMutedBanner: checkAndUpdate actual shipped function
// ---------------------------------------------------------------------------

test('muted banner: fewer than MUTE_DETECT_FRAMES frames → no show', () => {
  const banner = mod.buildMutedBanner();
  // 3 frames with rms > threshold, mic disabled
  for (let i = 0; i < 3; i++) banner.checkAndUpdate(false, 0.9);
  assert.equal(banner.node.hidden, true, 'banner must stay hidden after only 3 frames');
});

test('muted banner: exactly 4 frames → shows', () => {
  const banner = mod.buildMutedBanner();
  for (let i = 0; i < 4; i++) banner.checkAndUpdate(false, 0.9);
  assert.equal(banner.node.hidden, false, 'banner must show after 4 frames');
});

test('muted banner: below threshold frames do not accumulate', () => {
  const banner = mod.buildMutedBanner();
  banner.checkAndUpdate(false, 0.01);
  banner.checkAndUpdate(false, 0.01);
  banner.checkAndUpdate(false, 0.9);  // only 1 frame above threshold
  assert.equal(banner.node.hidden, true, 'frames below threshold reset the counter');
});

test('muted banner: micEnabled=true hides immediately', () => {
  const banner = mod.buildMutedBanner();
  for (let i = 0; i < 4; i++) banner.checkAndUpdate(false, 0.9);
  assert.equal(banner.node.hidden, false);
  banner.checkAndUpdate(true, 0.9);
  assert.equal(banner.node.hidden, true, 'mic unmuted must hide banner immediately');
});

// ---------------------------------------------------------------------------
// runAudioLoop: actual function tested with stub analysers
// ---------------------------------------------------------------------------

test('runAudioLoop: null analysers yield onFrame(0, 0)', (t, done) => {
  let called = false;
  // Use synchronous RAF: override to call once immediately
  const origRAF = global.requestAnimationFrame;
  global.requestAnimationFrame = function (cb) { setImmediate(cb); return ++rafIdCounter; };

  const loop = mod.runAudioLoop(null, null, function (selfRms, remoteRms) {
    if (called) return;
    called = true;
    assert.equal(selfRms, 0, 'selfRms must be 0 for null analyser');
    assert.equal(remoteRms, 0, 'remoteRms must be 0 for null analyser');
    loop.stop();
    global.requestAnimationFrame = origRAF;
    done();
  });
});

test('runAudioLoop: non-null analyser produces correct selfRms first, remoteRms second', (t, done) => {
  // selfAnalyser: all 128 → RMS = 0
  // remoteAnalyser: alternating 0/255 → RMS > 0
  const selfAnalyser = {
    frequencyBinCount: 4,
    getByteTimeDomainData(buf) { buf[0]=128; buf[1]=128; buf[2]=128; buf[3]=128; },
    disconnect() {},
  };
  const remoteAnalyser = {
    frequencyBinCount: 4,
    getByteTimeDomainData(buf) { buf[0]=0; buf[1]=255; buf[2]=0; buf[3]=255; },
    disconnect() {},
  };
  let called = false;
  const origRAF = global.requestAnimationFrame;
  global.requestAnimationFrame = function (cb) { setImmediate(cb); return ++rafIdCounter; };

  const loop = mod.runAudioLoop(selfAnalyser, remoteAnalyser, function (selfRms, remoteRms) {
    if (called) return;
    called = true;
    assert.equal(selfRms, 0, 'selfRms: all-128 analyser → 0');
    assert.ok(remoteRms > 0.9, 'remoteRms: 0/255 alternating → ~1.0, got ' + remoteRms);
    loop.stop();
    global.requestAnimationFrame = origRAF;
    done();
  });
});

test('runAudioLoop: stop() prevents further onFrame calls', (t, done) => {
  let calls = 0;
  const origRAF = global.requestAnimationFrame;
  const callbacks = [];
  global.requestAnimationFrame = function (cb) { callbacks.push(cb); return ++rafIdCounter; };
  global.cancelAnimationFrame = function () { callbacks.length = 0; };

  const loop = mod.runAudioLoop(null, null, function () { calls++; });
  loop.stop();
  // Drain any queued callbacks
  const saved = [...callbacks]; callbacks.length = 0;
  saved.forEach(fn => fn());
  assert.equal(calls, 0, 'no frames must fire after stop()');
  global.requestAnimationFrame = origRAF;
  global.cancelAnimationFrame = function () {};
  done();
});

// ---------------------------------------------------------------------------
// mount: teardown calls audioCtx.close() exactly once (idempotent)
// ---------------------------------------------------------------------------

test('mount teardown calls audioCtx.close() exactly once', () => {
  let closeCalls = 0;
  const origAC = global.AudioContext;
  global.AudioContext = class {
    createAnalyser() {
      return { frequencyBinCount: 4, getByteTimeDomainData(b) { b.fill(128); }, disconnect() {} };
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    close() { closeCalls++; }
  };

  const container = document.createElement('div');
  const h = mod.mount(container, defaultOpts());
  h.teardown();
  assert.equal(closeCalls, 1, 'close() called once');
  h.teardown(); // idempotent
  assert.equal(closeCalls, 1, 'close() not called again on second teardown');
  global.AudioContext = origAC;
});

// ---------------------------------------------------------------------------
// mount: null localStream mounts without error, no muted banner
// ---------------------------------------------------------------------------

test('mount with localStream: null mounts without error', () => {
  const container = document.createElement('div');
  let threw = false;
  let h;
  try {
    h = mod.mount(container, Object.assign(defaultOpts(), { localStream: null }));
  } catch (e) { threw = true; }
  assert.equal(threw, false);
  if (h) h.teardown();
});

// ---------------------------------------------------------------------------
// mount: XSS — peer name must not execute injected payload
// ---------------------------------------------------------------------------

test('XSS: remoteName with script payload does not execute', () => {
  let executed = false;
  global.xssCheck = function () { executed = true; };
  const container = document.createElement('div');
  const h = mod.mount(container, Object.assign(defaultOpts(), {
    remoteName: '<img src=x onerror="xssCheck()">',
    remoteRoleLabel: '<script>xssCheck()</script>',
  }));
  assert.equal(executed, false, 'XSS payload must not execute');
  h.teardown();
  delete global.xssCheck;
});

// ---------------------------------------------------------------------------
// setRemoteStream: no loop stacking after swap
// ---------------------------------------------------------------------------

test('setRemoteStream does not stack RAF loops', () => {
  let netLoops = 0;
  const origRAF = global.requestAnimationFrame;
  const origCAF = global.cancelAnimationFrame;
  global.requestAnimationFrame = function () { netLoops++; return netLoops; };
  global.cancelAnimationFrame = function () { netLoops = Math.max(0, netLoops - 1); };

  const container = document.createElement('div');
  const h = mod.mount(container, defaultOpts());
  const after_mount = netLoops;
  h.setRemoteStream(null);
  assert.ok(netLoops <= after_mount + 1, 'at most one net new RAF loop after setRemoteStream');
  h.teardown();
  global.requestAnimationFrame = origRAF;
  global.cancelAnimationFrame = origCAF;
});

// ---------------------------------------------------------------------------
// button click callbacks
// ---------------------------------------------------------------------------

test('mic button click calls onMicToggle', () => {
  let calls = 0;
  const container = document.createElement('div');
  const h = mod.mount(container, Object.assign(defaultOpts(), { onMicToggle() { calls++; } }));
  // controls node is the first child of .sb-bottom, which is the third child of root
  const root = container.children[0];
  const bottom = root.children[2];
  const controls = bottom.children[0];
  const micBtn = controls.children[0];
  micBtn.dispatchClick();
  assert.equal(calls, 1, 'onMicToggle must be called on mic button click');
  h.teardown();
});

test('video button click calls onVideoToggle', () => {
  let calls = 0;
  const container = document.createElement('div');
  const h = mod.mount(container, Object.assign(defaultOpts(), { onVideoToggle() { calls++; } }));
  const bottom = container.children[0].children[2];
  const vidBtn = bottom.children[0].children[1];
  vidBtn.dispatchClick();
  assert.equal(calls, 1, 'onVideoToggle must be called on video button click');
  h.teardown();
});

test('note button click calls onNote', () => {
  let calls = 0;
  const container = document.createElement('div');
  const h = mod.mount(container, Object.assign(defaultOpts(), { onNote() { calls++; } }));
  const bottom = container.children[0].children[2];
  const noteBtn = bottom.children[0].children[2];
  noteBtn.dispatchClick();
  assert.equal(calls, 1, 'onNote must be called on note button click');
  h.teardown();
});

test('say button click calls onSay', () => {
  let calls = 0;
  const container = document.createElement('div');
  const h = mod.mount(container, Object.assign(defaultOpts(), { onSay() { calls++; } }));
  const bottom = container.children[0].children[2];
  const sayBtn = bottom.children[0].children[3];
  sayBtn.dispatchClick();
  assert.equal(calls, 1, 'onSay must be called on say button click');
  h.teardown();
});

// ---------------------------------------------------------------------------
// appendChatMsg (Sprint 9)
// ---------------------------------------------------------------------------

test('mount returns appendChatMsg function on handle', () => {
  const container = document.createElement('div');
  const h = mod.mount(container, defaultOpts());
  assert.equal(typeof h.appendChatMsg, 'function');
  h.teardown();
});

test('appendChatMsg does not throw when sbChatDrawer is absent', () => {
  const container = document.createElement('div');
  const opts = Object.assign(defaultOpts(), { onSendChat() {} });
  // window.sbChatDrawer is not set in test env; appendChatMsg should be a no-op.
  const h = mod.mount(container, opts);
  assert.doesNotThrow(() => h.appendChatMsg('teacher', 'hi'));
  h.teardown();
});

test('appendChatMsg routes to chatDrawer.appendMsg when drawer is present', () => {
  const msgs = [];
  const fakeDrawer = {
    node: document.createElement('div'),
    open() {},
    close() {},
    toggle() {},
    appendMsg(from, text) { msgs.push({ from, text }); },
    hasUnread() { return false; },
  };
  // Inject a fake sbChatDrawer into globalThis (what session-ui.js reads in Node).
  const savedDrawer = globalThis.sbChatDrawer;
  globalThis.sbChatDrawer = { buildChatDrawer() { return fakeDrawer; } };

  const container = document.createElement('div');
  const opts = Object.assign(defaultOpts(), { onSendChat() {} });
  const h = mod.mount(container, opts);
  h.appendChatMsg('teacher', 'hello');
  assert.deepEqual(msgs, [{ from: 'teacher', text: 'hello' }]);
  h.teardown();

  globalThis.sbChatDrawer = savedDrawer;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOpts() {
  return {
    role: 'teacher',
    remoteName: 'Alex',
    remoteRoleLabel: 'Student',
    localStream: null,
    remoteStream: null,
    headphonesConfirmed: false,
    micEnabled: true,
    videoEnabled: true,
    onMicToggle() {},
    onVideoToggle() {},
    onEnd() {},
    onNote() {},
    onSay() {},
  };
}
