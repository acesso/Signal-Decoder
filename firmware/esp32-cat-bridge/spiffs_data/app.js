const msg = document.getElementById('msg');
const ssidSelect = document.getElementById('wifi-ssid');
const scanBtn = document.getElementById('scan-btn');

function showMsg(text, kind) {
  msg.textContent = text;
  msg.dataset.kind = kind || '';
}

function fmtUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

const WIFI_STATE_LABEL = {
  connected: 'connected',
  connecting: 'connecting…',
  disconnected: 'disconnected',
  ap_fallback: 'can’t reach network — broadcasting setup AP',
};

// Ensures the currently-configured SSID always has a matching <option>, even
// before any scan has run (a fresh page load) or if that network happens to
// be out of range right now — otherwise the select would silently show the
// wrong (first-in-list) network instead of the one actually configured.
function ensureOption(select, ssid) {
  if (!ssid) return;
  for (const opt of select.options) {
    if (opt.value === ssid) return;
  }
  const opt = document.createElement('option');
  opt.value = ssid;
  opt.textContent = ssid;
  select.insertBefore(opt, select.firstChild);
}

const STATUS_AUTO_REFRESH_MS = 5000;

// silent: true suppresses error messages — used by the background
// auto-refresh timer so a single dropped poll (Wi-Fi hiccup, page in a
// backgrounded tab) doesn't flash an error at the user; the next tick
// quietly retries. The manual Refresh button passes silent: false so an
// actual failure there is still visible.
async function refreshStatus(silent) {
  try {
    const [statusRes, infoRes] = await Promise.all([
      fetch('/status'),
      fetch('/info'),
    ]);
    const status = await statusRes.json();
    const info = await infoRes.json();

    document.getElementById('s-wifi').textContent =
      WIFI_STATE_LABEL[status.wifi_state] || status.wifi_state;
    document.getElementById('s-ip').textContent = status.ip || '—';
    document.getElementById('s-rssi').textContent =
      status.wifi_state === 'connected' ? `${status.rssi} dBm` : '—';
    document.getElementById('s-radio').textContent =
      status.radio_linked ? 'linked' : 'no traffic seen';
    document.getElementById('s-clients').textContent =
      `${status.ws_clients} / ${status.ws_max_clients}`;
    document.getElementById('s-uptime').textContent = fmtUptime(status.uptime_s);
    document.getElementById('s-fw').textContent = info.firmware_version;

    ensureOption(ssidSelect, status.ssid);
    if (status.ssid) ssidSelect.value = status.ssid;

    const catBaudSelectEl = document.getElementById('cat-baud-select');
    if (status.cat_baud && catBaudSelectEl) catBaudSelectEl.value = String(status.cat_baud);

    updatePaCard(status.pa_sense, status.pa_emergency_tripped);
  } catch (err) {
    if (!silent) showMsg(`Failed to load status: ${err.message}`, 'error');
  }
}

// ── PA safety watchdog ────────────────────────────────────────────────────
// Purely a status readout + manual clear — the actual watchdog (sensing,
// timeout, latching) lives entirely in the firmware (pa_watchdog.c); this
// page has no logic of its own beyond displaying GET /status's pa_sense/
// pa_emergency_tripped fields and calling POST /pa-emergency-clear.
const paCard = document.getElementById('pa-card');
const paClearBtn = document.getElementById('pa-clear-btn');

function updatePaCard(paSense, tripped) {
  document.getElementById('pa-sense').textContent =
    paSense === undefined ? '—' : (paSense ? 'energized' : 'off');
  document.getElementById('pa-emergency').textContent =
    tripped === undefined ? '—' : (tripped ? 'TRIPPED — PA disabled' : 'clear');
  paCard.classList.toggle('pa-tripped', tripped === true);
  paClearBtn.disabled = tripped !== true;
}

