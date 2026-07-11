// Port of src/components/GLSpectrogram.tsx (Next.js app) — raw WebGL terrain
// spectrogram. Almost none of the original logic depends on React's render
// cycle (it's imperative GL code driven by refs); the React wrapper only
// diffed props into ref updates and exposed an imperative
// pushRow/render/setSmooth/setRowInterval API via useImperativeHandle.
//
// Solid has no useImperativeHandle equivalent — the idiomatic replacement is
// a caller-supplied mutable object (`handle` prop) that this component fills
// in via onMount, mirroring what a React ref object looks like from the
// outside without needing forwardRef.
import { createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { buildColormapLUT, COLORMAP_LUT_SIZE, type ColormapName } from '$decoder-lib/colormaps'

export type GLView = 'terrain' | 'waterfall'

export interface SpectroBand {
  fromHz: number
  toHz: number
  color: string
  line?: boolean
}

export interface GLSpectrogramHandle {
  pushRow(data: Uint8Array): void
  render(): void
  setSmooth(alpha: number): void
  setRowInterval(ms: number): void
}

interface Props {
  handle?: { current: GLSpectrogramHandle | null }
  view: GLView
  gamma: number
  height: number
  minHz?: number
  maxHz: number
  bands?: SpectroBand[]
  bandAlpha?: number
  markers?: SpectroBand[]
  sqlLevel?: number
  sqlAlpha?: number
  sqlGridSize?: number
  vfoFrequency?: number
  txMarkerHz?: number
  /** Palette for the terrain/waterfall intensity mapping (default turbo). */
  colormap?: ColormapName
  /** Called once if WebGL init or shader compilation fails — lets the host
   *  swap in a CPU-rendered fallback instead of showing a dead box. */
  onFailed?: () => void
}

const TEX_W = 512
const TEX_H = 256
const BG: [number, number, number] = [0.051, 0.067, 0.09]
const SQL_COLOR: [number, number, number] = [0.89, 0.7, 0.25]
const MAX_BANDS = 8
const HEIGHT_SCALE = 0.55
const TERRAIN_X = 192
const TERRAIN_Z = 56

// Palette lookup — samples the 256×1 LUT texture built by
// $decoder-lib/colormaps (unit 1), shared with the CPU-fallback waterfall so
// every renderer shows identical colors. Half-texel offsets keep t=0 and t=1
// from bleeding across the clamped edge texels.
const CMAP_GLSL = `
uniform sampler2D uCmapTex;
vec3 cmap(float t) {
  float x = clamp(t, 0.0, 1.0) * ${(COLORMAP_LUT_SIZE - 1) / COLORMAP_LUT_SIZE} + ${0.5 / COLORMAP_LUT_SIZE};
  return texture2D(uCmapTex, vec2(x, 0.5)).rgb;
}
`

const BANDS_GLSL = `
uniform int   uBandCount;
uniform vec2  uBandRange[${MAX_BANDS}];
uniform vec3  uBandColor[${MAX_BANDS}];
uniform float uBandStrength[${MAX_BANDS}];
uniform float uBandAlpha;
vec3 applyBands(vec3 c, float x) {
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= uBandCount) break;
    if (x >= uBandRange[i].x && x <= uBandRange[i].y) {
      c = mix(c, uBandColor[i], clamp(uBandAlpha * uBandStrength[i], 0.0, 1.0));
    }
  }
  return c;
}
`

const GRID_GLSL = `
uniform vec2 uGrid;
float gridK(float x, float step, float halfW) {
  float d = abs(fract(x / step + 0.5) - 0.5) * step;
  return 1.0 - smoothstep(halfW * 0.5, halfW, d);
}
vec3 applyGrid(vec3 c, float x) {
  float minor = gridK(x, uGrid.x, 0.0025);
  float major = gridK(x, uGrid.y, 0.0035);
  return mix(c, vec3(0.55, 0.60, 0.66), minor * 0.10 + major * 0.18);
}
`

const SQL_GRID_VS = `
precision mediump float;
attribute vec2 aPos;
uniform mat4 uMVP;
uniform float uY;
varying float vX;
varying float vZ;
void main() {
  vX = aPos.x;
  vZ = aPos.y;
  gl_Position = uMVP * vec4(aPos.x * 2.0 - 1.0, uY, -aPos.y * 2.0, 1.0);
}
`

const SQL_GRID_FS = `
precision mediump float;
varying float vX;
varying float vZ;
uniform sampler2D uTex;
uniform float uHead, uDepth, uSqlLvl, uAlpha;
uniform vec2  uGridCells;
uniform int   uBandCount;
uniform vec2  uBandRange[${MAX_BANDS}];
uniform vec3  uBandColor[${MAX_BANDS}];
uniform float uBandStrength[${MAX_BANDS}];
uniform float uBandAlpha;

vec3 channelCol(float x) {
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= uBandCount) break;
    if (x >= uBandRange[i].x && x <= uBandRange[i].y) {
      return uBandColor[i];
    }
  }
  return vec3(0.89, 0.70, 0.25);
}

void main() {
  vec2 cc = (floor(vec2(vX, vZ) * uGridCells) + 0.5) / uGridCells;
  float texV = fract(uHead - cc.y * uDepth);
  float raw  = texture2D(uTex, vec2(cc.x, texV)).r;

  vec2  cellFrac = fract(vec2(vX, vZ) * uGridCells);
  float lineW    = 0.055;
  float isLine   = max(step(1.0 - lineW, cellFrac.x), step(1.0 - lineW, cellFrac.y));

  bool  lit    = raw > uSqlLvl;
  vec3  litCol = channelCol(cc.x);

  vec3 cellCol;
  if (lit) {
    float t = clamp((raw - uSqlLvl) / max(1.0 - uSqlLvl, 0.01) * 0.6 + 0.38, 0.15, 1.0);
    cellCol = litCol * t;
  } else {
    cellCol = vec3(0.04, 0.055, 0.08);
  }

  vec3 lineCol = lit ? litCol * 0.22 : vec3(0.11, 0.14, 0.19);
  gl_FragColor = vec4(mix(cellCol, lineCol, isLine), uAlpha);
}
`

const FLOOR_VS = `
precision mediump float;
attribute vec3 aPos;
uniform mat4 uMVP;
varying float vFade;
void main() {
  vFade = aPos.z;
  gl_Position = uMVP * vec4(aPos.x, -0.003, aPos.y, 1.0);
}
`
const FLOOR_FS = `
precision mediump float;
varying float vFade;
void main() {
  float fade = 1.0 - smoothstep(0.4, 1.0, vFade);
  gl_FragColor = vec4(0.50, 0.58, 0.72, 0.75 * fade);
}
`

const TERRAIN_VS = `
precision mediump float;
attribute float aHeight;
attribute vec2 aPos;
uniform float uGamma;
uniform mat4 uMVP;
varying float vV;
varying float vZ;
varying float vX;
void main() {
  float v = pow(aHeight, uGamma);
  vV = v;
  vZ = aPos.y;
  vX = aPos.x;
  vec3 p = vec3(aPos.x * 2.0 - 1.0, v * ${HEIGHT_SCALE}, -aPos.y * 2.0);
  gl_Position = uMVP * vec4(p, 1.0);
}
`

const TERRAIN_FS = `
precision mediump float;
varying float vV;
varying float vZ;
varying float vX;
${CMAP_GLSL}
${BANDS_GLSL}
${GRID_GLSL}
void main() {
  vec3 c = cmap(vV);
  c = applyGrid(c, vX);
  c = applyBands(c, vX);
  c = mix(c, vec3(${BG[0]}, ${BG[1]}, ${BG[2]}), smoothstep(0.45, 1.0, vZ));
  gl_FragColor = vec4(c, 1.0);
}
`

// Top-down scrolling waterfall — a fullscreen quad sampling the same row
// ring-texture the terrain keeps on the GPU. Replaces the old CPU 2D canvas
// (getImageData/putImageData full-canvas scroll every row) so waterfall
// rendering costs the CPU nothing beyond one texSubImage row upload.
const WATERFALL_VS = `
precision mediump float;
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}
`

const WATERFALL_FS = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uHead, uDepth, uGamma;
${CMAP_GLSL}
${BANDS_GLSL}
${GRID_GLSL}
void main() {
  float texV = fract(uHead - vUV.y * uDepth);
  float raw  = texture2D(uTex, vec2(vUV.x, texV)).r;
  float v    = pow(raw, uGamma);
  vec3 c = cmap(v);
  c = mix(vec3(${BG[0]}, ${BG[1]}, ${BG[2]}), c, smoothstep(0.0, 0.06, v));
  c = applyGrid(c, vUV.x);
  c = applyBands(c, vUV.x);
  gl_FragColor = vec4(c, 1.0);
}
`

const SQL_VS = `
precision mediump float;
attribute vec2 aPos;
uniform mat4 uMVP;
uniform float uY, uMode;
uniform vec2 uPan;
uniform float uScale;
void main() {
  if (uMode < 0.5) {
    vec3 p = vec3(aPos.x * 2.0 - 1.0, uY, -aPos.y * 2.0);
    gl_Position = uMVP * vec4(p, 1.0);
  } else {
    float x = (aPos.x * 2.0 - 1.0) * 0.98;
    float y = uY + (aPos.y - 0.5) * 0.014;
    gl_Position = vec4((vec2(x, y) + uPan) * uScale, 0.0, 1.0);
  }
}
`

const SQL_FS = `
precision mediump float;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(${SQL_COLOR[0]}, ${SQL_COLOR[1]}, ${SQL_COLOR[2]}, uAlpha);
}
`

function makeProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('GLSpectrogram shader error:', gl.getShaderInfoLog(sh))
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
    console.error('GLSpectrogram link error:', gl.getProgramInfoLog(prog))
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return out
}

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2)
  const out = new Float32Array(16)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

function mat4LookAt(eye: [number, number, number], center: [number, number, number]): Float32Array {
  let zx = eye[0] - center[0],
    zy = eye[1] - center[1],
    zz = eye[2] - center[2]
  const zl = Math.hypot(zx, zy, zz)
  zx /= zl
  zy /= zl
  zz /= zl
  let xx = zz,
    xy = 0,
    xz = -zx
  const xl = Math.hypot(xx, xy, xz) || 1
  xx /= xl
  xy /= xl
  xz /= xl
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ])
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${hz % 1000 === 0 ? hz / 1000 : (hz / 1000).toFixed(1)}k`
  return String(hz)
}

