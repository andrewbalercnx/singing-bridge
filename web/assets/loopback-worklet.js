// File: web/assets/loopback-worklet.js
// Purpose: AudioWorkletProcessor that forwards captured input blocks
//          to the main thread via MessagePort transfer (no
//          SharedArrayBuffer — avoids the COOP/COEP requirement).
// Role: Renders on the audio render thread; main-thread cross-
//       correlation happens in loopback.js.
// Last updated: Sprint 2 (2026-04-17) -- initial implementation

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;
    // Copy into a fresh ArrayBuffer so we can transfer it without
    // affecting the render thread's view.
    const out = new Float32Array(ch.length);
    out.set(ch);
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}

registerProcessor('sb-capture', CaptureProcessor);
