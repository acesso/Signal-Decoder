'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

export type GLView = 'terrain' | 'ridge';

export interface GLSpectrogramHandle {
  pushRow(data: Uint8Array): void;
}

// A frequency range of interest rendered over the spectrogram (decoder filter
// bands, tone markers). `line: true` renders at full strength (marker line);
// otherwise it's a translucent band.
export interface SpectroBand {
  fromHz: number;
  toHz: number;
  color: string;
  line?: boolean;
}

interface Props {
  view: GLView;
  gamma: number;
  height: number;
  minHz?: number;          // lower bound of the display window (default 0)
  maxHz: number;           // upper bound of the display window
  bands?: SpectroBand[];
  bandAlpha?: number;      // 0..1 opacity of the band overlays
  markers?: SpectroBand[]; // screen-space center-line markers (projected to front edge)
  sqlLevel?: number;       // 0..1 squelch threshold — rendered as a cutting plane
  sqlAlpha?: number;       // 0..1 opacity of the squelch plane
  sqlGridSize?: number;    // grid resolution (cols = size*2, rows = size); enables grid mode
}

// History texture: TEX_W frequency bins × TEX_H rows, written as a ring buffer
// so scrolling is a sampling offset instead of a per-frame copy
const TEX_W = 512;
const TEX_H = 256;
const BG: [number, number, number] = [0.051, 0.067, 0.09]; // #0d1117
const SQL_COLOR: [number, number, number] = [0.89, 0.70, 0.25]; // #e3b341
const MAX_BANDS = 8;
const HEIGHT_SCALE = 0.55;

const TERRAIN_X = 96;   // mesh columns (frequency)
const TERRAIN_Z = 112;  // mesh rows (time) — keeps indices under the Uint16 limit
const RIDGE_COUNT = 56; // ridgeline rows
const RIDGE_SEGS  = 180;
const RIDGE_BASE_NEW = -0.85;
const RIDGE_BASE_OLD = 0.80;
const RIDGE_LABEL_Y  = -0.92;

// Google's polynomial approximation of the Turbo colormap
const TURBO_GLSL = `
vec3 turbo(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, t, t*t, t*t*t);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4,kR4)+dot(v2,kR2), dot(v4,kG4)+dot(v2,kG2), dot(v4,kB4)+dot(v2,kB2)), 0.0, 1.0);
}
`;

// Tints the surface color inside each band range. vX is the normalized
// frequency coordinate; loop bound must be a constant in WebGL1 GLSL.
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
`;

// Frequency reference grid: minor/major line steps in normalized x
const GRID_GLSL = `
uniform vec2 uGrid; // (minor step, major step)
float gridK(float x, float step, float halfW) {
  float d = abs(fract(x / step + 0.5) - 0.5) * step;
  return 1.0 - smoothstep(halfW * 0.5, halfW, d);
}
vec3 applyGrid(vec3 c, float x) {
  float minor = gridK(x, uGrid.x, 0.0025);
  float major = gridK(x, uGrid.y, 0.0035);
  return mix(c, vec3(0.55, 0.60, 0.66), minor * 0.10 + major * 0.18);
}
`;

// ── SQL grid shaders (terrain mode only) ────────────────────────────────────
// The plane at the squelch height is replaced by a grid of cells. Each cell
// is snapped to a centre sample from the ring-buffer texture; if that sample
// exceeds the raw squelch level the cell lights up in the channel's colour.

const SQL_GRID_VS = `
precision mediump float;
attribute vec2 aPos; // x = freq [0,1], y = depth/time [0,1]
uniform mat4 uMVP;
uniform float uY;
varying float vX;
varying float vZ;
void main() {
  vX = aPos.x;
  vZ = aPos.y;
  gl_Position = uMVP * vec4(aPos.x * 2.0 - 1.0, uY, -aPos.y * 2.0, 1.0);
}
`;

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
  return vec3(0.89, 0.70, 0.25); // amber default
}

void main() {
  // Snap to cell centre so every fragment in a cell shares the same sample
  vec2 cc = (floor(vec2(vX, vZ) * uGridCells) + 0.5) / uGridCells;

  // Sample history at cell centre
  float texV = fract(uHead - cc.y * uDepth);
  float raw  = texture2D(uTex, vec2(cc.x, texV)).r;

  // Grid line mask (thin border around each cell)
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
`;