paClearBtn.addEventListener('click', async () => {
  if (!confirm('Clear the PA emergency cutoff? Only do this if you have confirmed by eye/ear that the amplifier is actually safe to re-enable.')) return;
  try {
    const res = await fetch('/pa-emergency-clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { pa_emergency_tripped } = await res.json();
    showMsg(pa_emergency_tripped ? 'Failed to clear — still tripped.' : 'PA emergency cutoff cleared.',
            pa_emergency_tripped ? 'error' : 'ok');
    void refreshStatus(true);
  } catch (err) {
    showMsg(`Failed to clear PA emergency: ${err.message}`, 'error');
  }
});

async function scanNetworks() {
  scanBtn.disabled = true;
  scanBtn.classList.add('spinning');
  try {
    const res = await fetch('/wifi-scan');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { networks } = await res.json();
    const previous = ssidSelect.value;

    networks.sort((a, b) => b.rssi - a.rssi);
    ssidSelect.innerHTML = '';
    for (const net of networks) {
      const opt = document.createElement('option');
      opt.value = net.ssid;
      opt.textContent = `${net.ssid} (${net.rssi} dBm)`;
      ssidSelect.appendChild(opt);
    }
    ensureOption(ssidSelect, previous);
    if (previous) ssidSelect.value = previous;

    showMsg(`Found ${networks.length} network${networks.length === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    showMsg(`Scan failed: ${err.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
    scanBtn.classList.remove('spinning');
  }
}

document.getElementById('refresh-btn').addEventListener('click', () => {
  showMsg('Refreshing…');
  refreshStatus(false).then(() => showMsg('Updated.', 'ok'));
});

// Pause polling while the tab isn't visible — no point spending the
// ESP32's CPU/RF time refreshing a page nobody's looking at, and resume
// (with an immediate refresh so the numbers aren't stale) when it's back.
let statusAutoRefreshTimer = null;
function startStatusAutoRefresh() {
  if (statusAutoRefreshTimer) return;
  statusAutoRefreshTimer = setInterval(() => refreshStatus(true), STATUS_AUTO_REFRESH_MS);
}
function stopStatusAutoRefresh() {
  clearInterval(statusAutoRefreshTimer);
  statusAutoRefreshTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopStatusAutoRefresh();
  } else {
    refreshStatus(true);
    startStatusAutoRefresh();
  }
});

scanBtn.addEventListener('click', scanNetworks);

document.getElementById('wifi-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ssid = ssidSelect.value.trim();
  const password = document.getElementById('wifi-pass').value;
  if (!ssid) return;
  if (!confirm(`Save Wi-Fi network "${ssid}" and reboot the bridge now?`)) return;

  showMsg('Saving and rebooting…');
  try {
    const res = await fetch('/wifi-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showMsg('Saved. Bridge is rebooting onto the new network—this page will lose connection.', 'ok');
  } catch (err) {
    showMsg(`Failed to save Wi-Fi config: ${err.message}`, 'error');
  }
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  if (!confirm('Restart the bridge now? Any connected clients will be disconnected briefly.')) return;
  showMsg('Restarting…');
  try {
    const res = await fetch('/reset', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showMsg('Restarting… this page will lose connection for a few seconds.', 'ok');
  } catch (err) {
    showMsg(`Failed to restart: ${err.message}`, 'error');
  }
});

// ── Audio bridge ─────────────────────────────────────────────────────────
// Debug-only audio path direct from this page: a second WebSocket (/audio,
// separate from the CAT-command relay) carrying raw 16-bit PCM mono at
// BRIDGE_AUDIO_SAMPLE_RATE in both directions. Not real WebRTC — see the
// firmware's audio_ws.h for why. Uses ScriptProcessorNode rather than a
// separate AudioWorklet module file: this page has no bundler, and pulling
// in a second .js module (with its own SPIFFS entry + fetch) isn't worth it
// for what's meant to stay a lightweight debug tool, not the main app.
const BRIDGE_AUDIO_SAMPLE_RATE = 8000; // must match ES8388_SAMPLE_RATE_HZ in bridge_config.h

const meterIn = document.getElementById('meter-in');
const meterInPct = document.getElementById('meter-in-pct');
const meterOut = document.getElementById('meter-out');
const meterOutPct = document.getElementById('meter-out-pct');
const listenBtn = document.getElementById('audio-listen-btn');
const micBtn = document.getElementById('audio-mic-btn');

let audioWs = null;
let playCtx = null;
let playAnalyserNode = null;
let nextPlayTime = 0;
let micCtx = null;
let micStream = null;
let micAnalyserNode = null;
let micProcessor = null;

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function int16ToFloat(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

// sqrt-compressed 0-1 — matches the firmware's own LED brightness curve
// (audio_monitor.c's rms_to_led_level) so this page's meters and the
// physical LEDs "agree" on what a given signal looks like.
function rmsLevel(samples) {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  return Math.sqrt(Math.min(1, Math.sqrt(sumSq / samples.length)));
}

function setMeter(fillEl, pctEl, level, active) {
  const pct = active ? Math.round(level * 100) : 0;
  fillEl.style.width = `${pct}%`;
  pctEl.textContent = active ? `${pct}%` : '—';
}

function playFrame(int16) {
  if (!playCtx) return;
  const floatSamples = int16ToFloat(int16);
  const resampled = resampleLinear(floatSamples, BRIDGE_AUDIO_SAMPLE_RATE, playCtx.sampleRate);

  const buffer = playCtx.createBuffer(1, resampled.length, playCtx.sampleRate);
  buffer.copyToChannel(resampled, 0);

  const source = playCtx.createBufferSource();
  source.buffer = buffer;
  // Routed through the shared analyser (created once in connectAudio(),
  // already wired to destination there) so the quality view can read from
  // one persistent node instead of a new analyser per short-lived frame.
  source.connect(playAnalyserNode || playCtx.destination);

  const startAt = Math.max(nextPlayTime, playCtx.currentTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;

  setMeter(meterIn, meterInPct, rmsLevel(floatSamples), true);
}

function stopMic() {
  if (micProcessor) { micProcessor.disconnect(); micProcessor.onaudioprocess = null; micProcessor = null; }
  micAnalyserNode = null;
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (micCtx) { micCtx.close(); micCtx = null; }
  micBtn.textContent = 'Send Mic to Radio';
  micBtn.disabled = !audioWs;
  setMeter(meterOut, meterOutPct, 0, false);
}

function disconnectAudio() {
  if (audioWs) { audioWs.close(); audioWs = null; }
  stopMic();
  if (playCtx) { playCtx.close(); playCtx = null; }
  playAnalyserNode = null;
  nextPlayTime = 0;
  listenBtn.textContent = 'Listen to Radio';
  micBtn.disabled = true;
  setMeter(meterIn, meterInPct, 0, false);
}

function connectAudio() {
  const url = new URL('/audio', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  playCtx = new AudioContext();
  nextPlayTime = 0;
  playAnalyserNode = playCtx.createAnalyser();
  playAnalyserNode.fftSize = 2048;
  playAnalyserNode.connect(playCtx.destination);

  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    audioWs = ws;
    listenBtn.textContent = 'Stop Listening';
    micBtn.disabled = false;
    showMsg('Audio connected.', 'ok');
  };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    playFrame(new Int16Array(ev.data));
  };
  ws.onerror = () => showMsg('Audio connection failed.', 'error');
  ws.onclose = () => { if (audioWs === ws) disconnectAudio(); };
}

async function startMic() {
  if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    micCtx = new AudioContext();
    const source = micCtx.createMediaStreamSource(micStream);

    // AnalyserNode doesn't need a destination connection to be readable —
    // it just needs to sit in the signal path, so tapping it here doesn't
    // change the fact that the mic is never routed to local speakers.
    micAnalyserNode = micCtx.createAnalyser();
    micAnalyserNode.fftSize = 2048;
    source.connect(micAnalyserNode);

    // 4096-sample buffer: large enough that ScriptProcessorNode's main-thread
    // callback overhead is negligible relative to buffer duration, small
    // enough to keep mic->radio latency reasonable for a debug tool (this
    // isn't the primary UI's carefully-tuned AudioWorklet capture path).
    micProcessor = micCtx.createScriptProcessor(4096, 1, 1);
    micProcessor.onaudioprocess = (ev) => {
      if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(input, micCtx.sampleRate, BRIDGE_AUDIO_SAMPLE_RATE);
      const int16 = floatToInt16(resampled);
      audioWs.send(int16.buffer);
      setMeter(meterOut, meterOutPct, rmsLevel(resampled), true);
    };
    source.connect(micProcessor);
    // ScriptProcessorNode only fires onaudioprocess while connected into the
    // graph all the way to a destination — a silent gain keeps it running
    // without actually putting the mic signal on the speakers (that would
    // be a feedback loop, not a debug tool).
    const silencer = micCtx.createGain();
    silencer.gain.value = 0;
    micProcessor.connect(silencer);
    silencer.connect(micCtx.destination);

    micBtn.textContent = 'Stop Mic';
  } catch (err) {
    showMsg(`Microphone access failed: ${err.message}`, 'error');
    stopMic();
  }
}

listenBtn.addEventListener('click', () => {
  if (audioWs) disconnectAudio();
  else connectAudio();
});

micBtn.addEventListener('click', () => {
  if (micStream) stopMic();
  else void startMic();
});

// ── CAT monitor ───────────────────────────────────────────────────────────
// Connects to the SAME /cat WebSocket the Signal-Decoder web app uses — this
// is a plain observer + occasional sender, not a separate protocol. Frames
// are split on ';' (Kenwood CAT frames are always ';'-terminated) and logged
// with a direction arrow: green/left for radio->bridge, red/right for
// bridge/browser->radio. Client-side only — the firmware doesn't buffer or
// replay history, so reloading this page starts with an empty log (see the
// README's note on why persistence wasn't worth the added firmware
// complexity for what's meant to stay a live debug view).
const CAT_LOG_MAX_LINES = 200;

const catLog = document.getElementById('cat-log');
const catLogPause = document.getElementById('cat-log-pause');
const catSendForm = document.getElementById('cat-send-form');
const catSendInput = document.getElementById('cat-send-input');
const catBaudSelect = document.getElementById('cat-baud-select');
const catBaudApplyBtn = document.getElementById('cat-baud-apply-btn');

let catWs = null;
let catRadioBuf = '';
let catClientBuf = '';

function appendCatFrame(direction, frame) {
  if (catLogPause.checked) return;
  const line = document.createElement('div');
  line.className = 'cat-log-line';

  const time = document.createElement('span');
  time.className = 'cat-log-time';
  time.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });

  const arrow = document.createElement('span');
  arrow.className = `arrow arrow-${direction}`;
  arrow.textContent = direction === 'in' ? '←' : '→';
  arrow.title = direction === 'in' ? 'from radio' : 'to radio';

  const text = document.createElement('span');
  text.className = 'cat-log-frame';
  text.textContent = frame;

  line.append(time, arrow, text);
  catLog.appendChild(line);

  while (catLog.childElementCount > CAT_LOG_MAX_LINES) {
    catLog.removeChild(catLog.firstChild);
  }
  catLog.scrollTop = catLog.scrollHeight;
}

