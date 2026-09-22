// GPU-rendered spectrum trace — the green line graph at the top of
// SignalAnalysisPanel. Companion to GLSpectrogram.tsx (the waterfall/terrain
// view below it), which this deliberately mirrors in shape: same
// handle-ref imperative API, same onFailed -> CPU-fallback contract, same
// makeProgram helper style.
//
// Why this exists: drawSpectrum()'s 2D-canvas path strokes one lineTo() per
// visible bin every frame on the main thread. On an idle machine that's
// cheap (a measured ~0.4ms/frame at 2048 bins), but the main thread is
// exactly what's contended when several decoder tabs run concurrently —
// and a real report had the trace visibly slow under that load while the
// already-GPU waterfall directly below it stayed smooth. Moving just the
// trace to the GPU takes the per-bin work off the main thread entirely.
//
// Scope is deliberately narrow: ONLY the filled trace. Every overlay the
// panel draws on top (grid lines, dB ticks, squelch line/label, channel and
// TX markers) stays on a thin 2D sibling canvas — they're a fixed handful of
// draw calls regardless of bin count, several involve text (which WebGL has
// no native answer for), and SignalAnalysisPanel already layers a 2D canvas
// over GLSpectrogram for exactly this reason.
import { createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { buildColormapLUT, COLORMAP_LUT_SIZE, type ColormapName } from '$decoder-lib/colormaps'

export interface GLSpectrumHandle {
  /** Upload one frame of bin magnitudes (0-255, already cropped to the
   *  visible frequency span by the caller). */
  pushFrame(data: Uint8Array): void
  render(): void
  /** Trace opacity — the panel dims the trace when its squelch grid is on. */
  setAlpha(alpha: number): void
}

interface Props {
  handle?: { current: GLSpectrumHandle | null }
  height: number
  /** Palette for the magnitude->colour mapping. Deliberately the SAME
   *  ColormapName the waterfall below this plot uses, fed from the same
   *  operator-selected setting: the two plots show the same data seconds
   *  apart, so a carrier that is bright yellow in the waterfall should be
   *  bright yellow in the trace rather than a second, unrelated colour
   *  language the operator has to learn. */
  colormap?: ColormapName
  /** Called once if WebGL init or shader compilation fails — lets the host
   *  swap the CPU 2D path back in rather than showing a dead box. */
  onFailed?: () => void
  class?: string
}

// Max bins uploadable in one frame. The panel crops to the visible span
// before pushing, and no real source exceeds this (the widest is I/Q's
// 4096-point FFT, and that's the FULL span before cropping). A frame with
// more bins than this is downsampled to fit rather than rejected.
const MAX_BINS = 4096

// Thickness of the bright "curve" band at the top of each column, as a
// fraction of that column's own height. Small enough to read as a line at
// typical heights, and since it is relative rather than a fixed pixel count
// it neither disappears on a tall peak nor swallows a short one.
const EDGE_FRAC = 0.14
// One vertex per bin edge, positioned entirely on the GPU: the vertex
// shader reads the bin's magnitude from a 1-D LUMINANCE texture rather than
// from a per-frame vertex buffer, so a new frame is a single texSubImage2D
// of at most MAX_BINS bytes instead of rebuilding and re-uploading
// geometry. u_binCount tells it how much of that texture is live this frame.
const VS = `
precision highp float;
attribute float a_index;      // 0..(2*binCount-1): even = baseline, odd = magnitude
uniform sampler2D u_bins;
uniform float u_binCount;
uniform float u_texWidth;
varying float v_mag;          // this column's magnitude (flat across the column)
varying float v_frac;         // 0 at the baseline, 1 at this column's peak
void main() {
  float bin = floor(a_index * 0.5);
  float isTop = mod(a_index, 2.0);
  // Sample at the texel CENTRE so no filtering/rounding straddles two bins.
  float u = (bin + 0.5) / u_texWidth;
  float v = texture2D(u_bins, vec2(u, 0.5)).r;
  // Bin index -> clip space across the full canvas width.
  float x = (bin / max(u_binCount - 1.0, 1.0)) * 2.0 - 1.0;
  // Magnitude 0..1 -> clip space, bottom-anchored. Baseline vertices sit at
  // the very bottom so each column is a filled quad strip.
  float y = mix(-1.0, v * 2.0 - 1.0, isTop);
  v_mag = v;
  // Interpolates 0->1 up the column, which is what lets the fragment shader
  // tell "near the baseline" from "at the peak". The previous version varied
  // only v_mag, which is constant within a column — so every column shaded
  // identically from top to bottom and the plot read as separate blades of
  // grass rather than one filled curve.
  v_frac = isTop;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`

const FS = `
precision highp float;
uniform sampler2D u_cmap;     // 256x1 palette LUT, shared with the waterfall
uniform float u_alpha;
uniform float u_edge;         // clip-space height of the peak line, in 0..1 units
varying float v_mag;
varying float v_frac;
void main() {
  // Colour by MAGNITUDE, not by height within the column: every fragment of
  // a column takes the palette entry for that column's own peak, so the
  // plot reads the same way the waterfall directly below it does — a weak
  // carrier is the palette's low colour whether you look at its tip or its
  // base. (Sampling the LUT by v_frac instead would paint every column with
  // the full ramp and make them indistinguishable.)
  vec3 peak = texture2D(u_cmap, vec2(clamp(v_mag, 0.0, 1.0), 0.5)).rgb;
  // The fill below the peak is the same hue held down toward the
  // background, so the bright palette colour marks the CURVE and the body
  // under it stays subordinate — this is what turns a field of blades back
  // into a line with a tinted area beneath it.
  float body = 0.10 + 0.22 * v_frac;
  // Top band of each column is drawn at full palette intensity, giving the
  // trace a crisp lit edge at every zoom level (at wide spans columns are
  // sub-pixel and this is most of what's visible; zoomed in it becomes a
  // proper line along the top of the fill).
  float lit = smoothstep(1.0 - u_edge, 1.0, v_frac);
  vec3 rgb = mix(peak * body, peak, lit);
  // Alpha follows the same split: the body is translucent so overlapping
  // grid lines stay readable through it, the edge is solid.
  float a = u_alpha * mix(0.55, 1.0, lit);
  gl_FragColor = vec4(rgb * a, a);
}
`

function makeProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('GLSpectrum shader error:', gl.getShaderInfoLog(sh))
      gl.deleteShader(sh)
      return null
    }
    return sh
  }
  const vs = compile(gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc)
  if (!vs || !fs) return null
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('GLSpectrum link error:', gl.getProgramInfoLog(prog))
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