// ── Shaders ───────────────────────────────────────────────────────────────────
// Both views sample the same ring-buffer texture: depth d ∈ [0,1] (0 = newest)
// maps to texture row fract(uHead - d * uDepth).

const TERRAIN_VS = `
precision mediump float;
attribute vec2 aPos; // x = freq [0,1], y = depth [0,1] (0 = front/newest)
uniform sampler2D uTex;
uniform float uHead, uDepth, uGamma;
uniform mat4 uMVP;
varying float vV;
varying float vZ;
varying float vX;
void main() {
  float texV = fract(uHead - aPos.y * uDepth);
  float v = pow(texture2D(uTex, vec2(aPos.x, texV)).r, uGamma);
  vV = v;
  vZ = aPos.y;
  vX = aPos.x;
  vec3 p = vec3(aPos.x * 2.0 - 1.0, v * ${HEIGHT_SCALE}, -aPos.y * 2.0);
  gl_Position = uMVP * vec4(p, 1.0);
}
`;

const TERRAIN_FS = `
precision mediump float;
varying float vV;
varying float vZ;
varying float vX;
${TURBO_GLSL}
${BANDS_GLSL}
${GRID_GLSL}
void main() {
  vec3 c = turbo(vV);
  c = applyGrid(c, vX);
  c = applyBands(c, vX);
  c = mix(c, vec3(${BG[0]}, ${BG[1]}, ${BG[2]}), smoothstep(0.45, 1.0, vZ)); // fade into the distance
  gl_FragColor = vec4(c, 1.0);
}
`;

const RIDGE_VS = `
precision mediump float;
attribute vec2 aPos; // x = freq [0,1], y = 1 on the curve / 0 on the baseline
uniform sampler2D uTex;
uniform float uHead, uDepth, uGamma, uRow; // uRow = depth [0,1] (0 = newest, drawn at the bottom)
uniform vec2 uPan;
uniform float uScale;
varying float vV;
varying float vX;
void main() {
  float texV = fract(uHead - uRow * uDepth);
  float v = pow(texture2D(uTex, vec2(aPos.x, texV)).r, uGamma);
  vV = v;
  vX = aPos.x;
  float base = mix(${RIDGE_BASE_NEW}, ${RIDGE_BASE_OLD}, uRow);
  float y = base + aPos.y * v * ${HEIGHT_SCALE};
  float x = (aPos.x * 2.0 - 1.0) * mix(0.98, 0.86, uRow); // slight narrowing for depth
  gl_Position = vec4((vec2(x, y) + uPan) * uScale, 0.0, 1.0);
}
`;

const RIDGE_FS = `
precision mediump float;
uniform float uStroke, uRow;
varying float vV;
varying float vX;
${TURBO_GLSL}
${BANDS_GLSL}
void main() {
  if (uStroke < 0.5) {
    gl_FragColor = vec4(${BG[0]}, ${BG[1]}, ${BG[2]}, 1.0); // fill occludes ridges behind
  } else {
    vec3 c = turbo(clamp(vV * 1.15, 0.0, 1.0));
    c = applyBands(c, vX);
    gl_FragColor = vec4(c * mix(1.0, 0.3, uRow), 1.0);
  }
}
`;

// Ridge background plate carrying the frequency grid (pans/zooms with content)
const RIDGE_GRID_VS = `
precision mediump float;
attribute vec2 aPos; // x = freq [0,1], y = content-space y
uniform vec2 uPan;
uniform float uScale;
varying float vX;
void main() {
  vX = aPos.x;
  float x = (aPos.x * 2.0 - 1.0) * 0.98;
  gl_Position = vec4((vec2(x, aPos.y) + uPan) * uScale, 0.0, 1.0);
}
`;

const RIDGE_GRID_FS = `
precision mediump float;
varying float vX;
${GRID_GLSL}
void main() {
  gl_FragColor = vec4(applyGrid(vec3(${BG[0]}, ${BG[1]}, ${BG[2]}), vX), 1.0);
}
`;

