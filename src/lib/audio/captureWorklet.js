// Shared AudioWorkletProcessor: a thin raw-sample forwarder, nothing else.
// Runs on the browser's dedicated real-time audio thread (not the main
// thread), so it isn't subject to the jank ScriptProcessorNode has —
// ScriptProcessorNode's onaudioprocess runs on the main thread and can be
// delayed by anything else busy there (React/Solid re-renders, GC pauses,
// synchronous decode work), which can drop or corrupt captured/played audio.
//
// Deliberately does ZERO decoding/decision logic — every call site's actual
// decoder (CW/RTTY/SSTV/MFSK/FT8 state machines, WASM instances, Solid
// signals) stays exactly where it already lives, on the main thread. This
// processor only copies each render quantum's samples out via its port;
// callers batch those into the buffer size they need (matching what each
// site's old createScriptProcessor(bufferSize, ...) used) before running
// their existing per-chunk logic unchanged.
//
// AudioWorkletGlobalScope has no window/document — only what's registered
// here and what arrives via the MessagePort are available.
//
// Plain JS, not TS: this file is loaded via
// `audioWorklet.addModule(new URL('./captureWorklet.js', import.meta.url))`
// (see captureNode.ts) — Vite has built-in bundling/transpilation support
// for that `new URL(...)` pattern with `new Worker(...)`, but NOT with
// AudioWorklet's addModule(); a .ts version here gets inlined as a raw,
// untranspiled data: URL in production builds (works fine in dev, where
// Vite's dev server transpiles .ts on the fly), and the browser's real JS
// parser then fails on the TS-only syntax (typed params/return) with
// "SyntaxError: missing ) after formal parameters". Plain JS sidesteps the
// gap entirely since there's nothing to transpile.
class CaptureForwarderProcessor extends AudioWorkletProcessor {
  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      // copy — `input` is a reused buffer owned by the audio thread, unsafe
      // to transfer/hold onto past this call.
      this.port.postMessage(input.slice());
    }
    return true; // keep the processor alive for the graph's lifetime
  }
}

registerProcessor('capture-forwarder', CaptureForwarderProcessor);

// Stereo variant, for soundcard I/Q capture (see useIQBridge.ts's
// startSoundcard()). A direct-sampling/quadrature receiver presents I on the
// left channel and Q on the right, so both channels have to reach the main
// thread — capture-forwarder above deliberately forwards only channel 0,
// which is correct for every mono decoder but would silently discard Q here.
//
// Forwards ONE interleaved I,Q,I,Q... buffer rather than two arrays: that is
// exactly the layout useIQBridge's whole pipeline already expects from the
// bridge WebSocket (feedIQSamples), so the soundcard path joins it with no
// reshaping and no second format to keep in sync.
class IQCaptureForwarderProcessor extends AudioWorkletProcessor {
  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const input = inputs[0];
    const i = input?.[0];
    // A mono device connected by mistake would leave [1] undefined; fall
    // back to the same channel so the stream stays well-formed (it will
    // demodulate as a real-valued signal with mirrored spectrum, which is
    // a legible symptom, rather than throwing on every quantum).
    const q = input?.[1] ?? i;
    if (i && i.length > 0 && q) {
      const out = new Float32Array(i.length * 2);
      for (let n = 0; n < i.length; n++) {
        out[n * 2] = i[n];
        out[n * 2 + 1] = q[n];
      }
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('iq-capture-forwarder', IQCaptureForwarderProcessor);
