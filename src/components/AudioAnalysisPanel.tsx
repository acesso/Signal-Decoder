// Port of src/components/AudioAnalysisPanel.tsx (Next.js app).
import { createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import GLSpectrogram, { type GLSpectrogramHandle, type SpectroBand } from './GLSpectrogram'
import { loadNumber, saveNumber, loadString, saveString } from '$decoder-lib/storage'
import { buildColormapLUT, COLORMAPS, COLORMAP_LABEL, type ColormapName } from '$decoder-lib/colormaps'
import NumberField from './NumberField'

// Both views render on the GPU (GLSpectrogram); the old CPU 2D-canvas
// pipeline survives only as an automatic fallback when WebGL init fails.
// A previously-stored 'legacy' value fails validation in loadString and
// falls back to 'waterfall' — its GPU replacement.
type SpectrogramView = 'waterfall' | 'terrain'
const SPECTROGRAM_VIEWS = ['waterfall', 'terrain'] as const

const LS_SG_VIEW = 'sg_view_mode'
const LS_SG_GAMMA = 'sg_gamma'
const LS_SG_3D_SPEED = 'sg_3d_speed'
const LS_SG_2D_SPEED = 'sg_2d_speed'
const LS_SG_3D_SMOOTH = 'sg_3d_smooth'
const LS_SG_BAND_ALPHA = 'sg_band_alpha'

// The ruler used to be painted into a reserved bottom band of this canvas —
// it's now a separate HTML strip below the canvas (see FreqRuler), so the
// full canvas height is plot area.
const CANVAS_H = 200
const PLOT_H = CANVAS_H

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [isNaN(r) ? 100 : r, isNaN(g) ? 100 : g, isNaN(b) ? 100 : b]
}

function niceTicks(span: number): { maj: number; min: number } {
  const targets = [25, 50, 100, 200, 250, 500, 1000, 1500, 2000, 2500, 5000]
  const majStep = targets.find((s) => span / s <= 12) ?? Math.ceil(span / 12 / 1000) * 1000
  return { maj: majStep, min: majStep / 5 }
}

interface FreqTick {
  x: number // 0..1 fraction across the span
  isMaj: boolean
  label: string | null
}

// Pure tick geometry, shared by the canvas grid-line pass and the HTML ruler
// rendered outside the plot box (see FreqRuler below).
function computeTicks(minF: number, maxF: number, vfoHz = 0): FreqTick[] {
  const span = maxF - minF
  if (span <= 0) return []
  const { maj, min } = niceTicks(span)
  const out: FreqTick[] = []
  const firstMin = Math.ceil(minF / min) * min
  for (let f = firstMin; f <= maxF + min * 0.5; f += min) {
    const x = (f - minF) / span
    if (x < 0 || x > 1) continue
    const isMaj = Math.round(f / maj) * maj === Math.round(f)
    let label: string | null = null
    if (isMaj) {
      if (vfoHz > 0) {
        const absHz = vfoHz + f
        const mhzInt = Math.floor(absHz / 1_000_000)
        const khzFrac = Math.round((absHz % 1_000_000) / 1000)
        label = `${mhzInt}.${String(khzFrac).padStart(3, '0')}`
      } else {
        label = f >= 1000 ? `${(f / 1000).toFixed(f % 1000 === 0 ? 0 : 1)}k` : `${f}`
      }
    }
    out.push({ x, isMaj, label })
  }
  return out
}

// Faint vertical grid lines at major ticks, drawn INTO the plot canvas itself
// (used by the waterfall, which benefits from gridlines through the image).
// The ruler's own tick marks/labels are rendered as HTML outside the canvas
// by FreqRuler — this function no longer draws them.
function drawGridLines(ctx: CanvasRenderingContext2D, w: number, pH: number, minF: number, maxF: number) {
  for (const t of computeTicks(minF, maxF)) {
    if (!t.isMaj) continue
    const x = t.x * w
    ctx.strokeStyle = 'rgba(48,54,61,0.6)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, pH)
    ctx.stroke()
  }
}