// Splits a raw byte chunk on ';' into complete frames, carrying any partial
// trailing frame over in `buf` for the next chunk — a WebSocket frame
// doesn't necessarily align with a CAT frame boundary.
function feedCatBuf(buf, chunk, direction) {
  buf += chunk;
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === ';') {
      appendCatFrame(direction, buf.slice(start, i + 1));
      start = i + 1;
    }
  }
  return buf.slice(start);
}

function connectCatMonitor() {
  const url = new URL('/cat', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => { catWs = ws; };
  ws.onmessage = (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    catRadioBuf = feedCatBuf(catRadioBuf, text, 'in');
  };
  ws.onclose = () => {
    if (catWs === ws) catWs = null;
    // Reconnect after a short delay — the CAT monitor is meant to stay
    // open indefinitely as a debug view, so a dropped connection (bridge
    // reboot, brief Wi-Fi hiccup) should recover on its own rather than
    // leaving the log silently dead until a manual page reload.
    setTimeout(connectCatMonitor, 2000);
  };
}

catSendForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const raw = catSendInput.value.trim();
  if (!raw || !catWs || catWs.readyState !== WebSocket.OPEN) return;
  // Frames sent from here go out exactly as typed — the operator is
  // responsible for the trailing ';' and correct casing, same as typing
  // into a terminal talking to the radio directly. A missing ';' just
  // means the radio (and this page's own frame splitter) won't see it as
  // complete until the next character arrives.
  catWs.send(raw);
  appendCatFrame('out', raw.endsWith(';') ? raw : raw + ';');
  catSendInput.value = '';
});

