// Spectrogram color palettes — single source of truth for every renderer.
// GLSpectrogram uploads the LUT as a 256×1 texture its shaders sample, and
// the CPU-fallback waterfall indexes the same table directly, so GPU and CPU
// output stay pixel-identical per palette.

export const COLORMAPS = ['turbo', 'viridis', 'inferno', 'jet', 'gray', 'green'] as const
export type ColormapName = (typeof COLORMAPS)[number]

export const COLORMAP_LABEL: Record<ColormapName, string> = {
  turbo: 'Turbo',
  viridis: 'Viridis',
  inferno: 'Inferno',
  jet: 'Jet',
  gray: 'Grayscale',
  green: 'Green',
}

// Turbo — same polynomial fit the terrain shader used before this table
// existed (Google's Turbo, McNames/Zucker fit), so the default look is
// unchanged.
function turbo(t: number): [number, number, number] {
  const t2 = t * t
  const t3 = t2 * t
  const t4 = t2 * t2
  const t5 = t4 * t
  const r = 0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5
  const g = 0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5
  const b = 0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5
  return [r, g, b]
}

// Viridis / Inferno — matplotlib anchor colors, linearly interpolated.
const VIRIDIS_STOPS = ['#440154', '#482878', '#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']
const INFERNO_STOPS = ['#000004', '#1b0c42', '#4b0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9a06', '#f7d03c', '#fcffa4']

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255]
}

function fromStops(stops: string[], t: number): [number, number, number] {
  const f = t * (stops.length - 1)
  const i0 = Math.min(Math.floor(f), stops.length - 2)
  const k = f - i0
  const a = hexRgb(stops[i0])
  const b = hexRgb(stops[i0 + 1])
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

// Classic MATLAB-style jet.
function jet(t: number): [number, number, number] {
  return [1.5 - Math.abs(4 * t - 3), 1.5 - Math.abs(4 * t - 2), 1.5 - Math.abs(4 * t - 1)]
}

// Mono green phosphor — black → green → washed top, like classic SDR waterfalls.
function green(t: number): [number, number, number] {
  const w = Math.pow(t, 1.7)
  return [w, t, w * 0.45]
}

export function colormapRGB(name: ColormapName, t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  let c: [number, number, number]
  switch (name) {
    case 'viridis': c = fromStops(VIRIDIS_STOPS, x); break
    case 'inferno': c = fromStops(INFERNO_STOPS, x); break
    case 'jet':     c = jet(x); break
    case 'gray':    c = [x, x, x]; break
    case 'green':   c = green(x); break
    default:        c = turbo(x)
  }
  return [Math.max(0, Math.min(1, c[0])), Math.max(0, Math.min(1, c[1])), Math.max(0, Math.min(1, c[2]))]
}

export const COLORMAP_LUT_SIZE = 256

/** 256×1 RGBA byte table for a palette — texture upload or direct indexing. */
export function buildColormapLUT(name: ColormapName): Uint8Array {
  const lut = new Uint8Array(COLORMAP_LUT_SIZE * 4)
  for (let i = 0; i < COLORMAP_LUT_SIZE; i++) {
    const [r, g, b] = colormapRGB(name, i / (COLORMAP_LUT_SIZE - 1))
    lut[i * 4] = Math.round(r * 255)
    lut[i * 4 + 1] = Math.round(g * 255)
    lut[i * 4 + 2] = Math.round(b * 255)
    lut[i * 4 + 3] = 255
  }
  return lut
}