// HTML frequency ruler, rendered as a sibling strip BELOW the spectrum/
// waterfall canvas instead of painted into it — keeps the full canvas height
// available for signal data and gives crisper, denser tick labels than the
// old canvas-drawn axis band.
function FreqRuler(props: { minHz: number; maxHz: number; vfoHz?: number }): JSX.Element {
  const ticks = createMemo(() => computeTicks(props.minHz, props.maxHz, props.vfoHz ?? 0))
  return (
    <div class="relative h-4 select-none">
      {ticks().map((t) => (
        <div
          class="absolute top-0 flex flex-col items-center"
          style={{ left: `${t.x * 100}%`, transform: 'translateX(-50%)' }}
        >
          <div class={`w-px ${t.isMaj ? 'h-2 bg-[#8b949e]' : 'h-1 bg-[#3d444d]'}`} />
          {t.label && <span class="font-mono text-[9px] text-[#8b949e] leading-tight">{t.label}</span>}
        </div>
      ))}
    </div>
  )
}

// TX marker color — red: clearly visible over the waterfall's dark-blue
// quiet floor (a blue marker blended right into it).
const TX_MARKER_COLOR = '#f85149'

function drawTxMarker(ctx: CanvasRenderingContext2D, w: number, h: number, txHz: number, minHz: number, maxHz: number) {
  const span = maxHz - minHz
  if (txHz < minHz || txHz > maxHz) return
  const x = ((txHz - minHz) / span) * w
  ctx.save()
  ctx.strokeStyle = TX_MARKER_COLOR
  ctx.lineWidth = 1.5
  ctx.shadowColor = TX_MARKER_COLOR
  ctx.shadowBlur = 6
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.font = '9px monospace'
  ctx.textAlign = x > w * 0.85 ? 'right' : 'left'
  ctx.fillStyle = TX_MARKER_COLOR
  ctx.fillText(`TX ${txHz}Hz`, x + (x > w * 0.85 ? -4 : 4), 10)
  ctx.restore()
}

function drawSqGrid(
  ctx: CanvasRenderingContext2D,
  cW: number,
  pH: number,
  fd: Uint8Array,
  sql: number,
  gCols: number,
  gRows: number,
  channels: AudioMarker[],
  minHz: number,
  maxHz: number,
  halfBw: number,
) {
  const span = maxHz - minHz
  const cH = pH / gRows
  const cWc = cW / gCols
  const sqlF = sql / 100
  const colCh: (AudioMarker | null)[] = Array(gCols).fill(null)
  for (let c = 0; c < gCols; c++) {
    const cf = minHz + ((c + 0.5) / gCols) * span
    for (const ch of channels) {
      const bw = halfBw
      if (cf >= ch.freq - bw && cf <= ch.freq + bw) {
        colCh[c] = ch
        break
      }
    }
  }
  for (let c = 0; c < gCols; c++) {
    const f0 = Math.floor((c / gCols) * fd.length)
    const f1 = Math.min(Math.ceil(((c + 1) / gCols) * fd.length), fd.length)
    let pk = 0
    for (let f = f0; f < f1; f++) if (fd[f] > pk) pk = fd[f]
    const aF = pk / 255
    const col = colCh[c]
    const [lr, lg, lb] = col ? hexToRgb(col.color) : [227, 179, 65]
    for (let r = 0; r < gRows; r++) {
      const x = c * cWc,
        y = r * cH,
        rb = 1 - (r + 1) / gRows
      if (aF > rb) {
        if (rb >= sqlF || sql === 0) {
          ctx.fillStyle = `rgba(${lr},${lg},${lb},${Math.min(0.92, 0.35 + (aF - rb) * gRows * 0.55)})`
        } else {
          ctx.fillStyle = `rgba(${lr},${lg},${lb},0.12)`
        }
        ctx.fillRect(x + 0.5, y + 0.5, cWc - 1, cH - 1)
      }
    }
  }
  ctx.strokeStyle = 'rgba(48,54,61,.55)'
  ctx.lineWidth = 0.5
  ctx.setLineDash([])
  ctx.beginPath()
  for (let c = 0; c <= gCols; c++) {
    ctx.moveTo(c * cWc, 0)
    ctx.lineTo(c * cWc, pH)
  }
  for (let r = 0; r <= gRows; r++) {
    ctx.moveTo(0, r * cH)
    ctx.lineTo(cW, r * cH)
  }
  ctx.stroke()
  if (sql > 0) {
    const sY = pH * (1 - sqlF)
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 2])
    ctx.strokeStyle = '#e3b341'
    ctx.beginPath()
    ctx.moveTo(0, sY)
    ctx.lineTo(cW, sY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#e3b341'
    ctx.beginPath()
    ctx.moveTo(0, sY - 5)
    ctx.lineTo(9, sY)
    ctx.lineTo(0, sY + 5)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cW, sY - 5)
    ctx.lineTo(cW - 9, sY)
    ctx.lineTo(cW, sY + 5)
    ctx.closePath()
    ctx.fill()
    ctx.font = '9px monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#e3b341'
    ctx.fillText(`SQL ${sql}%`, 12, sY > 12 ? sY - 3 : sY + 12)
  }
}

