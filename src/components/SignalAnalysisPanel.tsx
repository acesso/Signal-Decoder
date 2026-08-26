// Port of src/components/AudioAnalysisPanel.tsx (Next.js app), renamed
// SignalAnalysisPanel and widened to accept I/Q data (see SpectrumSource
// below) — same panel now serves both a decoder's demodulated-audio
// spectrum (the original, real-FFT-only behavior) and, in I/Q mode, the
// bridge's own full wideband I/Q spectrum with a draggable bandwidth
// marker that retunes what SSBDemodulator extracts into audio (see
// useIQBridge.ts's setPassband()). Retires IQSpectrumPanel.tsx, whose
// job (an I/Q-aware GLSpectrogram view) this component now covers with a
// real marker/bandwidth system instead of that panel's plain zoom slider.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, type JSX } from 'solid-js'
import GLSpectrogram, { type GLSpectrogramHandle, type SpectroBand } from './GLSpectrogram'
import { loadNumber, saveNumber, loadString, saveString } from '$decoder-lib/storage'
import { buildColormapLUT, COLORMAPS, COLORMAP_LABEL, type ColormapName } from '$decoder-lib/colormaps'
import NumberField from './NumberField'

// Abstracts "where the byte-magnitude spectrum data comes from" so this
// panel doesn't need to know whether it's reading a real-valued
// AnalyserNode (decoders' demodulated audio, span always 0..Nyquist) or
// useIQBridge.ts's IQSpectrumComputer (raw wideband I/Q, span
// -Nyquist..+Nyquist — a complex signal's negative and positive frequency
// halves are genuinely different content, unlike a real FFT's mirrored
// negative half). getBytes() returns null when there's nothing to read yet
// (e.g. not connected) — same "draw nothing" behavior the old analyser==null
// case already had.
export interface SpectrumSource {
  getBytes(): Uint8Array | null
  minHz: number
  maxHz: number
}

// Adapts a Web Audio AnalyserNode to SpectrumSource — every existing
// decoder caller (CW/SSTV/MFSK/RTTY/FT8's own demodulated-audio view)
// keeps passing `analyser` unchanged; this class is constructed internally
// by SignalAnalysisPanel itself, not by callers.
class AnalyserSpectrumSource implements SpectrumSource {
  private buf: Uint8Array<ArrayBuffer> | null = null
  constructor(private analyser: AnalyserNode) {}
  get minHz() {
    return 0
  }
  get maxHz() {
    return this.analyser.context.sampleRate / 2
  }
  getBytes(): Uint8Array | null {
    const bc = this.analyser.frequencyBinCount
    if (!this.buf || this.buf.length !== bc) this.buf = new Uint8Array(bc) as Uint8Array<ArrayBuffer>
    this.analyser.getByteFrequencyData(this.buf)
    return this.buf
  }
}

// Adapts useIQBridge.ts's IQSpectrumComputer to SpectrumSource — always
// reports the FULL -Nyquist..+Nyquist span (IQSpectrumComputer.magBytes
// itself covers exactly that, uncropped); zooming into a narrower slice is
// left entirely to this panel's own existing displayMinHz/displayMaxHz
// "View" controls, the same mechanism the real-FFT case already uses to
// crop into a wider Nyquist span. getBytes() returns null when `active` is
// false (mirrors the old analyser==null "draw nothing" behavior) — passed
// as a plain value rather than read from a signal since the panel calls
// this every animation frame already, not reactively.
export class IQSpectrumSourceAdapter implements SpectrumSource {
  constructor(
    private computer: { magBytes: Uint8Array },
    private sampleRateHz: () => number,
    private active: () => boolean,
  ) {}
  get minHz() {
    return -this.sampleRateHz() / 2
  }
  get maxHz() {
    return this.sampleRateHz() / 2
  }
  getBytes(): Uint8Array | null {
    return this.active() ? this.computer.magBytes : null
  }
}

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

// Config for the I/Q-mode passband marker — a SEPARATE concept from
// markers/onMarkerDrag (used for tone markers within already-demodulated
// audio): this one drives useIQBridge.ts's SSBDemodulator.setPassband(),
// retuning what the bridge's raw I/Q gets turned into decodable audio, not
// just relabeling a spot in an already-fixed audio stream. Rendered via
// the SAME drawChannelMarker/MarkerGrips drag machinery as a regular
// AudioMarker (kept as a single-element internal marker list), since the
// visual — a shaded, draggable band — is identical either way.
export interface IQPassband {
  centerHz: number
  bandwidthHz: number
}

