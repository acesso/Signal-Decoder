/// <reference types="audioworklet" />
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
class CaptureForwarderProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
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