function drawChannelMarker(
  ctx: CanvasRenderingContext2D,
  cW: number,
  pH: number,
  freq: number,
  color: string,
  label: string,
  halfBw: number,
  minHz: number,
  maxHz: number,
) {
  const [r, g, b] = hexToRgb(color)
  const span = maxHz - minHz
  const tX = ((freq - minHz) / span) * cW
  const lo = Math.max(0, ((freq - halfBw - minHz) / span) * cW)
  const hi = Math.min(cW, ((freq + halfBw - minHz) / span) * cW)
  ctx.fillStyle = `rgba(${r},${g},${b},.07)`
  ctx.fillRect(lo, 0, hi - lo, pH)
  ctx.lineWidth = 1
  ctx.setLineDash([2, 4])
  ctx.strokeStyle = `rgba(${r},${g},${b},.30)`
  ctx.beginPath()
  ctx.moveTo(lo, 0)
  ctx.lineTo(lo, pH)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(hi, 0)
  ctx.lineTo(hi, pH)
  ctx.stroke()
  ctx.setLineDash([])
  // Solid line with a soft glow — same visual as the GL waterfall's DOM
  // marker lines, so the marker reads identically across both boxes.
  ctx.save()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6
  ctx.beginPath()
  ctx.moveTo(tX, 0)
  ctx.lineTo(tX, pH)
  ctx.stroke()
  ctx.restore()
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(label, tX, 14)
}

export interface AudioMarker {
  freq: number
  color: string
  label: string
  bandwidthHz?: number
}

interface GLBand {
  freq: number
  color: string
}

interface Props {
  analyser: AnalyserNode | null
  isRecording: boolean
  markers?: AudioMarker[]
  onMarkerDrag?: (index: number, newFreq: number) => void
  squelch?: number
  onSquelchChange?: (v: number) => void
  showGrid?: boolean
  gridSize?: number
  defaultMaxHz?: number
  glBands?: GLBand[]
  vfoFrequency?: number
  txMarkerHz?: number
  /** Label for the marker readout above the canvas — defaults to "Center". */
  markerFieldLabel?: string
  class?: string
  style?: JSX.CSSProperties
  storageKeyPrefix?: string
}

