// Small, deliberately unobtrusive render-rate readout, shown on each plot
// only while debug mode is on (gear panel -> Diagnostics).
//
// Measures the rate the HOST actually paints at, not requestAnimationFrame's
// own cadence: the caller ticks this once per real draw, so a plot that is
// gated to 30fps reads ~30 and one that is starving reads what it really
// achieves. That distinction is the whole point — a counter driven by rAF
// would read ~60 on both.
import { createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { debugMode } from '$decoder-lib/debugMode'

export interface FpsCounter {
  /** Call once per completed draw. */
  tick(): void
}

/** Creates a counter plus the badge element that displays it. The counter is
 *  safe to tick unconditionally — it costs an increment when debug mode is
 *  off, and the badge renders nothing. */
export function createFpsBadge(label?: string): { counter: FpsCounter; Badge: () => JSX.Element } {
  const [fps, setFps] = createSignal(0)
  let frames = 0
  let since = performance.now()

  const counter: FpsCounter = {
    tick() {
      frames++
      const now = performance.now()
      const elapsed = now - since
      // One update per second: frequent enough to notice a stall, slow
      // enough that the number is readable rather than flickering.
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed))
        frames = 0
        since = now
      }
    },
  }

  // Reset rather than freeze when the plot stops drawing entirely — a stale
  // number left on screen would read as "still rendering at 30fps".
  const idle = setInterval(() => {
    if (performance.now() - since > 2000) {
      setFps(0)
      frames = 0
      since = performance.now()
    }
  }, 1000)
  onCleanup(() => clearInterval(idle))

  const Badge = () => (
    <Show when={debugMode()}>
      <span
        class="pointer-events-none absolute top-1 right-1 z-20 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[9px] leading-none text-[#8b949e]"
        title={`${label ? label + ' — ' : ''}render rate (debug mode)`}
      >
        {fps()} fps
      </span>
    </Show>
  )

  return { counter, Badge }
}