document.getElementById('cat-log-clear-btn').addEventListener('click', () => {
  catLog.innerHTML = '';
});

catBaudApplyBtn.addEventListener('click', async () => {
  const baud = Number(catBaudSelect.value);
  if (!confirm(`Set the bridge's CAT UART to ${baud} baud? This must match the radio's own CAT menu setting.`)) return;
  try {
    const res = await fetch('/cat-baud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baud }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showMsg(`CAT baud set to ${baud}.`, 'ok');
  } catch (err) {
    showMsg(`Failed to set CAT baud: ${err.message}`, 'error');
  }
});

connectCatMonitor();

// ── Audio quality view ───────────────────────────────────────────────────
// For tuning the interface board's audio-in/audio-out RC filter trimpots by
// eye instead of by ear. Runs entirely in this browser tab (real CPU/GPU
// budget here, unlike the ESP32) — deliberately more than a bare meter:
// bar spectrum + a simple scrolling waterfall + oscilloscope, plus several
// automated "notice this" readouts (estimated filter cutoff, clip events,
// DC offset, noise floor), same analyses as the Signal-Decoder web app's
// AudioQualityPanel.tsx, ported to plain JS since this page has no
// bundler/component framework. Only ticks while "Show" is checked AND the
// corresponding audio direction is actually active — no point spending
// canvas-redraw work on a hidden or inactive view.
const CLIP_THRESHOLD = 0.98; // fraction of full-scale (Web Audio's -1..1 float range)
const CLIP_WINDOW_MS = 10000; // rolling window for the "N clips in the last 10s" counter
const CLIP_FLASH_MS = 250;
const NOISE_FLOOR_WINDOW_MS = 4000;
const DC_OFFSET_WARN = 0.03; // ~3% of full-scale

const qualityToggle = document.getElementById('quality-toggle');
const qualityView = document.getElementById('quality-view');

function makeChannelState(prefix) {
  return {
    prefix,
    barCanvas: document.getElementById(`quality-${prefix}-bars`),
    waterfallCanvas: document.getElementById(`quality-${prefix}-waterfall`),
    scopeCanvas: document.getElementById(`quality-${prefix}-scope`),
    readoutEl: document.getElementById(`quality-${prefix}-readout`),
    cutoffEl: document.getElementById(`quality-${prefix}-cutoff`),
    floorEl: document.getElementById(`quality-${prefix}-floor`),
    dcEl: document.getElementById(`quality-${prefix}-dc`),
    clipsEl: document.getElementById(`quality-${prefix}-clips`),
    channelEl: document.getElementById(`quality-${prefix}-bars`).closest('.quality-channel'),
    freqData: null,
    timeDataFloat: null,
    timeDataByte: null,
    clipEvents: [],
    lastClipFlashAt: 0,
    noiseFloorMin: Infinity,
    noiseFloorWindowStart: 0,
    waterfallImage: null, // ImageData scratch row, built lazily once canvas size is known
  };
}

const qualityIn = makeChannelState('in');
const qualityOut = makeChannelState('out');

// Same -6dB-relative-to-peak rolloff estimate as the web app's
// AudioQualityPanel.tsx — see that file for the full reasoning (a simple,
// robust threshold on 8-bit log-mapped analyser data beats trying to
// reconstruct a true -3dB point from this resolution).
function estimateRolloffBin(data) {
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > peak) { peak = data[i]; peakIdx = i; }
  }
  if (peak < 40) return null;
  const halfPeak = peak / 2;
  let belowRun = 0;
  for (let i = peakIdx; i < data.length; i++) {
    if (data[i] < halfPeak) {
      belowRun++;
      if (belowRun >= 3) return i - 2;
    } else {
      belowRun = 0;
    }
  }
  return null;
}