export default function GLSpectrum(props: Props): JSX.Element {
  let canvasEl: HTMLCanvasElement | undefined
  let gl: WebGLRenderingContext | null = null
  let tex: WebGLTexture | null = null
  let cmapTex: WebGLTexture | null = null
  let prog: WebGLProgram | null = null
  let idxBuf: WebGLBuffer | null = null
  let binCount = 0
  let alpha = 1
  // Starts true so the very first render() paints the background and sizes
  // the drawing buffer even before any data arrives — without it a panel
  // that is mounted but not yet decoding showed a default-sized, never-
  // cleared canvas (the 2D overlay above it is transparent, so that read
  // as a black box with the grid missing).
  let dirty = true
  let lastW = 0
  let lastH = 0
  const scratch = new Uint8Array(MAX_BINS)
  const [failed, setFailed] = createSignal(false)

  const failedSetter = () => {
    setFailed(true)
    props.onFailed?.()
  }

  onMount(() => {
    const canvas = canvasEl
    if (!canvas) return
    // No preserveDrawingBuffer: unlike the waterfall (which scrolls its own
    // previous contents) every frame here is drawn from scratch, so letting
    // the browser discard the buffer after compositing is both correct and
    // cheaper.
    const ctx = canvas.getContext('webgl', { antialias: true, alpha: false })
    if (!ctx) {
      failedSetter()
      return
    }
    gl = ctx

    const p = makeProgram(ctx, VS, FS)
    if (!p) {
      failedSetter()
      return
    }
    prog = p

    const t = ctx.createTexture()
    ctx.bindTexture(ctx.TEXTURE_2D, t)
    // Explicit zeroed storage rather than null — same reasoning as
    // GLSpectrogram's own texture: passing null defers zero-fill to the
    // first draw, which shows up as a lazy-initialization stall on the
    // frame the first real data lands.
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.LUMINANCE, MAX_BINS, 1, 0, ctx.LUMINANCE, ctx.UNSIGNED_BYTE, new Uint8Array(MAX_BINS))
    // NEAREST + CLAMP: each texel is one bin, and sampling is already
    // centred in the shader — any interpolation here would blend adjacent
    // bins and visibly smear narrow carriers.
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
    tex = t

    // Palette LUT on texture unit 1 (unit 0 stays the bin-data texture, whose
    // default binding pushFrame relies on) — same split GLSpectrogram uses,
    // and the same buildColormapLUT source, so a given magnitude maps to the
    // same colour in both plots.
    const ct = ctx.createTexture()
    ctx.activeTexture(ctx.TEXTURE1)
    ctx.bindTexture(ctx.TEXTURE_2D, ct)
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, COLORMAP_LUT_SIZE, 1, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, buildColormapLUT('turbo'))
    // LINEAR here (unlike the bin texture): the palette IS a continuous ramp,
    // so interpolating between its 256 steps is correct and avoids banding on
    // a smoothly varying noise floor.
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
    ctx.activeTexture(ctx.TEXTURE0)
    cmapTex = ct

    // Static index attribute, uploaded ONCE. Two vertices per bin
    // (baseline + magnitude) consumed as a TRIANGLE_STRIP, so the whole
    // trace is one draw call whose vertex count is the only thing that
    // varies frame to frame.
    const indices = new Float32Array(MAX_BINS * 2)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    const ib = ctx.createBuffer()
    ctx.bindBuffer(ctx.ARRAY_BUFFER, ib)
    ctx.bufferData(ctx.ARRAY_BUFFER, indices, ctx.STATIC_DRAW)
    idxBuf = ib

    ctx.clearColor(0.039, 0.039, 0.039, 1) // #0a0a0a, matching the 2D path's fill
    ctx.enable(ctx.BLEND)
    // PREMULTIPLIED alpha: the fragment shader outputs rgb already scaled by
    // its own alpha, so the fill fades toward the background cleanly instead
    // of toward black at low alpha (which is what a straight SRC_ALPHA blend
    // does to a dark-background plot).
    ctx.blendFunc(ctx.ONE, ctx.ONE_MINUS_SRC_ALPHA)

    const render = () => {
      const g = gl
      if (!g || !prog || !tex || !idxBuf) return
      const w = canvas.clientWidth || canvas.width
      const h = canvas.clientHeight || props.height
      // Match the drawing buffer to the CSS box (device pixels) so the
      // trace stays crisp on HiDPI and after a panel resize.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const pw = Math.max(1, Math.round(w * dpr))
      const ph = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      g.viewport(0, 0, canvas.width, canvas.height)
      g.clear(g.COLOR_BUFFER_BIT)
      if (binCount === 0) return

      g.useProgram(prog)
      g.bindBuffer(g.ARRAY_BUFFER, idxBuf)
      const loc = g.getAttribLocation(prog, 'a_index')
      g.enableVertexAttribArray(loc)
      g.vertexAttribPointer(loc, 1, g.FLOAT, false, 0, 0)
      g.activeTexture(g.TEXTURE0)
      g.bindTexture(g.TEXTURE_2D, tex)
      g.uniform1i(g.getUniformLocation(prog, 'u_bins'), 0)
      g.uniform1f(g.getUniformLocation(prog, 'u_binCount'), binCount)
      g.uniform1f(g.getUniformLocation(prog, 'u_texWidth'), MAX_BINS)
      g.uniform1f(g.getUniformLocation(prog, 'u_alpha'), alpha)
      g.activeTexture(g.TEXTURE1)
      g.bindTexture(g.TEXTURE_2D, cmapTex)
      g.uniform1i(g.getUniformLocation(prog, "u_cmap"), 1)
      g.uniform1f(g.getUniformLocation(prog, "u_edge"), EDGE_FRAC)
      g.activeTexture(g.TEXTURE0)
      g.drawArrays(g.TRIANGLE_STRIP, 0, binCount * 2)
      dirty = false
    }

    const handle: GLSpectrumHandle = {
      pushFrame(data: Uint8Array) {
        const g = gl
        if (!g || !tex) return
        let src = data
        let n = data.length
        if (n > MAX_BINS) {
          // Decimate to fit rather than dropping the frame — picking the max
          // of each group keeps narrow peaks visible, which is the whole
          // point of this view (a plain stride would alias them away).
          const stride = n / MAX_BINS
          for (let i = 0; i < MAX_BINS; i++) {
            const a = Math.floor(i * stride)
            const b = Math.min(Math.floor((i + 1) * stride), data.length)
            let m = 0
            for (let k = a; k < b; k++) if (data[k] > m) m = data[k]
            scratch[i] = m
          }
          src = scratch
          n = MAX_BINS
        }
        binCount = n
        g.bindTexture(g.TEXTURE_2D, tex)
        g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, n, 1, g.LUMINANCE, g.UNSIGNED_BYTE, src.subarray(0, n))
        dirty = true
      },
      render() {
        // Also repaint when the element has been resized (panel drag, window
        // resize, a collapsed <details> opening): the drawing buffer has to
        // be re-matched to the new CSS box or the trace stays stretched at
        // the old aspect until the next frame of data happens to arrive.
        const w = canvas.clientWidth
        const h = canvas.clientHeight
        if (w !== lastW || h !== lastH) {
          lastW = w
          lastH = h
          dirty = true
        }
        if (dirty) render()
      },
      setAlpha(a: number) {
        if (a !== alpha) {
          alpha = a
          dirty = true
        }
      },
    }
    if (props.handle) props.handle.current = handle

    // Re-upload the LUT whenever the operator picks a different palette, and
    // mark dirty so the change is visible on the next frame even if no new
    // data has arrived (a paused/idle panel should still repaint).
    createEffect(() => {
      const name = props.colormap ?? 'turbo'
      const g = gl
      if (!g || !cmapTex) return
      g.activeTexture(g.TEXTURE1)
      g.bindTexture(g.TEXTURE_2D, cmapTex)
      g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, COLORMAP_LUT_SIZE, 1, g.RGBA, g.UNSIGNED_BYTE, buildColormapLUT(name))
      g.activeTexture(g.TEXTURE0)
      dirty = true
    })

    onCleanup(() => {
      if (props.handle) props.handle.current = null
      const g = gl
      if (!g) return
      if (prog) g.deleteProgram(prog)
      if (tex) g.deleteTexture(tex)
      if (cmapTex) g.deleteTexture(cmapTex)
      if (idxBuf) g.deleteBuffer(idxBuf)
      // Explicitly drop the context rather than waiting for GC. Browsers cap
      // live WebGL contexts (~16 in Firefox) and this component can be
      // mounted once per visible decoder panel ALONGSIDE GLSpectrogram's own
      // context, so a panel that unmounts without releasing its context
      // brings that ceiling meaningfully closer for the panels still open.
      const lose = g.getExtension('WEBGL_lose_context')
      lose?.loseContext()
      gl = null
      prog = null
      tex = null
      cmapTex = null
      idxBuf = null
    })
  })

  return (
    <canvas
      ref={canvasEl}
      // Fills whatever box the host gives it (props.class), rather than
      // imposing props.height as a CSS height — the host lays the plot out
      // and this layer just matches it, so dropping the GPU layer in can't
      // change the panel's own geometry. props.height stays the drawing
      // buffer's reference height for the aspect the trace is drawn at.
      class={props.class}
      style={{ display: failed() ? 'none' : 'block' }}
    />
  )
}