interface Props {
  /** Real-valued FFT source (decoders' demodulated audio). When iqSource is
   *  ALSO given (I/Q mode), this is the pipeline's FINAL output — after
   *  every correction/AGC/highpass/noise-reduction stage useIQBridge.ts
   *  applies — and a "Signal source" toggle lets the operator pick between
   *  the two instead of only ever seeing the raw wideband view. When
   *  iqSource is absent (Audio mode), this is the only source and no
   *  toggle is shown. */
  analyser: AnalyserNode | null
  /** Raw wideband I/Q source (useIQBridge.ts), i.e. the pipeline's INPUT —
   *  before DC removal/imbalance correction/swap-negate even runs, let
   *  alone demodulation. See analyser's own comment for how the two
   *  combine. Span is always -sampleRateHz()/2..+sampleRateHz()/2. */
  iqSource?: {
    computer: { magBytes: Uint8Array; setActive?: (active: boolean) => void }
    sampleRateHz: () => number
    active: () => boolean
    /** Pre-AGC signal strength (dBFS) — useIQBridge.ts's IQBridgeState.iqSignalDbfs.
     *  Drives the icon-only meter next to the panel title; null until the
     *  first I/Q frame is demodulated. */
    signalDbfs?: () => number | null
  }
  isRecording: boolean
  markers?: AudioMarker[]
  /** shiftKey reflects the modifier during the drag — lets a mode offer an
   *  alternate drag behavior (e.g. MFSK: move one tone instead of the group). */
  onMarkerDrag?: (index: number, newFreq: number, shiftKey?: boolean) => void
  /** I/Q mode only — see IQPassband. Present together, or not at all. */
  passband?: IQPassband
  onPassbandChange?: (passband: IQPassband) => void
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

type IQTapPoint = 'raw' | 'processed'
const IQ_TAP_POINTS: IQTapPoint[] = ['raw', 'processed']

// Icon-only signal-strength meter (bars, no numeric/text readout by
// design — the existing IQSignalMeterDisplay in RadioCATPanel.tsx already
// covers the numeric "S9+12 -18dB" case). Floor/ceiling are coarse, not the
// precise S-unit scale RadioCATPanel's own dbfsToSUnitLabel uses (-30dBFS =
// S9, ~6dB/S-unit) — this is meant for an at-a-glance glance, not a report.
const SIGNAL_METER_FLOOR_DBFS = -80
const SIGNAL_METER_CEIL_DBFS = -20
function SignalStrengthMeter(props: { dbfs: number | null }): JSX.Element {
  const fraction = createMemo(() => {
    if (props.dbfs === null) return null
    const span = SIGNAL_METER_CEIL_DBFS - SIGNAL_METER_FLOOR_DBFS
    return Math.max(0, Math.min(1, (props.dbfs - SIGNAL_METER_FLOOR_DBFS) / span))
  })
  const BAR_COUNT = 4
  return (
    <div class="flex items-end gap-[1.5px] h-3.5" title={props.dbfs === null ? 'Signal strength: no signal yet' : `Signal strength: ${Math.round(props.dbfs)} dBFS`}>
      <For each={Array.from({ length: BAR_COUNT }, (_, i) => i)}>
        {(i) => {
          const lit = () => fraction() !== null && fraction()! >= (i + 1) / BAR_COUNT
          return (
            <div
              class={`w-[3px] rounded-sm transition-colors ${lit() ? 'bg-[#2ea043]' : 'bg-[#30363d]'}`}
              style={{ height: `${((i + 1) / BAR_COUNT) * 100}%` }}
            />
          )
        }}
      </For>
    </div>
  )
}

// Plain parseFloat, no min/max clamp — the frequency NumberFields in this
// panel used to clamp on every keystroke (NumberField's own defaultParse),
// which fought the operator mid-typing (e.g. clearing a field to type a
// bigger number got immediately snapped back to the old max). Whatever gets
// committed here still flows through the same drag/passband-change logic a
// real out-of-range value would hit via mouse drag, so nothing downstream
// relies on this field enforcing bounds itself.
function rawFreqParse(raw: string): number | null {
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

export default function SignalAnalysisPanel(props: Props): JSX.Element {
  // Only meaningful when BOTH iqSource and analyser are given (I/Q mode) —
  // see analyser's own comment on what each tap point actually shows.
  // Persisted per-mode like colormap below, since an operator's
  // preference plausibly differs between e.g. FT8 (probably wants to see
  // the raw band to find signals) and a mode where they're mainly
  // diagnosing THIS pipeline's own effect.
  const lsIqTap = props.storageKeyPrefix ? `${props.storageKeyPrefix}_sg_iq_tap` : 'sg_iq_tap'
  const [iqTap, setIqTap] = createSignal<IQTapPoint>(loadString(lsIqTap, 'raw', IQ_TAP_POINTS))
  createEffect(() => saveString(lsIqTap, iqTap()))
  const hasBothTaps = createMemo(() => !!props.iqSource && !!props.analyser)

  const source = createMemo<SpectrumSource | null>(() => {
    if (props.iqSource && (iqTap() === 'raw' || !props.analyser)) {
      return new IQSpectrumSourceAdapter(props.iqSource.computer, props.iqSource.sampleRateHz, props.iqSource.active)
    }
    return props.analyser ? new AnalyserSpectrumSource(props.analyser) : null
  })
  // Tells useIQBridge.ts's IQSpectrumComputer whether this panel is actually
  // displaying the raw I/Q tap right now, so it can skip its own per-frame
  // FFT/magnitude work (a real, fixed cost — see setActive's own comment)
  // whenever nothing on screen reads magBytes. Reference-counted on the
  // computer's side, so this only needs to report ITS OWN true/false — not
  // worry about other mounted panels. Runs whenever `source()` changes
  // identity (tap switch, iqSource appearing/disappearing) and once more
  // on cleanup to release this panel's own count.
  createEffect(() => {
    const isRaw = source() instanceof IQSpectrumSourceAdapter
    props.iqSource?.computer.setActive?.(isRaw)
    onCleanup(() => props.iqSource?.computer.setActive?.(false))
  })
  // I/Q mode's passband marker is presented through the exact same
  // drawChannelMarker/MarkerGrips path as a regular AudioMarker — appended
  // to (never replacing) props.markers so a decoder could in principle show
  // both, though in practice a component only ever passes one or the other.
  // Only meaningful on the RAW I/Q tap — centerHz is an offset within the
  // wideband I/Q spectrum, which has no equivalent position on the
  // "processed" tap (that view is already the post-demodulation baseband
  // audio the passband setting PRODUCED, not something the passband
  // marker itself could still be dragged within).
  // onRawTap: are we actually looking at the raw I/Q spectrum right now?
  // false whenever there's no I/Q tap choice at all (ordinary audio-mode
  // decoders, hasBothTaps()===false) OR the operator picked "processed".
  const onRawTap = createMemo(() => hasBothTaps() && iqTap() === 'raw')
  const effectiveMarkers = createMemo<AudioMarker[]>(() => {
    // props.markers (tone/channel markers) describe positions in
    // DEMODULATED AUDIO — meaningless on the raw wideband I/Q spectrum, so
    // suppressed there exactly like the passband marker below (which is
    // the opposite case: meaningful only on raw I/Q, since centerHz is an
    // offset within that wideband spectrum with no equivalent on
    // already-demodulated "processed" audio). Confirmed via a real report
    // that these were unintentionally never shown at all once a decoder
    // started passing iqSource — passing them back in is the fix; this
    // onRawTap() guard is what keeps them from also cluttering the raw view
    // once they ARE passed in.
    const base = onRawTap() ? [] : (props.markers ?? [])
    if (!props.passband || !onRawTap()) return base
    return [...base, { freq: props.passband.centerHz, color: '#58a6ff', label: 'Passband', bandwidthHz: props.passband.bandwidthHz }]
  })
  // The passband marker is the ONLY thing effectiveMarkers ever includes on
  // the raw tap (base is forced empty there — see effectiveMarkers' own
  // comment), so it's always at index 0 when this is true.
  const isPassbandMarkerIndex = (i: number) => props.passband != null && onRawTap() && i === 0
  const handleMarkerDrag = (index: number, newFreq: number, shiftKey?: boolean) => {
    if (isPassbandMarkerIndex(index)) {
      props.onPassbandChange?.({ centerHz: newFreq, bandwidthHz: props.passband!.bandwidthHz })
      return
    }
    props.onMarkerDrag?.(index, newFreq, shiftKey)
  }
  const hasMarkerDrag = createMemo(() => !!props.onMarkerDrag || !!props.onPassbandChange)

  // I/Q's span can be negative (source.minHz < 0) — the real-FFT case
  // always starts at 0, so defaulting to that keeps every existing caller's
  // behavior byte-for-byte unchanged.
  const sourceMinHz = () => source()?.minHz ?? 0
  const sourceMaxHz = () => source()?.maxHz ?? (props.defaultMaxHz ?? 3000)

  const defaultMaxHz = () => props.defaultMaxHz ?? 3000
  const lsMinHz = props.storageKeyPrefix ? `${props.storageKeyPrefix}_sg_display_min_hz` : null
  const lsMaxHz = props.storageKeyPrefix ? `${props.storageKeyPrefix}_sg_display_max_hz` : null

  const [displayMinHz, setDisplayMinHz] = createSignal(lsMinHz ? loadNumber(lsMinHz, sourceMinHz()) : sourceMinHz())
  const [displayMaxHz, setDisplayMaxHz] = createSignal(lsMaxHz ? loadNumber(lsMaxHz, defaultMaxHz()) : defaultMaxHz())
  // Re-clamps the View range only when it's genuinely UNREACHABLE on the
  // current source — i.e. the whole [displayMinHz,displayMaxHz] window now
  // sits entirely outside [sourceMinHz,sourceMaxHz] (would show nothing at
  // all), which only happens from a real sample-rate change (e.g.
  // GET /status resolving after mount). Deliberately does NOT clamp on
  // every tap switch: the raw-I/Q source's span is -Nyquist..+Nyquist while
  // the processed/decoded-audio source is 0-floored (see
  // AnalyserSpectrumSource.minHz), so a naive "snap into [lo,hi]" on every
  // switch fought the operator's own chosen zoom — e.g. picking "Decoded
  // audio" while viewing -2000..2000Hz on raw I/Q used to force the view
  // back to 0..something, discarding the operator's zoom for no reason
  // other than the new source's span technically starting at 0. Confirmed
  // report: "when I select decoded audio as source, the view goes to 0, it
  // should be kept the same for all signal source." A merely PARTIALLY
  // out-of-range window (e.g. min dips slightly below the new source's 0)
  // is left alone — drawSpectrum's own bin-clamping (Math.max(0, bin0))
  // already renders a partial/empty edge gracefully instead of garbage.
  createEffect(() => {
    const lo = sourceMinHz()
    const hi = sourceMaxHz()
    if (displayMaxHz() <= lo || displayMinHz() >= hi) {
      setDisplayMinHz(lo)
      setDisplayMaxHz(hi === lo ? lo + 100 : hi)
    }
  })
  // Enforces min < max — the View min/max fields used to be native
  // <input type=number> with min/max attributes tying each field to the
  // OTHER field's current value, giving that ordering guarantee live as the
  // operator typed. Switching those to NumberField (so typing a new value
  // isn't fought by a clamp on every keystroke — see rawFreqParse's own
  // comment) dropped that live cross-field constraint; this effect is the
  // replacement, applied once after a value actually commits rather than
  // per keystroke — independent of the source-reachability effect above,
  // which must NOT run on every tap switch (see its own comment).
  createEffect(() => {
    if (displayMinHz() >= displayMaxHz()) setDisplayMinHz(Math.max(sourceMinHz(), displayMaxHz() - 100))
  })
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

    if (!hasMarkerDrag()) return
    const ms = effectiveMarkers()
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
    if (!el || !hasMarkerDrag()) return
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
      if (!drag || !hasMarkerDrag()) return
      e.preventDefault()
      const rect = drag.el.getBoundingClientRect()
      const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const newHz = Math.round(displayMinHz() + xRatio * (displayMaxHz() - displayMinHz()))
      handleMarkerDrag(drag.index, newHz, e.shiftKey)
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
    const markers = effectiveMarkers()
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
    const src = source()
    if (!src) return null
    const d = src.getBytes()
    if (!d) return null

    // Maps the displayed [minHz, maxHz] window onto d's own [src.minHz,
    // src.maxHz] span into bin indices — generalizes the old
    // hardcoded-[0, Nyquist] real-FFT assumption to any linear span,
    // including I/Q's negative-to-positive range.
    const bc = d.length
    const srcSpan = src.maxHz - src.minHz
    const bin0 = Math.floor(((minHz - src.minHz) / srcSpan) * bc)
    const bin1 = Math.min(Math.ceil(((maxHz - src.minHz) / srcSpan) * bc), bc)
    const vis = d.subarray(Math.max(0, bin0), Math.max(0, bin1))

    const ms = effectiveMarkers()
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
    // Same reasoning as effectiveMarkers' own onRawTap() guard: glBands (MFSK's
    // per-channel highlight bands) describes demodulated-audio channel
    // positions, meaningless on the raw wideband I/Q spectrum.
    props.glBands && !onRawTap()
      ? props.glBands.map((ch) => {
          const halfBw = 40
          return { fromHz: ch.freq - halfBw, toHz: ch.freq + halfBw, color: ch.color }
        })
      : effectiveMarkers().map((m) => {
          const halfBw = m.bandwidthHz != null ? m.bandwidthHz / 2 : 40
          return { fromHz: m.freq - halfBw, toHz: m.freq + halfBw, color: m.color }
        }),
  )

  const glMarkers = createMemo<SpectroBand[]>(() =>
    effectiveMarkers().map((m) => ({ fromHz: m.freq, toHz: m.freq, color: m.color })),
  )

  function applyCenterShift(newCenter: number) {
    if (!hasMarkerDrag()) return
    const delta = newCenter - centerFreq()
    if (delta === 0) return
    const markers = effectiveMarkers()
    markers.forEach((_, i) => {
      handleMarkerDrag(i, markers[i].freq + delta)
    })
  }

  // Triangular grab handles for the draggable markers — DOM elements rather
  // than canvas pixels, so they overflow a little above the box edge and give
  // a wide, obvious mouse target. Rendered over both the spectrum and the 2D
  // waterfall; `host` is the box whose width maps to the displayed frequency
  // span during the drag.
  const MarkerGrips = (p: { host: () => HTMLElement | undefined }) => (
    <>
      {hasMarkerDrag() &&
        effectiveMarkers().map((m, i) => {
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
      <div class="mb-2 shrink-0 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold sm:text-xl">Signal Analysis</h2>
          {/* Moved here from the Spectrogram controls row (bottom of the
              panel) — right after the title is a much more discoverable
              spot for "which pipeline stage am I even looking at" than
              buried among Colors/Range/Contrast/Speed. Only shown when
              there's genuinely a choice — see hasBothTaps's own comment. */}
          {hasBothTaps() && (
            <label class="flex items-center gap-1.5 text-xs text-[#8b949e]" title="Where in the I/Q processing pipeline this view taps the signal">
              Signal source
              <select
                value={iqTap()}
                onChange={(e) => setIqTap(e.currentTarget.value as IQTapPoint)}
                class="cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
              >
                <option value="raw">Raw I/Q (before demodulation)</option>
                <option value="processed">Decoded audio (after AGC/filters/NR)</option>
              </select>
            </label>
          )}
        </div>
        {/* Icon-only (bars, no number/text — RadioCATPanel.tsx's
            IQSignalMeterDisplay already covers that) — I/Q mode only. */}
        {props.iqSource?.signalDbfs && <SignalStrengthMeter dbfs={props.iqSource.signalDbfs()} />}
      </div>

      <div class="shrink-0">
        {effectiveMarkers().length > 0 && (
          <div class="mb-1.5 flex items-center gap-2 text-xs text-[#8b949e]">
            <span class="shrink-0">{props.markerFieldLabel ?? 'Center'}</span>
            {props.vfoFrequency ? (
              // Absolute dial+audio frequency, editable, in kHz down to Hz
              // precision (21075.5 = 21,075,500 Hz) — commits back as an
              // audio-offset shift of the markers.
              <NumberField
                value={Math.round(props.vfoFrequency + centerFreq()) / 1000}
                // No min/max/step here — a strict live clamp made it hard to
                // type a new value at all (each keystroke got clamped before
                // the next digit landed). onCommit still gets whatever was
                // actually typed; out-of-range results are the marker
                // drag/drop logic's own business, not this field's.
                parse={rawFreqParse}
                onCommit={(khz) => applyCenterShift(Math.round(khz * 1000) - props.vfoFrequency!)}
                readOnly={!hasMarkerDrag()}
                class={`w-28 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-xs text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none ${!hasMarkerDrag() ? 'cursor-default opacity-60' : ''}`}
              />
            ) : (
              <NumberField
                value={centerFreq()}
                parse={rawFreqParse}
                onCommit={applyCenterShift}
                readOnly={!hasMarkerDrag()}
                class={`w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none ${!hasMarkerDrag() ? 'cursor-default opacity-60' : ''}`}
              />
            )}
            <span class="shrink-0 text-[#484f58]">{props.vfoFrequency ? 'kHz' : 'Hz'}</span>
            {/* Bandwidth — separate from the generic marker-drag machinery
                above (that only ever moves a marker's CENTER frequency,
                for any AudioMarker including plain tone markers other
                decoders use — bandwidth only makes sense for the
                passband specifically). Real gap this fills: there was
                previously NO way to widen/narrow the demodulated audio
                band at all — the center field and marker drag both only
                ever changed centerHz, confirmed directly against a real
                report of "changed the passband value, audio bandwidth
                didn't change" (true: that value only ever WAS centerHz). */}
            {props.passband && props.onPassbandChange && onRawTap() && (
              <>
                <span class="shrink-0 ml-2">Width</span>
                <NumberField
                  value={props.passband.bandwidthHz}
                  // No min/max/step — see the Center field's own comment
                  // above for why a live clamp/spinner made this hard to
                  // type into.
                  parse={rawFreqParse}
                  onCommit={(hz) => props.onPassbandChange!({ centerHz: props.passband!.centerHz, bandwidthHz: Math.round(hz) })}
                  class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                />
                <span class="shrink-0 text-[#484f58]">Hz</span>
              </>
            )}
            <span class="ml-auto text-[10px] text-[#484f58]">
              {effectiveMarkers().length} marker{effectiveMarkers().length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        <div ref={specWrapEl} class="relative">
          <canvas
            ref={specEl}
            width={640}
            height={CANVAS_H}
            class={`block w-full touch-manipulation rounded border border-[#30363d] bg-[#0a0a0a] ${
              hasMarkerDrag() ? 'cursor-ew-resize' : props.onSquelchChange ? 'cursor-ns-resize' : 'cursor-crosshair'
            }`}
            onMouseDown={hasMarkerDrag() || props.onSquelchChange ? handleSpectrumMouseDown : undefined}
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
          {/* NumberField, not a raw <input type=number> — that native
              version clamped on every keystroke (same "can't type a new
              value" complaint as the Center/Width fields above) AND was a
              CONTROLLED input bound straight to the signal, which is exactly
              the Firefox mid-edit-focus-loss bug NumberField's own header
              comment documents. parse={rawFreqParse} skips the clamp;
              final min/max enforcement still happens via the existing
              sourceMinHz/sourceMaxHz clamp effect below. */}
          <NumberField
            value={displayMinHz()}
            parse={rawFreqParse}
            onCommit={setDisplayMinHz}
            class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
          />
          <span class="shrink-0 text-[#484f58]">–</span>
          <NumberField
            value={displayMaxHz()}
            parse={rawFreqParse}
            onCommit={setDisplayMaxHz}
            class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
          />
          <span class="shrink-0 text-[#484f58]">Hz</span>
          {/* Quick-set zoom presets — 1k/2k/3k/6k fixed, plus one dynamic
              chip for the full currently-available span (sourceMaxHz(),
              e.g. half the I/Q sample rate). All share lo=0: unlike the
              previous ± presets, these describe the same [0,hi] shape as
              the manual Hz fields' own natural reading, and — critically —
              each hi is capped to sourceMaxHz() so a fixed preset can never
              ask for a range wider than the actual source, which is what
              made these silently get bounced back to [sourceMinHz(),
              sourceMaxHz()] by the reachability-clamp effect above the
              instant they were clicked (a fixed 6k chip on a source whose
              real span tops out at 2400Hz, for instance). The manual Hz
              input fields remain for any custom/wider value the operator
              wants — these are only ever a convenience on top of them. */}
          {(() => {
            const cap = sourceMaxHz()
            const fixed = [1000, 2000, 3000, 6000]
              .filter(hi => hi <= cap)
              .map(hi => ({ hi, label: `${hi / 1000}k` }))
            // Only add the dynamic "full span" chip when it's not already
            // exactly one of the fixed presets above (e.g. a 3000Hz-wide
            // I/Q source would otherwise show a redundant "3k" twice).
            const dynamic = fixed.some(f => f.hi === cap)
              ? []
              : [{ hi: cap, label: `${(cap / 1000).toFixed(cap % 1000 === 0 ? 0 : 1)}k (full)` }]
            return [...fixed, ...dynamic]
          })().map(({ hi, label }) => (
            <button
              onClick={() => {
                setDisplayMinHz(0)
                setDisplayMaxHz(hi)
              }}
              class={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${
                displayMinHz() === 0 && displayMaxHz() === hi
                  ? 'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]'
                  : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
              }`}
            >
              {label}
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