function drawBarSpectrum(canvas, data, cutoffFrac) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);
  const barW = w / data.length;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] / 255;
    const barH = v * h;
    ctx.fillStyle = v > 0.85 ? '#f85149' : v > 0.6 ? '#e3b341' : '#2ea043';
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  }
  if (cutoffFrac != null && cutoffFrac >= 0 && cutoffFrac <= 1) {
    const x = cutoffFrac * w;
    ctx.save();
    ctx.strokeStyle = '#58a6ff';
    ctx.shadowColor = '#58a6ff';
    ctx.shadowBlur = 6;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
  }
}

// Simple scrolling waterfall: shift the existing image left by 1px each
// frame edge-in via drawImage-of-self, then paint one new column of pixels
// on the right from the current spectrum. Column-wise (not row-wise like
// GLSpectrogram's texture) since that's the cheap direction for a plain
// 2D canvas — shifting whole-canvas pixel data via getImageData/putImageData
// every frame would be far more main-thread work than this page needs.
function drawWaterfallColumn(canvas, data) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);
  for (let y = 0; y < h; y++) {
    const bf = (1 - y / h) * (data.length - 1);
    const b0 = Math.floor(bf), b1 = Math.min(b0 + 1, data.length - 1);
    const v = (data[b0] * (1 - (bf - b0)) + data[b1] * (bf - b0)) / 255;
    // turbo-ish cheap gradient: dark blue -> green -> yellow -> red
    const r = Math.round(Math.min(255, Math.max(0, 510 * (v - 0.5))));
    const g = Math.round(Math.min(255, Math.max(0, 510 * Math.min(v, 1 - v) + 60)));
    const b = Math.round(Math.min(255, Math.max(0, 255 - 510 * v)));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(w - 1, y, 1, 1);
  }
}

