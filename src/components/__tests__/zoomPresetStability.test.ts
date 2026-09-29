// The zoom preset chips (1k/2k/3k/…/full) were near-impossible to click on
// the raw I/Q tap: they appeared to blink on hover and never took the click.
//
// Cause: in I/Q mode the panel's sourceMaxHz() reads iqBridge.state(), and
// that whole state object is replaced many times a second by the signal
// meter (useIQBridge's updateSignalMeter). Anything memoised directly over
// it therefore recomputed at frame rate, rebuilding the chip array and — via
// a <For> keyed on object identity — recreating every <button>. A button
// replaced under the pointer loses :hover and never receives the click.
//
// The fix is to narrow the dependency to the CAP VALUE, so an unchanged
// sample rate stops the cascade at Solid's equality check. This pins that.
import { createRoot, createMemo, createSignal } from 'solid-js';
import { computeZoomPresets } from '../SignalAnalysisPanel';

/** Mirrors the panel's chain: state object -> maxHz getter -> cap -> presets. */
function buildChain(sampleRateHz: number) {
  // Stands in for iqBridge.state(): a NEW object every update, exactly as
  // setState(s => ({...s, iqSignalDbfs})) produces.
  const [state, setState] = createSignal({ sampleRateHz, iqSignalDbfs: -60 });

  // Raw I/Q: bipolar, and both edges resolve through the churning state.
  const source = () => ({
    get minHz() { return -state().sampleRateHz / 2 },
    get maxHz() { return state().sampleRateHz / 2 },
  });

  let presetRuns = 0;
  const presetSpanLoHz = createMemo(() => source().minHz);
  const presetSpanHiHz = createMemo(() => source().maxHz);
  const zoomPresets = createMemo(() => {
    presetRuns++;
    return computeZoomPresets(presetSpanLoHz(), presetSpanHiHz());
  });

  return {
    zoomPresets,
    runs: () => presetRuns,
    pushMeterUpdate: (dbfs: number) => setState((s) => ({ ...s, iqSignalDbfs: dbfs })),
    setSampleRate: (hz: number) => setState((s) => ({ ...s, sampleRateHz: hz })),
  };
}

describe('zoom preset stability under a churning I/Q state', () => {
  it('does not rebuild the presets when only the signal meter updates', () => {
    createRoot((dispose) => {
      const c = buildChain(48_000);
      c.zoomPresets();
      const before = c.runs();

      // A second or so of meter updates at frame rate.
      for (let i = 0; i < 60; i++) {
        c.pushMeterUpdate(-60 + i * 0.1);
        c.zoomPresets();
      }

      // The sample rate never changed, so the chips must not have been
      // rebuilt — that rebuild is what stole :hover from the pointer.
      expect(c.runs()).toBe(before);
      dispose();
    });
  });

  it('keeps the same preset objects across meter updates', () => {
    createRoot((dispose) => {
      const c = buildChain(48_000);
      const first = c.zoomPresets();
      c.pushMeterUpdate(-42);
      // Identity matters: <For> keys on it, so a new array/object means new
      // DOM elements.
      expect(c.zoomPresets()).toBe(first);
      dispose();
    });
  });

  it('still rebuilds when the sample rate genuinely changes', () => {
    createRoot((dispose) => {
      const c = buildChain(48_000);
      const before = c.zoomPresets();
      c.setSampleRate(6_000);
      const after = c.zoomPresets();

      expect(after).not.toBe(before);
      // A 6kHz sample rate spans -3k..+3k, so only widths under 6k survive
      // and the widest becomes the "full" chip.
      expect(after.map((p) => p.label)).toEqual(['1k', '2k', '3k', '6k (full)']);
      dispose();
    });
  });
});