const TERRAIN_CAM = { az: 0, el: Math.PI / 4, dist: 2.6, tx: 0, tz: 0 }

interface BandUniforms {
  count: WebGLUniformLocation | null
  range: WebGLUniformLocation | null
  color: WebGLUniformLocation | null
  strength: WebGLUniformLocation | null
  alpha: WebGLUniformLocation | null
}

export default function GLSpectrogram(props: Props): JSX.Element {
  let canvasEl: HTMLCanvasElement | undefined
  let gl: WebGLRenderingContext | null = null
  let tex: WebGLTexture | null = null
  let cmapTex: WebGLTexture | null = null
  let head = 0
  let rowInterval = 33
  let renderFn: (() => void) | null = null
  const terrainHeights = new Float32Array(TERRAIN_X * TERRAIN_Z)
  const terrainPrev = new Float32Array(TERRAIN_X * TERRAIN_Z)
  const terrainLerped = new Float32Array(TERRAIN_X * TERRAIN_Z)
  let terrainDirty = false
  let lastPushTime = 0
  const bandsState = {
    ranges: new Float32Array(MAX_BANDS * 2),
    colors: new Float32Array(MAX_BANDS * 3),
    strengths: new Float32Array(MAX_BANDS),
    count: 0,
    alpha: props.bandAlpha ?? 0.3,
  }
  const sqlState: { level?: number; alpha: number } = { level: props.sqlLevel, alpha: props.sqlAlpha ?? 0.3 }
  let sqlGridSizeVal: number | undefined = props.sqlGridSize
  let gridState: [number, number] = [0.1, 0.2]
  let minHzVal = props.minHz ?? 0
  let maxHzVal = props.maxHz
  let terrainCam = { ...TERRAIN_CAM }
  const rowScratch = new Uint8Array(TEX_W)
  const rowSmoothed = new Float32Array(TEX_W)
  let smoothAlpha = 0.35
  let labelEls: (HTMLSpanElement | undefined)[] = []
  let markerEls: (HTMLDivElement | undefined)[] = []
  let markersVal: SpectroBand[] = []
  let txMarkerEl: HTMLDivElement | undefined
  let txMarkerHzVal = props.txMarkerHz ?? 0
  const [failed, setFailed] = createSignal(false)
  const failedSetter = (v: boolean) => {
    setFailed(v)
    if (v) props.onFailed?.()
  }

  const minHz = createMemo(() => props.minHz ?? 0)
  const span = createMemo(() => props.maxHz - minHz())
  const gridMinorHz = createMemo(() => (span() > 2000 ? 250 : 125))
  const gridMajorHz = createMemo(() => (span() > 2000 ? 1000 : 500))
  const labels = createMemo(() => {
    const out: { x: number; text: string }[] = []
    const mn = minHz()
    const mx = props.maxHz
    const majStep = gridMajorHz()
    const firstMaj = Math.ceil(mn / majStep) * majStep
    for (let hz = firstMaj; hz < mx; hz += majStep) {
      let text: string
      if ((props.vfoFrequency ?? 0) > 0) {
        const absHz = (props.vfoFrequency ?? 0) + hz
        const mhzInt = Math.floor(absHz / 1_000_000)
        const khzFrac = Math.round((absHz % 1_000_000) / 1000)
        text = `${mhzInt}.${String(khzFrac).padStart(3, '0')}`
      } else {
        text = formatHz(hz)
      }
      out.push({ x: (hz - mn) / span(), text })
    }
    return out
  })

  // Palette LUT lives on texture unit 1 (unit 0 stays the row data texture —
  // existing samplers rely on its default binding). Always restore the active
  // unit to 0 so pushRow's bindTexture keeps hitting the data texture.
  const uploadCmap = () => {
    const g = gl
    if (!g || !cmapTex) return
    const lut = buildColormapLUT(props.colormap ?? 'turbo')
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D, cmapTex)
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, COLORMAP_LUT_SIZE, 1, g.RGBA, g.UNSIGNED_BYTE, lut)
    g.activeTexture(g.TEXTURE0)
  }
  createEffect(() => {
    void props.colormap
    uploadCmap()
    renderFn?.()
  })

  createEffect(() => {
    txMarkerHzVal = props.txMarkerHz ?? 0
    renderFn?.()
  })

  createEffect(() => {
    gridState = [gridMinorHz() / span(), gridMajorHz() / span()]
    minHzVal = minHz()
    maxHzVal = props.maxHz
    void labels()
    renderFn?.()
  })

  createEffect(() => {
    const list = props.markers ?? []
    markersVal = list
    renderFn?.()
  })
  createEffect(() => {
    void props.gamma
    renderFn?.()
  })
  createEffect(() => {
    sqlState.level = props.sqlLevel
    sqlState.alpha = props.sqlAlpha ?? 0.3
    renderFn?.()
  })
  createEffect(() => {
    sqlGridSizeVal = props.sqlGridSize
    renderFn?.()
  })

  createEffect(() => {
    const list = (props.bands ?? []).slice(0, MAX_BANDS)
    const mn = minHz()
    const sp = span()
    list.forEach((band, i) => {
      bandsState.ranges[i * 2] = Math.max(0, (band.fromHz - mn) / sp)
      bandsState.ranges[i * 2 + 1] = Math.min(1, (band.toHz - mn) / sp)
      const [r, g, bl] = hexToRgb(band.color)
      bandsState.colors[i * 3] = r
      bandsState.colors[i * 3 + 1] = g
      bandsState.colors[i * 3 + 2] = bl
      bandsState.strengths[i] = band.line ? 1.0 : 0.45
    })
    bandsState.count = list.length
    bandsState.alpha = props.bandAlpha ?? 0.3
    renderFn?.()
  })

  onMount(() => {
    const canvas = canvasEl
    if (!canvas) return
    const ctx = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true })
    if (!ctx) {
      failedSetter(true)
      return
    }
    gl = ctx

    const t = ctx.createTexture()
    ctx.bindTexture(ctx.TEXTURE_2D, t)
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.LUMINANCE, TEX_W, TEX_H, 0, ctx.LUMINANCE, ctx.UNSIGNED_BYTE, null)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.REPEAT)
    tex = t

    const ct = ctx.createTexture()
    ctx.activeTexture(ctx.TEXTURE1)
    ctx.bindTexture(ctx.TEXTURE_2D, ct)
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, COLORMAP_LUT_SIZE, 1, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, null)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
    ctx.activeTexture(ctx.TEXTURE0)
    cmapTex = ct
    uploadCmap()

    if (props.handle) {
      props.handle.current = {
        pushRow(data: Uint8Array) {
          const g = gl
          if (!g || data.length === 0) return
          const n = data.length
          const alpha = smoothAlpha

          terrainDirty = true
          lastPushTime = performance.now()
          terrainPrev.set(terrainHeights)
          terrainHeights.copyWithin(TERRAIN_X, 0, TERRAIN_X * (TERRAIN_Z - 1))

          for (let i = 0; i < TERRAIN_X; i++) {
            const f = (i / (TERRAIN_X - 1)) * (n - 1)
            const i0 = f | 0
            const i1 = Math.min(i0 + 1, n - 1)
            const raw = (data[i0] * (1 - (f - i0)) + data[i1] * (f - i0)) / 255
            rowSmoothed[i] = rowSmoothed[i] * (1 - alpha) + raw * alpha
            terrainHeights[i] = rowSmoothed[i]
          }

          // Ring-texture row: resample the RAW spectrum to the full texture
          // width. (Previously this copied terrainHeights[0..TEX_W-1] — but a
          // terrain row is only TERRAIN_X wide, so texture columns beyond it
          // held stale data from older rows. The waterfall view samples the
          // whole width, so it needs true full-res rows; unsmoothed keeps it
          // crisp like the old CPU waterfall.)
          for (let i = 0; i < TEX_W; i++) {
            const f = (i / (TEX_W - 1)) * (n - 1)
            const i0 = f | 0
            const i1 = Math.min(i0 + 1, n - 1)
            rowScratch[i] = data[i0] * (1 - (f - i0)) + data[i1] * (f - i0)
          }
          if (tex) {
            g.bindTexture(g.TEXTURE_2D, tex)
            g.texSubImage2D(g.TEXTURE_2D, 0, 0, head, TEX_W, 1, g.LUMINANCE, g.UNSIGNED_BYTE, rowScratch)
            head = (head + 1) % TEX_H
          }
        },
        render() {
          const tNow = Math.min((performance.now() - lastPushTime) / rowInterval, 1)
          for (let i = 0; i < terrainLerped.length; i++) {
            terrainLerped[i] = terrainPrev[i] + (terrainHeights[i] - terrainPrev[i]) * tNow
          }
          terrainDirty = true
          renderFn?.()
        },
        setSmooth(alpha: number) {
          smoothAlpha = alpha
        },
        setRowInterval(ms: number) {
          rowInterval = ms
        },
      }
    }
  })

  createEffect(() => {
    const view = props.view
    const g = gl
    const canvas = canvasEl
    if (!g || !canvas) return

    // The previous view's program may have left extra vertex attrib arrays
    // enabled (terrain uses two: aPos + aHeight). Their buffers are deleted
    // on view cleanup, and any draw call made while a stale enabled array
    // has no buffer is an INVALID_OPERATION — the new view then renders
    // nothing (2D waterfall going blank after a round-trip to 3D Terrain).
    const maxAttribs = g.getParameter(g.MAX_VERTEX_ATTRIBS) as number
    for (let i = 0; i < maxAttribs; i++) g.disableVertexAttribArray(i)

    const headNorm = () => ((head - 0.5 + TEX_H) % TEX_H) / TEX_H
    const DEPTH = (TEX_H - 1) / TEX_H
    const buffers: WebGLBuffer[] = []
    const programs: WebGLProgram[] = []

    const mkBuffer = (data: Float32Array) => {
      const buf = g.createBuffer()!
      buffers.push(buf)
      g.bindBuffer(g.ARRAY_BUFFER, buf)
      g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW)
      return buf
    }
    const mkProgram = (vs: string, fs: string) => {
      const p = makeProgram(g, vs, fs)
      if (p) programs.push(p)
      return p
    }

    const bandLocs = (p: WebGLProgram): BandUniforms => ({
      count: g.getUniformLocation(p, 'uBandCount'),
      range: g.getUniformLocation(p, 'uBandRange'),
      color: g.getUniformLocation(p, 'uBandColor'),
      strength: g.getUniformLocation(p, 'uBandStrength'),
      alpha: g.getUniformLocation(p, 'uBandAlpha'),
    })
    const setBandUniforms = (loc: BandUniforms) => {
      g.uniform1i(loc.count, bandsState.count)
      g.uniform2fv(loc.range, bandsState.ranges)
      g.uniform3fv(loc.color, bandsState.colors)
      g.uniform1fv(loc.strength, bandsState.strengths)
      g.uniform1f(loc.alpha, bandsState.alpha)
    }

    const sqlProg = mkProgram(SQL_VS, SQL_FS)
    if (!sqlProg) {
      failedSetter(true)
      return
    }
    const sqlQuad = mkBuffer(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]))
    const sqlLoc = {
      aPos: g.getAttribLocation(sqlProg, 'aPos'),
      mvp: g.getUniformLocation(sqlProg, 'uMVP'),
      y: g.getUniformLocation(sqlProg, 'uY'),
      mode: g.getUniformLocation(sqlProg, 'uMode'),
      pan: g.getUniformLocation(sqlProg, 'uPan'),
      scale: g.getUniformLocation(sqlProg, 'uScale'),
      alpha: g.getUniformLocation(sqlProg, 'uAlpha'),
    }
    const drawSql = (mode: number, y: number, mvp?: Float32Array) => {
      if (sqlState.level === undefined || sqlState.alpha <= 0) return
      g.useProgram(sqlProg)
      g.enable(g.BLEND)
      g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
      if (mode === 0) g.depthMask(false)
      g.bindBuffer(g.ARRAY_BUFFER, sqlQuad)
      g.enableVertexAttribArray(sqlLoc.aPos)
      g.vertexAttribPointer(sqlLoc.aPos, 2, g.FLOAT, false, 0, 0)
      if (mvp) g.uniformMatrix4fv(sqlLoc.mvp, false, mvp)
      g.uniform1f(sqlLoc.y, y)
      g.uniform1f(sqlLoc.mode, mode)
      g.uniform2f(sqlLoc.pan, 0, 0)
      g.uniform1f(sqlLoc.scale, 1)
      g.uniform1f(sqlLoc.alpha, sqlState.alpha)
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
      g.disable(g.BLEND)
      if (mode === 0) g.depthMask(true)
    }
    const sqlHeight = () => Math.pow(sqlState.level ?? 0, props.gamma) * HEIGHT_SCALE

    const placeLabels = (project: (xNorm: number) => [number, number] | null, hideLabels = false) => {
      const W = canvas.clientWidth,
        H = canvas.clientHeight
      labels().forEach((lb, i) => {
        const el = labelEls[i]
        if (!el) return
        // Waterfall view: labels live in the panel's external HTML ruler
        // below the box — hide the projected in-canvas ones.
        const pos = hideLabels ? null : project(lb.x)
        if (!pos || pos[0] < -20 || pos[0] > W + 20 || pos[1] < 0 || pos[1] > H) {
          el.style.display = 'none'
          return
        }
        el.style.display = 'block'
        el.style.left = `${pos[0]}px`
        el.style.top = `${Math.min(H - 14, pos[1])}px`
      })
      const spanLocal = maxHzVal - minHzVal
      markersVal.forEach((mk, i) => {
        const el = markerEls[i]
        if (!el) return
        const centerHz = (mk.fromHz + mk.toHz) / 2
        const xNorm = (centerHz - minHzVal) / spanLocal
        const pos = project(xNorm)
        if (!pos || pos[0] < 0 || pos[0] > W) {
          el.style.display = 'none'
          return
        }
        el.style.display = 'block'
        el.style.left = `${pos[0]}px`
        el.style.top = '0'
        el.style.bottom = '0'
      })
      const txEl = txMarkerEl
      const txHz = txMarkerHzVal
      if (txEl) {
        if (txHz > 0 && txHz >= minHzVal && txHz <= maxHzVal) {
          const xNorm = (txHz - minHzVal) / spanLocal
          const pos = project(xNorm)
          if (pos && pos[0] >= 0 && pos[0] <= W) {
            txEl.style.display = 'block'
            txEl.style.left = `${pos[0]}px`
            txEl.style.top = '0'
            txEl.style.bottom = '0'
          } else {
            txEl.style.display = 'none'
          }
        } else {
          txEl.style.display = 'none'
        }
      }
    }

    if (view === 'waterfall') {
      const prog = mkProgram(WATERFALL_VS, WATERFALL_FS)
      if (!prog) {
        failedSetter(true)
        return
      }
      const quad = mkBuffer(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]))
      const aPos = g.getAttribLocation(prog, 'aPos')
      const loc = {
        head: g.getUniformLocation(prog, 'uHead'),
        depth: g.getUniformLocation(prog, 'uDepth'),
        gamma: g.getUniformLocation(prog, 'uGamma'),
        grid: g.getUniformLocation(prog, 'uGrid'),
        cmapTex: g.getUniformLocation(prog, 'uCmapTex'),
        bands: bandLocs(prog),
      }

      renderFn = () => {
        g.viewport(0, 0, canvas.width, canvas.height)
        g.disable(g.DEPTH_TEST)
        g.clearColor(BG[0], BG[1], BG[2], 1)
        g.clear(g.COLOR_BUFFER_BIT)
        g.useProgram(prog)
        g.activeTexture(g.TEXTURE1)
        g.bindTexture(g.TEXTURE_2D, cmapTex)
        g.activeTexture(g.TEXTURE0)
        g.bindTexture(g.TEXTURE_2D, tex)
        g.uniform1i(loc.cmapTex, 1)
        g.bindBuffer(g.ARRAY_BUFFER, quad)
        g.enableVertexAttribArray(aPos)
        g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0)
        g.uniform1f(loc.head, headNorm())
        g.uniform1f(loc.depth, DEPTH)
        g.uniform1f(loc.gamma, props.gamma)
        g.uniform2f(loc.grid, gridState[0], gridState[1])
        setBandUniforms(loc.bands)
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
        // Straight linear projection — the waterfall has no camera.
        placeLabels((xNorm) => [xNorm * canvas.clientWidth, canvas.clientHeight - 14], true)
      }
    }

    if (view === 'terrain') {
      const prog = mkProgram(TERRAIN_VS, TERRAIN_FS)
      if (!prog) {
        failedSetter(true)
        return
      }

      const verts = new Float32Array(TERRAIN_X * TERRAIN_Z * 2)
      for (let j = 0; j < TERRAIN_Z; j++) {
        for (let i = 0; i < TERRAIN_X; i++) {
          verts[(j * TERRAIN_X + i) * 2] = i / (TERRAIN_X - 1)
          verts[(j * TERRAIN_X + i) * 2 + 1] = j / (TERRAIN_Z - 1)
        }
      }
      const idx = new Uint16Array((TERRAIN_X - 1) * (TERRAIN_Z - 1) * 6)
      let k = 0
      for (let j = 0; j < TERRAIN_Z - 1; j++) {
        for (let i = 0; i < TERRAIN_X - 1; i++) {
          const a = j * TERRAIN_X + i
          idx[k++] = a
          idx[k++] = a + 1
          idx[k++] = a + TERRAIN_X
          idx[k++] = a + 1
          idx[k++] = a + TERRAIN_X + 1
          idx[k++] = a + TERRAIN_X
        }
      }
      const vbuf = mkBuffer(verts)

      const hbuf = g.createBuffer()!
      buffers.push(hbuf)
      g.bindBuffer(g.ARRAY_BUFFER, hbuf)
      g.bufferData(g.ARRAY_BUFFER, terrainHeights, g.DYNAMIC_DRAW)

      const ibuf = g.createBuffer()!
      buffers.push(ibuf)
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibuf)
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, idx, g.STATIC_DRAW)

      const aPos = g.getAttribLocation(prog, 'aPos')
      const aHeight = g.getAttribLocation(prog, 'aHeight')
      const loc = {
        gamma: g.getUniformLocation(prog, 'uGamma'),
        mvp: g.getUniformLocation(prog, 'uMVP'),
        grid: g.getUniformLocation(prog, 'uGrid'),
        cmapTex: g.getUniformLocation(prog, 'uCmapTex'),
        bands: bandLocs(prog),
      }

      const floorProg = mkProgram(FLOOR_VS, FLOOR_FS)
      const floorLoc = floorProg
        ? { aPos: g.getAttribLocation(floorProg, 'aPos'), mvp: g.getUniformLocation(floorProg, 'uMVP') }
        : null
      const floorBuf = floorProg ? g.createBuffer()! : null
      if (floorBuf) buffers.push(floorBuf)
      let floorVertCount = 0
      const buildFloorLines = () => {
        const [minorStep, majorStep] = gridState
        const vertsArr: number[] = []
        const firstMaj = Math.ceil(0 / majorStep) * majorStep
        for (let x = firstMaj; x <= 1.0 + 1e-5; x += majorStep) {
          const wx = x * 2.0 - 1.0
          vertsArr.push(wx, 0.0, 0, wx, -2.0, 1)
        }
        const firstMin = Math.ceil(0 / minorStep) * minorStep
        for (let x = firstMin; x <= 1.0 + 1e-5; x += minorStep) {
          const onMajor = Math.abs(x % majorStep) < minorStep * 0.1 || Math.abs((x % majorStep) - majorStep) < minorStep * 0.1
          if (onMajor) continue
          const wx = x * 2.0 - 1.0
          vertsArr.push(wx, 0.0, 0, wx, -2.0, 0.4)
        }
        const DEPTH_STEPS = 5
        for (let di = 0; di <= DEPTH_STEPS; di++) {
          const wz = -(di / DEPTH_STEPS) * 2.0
          const fade = di / DEPTH_STEPS
          vertsArr.push(-1.0, wz, fade, 1.0, wz, fade)
        }
        const data = new Float32Array(vertsArr)
        floorVertCount = data.length / 3
        g.bindBuffer(g.ARRAY_BUFFER, floorBuf!)
        g.bufferData(g.ARRAY_BUFFER, data, g.DYNAMIC_DRAW)
      }
      buildFloorLines()

      const drawFloor = (mvp: Float32Array) => {
        if (!floorProg || !floorBuf || !floorLoc || floorVertCount === 0) return
        buildFloorLines()
        g.useProgram(floorProg)
        g.enable(g.BLEND)
        g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
        g.bindBuffer(g.ARRAY_BUFFER, floorBuf)
        g.enableVertexAttribArray(floorLoc.aPos)
        g.vertexAttribPointer(floorLoc.aPos, 3, g.FLOAT, false, 0, 0)
        g.uniformMatrix4fv(floorLoc.mvp, false, mvp)
        g.drawArrays(g.LINES, 0, floorVertCount)
        g.disable(g.BLEND)
      }

      const sqlGridProg = mkProgram(SQL_GRID_VS, SQL_GRID_FS)
      const sqlGridLoc = sqlGridProg
        ? {
            aPos: g.getAttribLocation(sqlGridProg, 'aPos'),
            mvp: g.getUniformLocation(sqlGridProg, 'uMVP'),
            y: g.getUniformLocation(sqlGridProg, 'uY'),
            tex: g.getUniformLocation(sqlGridProg, 'uTex'),
            head: g.getUniformLocation(sqlGridProg, 'uHead'),
            depth: g.getUniformLocation(sqlGridProg, 'uDepth'),
            sqlLvl: g.getUniformLocation(sqlGridProg, 'uSqlLvl'),
            alpha: g.getUniformLocation(sqlGridProg, 'uAlpha'),
            gridCells: g.getUniformLocation(sqlGridProg, 'uGridCells'),
            bands: bandLocs(sqlGridProg),
          }
        : null

      const drawSqlGrid = (mvp: Float32Array) => {
        if (sqlState.level === undefined || sqlState.alpha <= 0) return
        const gs = sqlGridSizeVal
        if (!gs || !sqlGridProg || !sqlGridLoc) {
          drawSql(0, sqlHeight(), mvp)
          return
        }
        g.useProgram(sqlGridProg)
        g.enable(g.BLEND)
        g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
        g.depthMask(false)
        g.bindBuffer(g.ARRAY_BUFFER, sqlQuad)
        g.enableVertexAttribArray(sqlGridLoc.aPos)
        g.vertexAttribPointer(sqlGridLoc.aPos, 2, g.FLOAT, false, 0, 0)
        g.uniformMatrix4fv(sqlGridLoc.mvp, false, mvp)
        g.uniform1f(sqlGridLoc.y, sqlHeight())
        g.bindTexture(g.TEXTURE_2D, tex)
        g.uniform1i(sqlGridLoc.tex, 0)
        g.uniform1f(sqlGridLoc.head, headNorm())
        g.uniform1f(sqlGridLoc.depth, DEPTH)
        g.uniform1f(sqlGridLoc.sqlLvl, sqlState.level)
        g.uniform1f(sqlGridLoc.alpha, sqlState.alpha)
        g.uniform2f(sqlGridLoc.gridCells, gs * 2, gs)
        setBandUniforms(sqlGridLoc.bands)
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
        g.disable(g.BLEND)
        g.depthMask(true)
      }

      renderFn = () => {
        const cam = terrainCam
        g.viewport(0, 0, canvas.width, canvas.height)
        g.enable(g.DEPTH_TEST)
        g.clearColor(BG[0], BG[1], BG[2], 1)
        g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)

        const target: [number, number, number] = [cam.tx, 0.15, -0.9 + cam.tz]
        const eye: [number, number, number] = [
          target[0] + cam.dist * Math.sin(cam.az) * Math.cos(cam.el),
          target[1] + cam.dist * Math.sin(cam.el),
          target[2] + cam.dist * Math.cos(cam.az) * Math.cos(cam.el),
        ]
        const proj = mat4Perspective(Math.PI / 3, canvas.width / canvas.height, 0.05, 20)
        const mvp = mat4Multiply(proj, mat4LookAt(eye, target))

        drawFloor(mvp)

        g.useProgram(prog)
        if (terrainDirty) {
          g.bindBuffer(g.ARRAY_BUFFER, hbuf)
          g.bufferSubData(g.ARRAY_BUFFER, 0, terrainLerped)
          terrainDirty = false
        } else {
          g.bindBuffer(g.ARRAY_BUFFER, hbuf)
        }
        g.enableVertexAttribArray(aHeight)
        g.vertexAttribPointer(aHeight, 1, g.FLOAT, false, 0, 0)
        g.bindBuffer(g.ARRAY_BUFFER, vbuf)
        g.enableVertexAttribArray(aPos)
        g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0)
        g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibuf)
        g.activeTexture(g.TEXTURE1)
        g.bindTexture(g.TEXTURE_2D, cmapTex)
        g.activeTexture(g.TEXTURE0)
        g.bindTexture(g.TEXTURE_2D, tex) // sqlGrid's sampler reads unit 0
        g.uniform1i(loc.cmapTex, 1)
        g.uniformMatrix4fv(loc.mvp, false, mvp)
        g.uniform1f(loc.gamma, props.gamma)
        g.uniform2f(loc.grid, gridState[0], gridState[1])
        setBandUniforms(loc.bands)
        g.drawElements(g.TRIANGLES, idx.length, g.UNSIGNED_SHORT, 0)
        drawSqlGrid(mvp)
        placeLabels((xNorm) => {
          const px = xNorm * 2 - 1
          const w = mvp[3] * px + mvp[15]
          if (w <= 0.01) return null
          const sx = (((mvp[0] * px + mvp[12]) / w) * 0.5 + 0.5) * canvas.clientWidth
          const sy = (1 - (((mvp[1] * px + mvp[13]) / w) * 0.5 + 0.5)) * canvas.clientHeight
          return [sx, sy + 2]
        })
      }
    }

    renderFn?.()
    onCleanup(() => {
      renderFn = null
      programs.forEach((p) => g.deleteProgram(p))
      buffers.forEach((b) => g.deleteBuffer(b))
    })
  })

  onMount(() => {
    const canvas = canvasEl
    if (!canvas) return

    let drag: { mode: 'rotate' | 'pan'; x: number; y: number } | null = null

    const onMouseDown = (e: MouseEvent) => {
      if (props.view !== 'terrain') return
      const pan = e.button === 2 || e.button === 1 || e.shiftKey
      drag = { mode: pan ? 'pan' : 'rotate', x: e.clientX, y: e.clientY }
      canvas.style.cursor = 'grabbing'
      e.preventDefault()
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX
      drag.y = e.clientY
      const cam = terrainCam
      if (drag.mode === 'rotate') {
        cam.az = Math.max(-1.3, Math.min(1.3, cam.az - dx * 0.008))
        cam.el = Math.max(0.12, Math.min(1.5, cam.el + dy * 0.008))
      } else {
        const s = 0.0022 * cam.dist
        cam.tx -= (dx * Math.cos(cam.az) + dy * Math.sin(cam.az)) * s
        cam.tz -= (dy * Math.cos(cam.az) - dx * Math.sin(cam.az)) * s
        cam.tx = Math.max(-1.5, Math.min(1.5, cam.tx))
        cam.tz = Math.max(-2.0, Math.min(1.5, cam.tz))
      }
      renderFn?.()
    }
    const onMouseUp = () => {
      drag = null
      canvas.style.cursor = 'grab'
    }
    const onWheel = (e: WheelEvent) => {
      if (props.view !== 'terrain') return // waterfall: let the page scroll
      e.preventDefault()
      const cam = terrainCam
      cam.dist = Math.max(0.8, Math.min(7, cam.dist * Math.exp(e.deltaY * 0.0012)))
      renderFn?.()
    }
    const onDblClick = () => {
      if (props.view !== 'terrain') return
      terrainCam = { ...TERRAIN_CAM }
      renderFn?.()
    }
    const onContextMenu = (e: MouseEvent) => {
      if (props.view === 'terrain') e.preventDefault()
    }

    createEffect(() => {
      canvas.style.cursor = props.view === 'terrain' ? 'grab' : 'default'
    })
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDblClick)
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    onCleanup(() => {
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDblClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    })
  })

  createEffect(() => {
    void props.height
    renderFn?.()
  })

  return (
    <>
      <canvas
        ref={canvasEl}
        width={640}
        height={props.height}
        style={{ height: `${props.height}px` }}
        class="block w-full rounded border border-[#30363d] bg-[#0d1117] select-none"
      />
      {labels().map((lb, i) => (
        <span
          ref={(el) => (labelEls[i] = el)}
          class="pointer-events-none absolute font-mono text-[9px] text-[#8b949e] select-none"
          style={{ display: 'none', transform: 'translateX(-50%)', 'text-shadow': '0 0 4px #0d1117, 0 0 4px #0d1117' }}
        >
          {lb.text}
        </span>
      ))}
      {(props.markers ?? []).map((mk, i) => (
        <div
          ref={(el) => (markerEls[i] = el)}
          class="pointer-events-none absolute"
          style={{
            display: 'none',
            width: '1px',
            transform: 'translateX(-50%)',
            background: mk.color,
            opacity: 0.55,
            'box-shadow': `0 0 3px ${mk.color}`,
          }}
        />
      ))}
      <div
        ref={txMarkerEl}
        class="pointer-events-none absolute"
        style={{
          display: 'none',
          width: '2px',
          transform: 'translateX(-50%)',
          // Red — stands out against the waterfall's dark-blue quiet floor.
          background: 'rgba(248,81,73,0.8)',
          'box-shadow': '0 0 4px rgba(248,81,73,0.5)',
        }}
      />
      {props.view === 'terrain' && (
        <div class="pointer-events-none absolute right-2 bottom-1.5 font-mono text-[9px] text-[#484f58] select-none">
          drag rotate · shift+drag pan · scroll zoom · dblclick reset
        </div>
      )}
      {failed() && (
        <div class="absolute inset-0 flex items-center justify-center font-mono text-xs text-[#f85149]">
          WebGL unavailable — using CPU fallback
        </div>
      )}
    </>
  )
}