function drawScope(canvas, data, clipping, dcOffsetFrac) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#3d444d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (Math.abs(dcOffsetFrac) >= DC_OFFSET_WARN) {
    const dcY = h / 2 - dcOffsetFrac * (h / 2) * 0.95;
    ctx.strokeStyle = '#e3b341';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, dcY);
    ctx.lineTo(w, dcY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = clipping ? '#f85149' : '#2ea043';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = w / data.length;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    const y = h / 2 - v * (h / 2) * 0.95;
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
  }
  ctx.stroke();

  if (clipping) {
    ctx.fillStyle = '#f85149';
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      if (Math.abs(v) >= CLIP_THRESHOLD) {
        const x = i * step;
        ctx.fillRect(x, 0, 2, 4);
        ctx.fillRect(x, h - 4, 2, 4);
      }
    }
  }
}

function tickQualityChannel(st, analyser, active, now) {
  if (!active || !analyser) {
    st.channelEl.classList.remove('clip-flash');
    st.readoutEl.textContent = 'inactive';
    st.readoutEl.classList.remove('clipping');
    st.cutoffEl.textContent = '—';
    st.floorEl.textContent = '—';
    st.dcEl.textContent = '—';
    st.clipsEl.textContent = '0';
    st.clipsEl.classList.remove('danger');
    return;
  }

  const bc = analyser.frequencyBinCount;
  if (!st.freqData || st.freqData.length !== bc) st.freqData = new Uint8Array(bc);
  analyser.getByteFrequencyData(st.freqData);

  const rolloffBin = estimateRolloffBin(st.freqData);
  if (rolloffBin != null) {
    const nyquist = analyser.context.sampleRate / 2;
    st.cutoffEl.textContent = `${Math.round((rolloffBin / bc) * nyquist)} Hz`;
  } else {
    st.cutoffEl.textContent = '—';
  }
  drawBarSpectrum(st.barCanvas, st.freqData, rolloffBin != null ? rolloffBin / bc : null);
  drawWaterfallColumn(st.waterfallCanvas, st.freqData);

  let avgLevel = 0;
  for (let i = 0; i < st.freqData.length; i++) avgLevel += st.freqData[i];
  avgLevel /= st.freqData.length;
  if (now - st.noiseFloorWindowStart > NOISE_FLOOR_WINDOW_MS) {
    st.noiseFloorWindowStart = now;
    st.noiseFloorMin = avgLevel;
  } else if (avgLevel < st.noiseFloorMin) {
    st.noiseFloorMin = avgLevel;
  }
  st.floorEl.textContent = `${Math.round((st.noiseFloorMin / 255) * 100)}%`;

  if (!st.timeDataFloat || st.timeDataFloat.length !== analyser.fftSize) {
    st.timeDataFloat = new Float32Array(analyser.fftSize);
    st.timeDataByte = new Uint8Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(st.timeDataFloat);
  let peak = 0, sum = 0;
  for (let i = 0; i < st.timeDataFloat.length; i++) {
    const s = st.timeDataFloat[i];
    sum += s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const dcOffset = sum / st.timeDataFloat.length;
  const dcOffsetPct = Math.round(dcOffset * 1000) / 10;
  st.dcEl.textContent = `${dcOffsetPct}%${Math.abs(dcOffsetPct) / 100 >= DC_OFFSET_WARN ? ' ⚠' : ''}`;
  st.dcEl.classList.toggle('warn', Math.abs(dcOffsetPct) / 100 >= DC_OFFSET_WARN);

  const isClipping = peak >= CLIP_THRESHOLD;
  st.readoutEl.textContent = `peak ${Math.round(Math.min(1, peak) * 100)}%${isClipping ? ' — CLIPPING' : ''}`;
  st.readoutEl.classList.toggle('clipping', isClipping);
  if (isClipping) {
    st.clipEvents.push(now);
    if (now - st.lastClipFlashAt > CLIP_FLASH_MS) {
      st.lastClipFlashAt = now;
      st.channelEl.classList.add('clip-flash');
      setTimeout(() => st.channelEl.classList.remove('clip-flash'), CLIP_FLASH_MS);
    }
  }
  while (st.clipEvents.length > 0 && now - st.clipEvents[0] > CLIP_WINDOW_MS) st.clipEvents.shift();
  st.clipsEl.textContent = String(st.clipEvents.length);
  st.clipsEl.classList.toggle('danger', st.clipEvents.length > 0);

  analyser.getByteTimeDomainData(st.timeDataByte);
  drawScope(st.scopeCanvas, st.timeDataByte, isClipping, dcOffset);
}

let qualityRafId = null;
function qualityTick(now) {
  tickQualityChannel(qualityIn, playAnalyserNode, !!audioWs, now);
  tickQualityChannel(qualityOut, micAnalyserNode, !!micStream, now);
  qualityRafId = requestAnimationFrame(qualityTick);
}

function startQualityView() {
  if (qualityRafId != null) return;
  qualityRafId = requestAnimationFrame(qualityTick);
}
function stopQualityView() {
  if (qualityRafId != null) cancelAnimationFrame(qualityRafId);
  qualityRafId = null;
}

qualityToggle.addEventListener('change', () => {
  qualityView.hidden = !qualityToggle.checked;
  if (qualityToggle.checked) startQualityView();
  else stopQualityView();
});

refreshStatus(true);
scanNetworks();
startStatusAutoRefresh();