export default function AudioAnalysisPanel(props: Props): JSX.Element {
  const defaultMaxHz = () => props.defaultMaxHz ?? 3000
  const lsMinHz = props.storageKeyPrefix ? `${props.storageKeyPrefix}_sg_display_min_hz` : null
  const lsMaxHz = props.storageKeyPrefix ? `${props.storageKeyPrefix}_sg_display_max_hz` : null

  const [displayMinHz, setDisplayMinHz] = createSignal(lsMinHz ? loadNumber(lsMinHz, 0) : 0)
  const [displayMaxHz, setDisplayMaxHz] = createSignal(lsMaxHz ? loadNumber(lsMaxHz, defaultMaxHz()) : defaultMaxHz())
  const [sgView, setSgView] = createSignal<SpectrogramView>(loadString(LS_SG_VIEW, 'waterfall', SPECTROGRAM_VIEWS))
  // WebGL init/shader failure → swap the spectrogram to the CPU 2D pipeline.
  const [glFailed, setGlFailed] = createSignal(false)
  // Palette — persisted PER MODE (unlike view/gamma/speed, which are global):
  // each decoder gets its own preference via storageKeyPrefix.
  const lsCmap = props.storageKeyPrefix ? `${props.storageKeyPrefix}_sg_colormap` : 'sg_colormap'
  const [colormap, setColormap] = createSignal<ColormapName>(loadString(lsCmap, 'turbo', COLORMAPS))
  createEffect(() => saveString(lsCmap, colormap()))
  // Same 256-entry table the GL shaders sample — used by the CPU fallback.
  const cmapLUT = createMemo(() => buildColormapLUT(colormap()))
  const [sgGamma, setSgGamma] = createSignal(loadNumber(LS_SG_GAMMA, 2.0))
  const [sg3dSpeed, setSg3dSpeed] = createSignal(loadNumber(LS_SG_3D_SPEED, 80))
  const [sg2dSpeed, setSg2dSpeed] = createSignal(loadNumber(LS_SG_2D_SPEED, 16))
  const [sg3dSmooth, setSg3dSmooth] = createSignal(loadNumber(LS_SG_3D_SMOOTH, 0.35))
  const [bandAlpha, setBandAlpha] = createSignal(loadNumber(LS_SG_BAND_ALPHA, 0.3))

  createEffect(() => saveNumber(LS_SG_GAMMA, sgGamma()))
  createEffect(() => saveNumber(LS_SG_3D_SPEED, sg3dSpeed()))
  createEffect(() => saveNumber(LS_SG_2D_SPEED, sg2dSpeed()))
  createEffect(() => saveNumber(LS_SG_3D_SMOOTH, sg3dSmooth()))
  createEffect(() => saveNumber(LS_SG_BAND_ALPHA, bandAlpha()))
  createEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(LS_SG_VIEW, sgView())
  })
  createEffect(() => {
    if (lsMinHz) saveNumber(lsMinHz, displayMinHz())
  })
  createEffect(() => {
    if (lsMaxHz) saveNumber(lsMaxHz, displayMaxHz())
  })

  let specEl: HTMLCanvasElement | undefined
  let specWrapEl: HTMLDivElement | undefined
  let sgCanvEl: HTMLCanvasElement | undefined
  let sgOverlayEl: HTMLCanvasElement | undefined
  const glSg: { current: GLSpectrogramHandle | null } = { current: null }
  let rafId: number | null = null
  let sgContainerEl: HTMLDivElement | undefined
  const [sgH, setSgH] = createSignal(300)

  let fftBuf: Uint8Array<ArrayBuffer> | null = null
  let squelchDragging = false
  let markerDrag: { index: number; el: HTMLElement } | null = null

  // Row cadence follows the active view's Speed control (2D and 3D each keep
  // their own preference, as before).
  const glRowInterval = () => (sgView() === 'terrain' ? sg3dSpeed() : sg2dSpeed())
  createEffect(() => {
    glSg.current?.setRowInterval(glRowInterval())
  })
  createEffect(() => {
    const sm = sg3dSmooth()
    glSg.current?.setSmooth(sm)
  })

  function handleSpectrumMouseDown(e: MouseEvent) {
    const canvas = specEl
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const yRatio = (e.clientY - rect.top) / rect.height
    const canvasY = yRatio * CANVAS_H

    const sql = props.squelch ?? 0
    if (props.onSquelchChange && sql > 0) {
      const sqY = PLOT_H * (1 - sql / 100)
      if (Math.abs(canvasY - sqY) <= 8) {
        e.preventDefault()
        e.stopPropagation()
        squelchDragging = true
        return
      }
    }

    if (!props.onMarkerDrag) return
    const ms = props.markers ?? []
    if (!ms.length) return
    const xRatio = (e.clientX - rect.left) / rect.width
    const clickHz = displayMinHz() + xRatio * (displayMaxHz() - displayMinHz())
    let best = 0,
      bestDist = Infinity
    for (let i = 0; i < ms.length; i++) {
      const d = Math.abs(ms[i].freq - clickHz)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    e.preventDefault()
    e.stopPropagation()
    markerDrag = { index: best, el: canvas }
  }

  // When a mode has both draggable markers (ew cursor) and squelch (ns
  // cursor), the static class picks the marker cursor everywhere — hovering
  // the horizontal squelch line must show up/down arrows instead. Uses the
  // same 8px hit zone as the mousedown handler; clearing the inline style
  // falls back to the class-based cursor.
  function handleSpectrumHover(e: MouseEvent) {
    const canvas = specEl
    if (!canvas) return
    const sql = props.squelch ?? 0
    let nearSql = false
    if (props.onSquelchChange && sql > 0) {
      const rect = canvas.getBoundingClientRect()
      const canvasY = ((e.clientY - rect.top) / rect.height) * CANVAS_H
      const sqY = PLOT_H * (1 - sql / 100)
      nearSql = Math.abs(canvasY - sqY) <= 8
    }
    canvas.style.cursor = nearSql ? 'ns-resize' : ''
  }

  // Grip mousedown — used by the DOM grip handles over the spectrum and the
  // waterfall. `el` is the box whose horizontal extent maps to the displayed
  // frequency span (the drag's pixel→Hz reference).
  function startGripDrag(index: number, el: HTMLElement | undefined, e: MouseEvent) {
    if (!el || !props.onMarkerDrag) return
    e.preventDefault()
    e.stopPropagation()
    markerDrag = { index, el }
  }

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      if (squelchDragging && props.onSquelchChange) {
        e.preventDefault()
        const canvas = specEl
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
        const plotFraction = yRatio * (CANVAS_H / PLOT_H)
        const newSql = Math.round(Math.max(0, Math.min(100, (1 - plotFraction) * 100)))
        props.onSquelchChange(newSql)
        return
      }
      const drag = markerDrag
      if (!drag || !props.onMarkerDrag) return
      e.preventDefault()
      const rect = drag.el.getBoundingClientRect()
      const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const newHz = Math.round(displayMinHz() + xRatio * (displayMaxHz() - displayMinHz()))
      props.onMarkerDrag(drag.index, newHz)
    }
    const onUp = () => {
      markerDrag = null
      squelchDragging = false
    }
    window.addEventListener('mousemove', onMove, { passive: false })
    window.addEventListener('mouseup', onUp)
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  })

  onMount(() => {
    const el = sgContainerEl
    if (!el) return
    const ro = new ResizeObserver((e) => {
      const h = Math.round(e[0].contentRect.height)
      if (h > 60 && Math.abs(h - sgH()) > 4) setSgH(h)
    })
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  })

  const centerFreq = createMemo(() => {
    const markers = props.markers ?? []
    return markers.length
      ? Math.round(markers.reduce((s, m) => s + m.freq, 0) / markers.length)
      : Math.round((displayMinHz() + displayMaxHz()) / 2)
  })

  function drawSpectrum(canvas: HTMLCanvasElement): Uint8Array | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const minHz = displayMinHz(),
      maxHz = displayMaxHz()
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, canvas.width, CANVAS_H)
    if (!props.analyser) return null

    const bc = props.analyser.frequencyBinCount
    if (!fftBuf || fftBuf.length !== bc) fftBuf = new Uint8Array(bc) as Uint8Array<ArrayBuffer>
    const d = fftBuf
    props.analyser.getByteFrequencyData(d)
    const nq = props.analyser.context.sampleRate / 2
    const bin0 = Math.floor((minHz / nq) * bc)
    const bin1 = Math.min(Math.floor((maxHz / nq) * bc), bc)
    const vis = d.subarray(bin0, bin1)

    const ms = props.markers ?? []
    const showGrid = props.showGrid ?? false
    ctx.globalAlpha = showGrid ? 0.3 : 1
    ctx.strokeStyle = '#2ea043'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const bw = canvas.width / Math.max(1, vis.length)
    for (let i = 0; i < vis.length; i++) {
      const x = i * bw,
        y = PLOT_H - (vis[i] / 255) * PLOT_H
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.globalAlpha = 1

    const squelch = props.squelch ?? 0
    if (showGrid) {
      const gs = props.gridSize ?? 48
      const halfBw = ms.length > 0 && ms[0].bandwidthHz != null ? ms[0].bandwidthHz / 2 : 40
      drawSqGrid(ctx, canvas.width, PLOT_H, vis, squelch, gs * 2, gs, ms, minHz, maxHz, halfBw)
    } else if (squelch > 0) {
      const sy = PLOT_H * (1 - squelch / 100)
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = '#e3b341'
      ctx.beginPath()
      ctx.moveTo(0, sy)
      ctx.lineTo(canvas.width, sy)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#e3b341'
      ctx.font = '9px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`SQL ${squelch}%`, 12, sy > 12 ? sy - 3 : sy + 12)
    }

    for (const m of ms) {
      const halfBw = m.bandwidthHz != null ? m.bandwidthHz / 2 : 40
      drawChannelMarker(ctx, canvas.width, PLOT_H, m.freq, m.color, m.label, halfBw, minHz, maxHz)
    }
    const txMarkerHz = props.txMarkerHz ?? 0
    if (txMarkerHz > 0) {
      drawTxMarker(ctx, canvas.width, PLOT_H, txMarkerHz, minHz, maxHz)
    }
    return vis
  }

  function drawSpectrogram(canvas: HTMLCanvasElement, fd: Uint8Array) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const row = ctx.createImageData(canvas.width, 1)
    const lut = cmapLUT()
    for (let px = 0; px < canvas.width; px++) {
      const bf = (px / canvas.width) * (fd.length - 1),
        b0 = Math.floor(bf),
        b1 = Math.min(b0 + 1, fd.length - 1)
      const v = fd[b0] * (1 - (bf - b0)) + fd[b1] * (bf - b0)
      const g = sgGamma()
      const a = g === 1 ? v : Math.pow(v / 255, g) * 255
      const li = Math.max(0, Math.min(255, Math.round(a))) * 4
      const i = px * 4
      row.data[i] = lut[li]
      row.data[i + 1] = lut[li + 1]
      row.data[i + 2] = lut[li + 2]
      row.data[i + 3] = 255
    }
    ctx.putImageData(ctx.getImageData(0, 0, canvas.width, canvas.height - 1), 0, 1)
    ctx.putImageData(row, 0, 0)
  }

  function drawSgOverlay(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width,
      h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const minHz = displayMinHz(),
      maxHz = displayMaxHz()
    drawGridLines(ctx, w, h, minHz, maxHz)
    const txMarkerHz = props.txMarkerHz ?? 0
    if (txMarkerHz > 0) {
      drawTxMarker(ctx, w, h, txMarkerHz, minHz, maxHz)
    }
  }

  onMount(() => {
    let glLastTs = 0
    let sg2dLastTs = 0
    let spLastTs = 0
    const tick = (now: number) => {
      const sp = specEl,
        sg = sgCanvEl,
        ov = sgOverlayEl
      if (sp && now - spLastTs >= 33) {
        spLastTs = now
        const fd = drawSpectrum(sp)
        if (fd) {
          if (glFailed()) {
            // CPU fallback pipeline — only runs when WebGL is unavailable.
            if (sg && now - sg2dLastTs >= sg2dSpeed()) {
              sg2dLastTs = now
              drawSpectrogram(sg, fd)
            }
          } else if (now - glLastTs >= glRowInterval()) {
            glLastTs = now
            glSg.current?.pushRow(fd)
          }
        }
      }
      if (ov && glFailed()) drawSgOverlay(ov)
      glSg.current?.render()
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId)
    })
  })

  const glBandsComputed = createMemo<SpectroBand[]>(() =>
    props.glBands
      ? props.glBands.map((ch) => {
          const halfBw = 40
          return { fromHz: ch.freq - halfBw, toHz: ch.freq + halfBw, color: ch.color }
        })
      : (props.markers ?? []).map((m) => {
          const halfBw = m.bandwidthHz != null ? m.bandwidthHz / 2 : 40
          return { fromHz: m.freq - halfBw, toHz: m.freq + halfBw, color: m.color }
        }),
  )

  const glMarkers = createMemo<SpectroBand[]>(() =>
    (props.markers ?? []).map((m) => ({ fromHz: m.freq, toHz: m.freq, color: m.color })),
  )

  function applyCenterShift(newCenter: number) {
    if (!props.onMarkerDrag) return
    const delta = newCenter - centerFreq()
    if (delta === 0) return
    const markers = props.markers ?? []
    markers.forEach((_, i) => {
      props.onMarkerDrag!(i, markers[i].freq + delta)
    })
  }

  // Triangular grab handles for the draggable markers — DOM elements rather
  // than canvas pixels, so they overflow a little above the box edge and give
  // a wide, obvious mouse target. Rendered over both the spectrum and the 2D
  // waterfall; `host` is the box whose width maps to the displayed frequency
  // span during the drag.
  const MarkerGrips = (p: { host: () => HTMLElement | undefined }) => (
    <>
      {props.onMarkerDrag &&
        (props.markers ?? []).map((m, i) => {
          const span = displayMaxHz() - displayMinHz()
          const frac = span > 0 ? (m.freq - displayMinHz()) / span : -1
          if (frac < 0 || frac > 1) return null
          return (
            <div
              class="absolute z-10 cursor-ew-resize select-none"
              style={{ left: `${frac * 100}%`, top: '-7px', transform: 'translateX(-50%)' }}
              title={`Drag to move ${m.label}`}
              onMouseDown={(e) => startGripDrag(i, p.host(), e)}
            >
              <svg width="18" height="15" viewBox="0 0 18 15">
                <path d="M1 1 L17 1 L9 14 Z" fill={m.color} stroke="rgba(13,17,23,0.7)" stroke-width="1.5" />
              </svg>
            </div>
          )
        })}
    </>
  )

  return (
    <div
      class={`flex flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4${props.class ? ` ${props.class}` : ''}`}
      style={props.style}
    >
      <div class="mb-2 shrink-0">
        <h2 class="text-lg font-semibold sm:text-xl">Audio Analysis</h2>
      </div>

      <div class="shrink-0">
        {(props.markers ?? []).length > 0 && (
          <div class="mb-1.5 flex items-center gap-2 text-xs text-[#8b949e]">
            <span class="shrink-0">{props.markerFieldLabel ?? 'Center'}</span>
            {props.vfoFrequency ? (
              <span class="w-24 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-xs text-[#c9d1d9]">
                {(() => {
                  const absHz = props.vfoFrequency! + centerFreq()
                  const mhzInt = Math.floor(absHz / 1_000_000)
                  const khzFrac = Math.round((absHz % 1_000_000) / 1000)
                  return `${mhzInt}.${String(khzFrac).padStart(3, '0')}`
                })()}
              </span>
            ) : (
              <NumberField
                value={centerFreq()}
                min={50}
                max={displayMaxHz()}
                onCommit={applyCenterShift}
                readOnly={!props.onMarkerDrag}
                class={`w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none ${!props.onMarkerDrag ? 'cursor-default opacity-60' : ''}`}
              />
            )}
            <span class="shrink-0 text-[#484f58]">{props.vfoFrequency ? 'MHz' : 'Hz'}</span>
            <span class="ml-auto text-[10px] text-[#484f58]">
              {(props.markers ?? []).length} marker{(props.markers ?? []).length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        <div ref={specWrapEl} class="relative">
          <canvas
            ref={specEl}
            width={640}
            height={CANVAS_H}
            class={`block w-full touch-manipulation rounded border border-[#30363d] bg-[#0a0a0a] ${
              props.onMarkerDrag ? 'cursor-ew-resize' : props.onSquelchChange ? 'cursor-ns-resize' : 'cursor-crosshair'
            }`}
            onMouseDown={props.onMarkerDrag || props.onSquelchChange ? handleSpectrumMouseDown : undefined}
            onMouseMove={props.onSquelchChange ? handleSpectrumHover : undefined}
          />
          <MarkerGrips host={() => specWrapEl} />
          {props.onSquelchChange && (
            <div
              class="absolute z-10 cursor-ns-resize select-none"
              style={{
                right: '-8px',
                top: `${(1 - (props.squelch ?? 0) / 100) * 100}%`,
                transform: 'translateY(-50%)',
              }}
              title="Drag to set squelch"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                squelchDragging = true
              }}
            >
              <svg width="15" height="18" viewBox="0 0 15 18">
                <path d="M14 1 L14 17 L1 9 Z" fill="#e3b341" stroke="rgba(13,17,23,0.7)" stroke-width="1.5" />
              </svg>
            </div>
          )}
        </div>
        <FreqRuler minHz={displayMinHz()} maxHz={displayMaxHz()} vfoHz={props.vfoFrequency} />

        <div class="mt-1 flex items-center gap-1.5 text-[10px] text-[#8b949e]">
          <span class="shrink-0">View</span>
          <input
            type="number"
            min={0}
            max={displayMaxHz() - 100}
            step={100}
            value={displayMinHz()}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value)
              if (!isNaN(v)) setDisplayMinHz(Math.max(0, Math.min(displayMaxHz() - 100, v)))
            }}
            class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
          />
          <span class="shrink-0 text-[#484f58]">–</span>
          <input
            type="number"
            min={displayMinHz() + 100}
            max={24000}
            step={100}
            value={displayMaxHz()}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value)
              if (!isNaN(v)) setDisplayMaxHz(Math.max(displayMinHz() + 100, Math.min(24000, v)))
            }}
            class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
          />
          <span class="shrink-0 text-[#484f58]">Hz</span>
          {[1000, 2000, 3000, 4000].map((mx) => (
            <button
              onClick={() => {
                setDisplayMinHz(0)
                setDisplayMaxHz(mx)
              }}
              class={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${
                displayMinHz() === 0 && displayMaxHz() === mx
                  ? 'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]'
                  : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
              }`}
            >
              {mx / 1000}k
            </button>
          ))}
        </div>

        <div class="mt-0.5 flex items-center justify-between">
          {props.onSquelchChange ? (
            <div class="flex items-center gap-2 text-xs text-[#8b949e]">
              <span class="shrink-0">Squelch</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={props.squelch ?? 0}
                onInput={(e) => props.onSquelchChange!(parseInt(e.currentTarget.value))}
                class="w-24 accent-[#e3b341]"
              />
              <span class="w-8 shrink-0 text-right font-mono text-[#e3b341]">{props.squelch ?? 0}%</span>
            </div>
          ) : (
            <p class="text-[10px] text-[#484f58]">{props.isRecording ? 'Receiving audio' : 'Start decoding to see spectrum'}</p>
          )}
        </div>
      </div>

      <div class="mt-3 flex min-h-0 flex-1 flex-col gap-2">
        <h3 class="shrink-0 text-xs font-medium text-[#8b949e]">Spectrogram</h3>
        <div ref={sgContainerEl} class="relative min-h-[100px] flex-1">
          {glFailed() ? (
            /* CPU 2D-canvas pipeline — only when WebGL is unavailable */
            <div class="relative">
              <canvas
                ref={sgCanvEl}
                width={640}
                height={sgH()}
                style={{ height: `${sgH()}px` }}
                class="block w-full rounded border border-[#30363d] bg-[#0d1117]"
              />
              <canvas
                ref={sgOverlayEl}
                width={640}
                height={sgH()}
                style={{ height: `${sgH()}px` }}
                class="pointer-events-none absolute inset-0 w-full"
              />
            </div>
          ) : (
            <GLSpectrogram
              handle={glSg}
              view={sgView()}
              gamma={sgGamma()}
              height={sgH()}
              maxHz={displayMaxHz()}
              minHz={displayMinHz()}
              bands={glBandsComputed()}
              bandAlpha={bandAlpha()}
              markers={glMarkers()}
              sqlLevel={props.onSquelchChange != null ? (props.squelch ?? 0) / 100 : undefined}
              sqlAlpha={0.6}
              sqlGridSize={props.showGrid ? props.gridSize : undefined}
              vfoFrequency={props.vfoFrequency}
              txMarkerHz={props.txMarkerHz}
              colormap={colormap()}
              onFailed={() => setGlFailed(true)}
            />
          )}
          {/* Grips over the waterfall — terrain excluded: its markers sit in a
              rotating 3D projection, so a flat grip row would misalign. */}
          {(sgView() === 'waterfall' || glFailed()) && <MarkerGrips host={() => sgContainerEl} />}
        </div>
        {(sgView() === 'waterfall' || glFailed()) && (
          <FreqRuler minHz={displayMinHz()} maxHz={displayMaxHz()} vfoHz={props.vfoFrequency} />
        )}
        <div class="flex flex-wrap items-center gap-3 text-xs text-[#8b949e]">
          <label class="flex items-center gap-1.5">
            View
            <select
              value={sgView()}
              onChange={(e) => setSgView(e.currentTarget.value as SpectrogramView)}
              class="cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
            >
              <option value="terrain">3D Terrain</option>
              <option value="waterfall">2D Waterfall</option>
            </select>
          </label>
          <label class="flex items-center gap-1.5">
            Colors
            <select
              value={colormap()}
              onChange={(e) => setColormap(e.currentTarget.value as ColormapName)}
              class="cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
            >
              {COLORMAPS.map((name) => (
                <option value={name}>{COLORMAP_LABEL[name]}</option>
              ))}
            </select>
          </label>
          {!glFailed() && (
            <label class="flex items-center gap-1.5">
              Range
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={bandAlpha()}
                onInput={(e) => setBandAlpha(parseFloat(e.currentTarget.value))}
                class="w-14 accent-[#2ea043]"
              />
            </label>
          )}
          <label class="flex items-center gap-1.5">
            Contrast
            <input
              type="range"
              min={0.2}
              max={2.0}
              step={0.1}
              value={sgGamma()}
              onInput={(e) => setSgGamma(parseFloat(e.currentTarget.value))}
              class="w-14 accent-[#2ea043]"
            />
          </label>
          {sgView() === 'waterfall' || glFailed() ? (
            <label class="flex items-center gap-1.5">
              Speed
              <select
                value={sg2dSpeed()}
                onChange={(e) => setSg2dSpeed(parseInt(e.currentTarget.value))}
                class="cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
              >
                <option value={16}>Fast</option>
                <option value={50}>Normal</option>
                <option value={150}>Slow</option>
                <option value={500}>Very Slow</option>
              </select>
            </label>
          ) : (
            <>
              <label class="flex items-center gap-1.5">
                Speed
                <select
                  value={sg3dSpeed()}
                  onChange={(e) => setSg3dSpeed(parseInt(e.currentTarget.value))}
                  class="cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                >
                  <option value={80}>Normal</option>
                  <option value={200}>Slow</option>
                  <option value={500}>Very Slow</option>
                  <option value={1200}>Paused</option>
                </select>
              </label>
              <label class="flex items-center gap-1.5">
                Smooth
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={sg3dSmooth()}
                  onInput={(e) => setSg3dSmooth(parseFloat(e.currentTarget.value))}
                  class="w-14 accent-[#2ea043]"
                />
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