// Squelch threshold: a translucent "sheet of paper" cutting through the terrain
// at the threshold height (uMode 0), or a thin line on the front ridge (uMode 1)
const SQL_VS = `
precision mediump float;
attribute vec2 aPos; // (x, depth-or-thickness) in [0,1]
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
`;

const SQL_FS = `
precision mediump float;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(${SQL_COLOR[0]}, ${SQL_COLOR[1]}, ${SQL_COLOR[2]}, uAlpha);
}
`;

// ── Small GL / matrix helpers ─────────────────────────────────────────────────

function makeProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('GLSpectrogram shader error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('GLSpectrogram link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function mat4LookAt(eye: [number, number, number], center: [number, number, number]): Float32Array {
  // up is fixed at (0,1,0)
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  const zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xy = 0, xz = -zx; // (0,1,0) × z
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${hz % 1000 === 0 ? hz / 1000 : (hz / 1000).toFixed(1)}k`;
  return String(hz);
}

// Camera defaults — terrain opens at a 45° elevation for a perspective look
const TERRAIN_CAM = { az: 0, el: Math.PI / 4, dist: 2.6, tx: 0, tz: 0 };
const RIDGE_CAM   = { scale: 1, panX: 0, panY: 0 };

interface BandUniforms {
  count: WebGLUniformLocation | null;
  range: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  strength: WebGLUniformLocation | null;
  alpha: WebGLUniformLocation | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

const GLSpectrogram = forwardRef<GLSpectrogramHandle, Props>(function GLSpectrogram(
  { view, gamma, height, minHz = 0, maxHz, bands, bandAlpha = 0.3, markers, sqlLevel, sqlAlpha = 0.3, sqlGridSize }, ref,
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const glRef      = useRef<WebGLRenderingContext | null>(null);
  const texRef     = useRef<WebGLTexture | null>(null);
  const headRef    = useRef(0); // next ring-buffer row to write
  const renderRef  = useRef<(() => void) | null>(null);
  const gammaRef   = useRef(gamma);
  const bandsRef   = useRef<{ ranges: Float32Array; colors: Float32Array; strengths: Float32Array; count: number; alpha: number }>({
    ranges: new Float32Array(MAX_BANDS * 2),
    colors: new Float32Array(MAX_BANDS * 3),
    strengths: new Float32Array(MAX_BANDS),
    count: 0,
    alpha: bandAlpha,
  });
  const sqlRef         = useRef<{ level?: number; alpha: number }>({ level: sqlLevel, alpha: sqlAlpha });
  const sqlGridSizeRef = useRef<number | undefined>(sqlGridSize);
  const gridRef    = useRef<[number, number]>([0.1, 0.2]); // normalized (minor, major) steps
  const minHzRef   = useRef(minHz);
  const maxHzRef   = useRef(maxHz);
  const terrainCam = useRef({ ...TERRAIN_CAM });
  const ridgeCam   = useRef({ ...RIDGE_CAM });
  const rowScratch = useRef(new Uint8Array(TEX_W));
  const labelElsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const markerElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const markersRef = useRef<SpectroBand[]>([]);
  const [failed, setFailed] = useState(false);

  // Frequency reference grid: minor lines + labelled major lines
  const span = maxHz - minHz;
  const gridMinorHz = span > 2000 ? 250 : 125;
  const gridMajorHz = span > 2000 ? 1000 : 500;
  const labels = useMemo(() => {
    const out: { x: number; text: string }[] = [];
    const firstMaj = Math.ceil(minHz / gridMajorHz) * gridMajorHz;
    for (let hz = firstMaj; hz < maxHz; hz += gridMajorHz) {
      out.push({ x: (hz - minHz) / span, text: formatHz(hz) });
    }
    return out;
  }, [minHz, maxHz, gridMajorHz, span]);
  const labelsRef = useRef(labels);
  useEffect(() => {
    labelsRef.current = labels;
    gridRef.current = [gridMinorHz / span, gridMajorHz / span];
    minHzRef.current = minHz;
    maxHzRef.current = maxHz;
    renderRef.current?.();
  }, [labels, gridMinorHz, gridMajorHz, span, minHz, maxHz]);

  useEffect(() => {
    const list = markers ?? [];
    markersRef.current = list;
    markerElsRef.current = markerElsRef.current.slice(0, list.length);
    renderRef.current?.();
  }, [markers]);
  useEffect(() => { gammaRef.current = gamma; renderRef.current?.(); }, [gamma]);
  useEffect(() => {
    sqlRef.current = { level: sqlLevel, alpha: sqlAlpha };
    renderRef.current?.();
  }, [sqlLevel, sqlAlpha]);
  useEffect(() => {
    sqlGridSizeRef.current = sqlGridSize;
    renderRef.current?.();
  }, [sqlGridSize]);

  // Pack band props into uniform-ready arrays
  useEffect(() => {
    const b = bandsRef.current;
    const list = (bands ?? []).slice(0, MAX_BANDS);
    list.forEach((band, i) => {
      b.ranges[i * 2]     = Math.max(0, (band.fromHz - minHz) / span);
      b.ranges[i * 2 + 1] = Math.min(1, (band.toHz - minHz) / span);
      const [r, g, bl] = hexToRgb(band.color);
      b.colors[i * 3] = r; b.colors[i * 3 + 1] = g; b.colors[i * 3 + 2] = bl;
      b.strengths[i] = band.line ? 1.0 : 0.45;
    });
    b.count = list.length;
    b.alpha = bandAlpha;
    renderRef.current?.();
  }, [bands, bandAlpha, minHz, maxHz, span]);

  // Context + shared history texture — created once, survives view switches
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) { setFailed(true); return; }
    glRef.current = gl;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, TEX_W, TEX_H, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT); // ring-buffer sampling needs wrap
    texRef.current = tex;
  }, []);

  // Build the programs + geometry for the active view
  useEffect(() => {
    const gl = glRef.current;
    const canvas = canvasRef.current;
    if (!gl || !canvas || failed) return;

    const headNorm = () => ((headRef.current - 0.5 + TEX_H) % TEX_H) / TEX_H;
    const DEPTH = (TEX_H - 1) / TEX_H;
    const buffers: WebGLBuffer[] = [];
    const programs: WebGLProgram[] = [];

    const mkBuffer = (data: Float32Array) => {
      const buf = gl.createBuffer()!;
      buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return buf;
    };
    const mkProgram = (vs: string, fs: string) => {
      const p = makeProgram(gl, vs, fs);
      if (p) programs.push(p);
      return p;
    };

    const bandLocs = (p: WebGLProgram): BandUniforms => ({
      count: gl.getUniformLocation(p, 'uBandCount'),
      range: gl.getUniformLocation(p, 'uBandRange'),
      color: gl.getUniformLocation(p, 'uBandColor'),
      strength: gl.getUniformLocation(p, 'uBandStrength'),
      alpha: gl.getUniformLocation(p, 'uBandAlpha'),
    });
    const setBandUniforms = (loc: BandUniforms) => {
      const b = bandsRef.current;
      gl.uniform1i(loc.count, b.count);
      gl.uniform2fv(loc.range, b.ranges);
      gl.uniform3fv(loc.color, b.colors);
      gl.uniform1fv(loc.strength, b.strengths);
      gl.uniform1f(loc.alpha, b.alpha);
    };

    // Shared translucent squelch program (plane on terrain / line on ridge)
    const sqlProg = mkProgram(SQL_VS, SQL_FS);
    if (!sqlProg) { setFailed(true); return; }
    const sqlQuad = mkBuffer(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    const sqlLoc = {
      aPos: gl.getAttribLocation(sqlProg, 'aPos'),
      mvp: gl.getUniformLocation(sqlProg, 'uMVP'),
      y: gl.getUniformLocation(sqlProg, 'uY'),
      mode: gl.getUniformLocation(sqlProg, 'uMode'),
      pan: gl.getUniformLocation(sqlProg, 'uPan'),
      scale: gl.getUniformLocation(sqlProg, 'uScale'),
      alpha: gl.getUniformLocation(sqlProg, 'uAlpha'),
    };
    const drawSql = (mode: number, y: number, mvp?: Float32Array) => {
      const sql = sqlRef.current;
      if (sql.level === undefined || sql.alpha <= 0) return;
      gl.useProgram(sqlProg);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (mode === 0) gl.depthMask(false);
      gl.bindBuffer(gl.ARRAY_BUFFER, sqlQuad);
      gl.enableVertexAttribArray(sqlLoc.aPos);
      gl.vertexAttribPointer(sqlLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      if (mvp) gl.uniformMatrix4fv(sqlLoc.mvp, false, mvp);
      gl.uniform1f(sqlLoc.y, y);
      gl.uniform1f(sqlLoc.mode, mode);
      gl.uniform2f(sqlLoc.pan, ridgeCam.current.panX, ridgeCam.current.panY);
      gl.uniform1f(sqlLoc.scale, ridgeCam.current.scale);
      gl.uniform1f(sqlLoc.alpha, sql.alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
      if (mode === 0) gl.depthMask(true);
    };
    const sqlHeight = () => Math.pow(sqlRef.current.level ?? 0, gammaRef.current) * HEIGHT_SCALE;

    // Position the HTML frequency labels and channel markers using the active projection
    const placeLabels = (project: (xNorm: number) => [number, number] | null) => {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      labelsRef.current.forEach((lb, i) => {
        const el = labelElsRef.current[i];
        if (!el) return;
        const pos = project(lb.x);
        if (!pos || pos[0] < -20 || pos[0] > W + 20 || pos[1] < 0 || pos[1] > H) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.left = `${pos[0]}px`;
        el.style.top  = `${Math.min(H - 14, pos[1])}px`;
      });
      // Channel center markers: vertical lines anchored to the projected front-edge y position
      const spanLocal = maxHzRef.current - minHzRef.current;
      markersRef.current.forEach((mk, i) => {
        const el = markerElsRef.current[i];
        if (!el) return;
        const centerHz = (mk.fromHz + mk.toHz) / 2;
        const xNorm = (centerHz - minHzRef.current) / spanLocal;
        const pos = project(xNorm);
        if (!pos || pos[0] < 0 || pos[0] > W) { el.style.display = 'none'; return; }
        el.style.display = 'block';
        el.style.left = `${pos[0]}px`;
        el.style.top = '0';
        el.style.bottom = '0';
      });
    };

    if (view === 'terrain') {
      const prog = mkProgram(TERRAIN_VS, TERRAIN_FS);
      if (!prog) { setFailed(true); return; }
      const verts = new Float32Array(TERRAIN_X * TERRAIN_Z * 2);
      for (let j = 0; j < TERRAIN_Z; j++) {
        for (let i = 0; i < TERRAIN_X; i++) {
          verts[(j * TERRAIN_X + i) * 2]     = i / (TERRAIN_X - 1);
          verts[(j * TERRAIN_X + i) * 2 + 1] = j / (TERRAIN_Z - 1);
        }
      }
      const idx = new Uint16Array((TERRAIN_X - 1) * (TERRAIN_Z - 1) * 6);
      let k = 0;
      for (let j = 0; j < TERRAIN_Z - 1; j++) {
        for (let i = 0; i < TERRAIN_X - 1; i++) {
          const a = j * TERRAIN_X + i;
          idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + TERRAIN_X;
          idx[k++] = a + 1; idx[k++] = a + TERRAIN_X + 1; idx[k++] = a + TERRAIN_X;
        }
      }
      const vbuf = mkBuffer(verts);
      const ibuf = gl.createBuffer()!;
      buffers.push(ibuf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      const loc = {
        head: gl.getUniformLocation(prog, 'uHead'),
        depth: gl.getUniformLocation(prog, 'uDepth'),
        gamma: gl.getUniformLocation(prog, 'uGamma'),
        mvp: gl.getUniformLocation(prog, 'uMVP'),
        grid: gl.getUniformLocation(prog, 'uGrid'),
        bands: bandLocs(prog),
      };

      // SQL grid program — replaces the solid plane with an animated cell grid
      const sqlGridProg = mkProgram(SQL_GRID_VS, SQL_GRID_FS);
      const sqlGridLoc = sqlGridProg ? {
        aPos:      gl.getAttribLocation(sqlGridProg, 'aPos'),
        mvp:       gl.getUniformLocation(sqlGridProg, 'uMVP'),
        y:         gl.getUniformLocation(sqlGridProg, 'uY'),
        tex:       gl.getUniformLocation(sqlGridProg, 'uTex'),
        head:      gl.getUniformLocation(sqlGridProg, 'uHead'),
        depth:     gl.getUniformLocation(sqlGridProg, 'uDepth'),
        sqlLvl:    gl.getUniformLocation(sqlGridProg, 'uSqlLvl'),
        alpha:     gl.getUniformLocation(sqlGridProg, 'uAlpha'),
        gridCells: gl.getUniformLocation(sqlGridProg, 'uGridCells'),
        bands:     bandLocs(sqlGridProg),
      } : null;

      const drawSqlGrid = (mvp: Float32Array) => {
        const sql = sqlRef.current;
        if (sql.level === undefined || sql.alpha <= 0) return;
        const gs = sqlGridSizeRef.current;
        if (!gs || !sqlGridProg || !sqlGridLoc) {
          drawSql(0, sqlHeight(), mvp); // fallback to solid plane
          return;
        }
        gl.useProgram(sqlGridProg);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.bindBuffer(gl.ARRAY_BUFFER, sqlQuad);
        gl.enableVertexAttribArray(sqlGridLoc.aPos);
        gl.vertexAttribPointer(sqlGridLoc.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(sqlGridLoc.mvp, false, mvp);
        gl.uniform1f(sqlGridLoc.y, sqlHeight());
        gl.bindTexture(gl.TEXTURE_2D, texRef.current);
        gl.uniform1i(sqlGridLoc.tex, 0);
        gl.uniform1f(sqlGridLoc.head, headNorm());
        gl.uniform1f(sqlGridLoc.depth, DEPTH);
        gl.uniform1f(sqlGridLoc.sqlLvl, sql.level);
        gl.uniform1f(sqlGridLoc.alpha, sql.alpha);
        gl.uniform2f(sqlGridLoc.gridCells, gs * 2, gs);
        setBandUniforms(sqlGridLoc.bands);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      };

      renderRef.current = () => {
        const cam = terrainCam.current;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(BG[0], BG[1], BG[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
        gl.bindTexture(gl.TEXTURE_2D, texRef.current);
        const target: [number, number, number] = [cam.tx, 0.15, -0.9 + cam.tz];
        const eye: [number, number, number] = [
          target[0] + cam.dist * Math.sin(cam.az) * Math.cos(cam.el),
          target[1] + cam.dist * Math.sin(cam.el),
          target[2] + cam.dist * Math.cos(cam.az) * Math.cos(cam.el),
        ];
        const proj = mat4Perspective(Math.PI / 3, canvas.width / canvas.height, 0.05, 20);
        const mvp  = mat4Multiply(proj, mat4LookAt(eye, target));
        gl.uniformMatrix4fv(loc.mvp, false, mvp);
        gl.uniform1f(loc.head, headNorm());
        gl.uniform1f(loc.depth, DEPTH);
        gl.uniform1f(loc.gamma, gammaRef.current);
        gl.uniform2f(loc.grid, gridRef.current[0], gridRef.current[1]);
        setBandUniforms(loc.bands);
        gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
        drawSqlGrid(mvp);
        // Labels track the front edge of the mesh (y=0, z=0)
        placeLabels(xNorm => {
          const px = xNorm * 2 - 1;
          const w = mvp[3] * px + mvp[15];
          if (w <= 0.01) return null;
          const sx = ((mvp[0] * px + mvp[12]) / w * 0.5 + 0.5) * canvas.clientWidth;
          const sy = (1 - ((mvp[1] * px + mvp[13]) / w * 0.5 + 0.5)) * canvas.clientHeight;
          return [sx, sy + 2];
        });
      };
    } else {
      const prog = mkProgram(RIDGE_VS, RIDGE_FS);
      const gridProg = mkProgram(RIDGE_GRID_VS, RIDGE_GRID_FS);
      if (!prog || !gridProg) { setFailed(true); return; }
      // Interleaved strip: (x,1)=on curve, (x,0)=baseline. The fill pass reads
      // both as a TRIANGLE_STRIP; the stroke pass strides over only the (x,1)s.
      const strip = new Float32Array((RIDGE_SEGS + 1) * 4);
      for (let i = 0; i <= RIDGE_SEGS; i++) {
        const x = i / RIDGE_SEGS;
        strip[i * 4]     = x; strip[i * 4 + 1] = 1;
        strip[i * 4 + 2] = x; strip[i * 4 + 3] = 0;
      }
      const sbuf = mkBuffer(strip);
      const gquad = mkBuffer(new Float32Array([0, -0.97, 1, -0.97, 0, 0.97, 1, 0.97]));
      const aPos = gl.getAttribLocation(prog, 'aPos');
      const gPos = gl.getAttribLocation(gridProg, 'aPos');
      const loc = {
        head: gl.getUniformLocation(prog, 'uHead'),
        depth: gl.getUniformLocation(prog, 'uDepth'),
        gamma: gl.getUniformLocation(prog, 'uGamma'),
        row: gl.getUniformLocation(prog, 'uRow'),
        stroke: gl.getUniformLocation(prog, 'uStroke'),
        pan: gl.getUniformLocation(prog, 'uPan'),
        scale: gl.getUniformLocation(prog, 'uScale'),
        bands: bandLocs(prog),
      };
      const gloc = {
        pan: gl.getUniformLocation(gridProg, 'uPan'),
        scale: gl.getUniformLocation(gridProg, 'uScale'),
        grid: gl.getUniformLocation(gridProg, 'uGrid'),
      };
      renderRef.current = () => {
        const cam = ridgeCam.current;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.disable(gl.DEPTH_TEST);
        gl.clearColor(BG[0], BG[1], BG[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        // Background grid plate
        gl.useProgram(gridProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, gquad);
        gl.enableVertexAttribArray(gPos);
        gl.vertexAttribPointer(gPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gloc.pan, cam.panX, cam.panY);
        gl.uniform1f(gloc.scale, cam.scale);
        gl.uniform2f(gloc.grid, gridRef.current[0], gridRef.current[1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // Ridges — painter's algorithm: oldest (back/top) first
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, sbuf);
        gl.enableVertexAttribArray(aPos);
        gl.bindTexture(gl.TEXTURE_2D, texRef.current);
        gl.uniform1f(loc.head, headNorm());
        gl.uniform1f(loc.depth, DEPTH);
        gl.uniform1f(loc.gamma, gammaRef.current);
        gl.uniform2f(loc.pan, cam.panX, cam.panY);
        gl.uniform1f(loc.scale, cam.scale);
        setBandUniforms(loc.bands);
        for (let r = RIDGE_COUNT - 1; r >= 0; r--) {
          gl.uniform1f(loc.row, r / (RIDGE_COUNT - 1));
          gl.uniform1f(loc.stroke, 0);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 8, 0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, (RIDGE_SEGS + 1) * 2);
          gl.uniform1f(loc.stroke, 1);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
          gl.drawArrays(gl.LINE_STRIP, 0, RIDGE_SEGS + 1);
        }
        // Squelch threshold on the front (newest) ridge
        drawSql(1, RIDGE_BASE_NEW + sqlHeight());
        placeLabels(xNorm => {
          const cx = ((xNorm * 2 - 1) * 0.98 + cam.panX) * cam.scale;
          const cy = (RIDGE_LABEL_Y + cam.panY) * cam.scale;
          return [
            (cx * 0.5 + 0.5) * canvas.clientWidth,
            (1 - (cy * 0.5 + 0.5)) * canvas.clientHeight,
          ];
        });
      };
    }

    renderRef.current?.();
    return () => {
      renderRef.current = null;
      programs.forEach(p => gl.deleteProgram(p));
      buffers.forEach(b => gl.deleteBuffer(b));
    };
  }, [view, failed]);

  // Mouse interaction — orbit/pan/zoom for terrain, pan/zoom for ridge.
  // Double-click resets the camera.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || failed) return;

    let drag: { mode: 'rotate' | 'pan'; x: number; y: number } | null = null;

    const onMouseDown = (e: MouseEvent) => {
      const pan = e.button === 2 || e.button === 1 || e.shiftKey || view === 'ridge';
      drag = { mode: pan ? 'pan' : 'rotate', x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (view === 'terrain') {
        const cam = terrainCam.current;
        if (drag.mode === 'rotate') {
          cam.az = Math.max(-1.3, Math.min(1.3, cam.az - dx * 0.008));
          cam.el = Math.max(0.12, Math.min(1.5, cam.el + dy * 0.008));
        } else {
          // Pan the look-at target in the ground plane, following the camera heading
          const s = 0.0022 * cam.dist;
          cam.tx -= (dx * Math.cos(cam.az) + dy * Math.sin(cam.az)) * s;
          cam.tz -= (dy * Math.cos(cam.az) - dx * Math.sin(cam.az)) * s;
          cam.tx = Math.max(-1.5, Math.min(1.5, cam.tx));
          cam.tz = Math.max(-2.0, Math.min(1.5, cam.tz));
        }
      } else {
        const cam = ridgeCam.current;
        const rect = canvas.getBoundingClientRect();
        cam.panX += (dx / rect.width)  *  2 / cam.scale;
        cam.panY += (dy / rect.height) * -2 / cam.scale;
      }
      renderRef.current?.();
    };
    const onMouseUp = () => { drag = null; canvas.style.cursor = 'grab'; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (view === 'terrain') {
        const cam = terrainCam.current;
        cam.dist = Math.max(0.8, Math.min(7, cam.dist * Math.exp(e.deltaY * 0.0012)));
      } else {
        const cam = ridgeCam.current;
        cam.scale = Math.max(0.5, Math.min(8, cam.scale * Math.exp(-e.deltaY * 0.0012)));
      }
      renderRef.current?.();
    };
    const onDblClick = () => {
      terrainCam.current = { ...TERRAIN_CAM };
      ridgeCam.current   = { ...RIDGE_CAM };
      renderRef.current?.();
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [view, failed]);

  // Changing the height attribute clears the drawing buffer — repaint
  useEffect(() => { renderRef.current?.(); }, [height]);

  useImperativeHandle(ref, () => ({
    pushRow(data: Uint8Array) {
      const gl = glRef.current;
      if (!gl || !texRef.current || data.length === 0) return;
      // Resample incoming bins to the fixed texture width
      const out = rowScratch.current;
      const n = data.length;
      for (let i = 0; i < TEX_W; i++) {
        const f  = (i / (TEX_W - 1)) * (n - 1);
        const i0 = f | 0;
        const i1 = Math.min(i0 + 1, n - 1);
        out[i] = data[i0] * (1 - (f - i0)) + data[i1] * (f - i0);
      }
      gl.bindTexture(gl.TEXTURE_2D, texRef.current);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, headRef.current, TEX_W, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, out);
      headRef.current = (headRef.current + 1) % TEX_H;
      renderRef.current?.();
    },
  }), []);

  return (
    <>
      <canvas
        ref={canvasRef}
        width={640}
        height={height}
        style={{ height }}
        className="w-full border border-[#30363d] rounded bg-[#0d1117] block select-none"
      />
      {labels.map((lb, i) => (
        <span
          key={lb.text}
          ref={el => { labelElsRef.current[i] = el; }}
          className="absolute text-[9px] font-mono text-[#8b949e] pointer-events-none select-none"
          style={{ display: 'none', transform: 'translateX(-50%)', textShadow: '0 0 4px #0d1117, 0 0 4px #0d1117' }}
        >
          {lb.text}
        </span>
      ))}
      {(markers ?? []).map((mk, i) => (
        <div
          key={i}
          ref={el => { markerElsRef.current[i] = el; }}
          className="absolute pointer-events-none"
          style={{
            display: 'none',
            width: '1px',
            transform: 'translateX(-50%)',
            background: mk.color,
            opacity: 0.55,
            boxShadow: `0 0 3px ${mk.color}`,
          }}
        />
      ))}
      <div className="absolute bottom-1.5 right-2 text-[9px] font-mono text-[#484f58] pointer-events-none select-none">
        {view === 'terrain' ? 'drag rotate · shift+drag pan · scroll zoom · dblclick reset' : 'drag pan · scroll zoom · dblclick reset'}
      </div>
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[#f85149] font-mono">
          WebGL unavailable — switch View back to Classic 2D
        </div>
      )}
    </>
  );
});

export default GLSpectrogram;
