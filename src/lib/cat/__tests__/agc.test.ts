import { AGC } from '../useIQBridge'

// Ported from the uSDX firmware's own "M0PUB" AGC (process_agc() in
// usdxBLACKBRICK.ino) — these tests confirm the ported behavior matches
// the firmware's own three-part shape (fast attack, windowed slow decay,
// settle-into-a-window rather than hunt), not just that SOME gain change
// happens.

function constantTone(amplitude: number, count: number): Float32Array {
  const out = new Float32Array(count)
  for (let n = 0; n < count; n++) out[n] = amplitude * Math.sin((2 * Math.PI * 700 * n) / 48000)
  return out
}

describe('AGC', () => {
  it('attenuates a strong signal quickly (fast attack)', () => {
    const agc = new AGC()
    const strong = constantTone(0.8, 2000) // well above the ~4/128*1.5 upper threshold
    const before = strong.slice(0, 50)
    agc.process(strong)
    const beforePeak = Math.max(...Array.from(before).map(Math.abs))
    const afterPeak = Math.max(...Array.from(strong.slice(-50)).map(Math.abs))
    expect(afterPeak).toBeLessThan(beforePeak * 0.5)
  })

  it('amplifies a weak signal over the decay window (slow, not instant)', () => {
    const agc = new AGC()
    const weak = constantTone(0.01, 5000) // well below the ~4/128 lower threshold
    const firstWindow = weak.slice(0, 400)
    agc.process(weak)
    const firstWindowPeakAfter = Math.max(...Array.from(weak.slice(0, 400)).map(Math.abs))
    const laterPeak = Math.max(...Array.from(weak.slice(-400)).map(Math.abs))
    // Gain should have ramped up substantially by the end, but the FIRST
    // decay window shouldn't already be fully amplified — the ramp is
    // gated by AGC_WINDOW_SAMPLES, not instant.
    expect(laterPeak).toBeGreaterThan(firstWindowPeakAfter * 2)
    void firstWindow
  })

  it('settles a signal already inside the target window without runaway gain change', () => {
    const agc = new AGC()
    // Amplitude picked to sit inside [lowerThreshold, upperThreshold] from
    // the very first sample — a well-behaved AGC should leave gain close
    // to 1 rather than hunting.
    const inWindow = constantTone((4 / 128 + 4 * 1.5 / 128) / 2, 5000)
    const first = Math.max(...Array.from(inWindow.slice(0, 50)).map(Math.abs))
    agc.process(inWindow)
    const last = Math.max(...Array.from(inWindow.slice(-50)).map(Math.abs))
    // Should stay within the same order of magnitude — not clamp to
    // AGC_GAIN_MIN/MAX, and not oscillate wildly.
    expect(last).toBeGreaterThan(first * 0.3)
    expect(last).toBeLessThan(first * 3)
  })
})
