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
//
// /status and /info are fetched independently (NOT Promise.all'd into one
// try block) — they used to be, and a single /info failure (hit for real:
// its response body outgrew a fixed buffer as more BRIDGE_FEATURES were
// added over time, started returning an error body instead of JSON) threw
// during `.json()`, which aborted the ENTIRE function before a single
// status field got applied. Since the auto-refresh timer always calls
// this with silent=true, that failure was invisible — the whole panel
// just stopped updating with no error shown, forever, until reload. Two
// independent try blocks mean /status updates (the actually load-bearing
// half) even if /info is having a bad day, and vice versa.
async function refreshStatus(silent) {
  try {
    const status = await (await fetch('/status')).json();

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

    ensureOption(ssidSelect, status.ssid);
    if (status.ssid) ssidSelect.value = status.ssid;

    const catBaudSelectEl = document.getElementById('cat-baud-select');
    if (status.cat_baud && catBaudSelectEl) catBaudSelectEl.value = String(status.cat_baud);

    updatePaCard(status.pa_sense, status.pa_emergency_tripped);
    if (typeof status.adc_input === 'string') updateAudioInputButtons(status.adc_input);
    // input_mode processed BEFORE rx_slot_right — updateInputModeButtons()
    // itself calls updateRxSlotButtons() (to force both-active in I/Q
    // mode), so currentInputMode must already reflect the real value by
    // the time this line runs, not still be yesterday's/the initial
    // placeholder ("audio") while rx_slot_right applies.
    if (typeof status.input_mode === 'string') updateInputModeButtons(status.input_mode);
    if (typeof status.rx_slot_right === 'boolean') updateRxSlotButtons(status.rx_slot_right, status.input_mode === 'iq');
    if (typeof status.led_enabled === 'boolean') updateLedEnableButtons(status.led_enabled);
    if (typeof status.alc_enabled === 'boolean') updateAlcButtons(status.alc_enabled);
    if (typeof status.noise_gate_enabled === 'boolean') updateNoiseGateButtons(status.noise_gate_enabled);
    if (typeof status.cpu_freq_mhz === 'number') updateCpuFreqButtons(status.cpu_freq_mhz);
    if (typeof status.wifi_tx_power_quarter_dbm === 'number') updateWifiTxPowerButtons(status.wifi_tx_power_quarter_dbm);
    if (typeof status.adc_hpf_enabled === 'boolean') updateAdcHpfButtons(status.adc_hpf_enabled);
    if (typeof status.sample_rate_hz === 'number') updateSampleRateButtons(status.sample_rate_hz);
    if (typeof status.speaker_amp_enabled === 'boolean') updateSpeakerAmpButtons(status.speaker_amp_enabled);
    if (typeof status.mic_gain_db === 'number') updateMicGainSlider(status.mic_gain_db);
    if (typeof status.speaker_vol === 'number') updateSpeakerVolSlider(status.speaker_vol);
    if (typeof status.tx_slot === 'string') updateTxSlotButtons(status.tx_slot);
    if (typeof status.cat_log_enabled === 'boolean') updateCatLogEnableButtons(status.cat_log_enabled);
  } catch (err) {
    if (!silent) showMsg(`Failed to load status: ${err.message}`, 'error');
  }

  try {
    const info = await (await fetch('/info')).json();
    document.getElementById('s-fw').textContent = info.firmware_version;
    applyBoardInfo(info);
  } catch (err) {
    if (!silent) showMsg(`Failed to load firmware info: ${err.message}`, 'error');
    document.documentElement.classList.remove('features-pending');  // unknown bridge: show everything
  }
}

// ── Board ─────────────────────────────────────────────────────────────────
// GET /info names the board ("a1s" / "s3") and lists what it can do. Every
// control that needs a capability carries data-feature="<name>" in
// index.html; anything the running bridge doesn't list is hidden, so the S3
// board never shows ES8388-only controls (and shows no audio cards until its
// converters are brought up). A bridge too old to report features shows
// everything, as before.
const BOARD_NAMES = {
  a1s: { name: 'ESP32-A1S', detail: 'AI-Thinker audio kit, ES8388 codec' },
  s3: { name: 'ESP32-S3-N16R8', detail: 'WM8782 · PCM1808 · PCM5102' },
};
const BOARD_SHORT = { a1s: 'A1S', s3: 'S3' };

function applyBoardInfo(info) {
  const board = typeof info.board === 'string' ? info.board : 'a1s';  // firmware before 0.11.0 is always the A1S
  const boardEl = document.getElementById('s-board');
  const known = BOARD_NAMES[board] || { name: board, detail: '' };
  boardEl.textContent = known.name;
  if (known.detail) {
    const detail = document.createElement('span');
    detail.className = 'board-detail';
    detail.textContent = known.detail;
    boardEl.append(detail);
  }
  boardEl.dataset.board = board;
  const badge = document.getElementById('board-badge');
  badge.textContent = BOARD_SHORT[board] || board;
  badge.dataset.board = board;
  badge.hidden = false;
  document.title = `uSDX CAT bridge (${BOARD_SHORT[board] || board})`;
  bridgeFeatures = Array.isArray(info.features) ? new Set(info.features) : null;
  document.documentElement.classList.remove('features-pending');
  if (!bridgeFeatures) return;
  // data-feature="a|b" shows the element when the bridge lists either.
  for (const el of document.querySelectorAll('[data-feature]')) {
    el.hidden = !el.dataset.feature.split('|').some((f) => bridgeFeatures.has(f));
  }
}
let bridgeFeatures = null;

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

// ── ADC input select ──────────────────────────────────────────────────────
// The onboard-mic-vs-P2-jack LIN1/LIN2 mapping (common ESP32-A1S board
// convention) was tested on real hardware and had no audible effect either
// way — this sweeps every ADC input mode the ES8388 actually supports (see
// audio_monitor.c's ADC_INPUT_OPTIONS) so the correct one, if any of these
// map to the physically wired mic/jack as expected, can be found live from
// the browser instead of guessing and reflashing per attempt.
const audioInputBtns = document.querySelectorAll('[data-adc-input]');

function updateAudioInputButtons(input) {
  audioInputBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.adcInput === input));
}

async function setAudioInput(input) {
  try {
    const res = await fetch('/audio-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateAudioInputButtons(result.input);
    showMsg(result.applied ? `ADC input set to "${result.input}".` : 'Failed to switch ADC input.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch ADC input: ${err.message}`, 'error');
  }
}

audioInputBtns.forEach((btn) => btn.addEventListener('click', () => void setAudioInput(btn.dataset.adcInput)));

// ── ADC RX slot (left/right) ──────────────────────────────────────────────
// A SEPARATE axis from ADC input above — once a physical input is
// selected via ADCCONTROL2, this picks which of the ADC's two resulting
// digital channels the ESP32 actually keeps. A jack's tip signal can land
// on either one depending on board wiring, independent of which physical
// pins the mux selects — real-hardware testing needed both axes swept
// together, not just one.
//
// Independent buttons (not a radio-button-styled exclusive pair) — but
// still functionally exclusive to each other WHILE in "audio" input mode:
// clicking Left calls POST /rx-slot {right:false}, which the firmware
// applies as MONO+LEFT, so Right visibly deactivates as a side effect of
// the same request, not because these buttons fight each other client-side.
// The only way both are ever actually active at once is I/Q input mode,
// which captures both channels unconditionally (see audio_monitor.c) —
// these buttons reflect that but don't drive it, and are disabled while
// I/Q mode is selected since clicking either one wouldn't mean anything
// (there's no live "drop to mono" toggle for I/Q capture; switching back
// to audio mode, which reboots, is what changes this axis in that case).
const rxSlotBtns = document.querySelectorAll('[data-rx-slot]');
// Tracked so updateInputModeButtons() can re-render this row (e.g. forcing
// both-active while I/Q is selected) without needing a fresh /status
// round-trip just to know which slot was last selected in audio mode.
let lastRxSlotIsRight = false;

function updateRxSlotButtons(isRight, iqModeActive) {
  lastRxSlotIsRight = isRight;
  rxSlotBtns.forEach((btn) => {
    btn.classList.toggle('active', iqModeActive || (btn.dataset.rxSlot === 'right') === isRight);
    btn.disabled = iqModeActive;
  });
}

async function setRxSlot(right) {
  try {
    const res = await fetch('/rx-slot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ right }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateRxSlotButtons(result.right, currentInputMode === 'iq');
    showMsg(result.applied ? `ADC RX channel set to ${result.right ? 'right' : 'left'}.` : 'Failed to switch RX channel.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch RX channel: ${err.message}`, 'error');
  }
}

rxSlotBtns.forEach((btn) => btn.addEventListener('click', () => void setRxSlot(btn.dataset.rxSlot === 'right')));

// ── MIC preamp gain ───────────────────────────────────────────────────────
// The onboard MIC1 preamp was found bleeding audibly into every ADC input
// mode above (including modes that shouldn't route it at all) — this lets
// the gain be dragged down live to test whether attenuating it kills the
// bleed-through. Debounced to a short delay after the slider stops moving
// rather than firing a POST on every single drag tick.
const micGainSlider = document.getElementById('mic-gain-slider');
const micGainReadout = document.getElementById('mic-gain-readout');
let micGainDebounce = null;

// Syncs the slider to the bridge's actual live value — without this, the
// slider always showed its hardcoded HTML default (0dB) on page load/
// refresh regardless of what gain was really applied, which looked exactly
// like "the setting didn't survive a reboot" even on builds where the
// backend had correctly persisted and re-applied it. Skipped while the
// slider has focus, so a periodic silent refreshStatus() poll can't yank
// the thumb out from under an in-progress drag.
function updateMicGainSlider(db) {
  if (document.activeElement === micGainSlider) return;
  micGainSlider.value = String(db);
  micGainReadout.textContent = `${db} dB`;
}

async function setMicGain(db) {
  try {
    const res = await fetch('/mic-gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    showMsg(result.applied ? `MIC gain set to ${result.db} dB.` : 'Failed to set MIC gain.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to set MIC gain: ${err.message}`, 'error');
  }
}

micGainSlider.addEventListener('input', () => {
  const db = Number(micGainSlider.value);
  micGainReadout.textContent = `${db} dB`;
  clearTimeout(micGainDebounce);
  micGainDebounce = setTimeout(() => void setMicGain(db), 200);
});

// ── Speaker (DAC) output volume ──────────────────────────────────────────
// The ES8388's own DAC output volume (0-100, esp_codec_dev's own volume-
// curve scale) — separate from the speaker-amp on/off GPIO toggle above.
// This firmware never set it before, so it silently inherited the driver's
// zero-initialized default, which esp_codec_dev treats as its -96dB floor
// (not the curve's 0% point) — real audio reached the DAC and the amp GPIO
// read enabled, yet the jack stayed essentially silent regardless. Same
// debounced-drag pattern as MIC gain above.
const speakerVolSlider = document.getElementById('speaker-vol-slider');
const speakerVolReadout = document.getElementById('speaker-vol-readout');
let speakerVolDebounce = null;

// Same "sync to the bridge's real live value, skip while focused" reasoning
// as updateMicGainSlider() above.
function updateSpeakerVolSlider(vol) {
  if (document.activeElement === speakerVolSlider) return;
  speakerVolSlider.value = String(vol);
  speakerVolReadout.textContent = String(vol);
}

async function setSpeakerVol(vol) {
  try {
    const res = await fetch('/speaker-vol', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vol }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    showMsg(result.applied ? `Speaker volume set to ${result.vol}.` : 'Failed to set speaker volume.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to set speaker volume: ${err.message}`, 'error');
  }
}

speakerVolSlider.addEventListener('input', () => {
  const vol = Number(speakerVolSlider.value);
  speakerVolReadout.textContent = String(vol);
  clearTimeout(speakerVolDebounce);
  speakerVolDebounce = setTimeout(() => void setSpeakerVol(vol), 200);
});

// ── TX/playback output channel ───────────────────────────────────────────
// Real bug: TX (mic-send AND /tx-play) was always LEFT-only, regardless of
// what the operator expected — this firmware never applied any output slot
// selection to the TX I2S channel at all (see audio_monitor_set_tx_slot()'s
// own comment). "Both" duplicates the always-mono TX source to both
// channels IN HARDWARE (I2S_SLOT_MODE_MONO + slot_mask=BOTH), not a
// software/CPU cost. Unlike RX slot, this is NOT gated by input mode — TX
// audio has nothing to do with I/Q.
const txSlotBtns = document.querySelectorAll('[data-tx-slot]');

function updateTxSlotButtons(slot) {
  txSlotBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.txSlot === slot);
  });
}

async function setTxSlot(slot) {
  try {
    const res = await fetch('/tx-slot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateTxSlotButtons(result.slot);
    showMsg(result.applied ? `TX output set to ${result.slot}.` : 'Failed to switch TX output (playback in progress?).',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch TX output: ${err.message}`, 'error');
  }
}

txSlotBtns.forEach((btn) => {
  btn.addEventListener('click', () => void setTxSlot(btn.dataset.txSlot));
});

// ── Routing (GET/POST /routing, both boards since 0.11.0) ─────────────────
// Which input feeds the I/Q and the audio streams. The web app sets the same
// state, so this polls it and keeps the buttons in step. Bridges that list
// "routing" in /info; the ADC buttons only appear on two-ADC boards.
const iqSourceBtns = document.querySelectorAll('[data-iq-source]');
const audioSourceBtns = document.querySelectorAll('[data-audio-source]');
const ROUTING_REFRESH_MS = 3000;

function markActive(btns, key, value) {
  btns.forEach((btn) => btn.classList.toggle('active', btn.dataset[key] === value));
}

async function refreshRouting() {
  try {
    const res = await fetch('/routing');
    if (!res.ok) return;
    const r = await res.json();
    markActive(iqSourceBtns, 'iqSource', r.iq && r.iq.input);
    markActive(audioSourceBtns, 'audioSource', r.audio && r.audio.input);
    // The RX channel buttons are left to the status refresh: it knows the
    // A1S's I/Q mode lights both channels, which /routing can't express.
    if (r.tx && typeof r.tx.channel === 'string') updateTxSlotButtons(r.tx.channel);
  } catch { /* older firmware without /routing */ }
}

async function postRouting(patch, what) {
  try {
    const res = await fetch('/routing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    const r = await res.json();
    showMsg(r.reboot_required ? `${what} saved; the bridge is restarting to apply it.` : `${what} applied and saved.`, 'ok');
  } catch (err) {
    showMsg(`Failed to change ${what}: ${err.message}`, 'error');
  }
  void refreshRouting();
}

iqSourceBtns.forEach((btn) => btn.addEventListener('click', () => void postRouting({ iq: { input: btn.dataset.iqSource } }, 'I/Q source')));
audioSourceBtns.forEach((btn) => btn.addEventListener('click', () => void postRouting({ audio: { input: btn.dataset.audioSource } }, 'Audio source')));
void refreshRouting();
setInterval(refreshRouting, ROUTING_REFRESH_MS);

// ── I/Q processing on the bridge (S3, GET/POST /iq-config) ────────────────
const iqFftBtns = document.querySelectorAll('[data-iq-fft]');
const iqRowsBtns = document.querySelectorAll('[data-iq-rows]');
const iqLoadEl = document.getElementById('iq-proc-load');

async function refreshIqProcessing() {
  if (!iqFftBtns.length) return;
  try {
    const res = await fetch('/iq-config');
    if (!res.ok) return;
    const c = await res.json();
    markActive(iqFftBtns, 'iqFft', String(c.fft_size));
    markActive(iqRowsBtns, 'iqRows', String(c.rows_per_s));
    if (iqLoadEl) iqLoadEl.textContent = `${(c.fs / 1000).toFixed(0)} kHz in, DSP ${c.dsp_load_pct}%`;
  } catch { /* not this board */ }
  // The WM8782's rate is set by its DIP switch; the bridge measures it.
  if (wm8782RateEl) {
    try {
      const caps = await (await fetch('/capabilities')).json();
      const wm = (caps.inputs || []).find((i) => i.id === 'wm8782');
      if (wm && wm.rate_hz) wm8782RateEl.textContent = `${wm.rate_hz / 1000} kHz`;
    } catch { /* older firmware */ }
  }
}
const wm8782RateEl = document.getElementById('wm8782-rate');

async function postIqConfig(patch, what) {
  try {
    const res = await fetch('/iq-config', { method: 'POST', body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    showMsg(`${what} applied.`, 'ok');
  } catch (err) {
    showMsg(`Failed to change ${what}: ${err.message}`, 'error');
  }
  void refreshIqProcessing();
}

iqFftBtns.forEach((btn) => btn.addEventListener('click', () => void postIqConfig({ fft_size: Number(btn.dataset.iqFft) }, 'FFT size')));
iqRowsBtns.forEach((btn) => btn.addEventListener('click', () => void postIqConfig({ rows_per_s: Number(btn.dataset.iqRows) }, 'Rows per second')));
void refreshIqProcessing();
setInterval(refreshIqProcessing, ROUTING_REFRESH_MS);

// ── PCM5102A output level and mute (S3, GET/POST /dac-level) ─────────────
const dacSlider = document.getElementById('dac-level-slider');
const dacReadout = document.getElementById('dac-level-readout');
const dacMuteBtns = document.querySelectorAll('[data-dac-muted]');

function showDac(d) {
  if (typeof d.db === 'number') { dacSlider.value = d.db; dacReadout.textContent = `${d.db} dB`; }
  markActive(dacMuteBtns, 'dacMuted', String(!!d.muted));
}

async function postDac(patch, what) {
  try {
    const res = await fetch('/dac-level', { method: 'POST', body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    showDac(await res.json());
    showMsg(`${what} applied.`, 'ok');
  } catch (err) {
    showMsg(`Failed to change ${what}: ${err.message}`, 'error');
  }
}

if (dacSlider) {
  fetch('/dac-level').then((r) => (r.ok ? r.json() : null)).then((d) => d && showDac(d)).catch(() => {});
  dacSlider.addEventListener('input', () => { dacReadout.textContent = `${dacSlider.value} dB`; });
  dacSlider.addEventListener('change', () => void postDac({ db: Number(dacSlider.value) }, 'DAC level'));
  dacMuteBtns.forEach((btn) => btn.addEventListener('click', () => void postDac({ muted: btn.dataset.dacMuted === 'true' }, 'DAC mute')));
}

// ── Status LCD (S3, GET/POST /display, /display-ws) ──────────────────────
// The preview draws the frame the bridge just sent to the glass: 6 banks of
// 84 column bytes, bit 0 at the top, each pixel a small square with a gap.
// Frames come over /display-ws as they change; while that socket is down
// (or the bridge's 4 feed clients are taken) the page polls GET /display/frame.
// Client views (drawn by the web app or another tool) get a button each,
// after the built-in views.
const lcdCanvas = document.getElementById('lcd-canvas');
const LCD_VIEW_LABELS = { radio: 'Radio', spectrum: 'Spectrum', levels: 'Levels', tx: 'TX', system: 'System', network: 'Network' };
const LCD_POLL_MS = 250;
const LCD_WS_RETRY_MS = 3000;
let lcdBacklight = 60;
let lcdWs = null;
let lcdBuiltin = [];
let lcdClient = [];   // [{id, title}], live client views
let lcdSaved = null, lcdShowing = null;

function drawLcd(frame) {
  const g = lcdCanvas.getContext('2d'), k = lcdCanvas.width / 84;
  const lit = 0.55 + 0.45 * (lcdBacklight / 100);
  g.fillStyle = `rgb(${Math.round(176 * lit)},${Math.round(196 * lit)},${Math.round(160 * lit)})`;
  g.fillRect(0, 0, lcdCanvas.width, lcdCanvas.height);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 84; x++) {
      const on = frame[(y >> 3) * 84 + x] & (1 << (y & 7));
      g.fillStyle = on ? '#1c2418' : 'rgba(28,36,24,0.06)';
      g.fillRect(x * k + 0.5, y * k + 0.5, k - 1, k - 1);
    }
  }
}

function lcdButtons() {
  const views = document.getElementById('lcd-views');
  const want = [...lcdBuiltin.map((v) => [v, LCD_VIEW_LABELS[v] || v, false]), ...lcdClient.map((c) => [c.id, c.title, true])];
  const have = [...views.querySelectorAll('button')].map((b) => b.dataset.lcdView).join('|');
  if (have !== want.map(([v]) => v).join('|')) {
    views.replaceChildren(...want.map(([v, label, client]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'audio-input-option';
      b.dataset.lcdView = v;
      b.textContent = label;
      if (client) b.title = `Drawn by a client (view id "${v}"): shown while it keeps sending, not saved as the view.`;
      b.addEventListener('click', () => void postLcd({ view: v }, 'LCD view'));
      return b;
    }));
  }
  markActive(views.querySelectorAll('button'), 'lcdView', lcdSaved);
  views.querySelectorAll('button').forEach((b) => b.classList.toggle('showing', b.dataset.lcdView === lcdShowing));
}

function showLcd(d) {
  lcdBuiltin = d.views;
  if (Array.isArray(d.client_views)) lcdClient = d.client_views.filter((c) => c.live);
  lcdSaved = d.view;
  lcdShowing = d.showing;
  lcdButtons();
  markActive(document.querySelectorAll('[data-lcd-cycle]'), 'lcdCycle', String(!!d.cycle));
  markActive(document.querySelectorAll('[data-lcd-invert]'), 'lcdInvert', String(!!d.invert));
  for (const [id, key, unit] of [['lcd-dwell', 'dwell_s', ' s'], ['lcd-backlight', 'backlight', ' %']]) {
    const el = document.getElementById(id);
    if (typeof d[key] === 'number' && document.activeElement !== el) el.value = d[key];
    document.getElementById(`${id}-readout`).textContent = `${el.value}${unit}`;
  }
  lcdBacklight = d.backlight;
  document.getElementById('lcd-state').textContent = d.lcd_ok ? 'running' : 'SPI setup failed';
}

async function postLcd(patch, what) {
  try {
    const res = await fetch('/display', { method: 'POST', body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    showLcd(await res.json());
    showMsg(`${what} applied.`, 'ok');
  } catch (err) {
    showMsg(`Failed to change ${what}: ${err.message}`, 'error');
  }
}

const lcdWanted = () => bridgeFeatures && bridgeFeatures.has('display') && document.visibilityState === 'visible';

function openLcdFeed() {
  if (lcdWs || !lcdWanted()) return;
  const ws = new WebSocket(`ws://${location.host}/display-ws`);
  ws.binaryType = 'arraybuffer';
  lcdWs = ws;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { drawLcd(new Uint8Array(ev.data)); return; }
    try {
      const m = JSON.parse(ev.data);
      if (m.showing !== undefined) lcdShowing = m.showing;
      if (Array.isArray(m.client_views)) lcdClient = m.client_views;
      lcdButtons();
    } catch { /* not ours */ }
  };
  ws.onclose = () => { lcdWs = null; setTimeout(openLcdFeed, LCD_WS_RETRY_MS); };
}

async function pollLcd() {
  try {
    if (lcdWanted() && !(lcdWs && lcdWs.readyState === WebSocket.OPEN)) {
      const res = await fetch('/display/frame');
      if (res.ok) {
        drawLcd(new Uint8Array(await res.arrayBuffer()));
        lcdShowing = res.headers.get('X-Display-View');
        lcdButtons();
      }
    }
  } catch { /* the next poll tries again */ }
  setTimeout(pollLcd, LCD_POLL_MS);
}

if (lcdCanvas) {
  const loadLcd = () => fetch('/display').then((r) => (r.ok ? r.json() : null)).then((d) => d && showLcd(d)).catch(() => {});
  void loadLcd();
  setInterval(loadLcd, ROUTING_REFRESH_MS);
  document.querySelectorAll('[data-lcd-cycle]').forEach((b) => b.addEventListener('click', () => void postLcd({ cycle: b.dataset.lcdCycle === 'true' }, 'Auto-cycle')));
  document.querySelectorAll('[data-lcd-invert]').forEach((b) => b.addEventListener('click', () => void postLcd({ invert: b.dataset.lcdInvert === 'true' }, 'Invert')));
  document.querySelectorAll('[data-lcd-key]').forEach((el) => {
    const unit = { dwell_s: ' s', backlight: ' %' }[el.dataset.lcdKey] || '';
    el.addEventListener('input', () => { document.getElementById(`${el.id}-readout`).textContent = `${el.value}${unit}`; });
    const name = { dwell_s: 'Dwell time', backlight: 'Backlight' }[el.dataset.lcdKey];
    el.addEventListener('change', () => void postLcd({ [el.dataset.lcdKey]: Number(el.value) }, name));
  });
  // The feed closes while the tab is hidden and reopens when it shows again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') openLcdFeed();
    else if (lcdWs) { lcdWs.onclose = () => { lcdWs = null; }; lcdWs.close(); }
  });
  setInterval(openLcdFeed, LCD_WS_RETRY_MS);  // also covers bridgeFeatures arriving after load
  void pollLcd();
}

// The event icons (GET /display/icons?rows=1), each drawn 3x on a small glass,
// the animated ones stepping through their frames like the LCD does (every 400 ms).
const LCD_ICON_SCALE = 3, LCD_ICON_FRAME_MS = 400;
let lcdIcons = [];  // [{canvas, icon}]
async function loadLcdIcons() {
  const box = document.getElementById('lcd-icons');
  if (!box) return;
  try {
    const res = await fetch('/display/icons?rows=1');
    if (!res.ok) return;
    const d = await res.json();
    box.replaceChildren();
    lcdIcons = [];
    for (const [list, kind] of [[d.builtin, 'builtin'], [d.library, 'library']]) {
      for (const icon of list || []) {
        if (typeof icon !== 'object' || !Array.isArray(icon.rows)) continue;  // older firmware: names only
        const cell = document.createElement('div');
        cell.className = `lcd-icon ${kind}`;
        cell.title = `${icon.name}: ${icon.w} x ${icon.h}${icon.frames > 1 ? `, ${icon.frames} frames` : ''} (${kind === 'library' ? 'library, lcd_icons.txt' : 'built in'})`;
        const canvas = document.createElement('canvas');
        canvas.width = 11 * LCD_ICON_SCALE;
        canvas.height = 11 * LCD_ICON_SCALE;
        const label = document.createElement('span');
        label.textContent = icon.name;
        cell.append(canvas, label);
        box.append(cell);
        lcdIcons.push({ canvas, icon });
      }
    }
    drawLcdIcons(0);
  } catch { /* the bridge is busy: the list stays as it was */ }
}
function drawLcdIcons(step) {
  for (const { canvas, icon } of lcdIcons) {
    const g = canvas.getContext('2d'), k = LCD_ICON_SCALE;
    const rows = icon.rows.slice((step % icon.frames) * icon.h, (step % icon.frames + 1) * icon.h);
    const x0 = Math.floor((11 - icon.w) / 2) * k, y0 = Math.floor((11 - icon.h) / 2) * k;
    g.fillStyle = '#b0c4a0';  // the glass of drawLcd() at full backlight
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#1c2418';
    rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') g.fillRect(x0 + i * k, y0 + j * k, k, k); });
  }
}
if (document.getElementById('lcd-icons')) {
  let step = 0;
  const waitFeatures = setInterval(() => {
    if (!bridgeFeatures) return;
    clearInterval(waitFeatures);
    if (bridgeFeatures.has('display')) void loadLcdIcons();
  }, 500);
  setInterval(() => { if (lcdIcons.length && document.visibilityState === 'visible') drawLcdIcons(++step); }, LCD_ICON_FRAME_MS);
}

// ── Explanations as hover tooltips ───────────────────────────────────────
// Every explanatory paragraph (p.hint) becomes the tooltip of the control it
// follows, marked with an ⓘ, so the page shows controls rather than prose.
// A hint the scripts fill in live (it has an id) stays as text.
(function hintsToTooltips() {
  for (const p of document.querySelectorAll('p.hint')) {
    if (p.id) continue;
    const text = p.textContent.replace(/\s+/g, ' ').trim();
    let target = p.previousElementSibling;
    while (target && (target.matches('p.hint') || target.tagName === 'SCRIPT')) target = target.previousElementSibling;
    // The control's own label when it has one; otherwise the card's title, so
    // an ⓘ never lands on a blank spot after a table or a log box.
    const card = p.closest('section') || p.parentElement;
    let label = target && (target.matches('.audio-input-label, label, h2, h3')
      ? target : target.querySelector('.audio-input-label, label, h2, h3'));
    if (!label) label = card.querySelector('h2') || card;
    label.title = label.title ? `${label.title}\n\n${text}` : text;
    if (!label.querySelector(':scope > .info')) {
      const i = document.createElement('span');
      i.className = 'info';
      i.textContent = ' ⓘ';
      label.append(i);
    }
    p.remove();
  }
})();

// ── Status LED kill-switch ────────────────────────────────────────────────
// One-time reversible test: does the LEDs' own PWM switching (GPIO22/19,
// right next to the codec on this board) inject noise into the analog
// audio path too, on top of the already-confirmed onboard-mic bleed?
const ledEnableBtns = document.querySelectorAll('[data-led-enable]');

function updateLedEnableButtons(enabled) {
  ledEnableBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.ledEnable === 'true') === enabled));
}

async function setLedEnabled(enabled) {
  try {
    const res = await fetch('/led-enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateLedEnableButtons(result.enabled);
    showMsg(`Status LEDs turned ${result.enabled ? 'on' : 'off'}.`, 'ok');
  } catch (err) {
    showMsg(`Failed to switch LEDs: ${err.message}`, 'error');
  }
}

ledEnableBtns.forEach((btn) => btn.addEventListener('click', () => void setLedEnabled(btn.dataset.ledEnable === 'true')));

// ── ADC digital high-pass filter ──────────────────────────────────────────
// UNLIKE ALC/noise-gate below, this one is ON by the ES8388's own
// power-on-reset default (datasheet Register 14/ADCCONTROL6) and was never
// touched by the vendored driver either — so "disabling" is the actual
// diagnostic direction, exposed to compare with/without while chasing a
// reported broadband noise floor that shows up even on a clean sine wave
// from a known-clean source.
const adcHpfBtns = document.querySelectorAll('[data-adc-hpf-enable]');

function updateAdcHpfButtons(enabled) {
  adcHpfBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.adcHpfEnable === 'true') === enabled));
}

async function setAdcHpfEnabled(enabled) {
  try {
    const res = await fetch('/adc-hpf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateAdcHpfButtons(result.enabled);
    showMsg(result.applied ? `ADC high-pass filter turned ${result.enabled ? 'on' : 'off'}.` : 'Failed to switch ADC HPF.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch ADC HPF: ${err.message}`, 'error');
  }
}

adcHpfBtns.forEach((btn) => btn.addEventListener('click', () => void setAdcHpfEnabled(btn.dataset.adcHpfEnable === 'true')));

// ── Speaker amp (NS4150) kill-switch ──────────────────────────────────────
// Forces the onboard NS4150 class-D speaker amp's own enable/shutdown GPIO
// directly, bypassing the codec driver's own PA-power logic entirely. A
// class-D amp has its own free-running switching oscillator — a real
// on-board noise source distinct from WiFi/ground-loop causes already
// ruled out. The enable pin's polarity was only ever a guess in firmware
// (ES8388_PA_REVERTED), never confirmed on real hardware — this toggle
// lets the operator test both real GPIO states live.
const speakerAmpBtns = document.querySelectorAll('[data-speaker-amp-enable]');

function updateSpeakerAmpButtons(enabled) {
  speakerAmpBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.speakerAmpEnable === 'true') === enabled));
}

async function setSpeakerAmpEnabled(enabled) {
  try {
    const res = await fetch('/speaker-amp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateSpeakerAmpButtons(result.enabled);
    showMsg(result.applied ? `Speaker amp forced ${result.enabled ? 'on' : 'off'}.` : 'Failed to switch speaker amp.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch speaker amp: ${err.message}`, 'error');
  }
}

speakerAmpBtns.forEach((btn) => btn.addEventListener('click', () => void setSpeakerAmpEnabled(btn.dataset.speakerAmpEnable === 'true')));

// ── Input mode (audio / I/Q) ─────────────────────────────────────────────
// Which physical signal the line-in jack is expected to carry — "audio"
// (today's original mode: demodulated SSB/audio, mono, broadcast on
// /audio) or "iq" (raw wideband in-phase/quadrature from the radio, I on
// the ADC's left channel/Q on the right, captured as true stereo,
// broadcast on the separate /iq-data). See bridge_settings.h's
// input_mode_name comment and audio_monitor.c's iq_mode branches for the
// full firmware-side reasoning. REBOOTS to apply, same as sample rate below
// — switching this reconfigures the I2S RX channel's slot mode (mono vs
// stereo), a boot-time-only operation in this firmware.
const inputModeBtns = document.querySelectorAll('[data-input-mode]');
let currentInputMode = 'audio'; // updated by refreshStatus(); read by setSampleRate()'s 96k gate below

function updateInputModeButtons(mode) {
  currentInputMode = mode;
  inputModeBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.inputMode === mode));
  updateRxSlotButtons(lastRxSlotIsRight, mode === 'iq');
  update96kButtonAvailability();
}

async function setInputMode(mode) {
  if (mode === currentInputMode) return;
  if (!confirm(`Switch input mode to "${mode}"? This saves the setting and restarts the bridge (~5-10s) to apply it.${
    mode === 'audio' ? ' If the saved sample rate is 96kHz (I/Q-only), change it to an audio-mode rate first.' : ''
  }`)) return;
  try {
    const res = await fetch('/input-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `HTTP ${res.status}`);
    }
    showMsg(`Input mode set to "${mode}" — bridge restarting...`, 'ok');
  } catch (err) {
    showMsg(`Failed to set input mode: ${err.message}`, 'error');
  }
}

inputModeBtns.forEach((btn) => btn.addEventListener('click', () => void setInputMode(btn.dataset.inputMode)));

// ── Sample rate ────────────────────────────────────────────────────────────
// The /audio (or /iq-data, in I/Q mode) WebSocket's wire rate IS the
// codec/I2S hardware's own rate — unlike every other toggle on this page,
// changing this persists to NVS AND REBOOTS the bridge to apply (a live
// I2S/codec reclock was deliberately avoided — see bridge_config.h), so
// this needs a confirm prompt the other live-switchable controls don't.
const sampleRateBtns = document.querySelectorAll('[data-sample-rate]');
const sampleRate96kBtn = document.getElementById('sample-rate-96k');
const iqUnsupportedRateBtns = document.querySelectorAll('.iq-unsupported-rate');

// 96kHz only makes sense (and is only accepted by the firmware — see
// http_control.c's SUPPORTED_IQ_SAMPLE_RATES_HZ) in I/Q mode; disabled
// rather than hidden in audio mode so its existence/purpose stays visible
// even when it's not clickable.
//
// 22.05k/44.1k are the inverse: available in audio mode, disabled in I/Q
// mode — real-hardware captures showed unique, reproducible spectral
// artifacts at exactly those two rates in I/Q mode (see
// SUPPORTED_IQ_SAMPLE_RATES_HZ's comment), not present at any other rate.
function update96kButtonAvailability() {
  if (!sampleRate96kBtn) return;
  sampleRate96kBtn.disabled = currentInputMode !== 'iq';
  iqUnsupportedRateBtns.forEach((btn) => { btn.disabled = currentInputMode === 'iq'; });
}

function updateSampleRateButtons(hz) {
  sampleRateBtns.forEach((btn) => btn.classList.toggle('active', Number(btn.dataset.sampleRate) === hz));
}

async function setSampleRate(hz) {
  const extraWarning = hz === 96000
    ? ' 96kHz switches the ES8388 into double-speed mode, which is less proven than the other rates on this board — if it doesn\'t clock cleanly, switch back to 48kHz.'
    : '';
  if (!confirm(`Change sample rate to ${hz} Hz? This saves the setting and restarts the bridge (~5-10s) to apply it.${extraWarning}`)) return;
  try {
    const res = await fetch('/sample-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hz }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `HTTP ${res.status}`);
    }
    showMsg(`Sample rate set to ${hz} Hz — bridge restarting...`, 'ok');
  } catch (err) {
    showMsg(`Failed to set sample rate: ${err.message}`, 'error');
  }
}

sampleRateBtns.forEach((btn) => btn.addEventListener('click', () => void setSampleRate(Number(btn.dataset.sampleRate))));

// ── ALC / noise gate ──────────────────────────────────────────────────────
// Confirmed off by the ES8388's own power-on-reset default and never
// touched by the vendored driver — exposed as checkable diagnostics since
// ALC/noise-gate behavior was suspected (but not confirmed) as a possible
// contributor to the already-confirmed onboard-mic noise. Not persisted.
const alcBtns = document.querySelectorAll('[data-alc-enable]');

function updateAlcButtons(enabled) {
  alcBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.alcEnable === 'true') === enabled));
}

async function setAlcEnabled(enabled) {
  try {
    const res = await fetch('/alc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateAlcButtons(result.enabled);
    showMsg(result.applied ? `ALC turned ${result.enabled ? 'on' : 'off'}.` : 'Failed to switch ALC.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch ALC: ${err.message}`, 'error');
  }
}

alcBtns.forEach((btn) => btn.addEventListener('click', () => void setAlcEnabled(btn.dataset.alcEnable === 'true')));

const noiseGateBtns = document.querySelectorAll('[data-noise-gate-enable]');

function updateNoiseGateButtons(enabled) {
  noiseGateBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.noiseGateEnable === 'true') === enabled));
}

async function setNoiseGateEnabled(enabled) {
  try {
    const res = await fetch('/noise-gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateNoiseGateButtons(result.enabled);
    showMsg(result.applied ? `Noise gate turned ${result.enabled ? 'on' : 'off'}.` : 'Failed to switch noise gate.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to switch noise gate: ${err.message}`, 'error');
  }
}

noiseGateBtns.forEach((btn) => btn.addEventListener('click', () => void setNoiseGateEnabled(btn.dataset.noiseGateEnable === 'true')));

// ── CPU frequency + live CPU/memory stats ─────────────────────────────────
// esp_pm_configure() with min==max — pinning, not dynamic scaling. A
// low-confidence experiment (ES8388 audio is digital I2S, not the ESP32's
// own noisy internal SAR ADC) built anyway as a diagnostic tool. Not
// persisted — reverts to CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ (160) on reboot.
const cpuFreqBtns = document.querySelectorAll('[data-cpu-freq]');

function updateCpuFreqButtons(mhz) {
  cpuFreqBtns.forEach((btn) => btn.classList.toggle('active', Number(btn.dataset.cpuFreq) === mhz));
}

async function setCpuFreq(mhz) {
  try {
    const res = await fetch('/cpu-freq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mhz }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateCpuFreqButtons(result.mhz);
    showMsg(`CPU frequency set to ${result.mhz} MHz.`, 'ok');
  } catch (err) {
    showMsg(`Failed to set CPU frequency: ${err.message}`, 'error');
  }
}

cpuFreqBtns.forEach((btn) => btn.addEventListener('click', () => void setCpuFreq(Number(btn.dataset.cpuFreq))));

// ── WiFi TX power ──────────────────────────────────────────────────────────
// esp_wifi_set_max_tx_power() — units are quarter-dBm, snapped internally to
// the driver's own nearest supported step (not a continuous scale), hence
// the fixed set of buttons here rather than a slider implying finer control
// than actually exists. A low-confidence experiment for whether the WiFi
// radio's own transmit activity couples noise into the analog audio path.
// Applied immediately AND persisted to NVS — unlike ALC/noise-gate/CPU
// frequency above, this one survives a reboot, same as mic gain, since a
// low-power choice here also affects connection reliability at range and
// shouldn't silently revert without the operator noticing.
const wifiTxPowerBtns = document.querySelectorAll('[data-wifi-tx-power]');

function updateWifiTxPowerButtons(quarterDbm) {
  wifiTxPowerBtns.forEach((btn) => btn.classList.toggle('active', Number(btn.dataset.wifiTxPower) === quarterDbm));
}

async function setWifiTxPower(quarterDbm) {
  try {
    const res = await fetch('/wifi-tx-power', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quarter_dbm: quarterDbm }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    updateWifiTxPowerButtons(result.quarter_dbm);
    showMsg(result.applied ? `WiFi TX power set to ${(result.quarter_dbm * 0.25).toFixed(1)} dBm.` : 'Failed to set WiFi TX power.',
            result.applied ? 'ok' : 'error');
  } catch (err) {
    showMsg(`Failed to set WiFi TX power: ${err.message}`, 'error');
  }
}

wifiTxPowerBtns.forEach((btn) => btn.addEventListener('click', () => void setWifiTxPower(Number(btn.dataset.wifiTxPower))));

function fmtBytes(n) {
  if (typeof n !== 'number') return '—';
  return `${(n / 1024).toFixed(1)} KB`;
}

const cpuTaskBody = document.getElementById('cpu-task-body');

// ── System graphs, storage bars, sortable task table ─────────────────────
const SYS_HISTORY = 60;  // 3 minutes at one sample per refresh
const sysHist = { core0: [], core1: [], internal: [], psram: [] };
function pushSystemHistory(stats) {
  const idle = (n) => (stats.tasks || []).find((t) => t.name === n);
  const push = (arr, v) => { arr.push(v); if (arr.length > SYS_HISTORY) arr.shift(); };
  const i0 = idle('IDLE0'), i1 = idle('IDLE1');
  push(sysHist.core0, i0 ? Math.max(0, 100 - i0.cpu_pct) : null);
  push(sysHist.core1, i1 ? Math.max(0, 100 - i1.cpu_pct) : null);
  push(sysHist.internal, stats.internal_total ? (100 * stats.internal_free) / stats.internal_total : null);
  push(sysHist.psram, stats.psram_total ? (100 * stats.psram_free) / stats.psram_total : null);
  const last = (a) => a[a.length - 1];
  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(0)}%`);
  document.getElementById('sys-cpu-now').textContent = `${pct(last(sysHist.core0))} · ${pct(last(sysHist.core1))}`;
  document.getElementById('sys-mem-now').textContent = `${pct(last(sysHist.internal))} · ${pct(last(sysHist.psram))}`;
}
function drawGraph(canvas, a, b) {
  const ctx = canvas.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = cs.getPropertyValue('--border') || '#888';
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); ctx.stroke(); }
  const line = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    arr.forEach((v, i) => {
      if (v === null) return;
      const x = (w * (SYS_HISTORY - arr.length + i)) / (SYS_HISTORY - 1);
      const y = h - (h * Math.min(100, v)) / 100;
      if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
    });
    ctx.stroke();
  };
  line(a, '#3fb950');
  line(b, '#58a6ff');
}
function drawSystemGraphs() {
  drawGraph(document.getElementById('sys-cpu-graph'), sysHist.core0, sysHist.core1);
  drawGraph(document.getElementById('sys-mem-graph'), sysHist.internal, sysHist.psram);
}
function renderStorage(list) {
  const el = document.getElementById('sys-storage');
  if (!Array.isArray(list)) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '';
  for (const s of list) {
    const pct = s.total ? Math.min(100, (100 * s.used) / s.total) : 0;
    const entries = /entries/.test(s.name);
    const row = document.createElement('div');
    row.className = 'sys-bar-row';
    row.innerHTML = `<span class="sys-bar-name"></span><div class="sys-bar"><div class="sys-bar-fill${pct > 85 ? ' hot' : ''}"></div></div><span class="sys-bar-val"></span>`;
    row.querySelector('.sys-bar-name').textContent = s.name;
    row.querySelector('.sys-bar-fill').style.width = `${pct}%`;
    row.querySelector('.sys-bar-val').textContent = entries ? `${s.used} / ${s.total}` : `${fmtBytes(s.used)} / ${fmtBytes(s.total)}`;
    el.append(row);
  }
}
// Task table: sorted by name until a column header is clicked (then by that
// column; click again to reverse), so rows don't jump around every refresh.
let taskSort = { key: 'name', dir: 1 };
try { const saved = JSON.parse(localStorage.getItem('taskSort') || 'null'); if (saved && saved.key) taskSort = saved; } catch { /* default */ }
function sortedTasks(tasks) {
  const k = taskSort.key;
  return [...tasks].sort((x, y) => {
    const a = x[k], b = y[k];
    const c = typeof a === 'string' ? a.localeCompare(b) : (a ?? -1) - (b ?? -1);
    return c * taskSort.dir || x.name.localeCompare(y.name);
  });
}
document.querySelectorAll('#cpu-task-table th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    taskSort = { key: k, dir: taskSort.key === k ? -taskSort.dir : (k === 'name' ? 1 : -1) };
    try { localStorage.setItem('taskSort', JSON.stringify(taskSort)); } catch { /* fine */ }
    document.querySelectorAll('#cpu-task-table th[data-sort]').forEach((h) => h.classList.toggle('sorted', h === th));
    void refreshSystemStats();
  });
  if (th.dataset.sort === taskSort.key) th.classList.add('sorted');
});

async function refreshSystemStats() {
  try {
    const res = await fetch('/system-stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stats = await res.json();

    updateCpuFreqButtons(stats.cpu_freq_mhz);
    document.getElementById('cpu-heap-free').textContent = fmtBytes(stats.heap_free);
    document.getElementById('cpu-heap-min').textContent = fmtBytes(stats.heap_min_free);
    document.getElementById('cpu-heap-total').textContent = fmtBytes(stats.heap_total);
    document.getElementById('cpu-heap-largest').textContent = fmtBytes(stats.heap_largest_free_block);
    document.getElementById('cpu-dma-free').textContent = fmtBytes(stats.dma_free);
    document.getElementById('cpu-dma-largest').textContent = fmtBytes(stats.dma_largest_free_block);

    pushSystemHistory(stats);
    drawSystemGraphs();
    renderStorage(stats.storage);

    cpuTaskBody.innerHTML = '';
    for (const task of sortedTasks(stats.tasks || [])) {
      const tr = document.createElement('tr');
      const core = task.core === 0 || task.core === 1 ? String(task.core) : '—';
      tr.innerHTML = `<td>${task.name}</td><td>${task.cpu_pct.toFixed(1)}%</td><td>${core}</td><td>${fmtBytes(task.stack_free)}</td>`;
      cpuTaskBody.appendChild(tr);
    }
  } catch (err) {
    // Silent — this panel auto-refreshes; a single dropped poll isn't worth
    // surfacing an error for, same reasoning as refreshStatus(true).
  }
}

const SYSTEM_STATS_REFRESH_MS = 3000;
refreshSystemStats();
setInterval(refreshSystemStats, SYSTEM_STATS_REFRESH_MS);

// ── TX cache ────────────────────────────────────────────────────────────
// Renders GET /tx-status's four slots. Everything shown comes from the
// device itself, which is the entire point: the content hash alone is a
// one-way fingerprint, so before slots carried message/label/audio_hz
// metadata, nothing that hadn't performed the upload itself — this page
// included — could say what a slot actually held.

const txCacheSlots = document.getElementById('tx-cache-slots');
const txCacheReadout = document.getElementById('tx-cache-readout');

// Named for the web app's own fixed slot roles (see useFTTransmit.ts's
// TX_SLOT_AUTOCQ/TX_SLOT_QUEUE_LOOKAHEAD) — a convention between the app
// and itself, not something the firmware enforces, so this is a display
// hint rather than a guarantee about what any slot really contains.
const TX_SLOT_ROLE = ['auto-CQ', 'queue +0', 'queue +1', 'spare'];

function fmtTxDuration(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderTxCache(status) {
  const slots = Array.isArray(status.slots) ? status.slots : [];
  const readyCount = slots.filter((s) => s.ready).length;
  txCacheReadout.textContent = status.playing
    ? `playing slot ${status.playing_slot}`
    : `${readyCount}/${slots.length || 4} staged`;

  txCacheSlots.replaceChildren();
  for (const slot of slots) {
    const row = document.createElement('div');
    row.className = 'tx-slot';
    if (!slot.ready) row.classList.add('tx-slot-empty');
    if (status.playing && status.playing_slot === slot.slot) row.classList.add('tx-slot-playing');

    const head = document.createElement('div');
    head.className = 'tx-slot-head';
    const name = document.createElement('span');
    name.className = 'tx-slot-name';
    name.textContent = `Slot ${slot.slot}`;
    const role = document.createElement('span');
    role.className = 'tx-slot-role';
    role.textContent = TX_SLOT_ROLE[slot.slot] || '';
    head.append(name, role);

    if (slot.ready) {
      const play = document.createElement('button');
      play.className = 'tx-slot-play';
      play.type = 'button';
      play.textContent = '▶ Play';
      play.disabled = txPlayBusy || status.playing || liveActive;
      play.title = txAutoPtt
        ? `Key the radio and transmit slot ${slot.slot}`
        : `Play slot ${slot.slot} on the bridge DAC (radio mic input) — not keyed, nothing goes on air`;
      play.addEventListener('click', () => void playTxSlot(slot.slot));
      head.append(play);

      const clear = document.createElement('button');
      clear.className = 'tx-slot-clear';
      clear.type = 'button';
      clear.textContent = 'Clear';
      // Never offer to yank the buffer out from under a live transmission —
      // the play task reads this slot straight from PSRAM.
      const playingThis = status.playing && status.playing_slot === slot.slot;
      if (playingThis) {
        clear.disabled = true;
        clear.title = 'Cannot clear a slot while it is playing';
      } else {
        clear.title = `Clear slot ${slot.slot}`;
        clear.addEventListener('click', () => clearTxSlot(slot.slot, clear));
      }
      head.append(clear);
    }

    const body = document.createElement('div');
    body.className = 'tx-slot-body';
    if (slot.ready) {
      // textContent throughout, never innerHTML — message/label are
      // operator-typed text echoed straight back from the device.
      const msg = document.createElement('div');
      msg.className = 'tx-slot-message';
      msg.textContent = slot.message || '(no message text)';
      if (!slot.message) msg.classList.add('tx-slot-dim');

      const meta = document.createElement('div');
      meta.className = 'tx-slot-meta';
      const bits = [];
      if (slot.audio_hz) bits.push(`${slot.audio_hz} Hz`);
      bits.push(fmtTxDuration(slot.duration_ms));
      bits.push(fmtBytes(slot.bytes));
      if (slot.label) bits.push(slot.label);
      meta.textContent = bits.join(' · ');

      const hash = document.createElement('div');
      hash.className = 'tx-slot-hash';
      hash.textContent = slot.hash;

      body.append(msg, meta, hash);
    } else {
      const empty = document.createElement('div');
      empty.className = 'tx-slot-message tx-slot-dim';
      empty.textContent = 'empty';
      body.append(empty);
    }

    row.append(head, body);
    txCacheSlots.append(row);
  }
}

// Frees the slot's PSRAM buffer and wipes its metadata on the device. Not
// confirmed first: a staged slot is re-uploadable at any time (the web app
// re-stages on its next encode), so this is cheap to undo — unlike the
// destructive settings elsewhere on this page.
async function clearTxSlot(slot, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/tx-clear?slot=${slot}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Re-enabled by the refresh below if the slot is in fact still there.
    btn.textContent = 'Failed';
  }
  refreshTxCache();
}

async function refreshTxCache() {
  try {
    const res = await fetch('/tx-status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderTxCache(await res.json());
  } catch (err) {
    // Silent — same reasoning as refreshSystemStats()/refreshStatus(true):
    // this panel auto-refreshes, so one dropped poll isn't worth an error.
  }
}

// Slower than the system-stats poll: slot contents only change when the web
// app stages a message, which is a human-paced event, and this endpoint is
// on the same shared httpd worker as everything else.
const TX_CACHE_REFRESH_MS = 5000;
refreshTxCache();
setInterval(refreshTxCache, TX_CACHE_REFRESH_MS);

// ── TX cache playback ────────────────────────────────────────────────────
// ▶ Play runs a staged slot through POST /tx-play, i.e. out of the bridge
// DAC into the radio's mic input. On its own that never transmits (the uSDX
// has no VOX); with Auto-PTT the page keys the radio around it the same way
// the web app does: TX; → pre-key → play → wait for the end → post-key → RX;.
// "Monitor in browser" listens to the playback through the mic sniffer
// (/audio-mic-sniff taps the same DAC write), so what you hear is exactly what
// the radio was fed.
const txAutoPttChip = document.getElementById('tx-autoptt-chip');
const txMonitorChip = document.getElementById('tx-monitor-chip');
const txPreKey = document.getElementById('tx-prekey');
const txPostKey = document.getElementById('tx-postkey');
const txStopBtn = document.getElementById('tx-stop-btn');
const txPlayStatus = document.getElementById('tx-play-status');

let txAutoPtt = loadJson('txAutoPtt', false);
let txMonitor = loadJson('txMonitor', false);
let txPlayBusy = false;
let txKeyed = false;
let txStopRequested = false;
txPreKey.value = loadJson('txPreKeyMs', 150);
txPostKey.value = loadJson('txPostKeyMs', 0);

function renderTxChips() {
  txAutoPttChip.classList.toggle('active', txAutoPtt);
  txAutoPttChip.title = txAutoPtt ? 'Auto-PTT on: Play keys the radio (TX;) around the slot' : 'Auto-PTT off: Play only feeds the radio mic input — nothing goes on air';
  txMonitorChip.classList.toggle('active', txMonitor);
}
txAutoPttChip.addEventListener('click', () => { txAutoPtt = !txAutoPtt; saveJson('txAutoPtt', txAutoPtt); renderTxChips(); refreshTxCache(); });
txMonitorChip.addEventListener('click', () => { txMonitor = !txMonitor; saveJson('txMonitor', txMonitor); renderTxChips(); });
txPreKey.addEventListener('change', () => saveJson('txPreKeyMs', Math.max(0, Number(txPreKey.value) || 0)));
txPostKey.addEventListener('change', () => saveJson('txPostKeyMs', Math.max(0, Number(txPostKey.value) || 0)));

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function setTxPlayStatus(text, kind) {
  txPlayStatus.textContent = text;
  txPlayStatus.dataset.kind = kind || '';
}

// Ask the radio for its mode right before keying: TX; in CW with CW Tune ON
// would send the tune carrier instead of the staged message, and AM/FM/CW
// refuse TX anyway — only LSB/USB make sense here.
async function radioModeForTx() {
  let mode = null;
  const prev = catProbe;
  if (prev) return null;  // a Query radio run is in flight — don't interleave
  const ok = await new Promise((resolve) => {
    const timer = setTimeout(() => { catProbe = null; resolve(false); }, 800);
    catProbe = { prefix: 'MD', resolve: (r) => { clearTimeout(timer); resolve(r); } };
    if (!sendCat('MD;')) { clearTimeout(timer); catProbe = null; resolve(false); }
  });
  if (ok) {
    const last = [...catFrames].reverse().find((f) => f.dir === 'in' && /^MD\d;$/.test(f.text));
    if (last) mode = Number(last.text[2]);
  }
  return mode;
}

async function unkey() {
  if (!txKeyed) return;
  sendCat('RX;');
  txKeyed = false;
}

async function playTxSlot(slot) {
  if (txPlayBusy || liveActive) return;
  txPlayBusy = true;
  txStopRequested = false;
  txStopBtn.disabled = false;
  refreshTxCache();
  let startedSniff = false;
  try {
    if (txAutoPtt) {
      const mode = await radioModeForTx();
      if (mode !== 1 && mode !== 2) {
        throw new Error(mode === null ? 'could not read the radio mode (MD;) — not keying' : `radio is in ${['', 'LSB', 'USB', 'CW', 'FM', 'AM'][mode] || 'mode ' + mode}, not LSB/USB — not keying`);
      }
    }
    if (txMonitor && !sniffActive) {
      micSniffPlayCheckbox.checked = true;
      await startSniff();
      startedSniff = true;
    }
    if (txAutoPtt) {
      if (!sendCat('TX;')) throw new Error('CAT not connected — not keying');
      txKeyed = true;
      setTxPlayStatus(`Slot ${slot}: keyed, pre-key ${txPreKey.value} ms…`, 'tx');
      await sleepMs(Math.max(0, Number(txPreKey.value) || 0));
      if (txStopRequested) throw new Error('stopped');
    }
    const res = await fetch(`/tx-play?slot=${slot}`, { method: 'POST' });
    if (!res.ok) throw new Error(`/tx-play: ${(await res.text()).trim() || 'HTTP ' + res.status}`);
    const { duration_ms: durationMs } = await res.json();
    const what = txAutoPtt ? 'transmitting' : 'playing (not keyed)';
    const startedAt = Date.now();
    const deadline = startedAt + (durationMs || 0) + 3000;
    for (;;) {
      // Countdown from the slot's own duration; the /tx-status poll below is
      // what actually decides the end.
      const left = Math.max(0, (durationMs || 0) - (Date.now() - startedAt));
      setTxPlayStatus(`Slot ${slot}: ${what} — ${(left / 1000).toFixed(1)} s left of ${fmtTxDuration(durationMs)}`, txAutoPtt ? 'tx' : 'play');
      await sleepMs(250);
      if (txStopRequested) break;
      let st = null;
      try { st = await (await fetch('/tx-status')).json(); } catch { /* one dropped poll — keep waiting until the deadline */ }
      if (st && !st.playing) break;
      if (Date.now() > deadline) throw new Error('playback did not finish in time');
    }
    if (txKeyed && !txStopRequested) await sleepMs(Math.max(0, Number(txPostKey.value) || 0));
    setTxPlayStatus(txStopRequested ? `Slot ${slot}: stopped` : `Slot ${slot}: done`, 'ok');
  } catch (err) {
    setTxPlayStatus(`Slot ${slot}: ${err.message}`, 'error');
  } finally {
    await unkey();  // every exit path un-keys — the radio's own TX time-out is only the backstop
    if (startedSniff) stopSniff();
    txPlayBusy = false;
    txStopBtn.disabled = true;
    refreshTxCache();
  }
}

txStopBtn.addEventListener('click', async () => {
  txStopRequested = true;
  try { await fetch('/tx-stop', { method: 'POST' }); } catch { /* the finally in playTxSlot still un-keys */ }
  await unkey();
});

renderTxChips();

// ── Diagnostic mode + live audio test ─────────────────────────────────────
// Radio diagnostic mode (CAT DG, radio firmware TX_DIAG): every TX runs the
// real path but nothing reaches the HF line, and while keyed the radio pushes
// a TA window every ~0.5 s. The live test keys such a dry TX with the bridge's
// test tone so the interface board can be tuned against what the radio's mic
// ADC actually receives — never a real transmission: Start is refused unless
// the radio itself has confirmed DG1.
const diagChip = document.getElementById('diag-chip');
const diagBanner = document.getElementById('diag-banner');
const liveBtn = document.getElementById('live-btn');
const liveHz = document.getElementById('live-hz');
const liveAmp = document.getElementById('live-amp');
const liveAmpVal = document.getElementById('live-amp-val');
const liveNow = document.getElementById('live-now');
const liveCharts = document.getElementById('live-charts');
const liveReadout = document.getElementById('live-readout');
const vizPct = document.getElementById('viz-pct');
const vizMic = document.getElementById('viz-mic');
const vizDac = document.getElementById('viz-dac');
const vizTip = document.getElementById('viz-tip');
const vizTbody = document.getElementById('viz-tbody');

let diagOn = null;        // null = unknown (radio hasn't answered DG)
let liveActive = false;
let liveSniffWs = null;
let liveSniffSum = 0;
let liveSniffN = 0;
let liveSniffTimer = null;
let liveDacDb = null;      // latest bridge DAC level (dBFS RMS), attached to each radio window
let liveT0 = 0;
let liveData = [];         // this run only: { t, drive, ceil, gated, mic, dac } per ~0.5 s radio window

function setDiagState(on) {
  diagOn = on;
  diagChip.textContent = `Diag mode: ${on ? 'ON' : 'OFF'}`;
  diagChip.classList.toggle('diag-on', on);
  diagBanner.hidden = !on;
  liveBtn.disabled = !on && !liveActive;
  // The radio un-keys on any DG change while keyed — a live test can't survive it.
  if (!on && liveActive) void stopLiveTest('diagnostic mode turned off');
}

diagChip.addEventListener('click', () => {
  if (diagOn === null) { sendCat('DG;'); return; }
  sendCat(diagOn ? 'DG0;' : 'DG1;');
});

liveAmp.addEventListener('input', () => {
  liveAmpVal.textContent = `${liveAmp.value}%`;
  if (liveActive) void postTone({ amp: Number(liveAmp.value) / 100 });
});
liveHz.addEventListener('change', () => { if (liveActive) void postTone({ hz: Number(liveHz.value) }); });

function startLiveSniff() {
  const url = new URL('/audio-mic-sniff', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const pcm = new Int16Array(ev.data);
    for (let i = 0; i < pcm.length; i++) liveSniffSum += pcm[i] * pcm[i];
    liveSniffN += pcm.length;
  };
  liveSniffWs = ws;
  liveSniffTimer = setInterval(() => {
    if (!liveSniffN) { liveDacDb = null; return; }
    const rms = Math.sqrt(liveSniffSum / liveSniffN) / 32768;
    liveDacDb = rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
    liveSniffSum = 0; liveSniffN = 0;
  }, 500);
}

function onLiveWindow(mic, avg, clip, gated) {
  const drive = catRadioDrive ?? 2;
  const pct = avg === null ? 0 : drive >= 8 ? 100 : Math.min(100, Math.round(((avg << drive) * 100) / 255));
  const point = { t: (Date.now() - liveT0) / 1000, drive: pct, ceil: clip, gated: gated ?? 0, mic: Math.round(mic * 1.07), dac: liveDacDb };
  liveData.push(point);
  liveNow.hidden = false;
  liveNow.textContent = `now: drive ${point.drive}% of ceiling · at ceiling ${point.ceil}% · gated off ${point.gated}% · mic ≈${point.mic} mV · DAC ${point.dac === null ? '—' : point.dac.toFixed(1) + ' dBFS'}`;
  liveReadout.textContent = `running · ${liveData.length} windows`;
  const tr = document.createElement('tr');
  for (const v of [point.t.toFixed(1), point.drive, point.ceil, point.gated, point.mic, point.dac === null ? '—' : point.dac.toFixed(1)]) {
    const td = document.createElement('td'); td.textContent = v; tr.append(td);
  }
  vizTbody.append(tr);
  renderLiveCharts();
}

// ── Live charts: three small multiples on one shared time axis ──
// One unit per chart (%, mV, dBFS) — never a dual axis. Thin 2px lines,
// recessive grid, end labels on the % chart, crosshair + tooltip across all
// three. The full-power mic reference is derived from the radio's TX drive:
// envelope ≈ 2 × mic counts, full power at envelope >= 255 >> drive.
const SVGNS = 'http://www.w3.org/2000/svg';
const VIZ_PAD = { l: 34, r: 74, t: 6, b: 16 };
let vizHoverIdx = null;

function svgEl(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

function vizX(t, w, tMax) { return VIZ_PAD.l + (tMax > 0 ? (t / tMax) : 0) * (w - VIZ_PAD.l - VIZ_PAD.r); }

function drawChart(host, { height, yMin, yMax, ticks, fmt, series, ref, endLabels }) {
  const w = Math.max(280, host.clientWidth || 600);
  const tMax = Math.max(5, liveData.length ? liveData[liveData.length - 1].t : 5);
  const y = (v) => VIZ_PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (height - VIZ_PAD.t - VIZ_PAD.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${height}`, height, role: 'img' });
  for (const v of ticks) {
    svg.append(svgEl('line', { class: 'grid', x1: VIZ_PAD.l, x2: w - VIZ_PAD.r, y1: y(v), y2: y(v) }));
    svg.append(svgEl('text', { x: VIZ_PAD.l - 5, y: y(v) + 3, 'text-anchor': 'end' }, fmt(v)));
  }
  // x ticks: whole seconds, ~6 labels
  const step = Math.max(1, Math.ceil(tMax / 6));
  for (let t = 0; t <= tMax; t += step) svg.append(svgEl('text', { x: vizX(t, w, tMax), y: height - 3, 'text-anchor': 'middle' }, `${t}s`));
  if (ref) {
    svg.append(svgEl('line', { class: 'ref', x1: VIZ_PAD.l, x2: w - VIZ_PAD.r, y1: y(ref.v), y2: y(ref.v) }));
    svg.append(svgEl('text', { class: 'end-label', x: w - VIZ_PAD.r + 4, y: y(ref.v) + 3 }, ref.label));
  }
  const labels = [];
  for (const sr of series) {
    const pts = liveData.filter((d) => d[sr.key] !== null && d[sr.key] !== undefined);
    if (!pts.length) continue;
    const clamp = (v) => Math.min(yMax, Math.max(yMin, v));
    const dAttr = pts.map((d, i) => `${i ? 'L' : 'M'}${vizX(d.t, w, tMax).toFixed(1)},${y(clamp(d[sr.key])).toFixed(1)}`).join('');
    svg.append(svgEl('path', { class: `line ${sr.cls}`, d: dAttr }));
    if (endLabels) {
      const last = pts[pts.length - 1];
      labels.push({ y: y(clamp(last[sr.key])) + 3, text: `${sr.label} ${fmt(last[sr.key])}` });
    }
  }
  // End labels: keep their natural order, then push apart so none overlap
  // (two series both at 100% used to print on top of each other).
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 11);
  const over = labels.length ? labels[labels.length - 1].y - (height - 2) : 0;
  if (over > 0) for (const l of labels) l.y -= over;
  for (const l of labels) svg.append(svgEl('text', { class: 'end-label', x: w - VIZ_PAD.r + 4, y: l.y }, l.text));
  if (vizHoverIdx !== null && liveData[vizHoverIdx]) {
    const d = liveData[vizHoverIdx];
    const x = vizX(d.t, w, tMax);
    svg.append(svgEl('line', { class: 'cross', x1: x, x2: x, y1: VIZ_PAD.t, y2: height - VIZ_PAD.b }));
    for (const sr of series) {
      if (d[sr.key] === null || d[sr.key] === undefined) continue;
      svg.append(svgEl('circle', { class: `dot ${sr.dot}`, cx: x, cy: y(Math.min(yMax, Math.max(yMin, d[sr.key]))), r: 4 }));
    }
  }
  host.replaceChildren(svg);
}

function renderLiveCharts() {
  liveCharts.hidden = !liveData.length;
  if (!liveData.length) return;
  drawChart(vizPct, {
    height: 150, yMin: 0, yMax: 100, ticks: [0, 50, 100], fmt: (v) => `${Math.round(v)}%`, endLabels: true,
    series: [
      { key: 'drive', cls: 'l1', dot: 'd1', label: 'drive' },
      { key: 'ceil', cls: 'l2', dot: 'd2', label: 'ceiling' },
      { key: 'gated', cls: 'l3', dot: 'd3', label: 'gated' },
    ],
  });
  const drive = catRadioDrive ?? 2;
  const fullMv = drive >= 8 ? 0 : Math.round(((255 >> drive) / 2) * 1.07);
  const micMax = Math.max(fullMv * 1.4, ...liveData.map((d) => d.mic), 10);
  drawChart(vizMic, {
    height: 110, yMin: 0, yMax: micMax, ticks: [0, Math.round(micMax / 2), Math.round(micMax)], fmt: (v) => `${Math.round(v)}`,
    series: [{ key: 'mic', cls: 'l1', dot: 'd1' }],
    ref: fullMv ? { v: fullMv, label: `full @DR${drive}` } : null,
  });
  drawChart(vizDac, {
    height: 110, yMin: -60, yMax: 0, ticks: [-60, -30, 0], fmt: (v) => `${Math.round(v)}`,
    series: [{ key: 'dac', cls: 'l1', dot: 'd1' }],
  });
}

// Crosshair: nearest window to the pointer, drawn on all three charts, one tooltip.
function vizPointer(ev) {
  if (!liveData.length) return;
  const host = ev.currentTarget;
  const rect = host.getBoundingClientRect();
  const w = Math.max(280, host.clientWidth || 600);
  const tMax = Math.max(5, liveData[liveData.length - 1].t);
  const t = ((ev.clientX - rect.left) * (w / rect.width) - VIZ_PAD.l) / (w - VIZ_PAD.l - VIZ_PAD.r) * tMax;
  let best = 0;
  for (let i = 1; i < liveData.length; i++) if (Math.abs(liveData[i].t - t) < Math.abs(liveData[best].t - t)) best = i;
  vizHoverIdx = best;
  renderLiveCharts();
  const d = liveData[best];
  vizTip.hidden = false;
  vizTip.innerHTML = '';
  const add = (html) => { const div = document.createElement('div'); div.innerHTML = html; vizTip.append(div); };
  add(`<b>t = ${d.t.toFixed(1)} s</b>`);
  add(`<i class="sw sw-1"></i>drive <b>${d.drive}%</b> of ceiling`);
  add(`<i class="sw sw-2"></i>at ceiling <b>${d.ceil}%</b>`);
  add(`<i class="sw sw-3"></i>gated off <b>${d.gated}%</b>`);
  add(`mic ≈ <b>${d.mic} mV</b> · DAC <b>${d.dac === null ? '—' : d.dac.toFixed(1) + ' dBFS'}</b>`);
  const box = liveCharts.getBoundingClientRect();
  const left = Math.min(ev.clientX - box.left + 12, box.width - vizTip.offsetWidth - 4);
  vizTip.style.left = `${Math.max(0, left)}px`;
  vizTip.style.top = `${ev.clientY - box.top + 12}px`;
}
function vizLeave() { vizHoverIdx = null; vizTip.hidden = true; renderLiveCharts(); }
for (const host of [vizPct, vizMic, vizDac]) {
  host.addEventListener('pointermove', vizPointer);
  host.addEventListener('pointerleave', vizLeave);
}
window.addEventListener('resize', () => { if (liveData.length) renderLiveCharts(); });

async function startLiveTest() {
  if (liveActive || txPlayBusy) return;
  if (diagOn !== true) { showMsg('Diagnostic mode is not confirmed ON by the radio — not keying.', 'error'); return; }
  const mode = await radioModeForTx();
  if (mode !== 1 && mode !== 2) { showMsg('Radio must be in LSB/USB for the live test (the SSB audio chain is what gets measured).', 'error'); return; }
  if (diagOn !== true) return;  // re-check: a DG0 could have arrived meanwhile
  liveActive = true;
  liveBtn.textContent = 'Stop live test';
  liveBtn.disabled = false;
  // This run's data only — Start clears the previous run.
  liveData = [];
  liveT0 = Date.now();
  liveDacDb = null;
  vizTbody.replaceChildren();
  renderLiveCharts();
  liveNow.hidden = false;
  liveNow.textContent = 'waiting for the first window…';
  liveReadout.textContent = 'running';
  refreshTxCache();
  await postTone({ on: true, hz: Number(liveHz.value), amp: Number(liveAmp.value) / 100 });
  startLiveSniff();
  sendCat('TX;');
}

async function stopLiveTest(reason) {
  if (!liveActive) return;
  liveActive = false;
  sendCat('RX;');
  await postTone({ on: false });
  if (liveSniffWs) { liveSniffWs.close(); liveSniffWs = null; }
  clearInterval(liveSniffTimer);
  liveBtn.textContent = 'Start live test';
  liveBtn.disabled = diagOn !== true;
  liveReadout.textContent = liveData.length ? `stopped · ${liveData.length} windows (kept until the next Start)` : 'idle';
  if (reason) showMsg(`Live test stopped: ${reason}.`, 'ok');
  refreshTxCache();
}

liveBtn.addEventListener('click', () => { if (liveActive) void stopLiveTest(); else void startLiveTest(); });

// Closing the tab mid-test: un-key (no RF in diagnostic mode, but the radio
// would otherwise stay keyed with its receiver muted) and stop the tone.
window.addEventListener('beforeunload', () => {
  if (!liveActive) return;
  try { catWs?.send('RX;'); } catch { /* best effort */ }
  try { fetch('/tone', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) }); } catch { /* best effort */ }
});

// ── Continuous test tone (POST/GET /tone) ────────────────────────────────
// Drives the same mic-send path the sniffer above taps, so the tone shows
// up in that waterfall with no extra wiring — see audio_monitor.h's
// audio_monitor_tone_start() block for the firmware side.
const toneToggle = document.getElementById('tone-toggle');
const toneReadout = document.getElementById('tone-readout');
const toneFreq = document.getElementById('tone-freq');
const toneFreqVal = document.getElementById('tone-freq-val');
const toneAmp = document.getElementById('tone-amp');
const toneAmpVal = document.getElementById('tone-amp-val');
let toneRunning = false;
let toneDebounce = null;

function renderToneState(state) {
  toneRunning = !!state.running;
  toneReadout.textContent = toneRunning ? `${state.hz} Hz` : 'off';
  toneToggle.textContent = toneRunning ? 'Stop' : 'Start';
  toneToggle.classList.toggle('tone-on', toneRunning);
  // Same focus guard as updateMicGainSlider(): never move a thumb the
  // operator is currently dragging.
  if (document.activeElement !== toneFreq && typeof state.hz === 'number') {
    toneFreq.value = String(state.hz);
    toneFreqVal.textContent = `${state.hz} Hz`;
  }
  if (document.activeElement !== toneAmp && typeof state.amp === 'number') {
    const pct = Math.round(state.amp * 100);
    toneAmp.value = String(pct);
    toneAmpVal.textContent = `${pct}%`;
  }
}

async function postTone(payload) {
  try {
    const res = await fetch('/tone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // The one expected failure is the single-audio-path conflict — the
      // firmware's own message text says which, so surface it verbatim.
      showMsg(await res.text() || `Tone request failed (HTTP ${res.status})`, 'error');
      return;
    }
    renderToneState(await res.json());
  } catch (err) {
    showMsg(`Tone request failed: ${err.message}`, 'error');
  }
}

// Retunes live while running (the firmware keeps phase, so this never
// clicks); while stopped it only moves the slider, so changing frequency
// before pressing Start doesn't start the tone unexpectedly.
function onToneSliderInput() {
  const hz = Number(toneFreq.value);
  const pct = Number(toneAmp.value);
  toneFreqVal.textContent = `${hz} Hz`;
  toneAmpVal.textContent = `${pct}%`;
  if (!toneRunning) return;
  clearTimeout(toneDebounce);
  toneDebounce = setTimeout(() => void postTone({ hz, amp: pct / 100 }), 150);
}

toneFreq.addEventListener('input', onToneSliderInput);
toneAmp.addEventListener('input', onToneSliderInput);

toneToggle.addEventListener('click', () => {
  if (toneRunning) {
    void postTone({ on: false });
  } else {
    void postTone({ on: true, hz: Number(toneFreq.value), amp: Number(toneAmp.value) / 100 });
  }
});

// One-shot sync so a reloaded page shows what the device is actually doing
// rather than the HTML defaults. Silent on failure, same as the other
// best-effort panel refreshes on this page.
(async () => {
  try {
    const res = await fetch('/tone');
    if (res.ok) renderToneState(await res.json());
  } catch (err) { /* silent */ }
})();

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
// Debug-only playback path direct from this page: a second WebSocket
// (/audio, separate from the CAT-command relay) carrying raw 16-bit PCM
// mono at BRIDGE_AUDIO_SAMPLE_RATE, radio -> browser only ("Listen to
// Radio"). Not real WebRTC — see the firmware's audio_ws.h for why.
// NOT a fixed constant — POST /sample-rate can change the bridge's actual
// wire rate at any time (reboot to apply). Fetched fresh from GET /status
// every time the /audio socket (re)opens (see ensureAudioSocket()) — a
// stale value here previously caused a silent but serious bug: treating a
// (say) 48000 Hz stream as if it were the old hardcoded 8000 Hz meant
// playFrame()'s createBuffer() call ran at the wrong rate, corrupting
// playback (wrong pitch, wrong buffer.duration -> playback scheduling
// drifting out of sync with real time -> growing latency and eventual
// dropout) and the quality view's cutoff-frequency readout (nyquist =
// analyser.context.sampleRate / 2 was fine, but the incoming signal itself
// had already been mis-resampled before it ever reached the analyser).
// Falls back to 8000 if the fetch fails for any reason — better than
// silently assuming a rate that's actively wrong.
let bridgeSampleRate = 8000;
// The I/Q input's rate where it differs from the audio's (the S3's WM8782
// runs at 96 kHz while /audio is 48 kHz); null = same as the audio.
let iqSampleRate = null;
const iqRate = () => iqSampleRate ?? bridgeSampleRate;

// A context at the stream's own rate: chunks scheduled back to back then join
// sample-exactly. At the device rate (often 44.1 kHz) each 8 ms chunk was
// resampled on its own, leaving a step at every boundary — a steady
// broadband comb under a clean test tone.
function audioContextAt(rate) {
  try { return new AudioContext({ sampleRate: rate }); } catch { return new AudioContext(); }
}

async function fetchBridgeSampleRate() {
  try {
    const res = await fetch('/status');
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.sample_rate_hz === 'number') bridgeSampleRate = data.sample_rate_hz;
  } catch {
    // Keep whatever value we already had — a dropped /status poll here
    // shouldn't block opening the audio socket.
  }
}

const listenBtn = document.getElementById('audio-listen-btn');

let audioWs = null;
let audioWsConnecting = null;
let playCtx = null;
let playAnalyserNode = null;
let nextPlayTime = 0;
let playbackActive = false;

function int16ToFloat(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

// AnalyserNode tuning: the Web Audio defaults (smoothingTimeConstant 0.8,
// minDecibels -100/maxDecibels -30) are built for music-loudness visualizers
// and made the spectrum/waterfall/scope read as almost static for typical
// line-level/mic signals — 0.8 smoothing blends ~5 frames together before
// anything moves, and a -30dBFS ceiling clips most real signal into a
// narrow low band of the 0-255 byte range before it even reaches the
// canvas. Both loosened so the views actually move at a glance.
const ANALYSER_SMOOTHING = 0.4;
const ANALYSER_MIN_DB = -90;
const ANALYSER_MAX_DB = -10;

// Time-domain (scope) buffer size — also used as the frequency-domain
// fftSize, since AnalyserNode only exposes one size for both. 8192 gives
// enough headroom for the scope's Zoom slider to zoom OUT to the full
// buffer (~170ms at a typical 48kHz AudioContext rate) while still zooming
// IN to a handful of samples for eyeballing a single cycle's shape (e.g.
// confirming a signal is a square vs. sine wave) — frequencyBinCount
// (half of fftSize) at 8192 is still plenty of spectrum resolution.
const SCOPE_FFT_SIZE = 8192;

function configureAnalyser(node) {
  node.smoothingTimeConstant = ANALYSER_SMOOTHING;
  node.minDecibels = ANALYSER_MIN_DB;
  node.maxDecibels = ANALYSER_MAX_DB;
}

function playFrame(int16) {
  if (!playCtx) return;
  const floatSamples = int16ToFloat(int16);

  // Created at the bridge's ACTUAL rate (bridgeSampleRate), not
  // playCtx.sampleRate — createBuffer() accepts any sample rate and
  // AudioBufferSourceNode resamples to the context's rendering rate
  // natively during playback (a real band-limited resampler in Firefox —
  // libspeex — categorically better than a hand-rolled linear
  // interpolation, and — the actual bug this replaces — correct by
  // construction instead of silently wrong whenever bridgeSampleRate
  // wasn't 8000).
  const buffer = playCtx.createBuffer(1, floatSamples.length, bridgeSampleRate);
  buffer.copyToChannel(floatSamples, 0);

  const source = playCtx.createBufferSource();
  source.buffer = buffer;
  // Routed through the shared analyser (created once in connectAudio(),
  // already wired to destination there) so the quality view can read from
  // one persistent node instead of a new analyser per short-lived frame.
  source.connect(playAnalyserNode || playCtx.destination);

  const startAt = Math.max(nextPlayTime, playCtx.currentTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;
}

// Opens the /audio socket for playback ("Listen to Radio"). Resolves once
// the socket is open.
async function ensureAudioSocket() {
  if (audioWs && audioWs.readyState === WebSocket.OPEN) return true;
  if (audioWsConnecting) return audioWsConnecting;

  // Fetched fresh on every fresh open — the operator may have just changed
  // POST /sample-rate (which reboots the bridge) since the last time audio
  // was started, and a stale rate here silently corrupts both directions
  // (see bridgeSampleRate's own comment for the full failure mode).
  await fetchBridgeSampleRate();

  const url = new URL('/audio', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  audioWsConnecting = new Promise((resolve) => {
    const ws = new WebSocket(url.toString());
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      audioWs = ws;
      audioWsConnecting = null;
      showMsg('Audio connected.', 'ok');
      resolve(true);
    };
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      playFrame(new Int16Array(ev.data));
    };
    ws.onerror = () => {
      audioWsConnecting = null;
      showMsg('Audio connection failed.', 'error');
      resolve(false);
    };
    ws.onclose = () => {
      if (audioWs !== ws) return;
      audioWs = null;
      stopPlayback();
    };
  });
  return audioWsConnecting;
}

function stopPlayback() {
  if (playCtx) { playCtx.close(); playCtx = null; }
  playAnalyserNode = null;
  nextPlayTime = 0;
  playbackActive = false;
  listenBtn.textContent = 'Listen to Radio';
  if (audioWs) { audioWs.close(); audioWs = null; }
}

async function connectAudio() {
  await fetchBridgeSampleRate();
  playCtx = audioContextAt(bridgeSampleRate);
  nextPlayTime = 0;
  playAnalyserNode = playCtx.createAnalyser();
  playAnalyserNode.fftSize = SCOPE_FFT_SIZE;
  configureAnalyser(playAnalyserNode);
  playAnalyserNode.connect(playCtx.destination);

  const ok = await ensureAudioSocket();
  if (!ok) {
    playCtx.close();
    playCtx = null;
    playAnalyserNode = null;
    return;
  }
  playbackActive = true;
  listenBtn.textContent = 'Stop Listening';
}

listenBtn.addEventListener('click', () => {
  if (playbackActive) stopPlayback();
  else void connectAudio();
});

// ── Mic → radio sniffer ───────────────────────────────────────────────────
// Read-only tap on ws://<device>/audio-mic-sniff (see firmware's
// audio_sniff.h) — a COMPLETELY separate WebSocket/AudioContext from
// /audio's own "Listen to Radio" above, deliberately: this exists
// specifically because the web app's mic-send path has no return signal at
// all, and mixing the sniff feed into /audio's own socket/graph would both
// risk conflating "what was sent" with "what the radio is doing" and add
// load to a path that's already had real reliability problems (see
// audio_ws.c's zombie-client history). Closing/failing this sniffer can
// never affect the real mic-send path either way.
const micSniffBtn = document.getElementById('mic-sniff-btn');
const micSniffPlayCheckbox = document.getElementById('mic-sniff-play');

let sniffWs = null;
let sniffActive = false;
let sniffPlayCtx = null;
let sniffNextPlayTime = 0;
let sniffAnalyserNode = null;
let sniffSilencer = null;

function playSniffFrame(int16) {
  const floatSamples = int16ToFloat(int16);

  if (!sniffPlayCtx) return;
  // Same createBuffer-at-bridgeSampleRate + native-resample approach as
  // playFrame() above — see that function's comment for why. bridgeSampleRate
  // is the same value on radio->browser and browser->radio; a fresh fetch
  // isn't needed here since starting the sniffer doesn't reboot anything
  // that could have changed it.
  const buffer = sniffPlayCtx.createBuffer(1, floatSamples.length, bridgeSampleRate);
  buffer.copyToChannel(floatSamples, 0);
  const source = sniffPlayCtx.createBufferSource();
  source.buffer = buffer;
  // Always routed through the analyser so the quality view keeps working
  // regardless of the "Play through speakers" checkbox — that checkbox only
  // toggles whether sniffSilencer's gain is 0 (silent, analyser-only) or 1
  // (audible), further downstream.
  source.connect(sniffAnalyserNode);
  const startAt = Math.max(sniffNextPlayTime, sniffPlayCtx.currentTime);
  source.start(startAt);
  sniffNextPlayTime = startAt + buffer.duration;
}

function stopSniff() {
  if (sniffWs) { sniffWs.close(); sniffWs = null; }
  if (sniffPlayCtx) { sniffPlayCtx.close(); sniffPlayCtx = null; }
  sniffAnalyserNode = null;
  sniffSilencer = null;
  sniffNextPlayTime = 0;
  sniffActive = false;
  micSniffBtn.textContent = 'Start Sniffing';
}

async function startSniff() {
  await fetchBridgeSampleRate(); // same reasoning as ensureAudioSocket() — read fresh in case /sample-rate changed since last use
  sniffPlayCtx = audioContextAt(bridgeSampleRate);
  sniffNextPlayTime = 0;
  sniffAnalyserNode = sniffPlayCtx.createAnalyser();
  sniffAnalyserNode.fftSize = SCOPE_FFT_SIZE;
  configureAnalyser(sniffAnalyserNode);
  // Gain node toggled by the "Play through speakers" checkbox — the
  // analyser tap itself never depends on it, so the quality view stays
  // live even with playback muted (see playSniffFrame()'s comment).
  sniffSilencer = sniffPlayCtx.createGain();
  sniffSilencer.gain.value = micSniffPlayCheckbox.checked ? 1 : 0;
  sniffAnalyserNode.connect(sniffSilencer);
  sniffSilencer.connect(sniffPlayCtx.destination);

  const url = new URL('/audio-mic-sniff', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    sniffWs = ws;
    sniffActive = true;
    micSniffBtn.textContent = 'Stop Sniffing';
    showMsg('Mic sniffer connected.', 'ok');
  };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    playSniffFrame(new Int16Array(ev.data));
  };
  ws.onerror = () => {
    showMsg('Mic sniffer connection failed.', 'error');
  };
  ws.onclose = () => {
    if (sniffWs !== ws) return; // superseded by a newer start — this close is stale
    stopSniff();
  };
}

micSniffBtn.addEventListener('click', () => {
  if (sniffActive) stopSniff();
  else void startSniff();
});

micSniffPlayCheckbox.addEventListener('change', () => {
  if (sniffSilencer) sniffSilencer.gain.value = micSniffPlayCheckbox.checked ? 1 : 0;
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
// Raw frames kept independently of what's on screen, so changing a filter
// (or un-pausing) re-renders from history instead of only affecting what
// arrives next.
const CAT_FRAME_HISTORY = 600;

const catLog = document.getElementById('cat-log');
const catLogPause = document.getElementById('cat-log-pause');
const catSendForm = document.getElementById('cat-send-form');
const catSendInput = document.getElementById('cat-send-input');
const catBaudSelect = document.getElementById('cat-baud-select');
const catBaudApplyBtn = document.getElementById('cat-baud-apply-btn');
const catHideChips = document.getElementById('cat-hide-chips');
const catFilterText = document.getElementById('cat-filter-text');
const catFilterMode = document.getElementById('cat-filter-mode');
const catHiddenCount = document.getElementById('cat-hidden-count');
const catQuickChips = document.getElementById('cat-quick-chips');
const catQueryBtn = document.getElementById('cat-query-btn');
const catTxDiag = document.getElementById('cat-txdiag');

let catWs = null;

// Direction of a frame on the /cat socket (bridge ≥0.8.0, feature
// "cat_echo_text"): bytes FROM THE RADIO arrive as BINARY frames, another
// client's outgoing command (e.g. the web app's poll) as TEXT. Frames this
// page sends itself are drawn locally at send time (the bridge never echoes
// them back to their sender). An older bridge sends everything as BINARY, so
// other clients' commands show as from-radio there, as they always did.
const CAT_DIR = {
  in:    { glyph: '◀', tag: 'RADIO', title: 'from the radio' },
  out:   { glyph: '▶', tag: 'BRIDGE', title: 'sent to the radio from this bridge page' },
  other: { glyph: '▶', tag: 'APP',   title: 'sent to the radio by another client (e.g. the web app)' },
};

function makeArrow(dir) {
  const d = CAT_DIR[dir];
  const arrow = document.createElement('span');
  arrow.className = `arrow arrow-${dir}`;
  arrow.title = d.title;
  arrow.textContent = `${d.glyph} ${d.tag}`;
  return arrow;
}

// Colours the command prefix apart from its payload — "FA" vs "00021074000"
// reads far faster than one undifferentiated monospace run. Error replies
// ("?;") get their own colour.
function makeCmd(frame) {
  const cmd = document.createElement('span');
  cmd.className = 'cat-log-cmd';
  if (frame === '?;') {
    cmd.classList.add('cat-cmd-error');
    cmd.textContent = frame;
    return cmd;
  }
  const prefix = document.createElement('span');
  prefix.className = 'cat-cmd-prefix';
  const rest = document.createElement('span');
  rest.className = 'cat-cmd-payload';
  const plen = frame.startsWith('AG0') ? 3 : /^[A-Z][A-Z0-9]/.test(frame) ? 2 : 0;  // AG0 is the one 3-char command name
  prefix.textContent = frame.slice(0, plen);
  rest.textContent = frame.slice(plen);
  cmd.append(prefix, rest);
  return cmd;
}

// ── Filter ──
// Prefix chips hide whole command families (SM is the usual flood — the radio
// pushes S-meter telemetry several times a second); the text box narrows
// further, either showing only matching frames or hiding them.
const CAT_HIDE_PREFIXES = [
  { key: 'SM', label: 'SM', title: 'S-meter telemetry' },
  { key: 'TXRX', label: 'TX/RX', title: 'TX0;/RX0; key status echoes' },
  { key: 'AI', label: 'AI', title: 'auto-report announces' },
  { key: 'FA', label: 'FA', title: 'frequency' },
  { key: 'IF', label: 'IF', title: 'status frames' },
];
const catHidden = new Set(loadJson('catHidePrefixes', ['SM']));
let catHiddenSeen = 0;

function loadJson(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window — non-essential */ }
}

function catFrameVisible(f) {
  const p2 = f.text.slice(0, 2);
  if (catHidden.has(p2)) return false;
  if (catHidden.has('TXRX') && (p2 === 'TX' || p2 === 'RX')) return false;
  const q = catFilterText.value.trim().toUpperCase();
  if (q) {
    const hit = f.text.toUpperCase().includes(q);
    if (catFilterMode.value === 'only' ? !hit : hit) return false;
  }
  return true;
}

function renderHideChips() {
  catHideChips.replaceChildren();
  for (const p of CAT_HIDE_PREFIXES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.classList.toggle('active', catHidden.has(p.key));
    chip.textContent = p.label;
    chip.title = `${catHidden.has(p.key) ? 'Hidden' : 'Shown'}: ${p.title} — click to toggle`;
    chip.addEventListener('click', () => {
      if (catHidden.has(p.key)) catHidden.delete(p.key); else catHidden.add(p.key);
      saveJson('catHidePrefixes', [...catHidden]);
      renderHideChips();
      rerenderCatLog();
    });
    catHideChips.append(chip);
  }
}

// ── Frame history + rendering ──
// Frames arriving in the same WebSocket message (e.g. the web app's batched
// poll) share one batch id and render as one log line of pills.
const catFrames = [];
let catBatchSeq = 0;
let catLastLine = null;   // { batch, dir, frameEl } of the last rendered line

function renderCatFrame(f) {
  if (!catFrameVisible(f)) {
    catHiddenSeen++;
    catHiddenCount.textContent = catHiddenSeen ? `${catHiddenSeen} hidden` : '';
    return;
  }
  if (!catLastLine || catLastLine.batch !== f.batch || catLastLine.dir !== f.dir) {
    const line = document.createElement('div');
    line.className = `cat-log-line cat-line-${f.dir}`;
    const time = document.createElement('span');
    time.className = 'cat-log-time';
    time.textContent = f.time;
    const frameEl = document.createElement('span');
    frameEl.className = 'cat-log-frame';
    line.append(time, makeArrow(f.dir), frameEl);
    catLog.appendChild(line);
    catLastLine = { batch: f.batch, dir: f.dir, frameEl };
    while (catLog.childElementCount > CAT_LOG_MAX_LINES) catLog.removeChild(catLog.firstChild);
  }
  catLastLine.frameEl.appendChild(makeCmd(f.text));
}

function rerenderCatLog() {
  catLog.replaceChildren();
  catLastLine = null;
  catHiddenSeen = 0;
  catHiddenCount.textContent = '';
  for (const f of catFrames) renderCatFrame(f);
  catLog.scrollTop = catLog.scrollHeight;
}

function recordCatFrame(dir, text, batch) {
  const f = { dir, text, batch, time: new Date().toLocaleTimeString(undefined, { hour12: false }) };
  catFrames.push(f);
  if (catFrames.length > CAT_FRAME_HISTORY) catFrames.shift();
  if (dir === 'in') onRadioFrame(text);
  if (catLogPause.checked) return;  // kept in history; shown again on un-pause
  renderCatFrame(f);
  catLog.scrollTop = catLog.scrollHeight;
}

// Splits one WebSocket message on ';' into complete frames, carrying a
// partial trailing frame over to the next message of the SAME direction (a
// frame can straddle two reads — see the LCD/UART pin-share quirk in the
// radio firmware README). Each direction has its own carry-over buffer.
const catPartial = { in: '', out: '', other: '' };
function feedCat(dir, chunk) {
  const batch = ++catBatchSeq;
  let buf = catPartial[dir] + chunk;
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === ';') { recordCatFrame(dir, buf.slice(start, i + 1), batch); start = i + 1; }
  }
  catPartial[dir] = buf.slice(start);
}

function sendCat(text) {
  if (!catWs || catWs.readyState !== WebSocket.OPEN) { showMsg('CAT monitor is not connected.', 'error'); return false; }
  catWs.send(text);
  feedCat('out', text.endsWith(';') ? text : text + ';');
  return true;
}

function connectCatMonitor() {
  const url = new URL('/cat', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    catWs = ws;
    // One query for the radio's diagnostic-mode state; after this the radio
    // pushes every change itself (radios without DG answer ?;, chip stays "?").
    ws.send('DG;FV;');
    // One retry if the version reply was lost to the line's occasional byte corruption.
    setTimeout(() => { if (radioFwVersion.textContent === '—' && catWs === ws) ws.send('FV;'); }, 2500);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') feedCat('other', ev.data);           // TEXT: another client's command
    else feedCat('in', new TextDecoder().decode(ev.data));               // BINARY: the radio
  };
  ws.onclose = () => {
    if (catWs === ws) catWs = null;
    // Reconnect — the monitor is meant to stay open indefinitely, so a
    // bridge reboot or Wi-Fi hiccup recovers on its own.
    setTimeout(connectCatMonitor, 2000);
  };
}

catSendForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const raw = catSendInput.value.trim();
  if (!raw) return;
  // Sent exactly as typed — the operator owns the trailing ';' and casing,
  // as in a terminal talking to the radio directly.
  if (sendCat(raw)) catSendInput.value = '';
});

document.getElementById('cat-log-clear-btn').addEventListener('click', () => {
  catFrames.length = 0;
  rerenderCatLog();
});
catLogPause.addEventListener('change', () => { if (!catLogPause.checked) rerenderCatLog(); });
catFilterText.addEventListener('input', rerenderCatLog);
catFilterMode.addEventListener('change', rerenderCatLog);

// ── Radio frame watchers: probe replies, TX drive, TX audio diagnostic ──
let catProbe = null;   // { prefix, resolve } while "Query radio" waits for one reply
let catRadioDrive = null;

function onRadioFrame(text) {
  if (catProbe) {
    if (text === '?;') { const p = catProbe; catProbe = null; p.resolve(false); }
    else if (text.startsWith(catProbe.prefix)) { const p = catProbe; catProbe = null; p.resolve(true); }
  }
  const fv = text.match(/^FV([^;]+);$/);
  if (fv) radioFwVersion.textContent = fv[1];
  const dg = text.match(/^DG([01]);$/);
  if (dg) setDiagState(dg[1] === '1');
  const dr = text.match(/^DR(\d);$/);
  if (dr) catRadioDrive = Number(dr[1]);
  // 5 fields on current radio firmware (avg envelope, then gated %); older builds send 3 or 4.
  const ta = text.match(/^TA(\d+),(\d+),(\d+)(?:,(\d+))?(?:,(\d+))?;$/);
  if (ta) renderTxDiag(Number(ta[1]), Number(ta[2]), Number(ta[3]), ta[4] === undefined ? null : Number(ta[4]), ta[5] === undefined ? null : Number(ta[5]));
}

// ── Quick-command chips ──
// Read-only queries only — never TX;/RX;/SR;/SR2; or any SET — so a misclick
// can't key the transmitter or wipe the radio's settings. Built by "Query
// radio": each candidate is sent once; it becomes a chip only if the radio
// answers with its own prefix (?; or silence = not supported by this
// firmware). The result is remembered in this browser until queried again.
const CAT_QUERY_CANDIDATES = [
  'FA;', 'MD;', 'IF;', 'ID;', 'FV;', 'PS;', 'SM;', 'AI;', 'TQ;', 'AG0;', 'FW;', 'VO;', 'AT;', 'A2;',
  'NR;', 'DR;', 'BL;', 'AL;', 'TT;', 'PM;', 'PX;', 'XF;', 'FD;', 'TU;', 'TA;',
];
let catChips = loadJson('catQuickChips', []);

function renderQuickChips() {
  catQuickChips.replaceChildren();
  if (!catChips.length) {
    const hint = document.createElement('span');
    hint.className = 'hint chip-hint';
    hint.textContent = 'Run “Query radio” to find the commands this radio answers.';
    catQuickChips.append(hint);
    return;
  }
  for (const c of catChips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip chip-cmd';
    chip.textContent = c;
    chip.title = `Add ${c} to the command line (Send when ready — several can be combined into one batch)`;
    chip.addEventListener('click', () => insertIntoCatInput(c));
    catQuickChips.append(chip);
  }
}

// Chips are command-building shortcuts, not senders: insert at the cursor so
// several can be chained into one batch (e.g. "FA;MD;SM;") or edited into a
// SET before pressing Send.
function insertIntoCatInput(text) {
  const el = catSendInput;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, start, end, 'end');
  el.focus();
}

document.getElementById('cat-send-clear').addEventListener('click', () => { catSendInput.value = ''; catSendInput.focus(); });

function probeOnce(cmd, timeoutMs = 700) {
  const prefix = cmd.replace(/;$/, '');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (catProbe && catProbe.prefix === prefix) catProbe = null; resolve(false); }, timeoutMs);
    catProbe = { prefix, resolve: (ok) => { clearTimeout(timer); resolve(ok); } };
    if (!sendCat(cmd)) { clearTimeout(timer); catProbe = null; resolve(false); }
  });
}

catQueryBtn.addEventListener('click', async () => {
  if (!catWs) { showMsg('CAT monitor is not connected.', 'error'); return; }
  catQueryBtn.disabled = true;
  // One query first: CL; (radio firmware ≥ this release) answers with every
  // read-only query it supports. Older firmware answers ?; — fall back to
  // probing each known query one by one.
  catQueryBtn.textContent = 'Querying…';
  // The LCD/UART pin share can drop a byte from a long reply (seen once:
  // "CLFAMD,..."), so a reply with any malformed entry is asked for again.
  let list = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    // A lost reply (timeout) is retried too; only a firmware that answers ?;
    // three times — i.e. has no CL — falls through to per-command probing.
    // 2 s: right after the page loads, the bridge's single httpd task is busy
    // serving the page's own startup requests and relays /cat late (seen as a
    // ~2 s round trip; ~60 ms once settled).
    if (!(await probeOnce('CL;', 2000))) continue;
    const reply = [...catFrames].reverse().find((f) => f.dir === 'in' && f.text.startsWith('CL'));
    const tokens = reply ? reply.text.slice(2, -1).split(',') : [];
    const valid = tokens.filter((c) => /^[A-Z][A-Z0-9]{1,2}$/.test(c));
    if (valid.length > list.length) list = valid;
    if (valid.length && valid.length === tokens.length) break;
  }
  {
    if (list.length) {
      catChips = list.map((c) => `${c};`);
      saveJson('catQuickChips', catChips);
      renderQuickChips();
      catQueryBtn.textContent = 'Query radio';
      catQueryBtn.disabled = false;
      showMsg(`Radio lists ${list.length} queries (CL;).`, 'ok');
      return;
    }
  }
  const found = [];
  for (let i = 0; i < CAT_QUERY_CANDIDATES.length; i++) {
    const c = CAT_QUERY_CANDIDATES[i];
    catQueryBtn.textContent = `Querying ${i + 1}/${CAT_QUERY_CANDIDATES.length}…`;
    if (await probeOnce(c)) found.push(c);
  }
  catChips = found;
  saveJson('catQuickChips', catChips);
  renderQuickChips();
  catQueryBtn.textContent = 'Query radio';
  catQueryBtn.disabled = false;
  showMsg(`Radio answered ${found.length} of ${CAT_QUERY_CANDIDATES.length} queries.`, 'ok');
});

// ── TX audio diagnostic (radio firmware TX_DIAG, frame TA<mic>,<env>,<clip%>;) ──
// Evaluated here in the browser only, for the operator's diagnostic session —
// the bridge firmware never parses it. The radio pushes the frame after every
// SSB key-up (also answers TA;), all measured after a ~100 ms settling window:
//   mic  — peak mic-ADC deviation, counts (~1.07 mV each, 1.1 V ref; ~480 = rail)
//   env  — peak envelope before the TX-drive shift; full output needs
//          env >= 255 >> drive (64 at DR2)
//   clip — share of samples at the 255 ceiling (100 = full power throughout)
//   avg  — average envelope. Peaks alone mislead (one transient reads as
//          "loud"); clip % and avg say where the transmission actually sat.
//   gated — share of the transmission with the carrier switched OFF by the
//          radio's low-level gate (CARRIER_COMPLETELY_OFF_ON_LOW): quiet audio
//          doesn't just transmit weakly, it transmits nothing for that share.
const TXD_SILENT = 5;
const TXD_RAIL = 470;
const TXD_VERDICT = {
  'no-audio':   { text: 'no audio at the radio', cls: 'bad',  hint: 'Nothing reaches the uSDX mic ADC — check the DAC → interface board → mic jack path.' },
  low:          { text: 'below full power',      cls: 'warn', hint: 'Audio arrives but mostly below the full-power knee — raise the level reaching the mic input (interface board / speaker vol) or TX drive. A high peak with a low ceiling share means one transient, not real level.' },
  full:         { text: 'full power',            cls: 'ok',   hint: 'The envelope sat at the ceiling for most of the transmission — the radio is getting enough audio.' },
  overdriven:   { text: 'overdriven',            cls: 'bad',  hint: 'Mic ADC near its rail — lower the level; clipping the ADC distorts the signal.' },
};

async function renderTxDiag(mic, env, clip, avg, gated) {
  if (liveActive) onLiveWindow(mic, avg, clip, gated);
  if (catRadioDrive === null) {
    // Need the drive to place the knee: ask once, then wait briefly for DRn;.
    sendCat('DR;');
    for (let i = 0; i < 10 && catRadioDrive === null; i++) await new Promise((r) => setTimeout(r, 100));
  }
  const drive = catRadioDrive ?? 2;
  const knee = drive >= 8 ? 0 : 255 >> drive;
  // clip % decides "full" — a peak over the knee can be one transient.
  const silent = avg !== null ? avg < 2 && mic < TXD_SILENT : mic < TXD_SILENT;
  const verdict = mic >= TXD_RAIL ? 'overdriven' : silent ? 'no-audio' : clip >= 90 ? 'full' : 'low';
  // Average drive as a share of the PA ceiling (envelope << drive, capped at 255).
  const drivePct = avg === null ? null : drive >= 8 ? 100 : Math.min(100, Math.round(((avg << drive) * 100) / 255));
  const v = TXD_VERDICT[verdict];
  catTxDiag.hidden = false;
  catTxDiag.replaceChildren();
  const head = document.createElement('div');
  head.className = 'txdiag-head';
  const title = document.createElement('strong');
  title.textContent = 'Last SSB TX audio';
  const badge = document.createElement('span');
  badge.className = `txdiag-badge txdiag-${v.cls}`;
  badge.textContent = v.text;
  const when = document.createElement('span');
  when.className = 'cat-log-time';
  when.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });
  head.append(title, badge, when);
  const stats = document.createElement('div');
  stats.className = 'txdiag-stats';
  stats.textContent = (gated !== null ? `carrier gated off ${gated}% · ` : '') + `at ceiling ${clip}%` + (drivePct !== null ? ` · average drive ${drivePct}% of ceiling (envelope avg ${avg} / knee ${knee}, DR${drive})` : ` · knee ${knee} (DR${drive})`)
    + ` · peaks: mic ${mic} counts (≈${Math.round(mic * 1.07)} mV), envelope ${env}`;
  const hint = document.createElement('div');
  hint.className = 'hint txdiag-hint';
  hint.textContent = v.hint;
  catTxDiag.append(head, stats, hint);
}

renderHideChips();
renderQuickChips();

// ── Persisted CAT log ────────────────────────────────────────────────────
// Distinct from the live in-memory log above: fetched on demand from
// GET /cat-log (a flash-backed ring buffer that survives reboots — see
// cat_log.h), not auto-refreshing, so "Load" is an explicit action.
const catLogPersisted = document.getElementById('cat-log-persisted');

function renderPersistedCatEntry(entry) {
  const line = document.createElement('div');
  line.className = 'cat-log-line';

  const time = document.createElement('span');
  time.className = 'cat-log-time';
  const totalSeconds = Math.floor(entry.uptime_ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  time.textContent = `+${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  time.title = 'uptime at log time, that boot — not a wall-clock timestamp';

  // The persisted log only knows radio vs not-radio, not which client sent it.
  const arrow = makeArrow(entry.from_radio ? 'in' : 'other');
  if (!entry.from_radio) { arrow.textContent = '▶ SENT'; arrow.title = 'sent to the radio by a client'; }

  const text = document.createElement('span');
  text.className = 'cat-log-frame';
  text.textContent = entry.frame + ';';

  line.append(time, arrow, text);
  catLogPersisted.appendChild(line);
}

document.getElementById('cat-log-persisted-load-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/cat-log');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    catLogPersisted.innerHTML = '';
    for (const entry of data.entries) renderPersistedCatEntry(entry);
    catLogPersisted.scrollTop = catLogPersisted.scrollHeight;
  } catch (err) {
    showMsg(`Failed to load persisted CAT log: ${err.message}`, 'error');
  }
});

document.getElementById('cat-log-persisted-clear-btn').addEventListener('click', async () => {
  if (!confirm('Erase the persisted CAT log (flash-backed, survives reboots)? This cannot be undone.')) return;
  try {
    const res = await fetch('/cat-log/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catLogPersisted.innerHTML = '';
  } catch (err) {
    showMsg(`Failed to clear persisted CAT log: ${err.message}`, 'error');
  }
});

// Off by default (see bridge_settings.c's DEFAULT_CAT_LOG_ENABLED comment
// — its boot-time recovery scan grows with the log's own record count and
// was found to cause a real crash-loop once that scan grew close to the
// bridge's 5s task-watchdog timeout). Reboots to apply, same pattern as
// sample-rate below — cat_log_init() only reads this once at boot.
const catLogEnableBtns = document.querySelectorAll('[data-cat-log-enable]');

function updateCatLogEnableButtons(enabled) {
  catLogEnableBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.catLogEnable === 'true') === enabled));
}

async function setCatLogEnabled(enabled) {
  if (!confirm(`${enabled ? 'Enable' : 'Disable'} the persisted CAT log? This saves the setting and restarts the bridge (~5-10s) to apply it.`)) return;
  try {
    const res = await fetch('/cat-log-enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showMsg('Saved, restarting…', 'ok');
  } catch (err) {
    showMsg(`Failed to change persisted CAT log setting: ${err.message}`, 'error');
  }
}

catLogEnableBtns.forEach((btn) => btn.addEventListener('click', () => void setCatLogEnabled(btn.dataset.catLogEnable === 'true')));

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
// bundler/component framework. Always rendered (no "Show" gate) — the
// per-frame canvas work is cheap enough at this size not to bother hiding.
const CLIP_THRESHOLD = 0.98; // fraction of full-scale (Web Audio's -1..1 float range)
const CLIP_WINDOW_MS = 10000; // rolling window for the "N clips in the last 10s" counter
const CLIP_FLASH_MS = 250;
const NOISE_FLOOR_WINDOW_MS = 4000;
const DC_OFFSET_WARN = 0.03; // ~3% of full-scale

// ── I/Q wideband spectrum ─────────────────────────────────────────────────
// Reads raw interleaved I/Q from ws://<device>/iq-data (see firmware's
// audio_iq.h) and renders a full complex-FFT spectrum/waterfall — NOT the
// browser's built-in AnalyserNode (used everywhere else on this page),
// which only computes a REAL-valued FFT and therefore can't represent I/Q
// data at all: a complex signal has independently meaningful positive AND
// negative frequency content (a real-valued FFT's negative half is just
// the mirror of its positive half, redundant information; a complex FFT's
// two halves are genuinely different signals — e.g. distinguishing a
// wanted signal above the LO from an image/interferer below it). Plain
// radix-2 iterative FFT, no library — same "no bundler" reasoning as the
// rest of this page.
function fftRadix2(re, im) {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

const IQ_FFT_SIZE = 4096; // power of 2 — ~11.7Hz/bin at 96kHz (768kHz/N... see bin-width readout), ~85ms latency per window at 48kHz
const IQ_MIN_DB = -90;
const IQ_MAX_DB = -10;

const iqSpectrumBtn = document.getElementById('iq-spectrum-btn');
const iqSpectrumReadout = document.getElementById('iq-spectrum-readout');
const iqSpectrumBars = document.getElementById('iq-spectrum-bars');
const iqSpectrumWaterfall = document.getElementById('iq-spectrum-waterfall');
const iqFreqZoomInput = document.getElementById('iq-freq-zoom');
const iqFreqZoomVal = document.getElementById('iq-freq-zoom-val');
const iqContrastInput = document.getElementById('iq-contrast');
const iqFreqMinEl = document.getElementById('iq-freq-min');
const iqFreqMid1El = document.getElementById('iq-freq-mid1');
const iqFreqMid2El = document.getElementById('iq-freq-mid2');
const iqFreqMaxEl = document.getElementById('iq-freq-max');
const iqSampleRateEl = document.getElementById('iq-sample-rate');
const iqFftSizeEl = document.getElementById('iq-fft-size');
const iqBinWidthEl = document.getElementById('iq-bin-width');
const iqPeakEl = document.getElementById('iq-peak');
const iqCorrectionBtns = document.querySelectorAll('[data-iq-correction]');

// 'none' | 'swap' | 'negateI' | 'negateQ' — see index.html's I/Q
// correction row and its hint text for what each means and why there are
// four instead of just an on/off swap (a literal channel swap and a
// single inverted channel are two physically distinct defects that both
// produce the same mirrored-spectrum symptom, but only one actually
// matches whatever's really wrong on THIS board).
let iqCorrection = 'none';
iqCorrectionBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    iqCorrection = btn.dataset.iqCorrection;
    iqCorrectionBtns.forEach((b) => b.classList.toggle('active', b === btn));
    // A bridge with its own DSP applies the correction before its spectrum.
    if (bridgeDoesSpectrum()) void fetch('/iq-config', { method: 'POST', body: JSON.stringify({ iq_correction: iqCorrection }) });
  });
});

let iqWs = null;
let iqActive = false;
// Rolling accumulation buffers — filled from arriving WS frames (whatever
// size the firmware's 50ms read window produces at the configured rate,
// see audio_monitor.c's s_read_samples) until IQ_FFT_SIZE complex samples
// are ready, then FFT'd and cleared. Deliberately not a fixed-size ring
// with overlap — a fresh, non-overlapping window each time is simpler and
// this view is a diagnostic tool, not a waterfall needing maximum time
// resolution.
let iqAccumRe = new Float32Array(IQ_FFT_SIZE);
let iqAccumIm = new Float32Array(IQ_FFT_SIZE);
let iqAccumCount = 0;
let iqFftRe = new Float32Array(IQ_FFT_SIZE);
let iqFftIm = new Float32Array(IQ_FFT_SIZE);
// Shifted (fftshift'd — bin 0 = most-negative frequency, bin N-1 = just
// below +Nyquist, center bin = 0Hz) byte-scaled magnitude, same 0-255
// log-dB-mapped convention as AnalyserNode.getByteFrequencyData() so
// drawBarSpectrum()/drawWaterfallColumn() work unmodified.
let iqMagBytes = new Uint8Array(IQ_FFT_SIZE);
let iqLastPeakDb = -Infinity;

function updateIqZoomLabel() {
  const nyquist = iqRate() / 2;
  const zoomFrac = Number(iqFreqZoomInput.value) / 100;
  // 100 = full ±Nyquist span; smaller values zoom into the center (0Hz) —
  // exponential mapping so the low end of the slider still gives a usable
  // zoomed-in range instead of being squeezed into the first few percent.
  const halfSpanHz = Math.max(nyquist * 0.01, nyquist * Math.pow(zoomFrac, 2));
  iqFreqZoomVal.textContent = `±${Math.round(halfSpanHz)} Hz`;
  const fmt = (hz) => (Math.abs(hz) >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${Math.round(hz)}`);
  iqFreqMinEl.textContent = fmt(-halfSpanHz);
  iqFreqMid1El.textContent = fmt(-halfSpanHz / 2);
  iqFreqMid2El.textContent = fmt(halfSpanHz / 2);
  iqFreqMaxEl.textContent = `${fmt(halfSpanHz)} Hz`;
  iqFftSizeEl.textContent = String(IQ_FFT_SIZE);
  iqBinWidthEl.textContent = `${(iqRate() / IQ_FFT_SIZE).toFixed(1)} Hz`;
  iqSampleRateEl.textContent = `${iqRate()} Hz`;
}
iqFreqZoomInput.addEventListener('input', updateIqZoomLabel);
updateIqZoomLabel();

// Runs one FFT over whatever's accumulated in iqAccumRe/Im, fftshifts the
// magnitude into display order, and maps to the same byte/dB scale
// AnalyserNode uses (so drawBarSpectrum/drawWaterfallColumn need no
// I/Q-specific branch). Called once per full IQ_FFT_SIZE window.
function processIqWindow() {
  iqFftRe.set(iqAccumRe);
  iqFftIm.set(iqAccumIm);
  fftRadix2(iqFftRe, iqFftIm);

  const n = IQ_FFT_SIZE;
  const half = n / 2;
  let peakDb = -Infinity;
  for (let i = 0; i < n; i++) {
    // fftshift: output bin i (0..n-1, natural FFT order: 0..+Nyquist then
    // -Nyquist..0) maps to display bin (i + half) % n, so the display
    // array reads most-negative-frequency-first, 0Hz exactly at the center.
    const srcIdx = i;
    const dstIdx = (i + half) % n;
    const mag = Math.sqrt(iqFftRe[srcIdx] * iqFftRe[srcIdx] + iqFftIm[srcIdx] * iqFftIm[srcIdx]) / n;
    const db = 20 * Math.log10(Math.max(mag, 1e-12));
    if (db > peakDb) peakDb = db;
    const frac = (db - IQ_MIN_DB) / (IQ_MAX_DB - IQ_MIN_DB);
    iqMagBytes[dstIdx] = Math.max(0, Math.min(255, Math.round(frac * 255)));
  }
  iqLastPeakDb = peakDb;
  iqPeakEl.textContent = Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dB` : '—';
}

// Feeds one incoming interleaved-I/Q Int16Array frame into the
// accumulator, running processIqWindow() every time it fills — a frame
// can be smaller OR larger than the remaining space, so this loops rather
// than assuming a 1:1 frame-to-window relationship (frame size depends on
// the firmware's configured sample rate, window size is fixed).
function feedIqSamples(int16) {
  let offset = 0;
  const pairCount = int16.length / 2;
  // I/Q correction buttons above — see their own comment for what each
  // mode means. Same choke point as the Signal-Decoder web app's
  // useIQBridge.ts (its onmessage handler) — this page has its own
  // independent I/Q pipeline, so the two controls are unrelated and must
  // each be set separately.
  const correction = iqCorrection;
  while (offset < pairCount) {
    const remaining = IQ_FFT_SIZE - iqAccumCount;
    const take = Math.min(remaining, pairCount - offset);
    for (let i = 0; i < take; i++) {
      let iSample = int16[(offset + i) * 2];
      let qSample = int16[(offset + i) * 2 + 1];
      if (correction === 'swap') {
        const tmp = iSample; iSample = qSample; qSample = tmp;
      } else if (correction === 'negateI') {
        iSample = iSample === -32768 ? 32767 : -iSample;
      } else if (correction === 'negateQ') {
        qSample = qSample === -32768 ? 32767 : -qSample;
      }
      iqAccumRe[iqAccumCount + i] = iSample / 32768;
      iqAccumIm[iqAccumCount + i] = qSample / 32768;
    }
    iqAccumCount += take;
    offset += take;
    if (iqAccumCount >= IQ_FFT_SIZE) {
      processIqWindow();
      iqAccumCount = 0;
    }
  }
}

// S3: the bridge computes the spectrum itself (/iq-spectrum, "IQS1" rows:
// seq, fs, bins, dB floor, dB span, then one byte per bin, lowest frequency
// first). Rows are mapped onto this page's dB scale and bin count, so the
// same bars and waterfall draw them.
const bridgeDoesSpectrum = () => !!bridgeFeatures && bridgeFeatures.has('iq_spectrum');
function feedSpectrumRow(buf) {
  if (buf.byteLength < 20) return;
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x49515331) return;  // "IQS1"
  const fs = dv.getUint32(8, true), bins = dv.getUint16(12, true);
  const floor = dv.getInt16(14, true), span = dv.getUint16(16, true);
  if (!bins || buf.byteLength < 20 + bins) return;
  const row = new Uint8Array(buf, 20, bins);
  if (fs && fs !== iqRate()) { iqSampleRate = fs; updateIqZoomLabel(); }
  let peakDb = -Infinity;
  for (let i = 0; i < IQ_FFT_SIZE; i++) {
    const db = floor + (row[Math.floor((i * bins) / IQ_FFT_SIZE)] * span) / 255;
    if (db > peakDb) peakDb = db;
    const frac = (db - IQ_MIN_DB) / (IQ_MAX_DB - IQ_MIN_DB);
    iqMagBytes[i] = Math.max(0, Math.min(255, Math.round(frac * 255)));
  }
  iqLastPeakDb = peakDb;
  iqPeakEl.textContent = `${peakDb.toFixed(1)} dB`;
  iqFftSizeEl.textContent = String(bins);
  iqBinWidthEl.textContent = `${(fs / bins).toFixed(1)} Hz`;
}

function stopIqSpectrum() {
  if (iqWs) { iqWs.close(); iqWs = null; }
  iqActive = false;
  iqAccumCount = 0;
  iqSpectrumBtn.textContent = 'Start I/Q Spectrum';
  iqSpectrumReadout.textContent = 'inactive';
  iqSpectrumReadout.classList.remove('clipping');
}

async function startIqSpectrum() {
  const onBridge = bridgeDoesSpectrum();
  if (onBridge) {
    try {
      const c = await (await fetch('/iq-config')).json();
      iqSampleRate = c.fs || iqSampleRate;
      if (c.iq_correction) {
        iqCorrection = c.iq_correction;
        iqCorrectionBtns.forEach((b) => b.classList.toggle('active', b.dataset.iqCorrection === iqCorrection));
      }
    } catch { /* keep */ }
  } else {
    await fetchBridgeSampleRate(); // fresh — the configured rate may have changed since this page loaded
  }
  updateIqZoomLabel();
  iqAccumCount = 0;

  const url = new URL(onBridge ? '/iq-spectrum' : '/iq-data', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    iqWs = ws;
    iqActive = true;
    iqSpectrumBtn.textContent = 'Stop I/Q Spectrum';
    iqSpectrumReadout.textContent = 'connected — waiting for data';
    showMsg('I/Q spectrum connected.', 'ok');
  };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    if (onBridge) feedSpectrumRow(ev.data);
    else feedIqSamples(new Int16Array(ev.data));
  };
  ws.onerror = () => {
    showMsg('I/Q spectrum connection failed.', 'error');
  };
  ws.onclose = () => {
    if (iqWs !== ws) return; // superseded by a newer start — this close is stale
    stopIqSpectrum();
  };
}

iqSpectrumBtn.addEventListener('click', () => {
  if (iqActive) stopIqSpectrum();
  else void startIqSpectrum();
});

function iqSpectrumTick() {
  if (!iqActive) return;
  const nyquist = iqRate() / 2;
  const zoomFrac = Number(iqFreqZoomInput.value) / 100;
  const halfSpanHz = Math.max(nyquist * 0.01, nyquist * Math.pow(zoomFrac, 2));
  // Crop the shifted (0Hz-centered) magnitude array to ±halfSpanHz around
  // the center bin — same idea as the other channels' Max-freq slider,
  // just symmetric around the center instead of cropping from an edge.
  const binHz = iqRate() / IQ_FFT_SIZE;
  const halfBins = Math.max(1, Math.round(halfSpanHz / binHz));
  const center = IQ_FFT_SIZE / 2;
  const lo = Math.max(0, center - halfBins);
  const hi = Math.min(IQ_FFT_SIZE, center + halfBins);
  const cropped = iqMagBytes.subarray(lo, hi);

  drawBarSpectrum(iqSpectrumBars, cropped, cropped.length, null);
  drawWaterfallColumn(iqSpectrumWaterfall, cropped, cropped.length, Number(iqContrastInput.value));

  if (Number.isFinite(iqLastPeakDb)) {
    iqSpectrumReadout.textContent = `peak ${iqLastPeakDb.toFixed(1)} dB`;
  }
}

function makeChannelState(prefix) {
  return {
    prefix,
    barCanvas: document.getElementById(`quality-${prefix}-bars`),
    waterfallCanvas: document.getElementById(`quality-${prefix}-waterfall`),
    scopeCanvas: document.getElementById(`quality-${prefix}-scope`),
    contrastInput: document.getElementById(`quality-${prefix}-contrast`),
    scopeAutoInput: document.getElementById(`quality-${prefix}-scope-auto`),
    scopeScaleInput: document.getElementById(`quality-${prefix}-scope-scale`),
    scopeZoomInput: document.getElementById(`quality-${prefix}-scope-zoom`),
    scopeWindowEl: document.getElementById(`quality-${prefix}-scope-window`),
    gainEl: document.getElementById(`quality-${prefix}-gain`),
    readoutEl: document.getElementById(`quality-${prefix}-readout`),
    cutoffEl: document.getElementById(`quality-${prefix}-cutoff`),
    floorEl: document.getElementById(`quality-${prefix}-floor`),
    dcEl: document.getElementById(`quality-${prefix}-dc`),
    clipsEl: document.getElementById(`quality-${prefix}-clips`),
    channelEl: document.getElementById(`quality-${prefix}-bars`).closest('.quality-channel'),
    freqRangeInput: document.getElementById(`quality-${prefix}-freq-range`),
    freqRangeValEl: document.getElementById(`quality-${prefix}-freq-range-val`),
    freqAxisEls: [
      document.getElementById(`quality-${prefix}-freq-mid1`),
      document.getElementById(`quality-${prefix}-freq-mid2`),
      document.getElementById(`quality-${prefix}-freq-mid3`),
      document.getElementById(`quality-${prefix}-freq-max`),
    ],
    freqData: null,
    timeDataFloat: null,
    timeDataByte: null,
    clipEvents: [],
    lastClipFlashAt: 0,
    noiseFloorMin: Infinity,
    noiseFloorWindowStart: 0,
  };
}

const qualityIn = makeChannelState('in');
const qualityOut = makeChannelState('out');

// Auto-scale defaults to enabled (the whole point of auto-ranging is to
// not need a manual scale most of the time) — the manual slider only
// matters, and is only enabled, once the operator unchecks Auto.
for (const st of [qualityIn, qualityOut]) {
  st.scopeAutoInput.addEventListener('change', () => {
    st.scopeScaleInput.disabled = st.scopeAutoInput.checked;
  });
}

// Frequency-range slider: crops the bar spectrum and waterfall to 0..maxFreq
// instead of always showing the full 0..nyquist span. Default max (4000 Hz,
// the slider's own max) matches the full-Nyquist behavior these views had
// before the slider existed; the radio's actual passband tops out well
// below that (per operator report, ~3kHz), so the slider defaults to full
// range but the operator can crop in for a bigger, more legible view of the
// signal they actually have. One label row serves BOTH the bar spectrum and
// the waterfall below it — both put frequency on the x-axis now (the
// waterfall used to run frequency on y/time on x; see drawWaterfallColumn's
// comment for why that changed), so they share this one axis instead of
// each needing its own.
function updateFreqAxisLabels(st) {
  const maxFreq = Number(st.freqRangeInput.value);
  st.freqRangeValEl.textContent = `${maxFreq} Hz`;
  const fmt = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${Math.round(hz)}`);
  st.freqAxisEls[0].textContent = fmt(maxFreq * 0.25);
  st.freqAxisEls[1].textContent = fmt(maxFreq * 0.5);
  st.freqAxisEls[2].textContent = fmt(maxFreq * 0.75);
  st.freqAxisEls[3].textContent = `${fmt(maxFreq)} Hz`;
}

for (const st of [qualityIn, qualityOut]) {
  updateFreqAxisLabels(st);
  st.freqRangeInput.addEventListener('input', () => updateFreqAxisLabels(st));
}

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

// binCount crops the display to data[0..binCount) — the operator's
// frequency-range slider — rather than always spanning the full
// 0..analyser.frequencyBinCount (0..Nyquist), since the radio's actual
// passband only occupies the bottom fraction of that at typical bridge
// sample rates. peakAmpFrac draws a HORIZONTAL dashed line at the
// half-peak (~-6dB) amplitude threshold — not a frequency-position marker —
// so it reads directly against the dB axis on the left; see
// tickQualityChannel() for how it's derived.
function drawBarSpectrum(canvas, data, binCount, peakAmpFrac) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);
  const n = Math.min(binCount, data.length);
  const barW = w / n;
  for (let i = 0; i < n; i++) {
    const v = data[i] / 255;
    const barH = v * h;
    ctx.fillStyle = v > 0.85 ? '#f85149' : v > 0.6 ? '#e3b341' : '#2ea043';
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  }
  if (peakAmpFrac != null && peakAmpFrac >= 0 && peakAmpFrac <= 1) {
    const y = h - peakAmpFrac * h;
    ctx.save();
    ctx.strokeStyle = '#58a6ff';
    ctx.shadowColor = '#58a6ff';
    ctx.shadowBlur = 6;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.restore();
  }
}

// Falling (top-down) waterfall, matching the Signal-Decoder web app's own
// GLSpectrogram convention — frequency across x (shared with the bar
// spectrum directly above this canvas), newest row painted at the top,
// history scrolling DOWN. Previously this scrolled sideways instead (time
// across x, frequency across y) — a real usability bug on this page
// specifically, since every other frequency-domain view here (bar
// spectrum, and the web app's own waterfall for comparison) puts frequency
// on x; keep this consistent now that it's fixed. Row-wise shift (not
// column-wise) is still the cheap direction for a plain 2D canvas — shifts
// via drawImage-of-self, one plain getImageData/putImageData full-canvas
// copy would be far more main-thread work than this page needs.
// gamma < 1 boosts faint signal into visible color range (more contrast on
// quiet passbands); gamma > 1 compresses it (less sensitive to noise floor).
function drawWaterfallColumn(canvas, data, binCount, gamma) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const n = Math.min(binCount, data.length);
  ctx.drawImage(canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
  for (let x = 0; x < w; x++) {
    const bf = (x / w) * (n - 1);
    const b0 = Math.floor(bf), b1 = Math.min(b0 + 1, n - 1);
    const raw = (data[b0] * (1 - (bf - b0)) + data[b1] * (bf - b0)) / 255;
    const v = Math.pow(Math.max(0, Math.min(1, raw)), gamma);
    // turbo-ish cheap gradient: dark blue -> green -> yellow -> red
    const r = Math.round(Math.min(255, Math.max(0, 510 * (v - 0.5))));
    const g = Math.round(Math.min(255, Math.max(0, 510 * Math.min(v, 1 - v) + 60)));
    const b = Math.round(Math.min(255, Math.max(0, 255 - 510 * v)));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, 1);
  }
}

// Auto-gain floor: below this, a quiet-but-present signal (e.g. a few % of
// full-scale) would only deflect the trace by a fraction of a pixel at the
// fixed +-100% scale a real oscilloscope uses, reading as a flatline even
// though the peak/DC-offset stats (computed independently) prove the
// analyser IS getting live data. Scaling the trace to "most of the visible
// height" instead — like turning up a scope's vertical gain knob — makes
// small signals visibly move; this floor just stops that gain from
// exploding pure noise into a wall of jitter once the signal is near-silent.
const SCOPE_MIN_GAIN_PEAK = 0.03; // clamp auto-gain scale to at most 1/0.03 ~= 33x

// autoGain true: scale so the actual peak this frame fills ~90% of the
// half-height — same idea as an auto-ranging scope, so a quiet signal is
// still legible instead of collapsing to a sub-pixel-tall flat line at a
// fixed +-100% scale built for near-clipping signals. autoGain false:
// manualGain is used directly (the operator's own "vertical gain knob"),
// for when auto-ranging itself is the thing being fought (e.g. comparing
// two moments at the same fixed scale rather than each auto-normalized).
// windowSamples zooms in on just the most recent N samples of the buffer
// (still the newest data — getByteTimeDomainData fills oldest-to-newest,
// so the tail is "now") rather than always stretching the entire fftSize
// buffer across the canvas width. A full square-wave cycle at a few
// hundred Hz is only a handful of samples at 48kHz — spreading it across
// 8192 samples' worth of trace makes it as hard to read as a bar spectrum
// with only 2 bars; zooming in reveals the actual edge shape.
function drawScope(canvas, data, windowSamples, clipping, dcOffsetFrac, peak, autoGain, manualGain, gainLabelEl) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  const gain = autoGain ? 0.9 / Math.max(peak, SCOPE_MIN_GAIN_PEAK) : manualGain;
  if (gainLabelEl) gainLabelEl.textContent = `${gain.toFixed(1)}x${autoGain ? '' : ' (manual)'}`;

  ctx.strokeStyle = '#3d444d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (Math.abs(dcOffsetFrac) >= DC_OFFSET_WARN) {
    const dcY = h / 2 - dcOffsetFrac * gain * (h / 2);
    ctx.strokeStyle = '#e3b341';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, dcY);
    ctx.lineTo(w, dcY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const count = Math.min(windowSamples, data.length);
  const offset = data.length - count;

  ctx.strokeStyle = clipping ? '#f85149' : '#2ea043';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = w / count;
  for (let i = 0; i < count; i++) {
    const v = (data[offset + i] - 128) / 128;
    const y = h / 2 - Math.max(-1, Math.min(1, v * gain)) * (h / 2) * 0.95;
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
  }
  ctx.stroke();

  if (clipping) {
    ctx.fillStyle = '#f85149';
    for (let i = 0; i < count; i++) {
      const v = (data[offset + i] - 128) / 128;
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
    if (st.gainEl) st.gainEl.textContent = '—';
    if (st.scopeWindowEl) st.scopeWindowEl.textContent = '—';
    return;
  }

  const bc = analyser.frequencyBinCount;
  if (!st.freqData || st.freqData.length !== bc) st.freqData = new Uint8Array(bc);
  analyser.getByteFrequencyData(st.freqData);

  const nyquist = analyser.context.sampleRate / 2;
  const maxFreq = Number(st.freqRangeInput.value);
  const cropBinCount = Math.max(1, Math.min(bc, Math.round((maxFreq / nyquist) * bc)));

  const rolloffBin = estimateRolloffBin(st.freqData);
  let peakAmpFrac = null;
  if (rolloffBin != null) {
    st.cutoffEl.textContent = `${Math.round((rolloffBin / bc) * nyquist)} Hz`;
    // Horizontal marker: half the peak amplitude that estimateRolloffBin()
    // itself used to find rolloffBin — reads directly against the bar
    // spectrum's dB axis instead of marking a frequency position.
    let peak = 0;
    for (let i = 0; i < st.freqData.length; i++) if (st.freqData[i] > peak) peak = st.freqData[i];
    peakAmpFrac = (peak / 2) / 255;
  } else {
    st.cutoffEl.textContent = '—';
  }
  drawBarSpectrum(st.barCanvas, st.freqData, cropBinCount, peakAmpFrac);
  drawWaterfallColumn(st.waterfallCanvas, st.freqData, cropBinCount, Number(st.contrastInput.value));

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

  // Zoom slider (1-100) maps exponentially to sample count, not linearly —
  // a linear map would leave almost no usable range at the "zoomed way in,
  // see individual cycles" end, which is the whole point of zooming in on
  // a square wave's edges. 1 -> ~16 samples (a handful of cycles at voice
  // frequencies), 100 -> the full buffer (max zoom-out).
  const zoomFrac = Number(st.scopeZoomInput.value) / 100;
  const minSamples = 16;
  const windowSamples = Math.round(minSamples * Math.pow(analyser.fftSize / minSamples, zoomFrac));
  if (st.scopeWindowEl) {
    const windowMs = (windowSamples / analyser.context.sampleRate) * 1000;
    st.scopeWindowEl.textContent = windowMs >= 10 ? `${Math.round(windowMs)}ms window` : `${windowMs.toFixed(1)}ms window`;
  }

  drawScope(
    st.scopeCanvas, st.timeDataByte, windowSamples, isClipping, dcOffset, peak,
    st.scopeAutoInput.checked, Number(st.scopeScaleInput.value), st.gainEl,
  );
}

function qualityTick(now) {
  tickQualityChannel(qualityIn, playAnalyserNode, playbackActive, now);
  tickQualityChannel(qualityOut, sniffAnalyserNode, sniffActive, now);
  iqSpectrumTick();
  requestAnimationFrame(qualityTick);
}
requestAnimationFrame(qualityTick);

refreshStatus(true);
scanNetworks();
startStatusAutoRefresh();

// ── Radio firmware update (bridge ≥0.9.0, POST /radio-ota) ────────────────
// The .hex is parsed here into the plain binary the bridge flashes; the
// bridge does the rest (UG; → Optiboot 8 → write, read back, compare →
// restart → FV;). Settings live in EEPROM and are never touched.
const radioFwVersion = document.getElementById('radio-fw-version');
const radioFwFile = document.getElementById('radio-fw-file');
const radioFwInfo = document.getElementById('radio-fw-info');
const radioFwBtn = document.getElementById('radio-fw-btn');
const radioFwProgress = document.getElementById('radio-fw-progress');
const radioFwBar = document.getElementById('radio-fw-bar');
const radioFwStatus = document.getElementById('radio-fw-status');
const RADIO_APP_MAX = 32256;
let radioFwImage = null;

// Intel HEX → Uint8Array from address 0 (gaps 0xFF, as erased flash).
function parseIntelHex(text) {
  let base = 0;
  let maxAddr = 0;
  const chunks = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error('not an Intel HEX file');
    const bytes = line.slice(1).match(/../g).map((h) => parseInt(h, 16));
    const sum = bytes.reduce((a, b) => (a + b) & 0xFF, 0);
    if (sum !== 0) throw new Error('checksum error in the .hex');
    const [len, hi, lo, type] = bytes;
    const data = bytes.slice(4, 4 + len);
    if (type === 0x00) {
      const addr = base + (hi << 8 | lo);
      chunks.push([addr, data]);
      maxAddr = Math.max(maxAddr, addr + data.length);
    } else if (type === 0x01) break;
    else if (type === 0x02) base = ((data[0] << 8) | data[1]) << 4;
    else if (type === 0x04) base = ((data[0] << 8) | data[1]) << 16;
  }
  const img = new Uint8Array(maxAddr).fill(0xFF);
  for (const [addr, data] of chunks) img.set(data, addr);
  return img;
}

radioFwFile.addEventListener('change', async () => {
  radioFwImage = null;
  radioFwBtn.disabled = true;
  radioFwInfo.textContent = '';
  const f = radioFwFile.files[0];
  if (!f) return;
  try {
    const img = parseIntelHex(await f.text());
    if (img.length > RADIO_APP_MAX) throw new Error(`image is ${img.length} bytes — over the ${RADIO_APP_MAX}-byte app area (would hit the bootloader)`);
    if (img.length < 4 || img[0] !== 0x0C || img[1] !== 0x94) throw new Error('not an ATmega328P app image (reset vector is not a JMP)');
    if (f.name.includes('with_bootloader')) throw new Error('this is the with_bootloader image — pick usdxBLACKBRICK.ino.hex');
    radioFwImage = img;
    radioFwInfo.textContent = `${f.name}: ${img.length} bytes, ${Math.ceil(img.length / 128)} pages`;
    radioFwBtn.disabled = false;
  } catch (err) {
    radioFwInfo.textContent = `Not usable: ${err.message}`;
  }
});

function setRadioFwStatus(text, kind) { radioFwStatus.textContent = text; radioFwStatus.dataset.kind = kind || ''; }

radioFwBtn.addEventListener('click', async () => {
  if (!radioFwImage) return;
  if (liveActive || txPlayBusy) { setRadioFwStatus('Stop the live test / playback first.', 'error'); return; }
  if (!confirm(`Update the radio firmware (${radioFwImage.length} bytes)?\n\n` +
    '• Keep the radio powered and the external PA off during the ~25 s update.\n' +
    '• CAT is paused meanwhile.\n• If it fails part-way, the radio needs the ISP cable.')) return;
  radioFwBtn.disabled = true;
  radioFwProgress.hidden = false;
  radioFwBar.style.width = '0';
  setRadioFwStatus('Uploading image to the bridge…', 'play');
  try {
    const res = await fetch('/radio-ota', { method: 'POST', body: radioFwImage });
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
  } catch (err) {
    setRadioFwStatus(`Refused: ${err.message}`, 'error');
    radioFwBtn.disabled = false;
    return;
  }
  for (;;) {
    await sleepMs(300);
    let st = null;
    try { st = await (await fetch('/radio-ota-status')).json(); } catch { continue; }
    const frac = st.pages_total ? st.pages_done / st.pages_total : 0;
    const pct = st.state === 'writing' ? frac * 50 : st.state === 'verifying' ? 50 + frac * 45 : st.state === 'restarting' ? 97 : st.state === 'done' ? 100 : 2;
    radioFwBar.style.width = `${pct}%`;
    const label = { entering: 'Asking the radio to enter its bootloader (UG;)…', syncing: 'Syncing with the bootloader…',
      writing: `Writing page ${st.pages_done}/${st.pages_total}…`, verifying: `Verifying page ${st.pages_done}/${st.pages_total}…`,
      restarting: 'Restarting the radio, waiting for FV;…' }[st.state];
    if (label) { setRadioFwStatus(label, 'tx'); continue; }
    if (st.state === 'done') {
      setRadioFwStatus(`Done — radio running ${st.version}, every page verified.`, 'ok');
      radioFwVersion.textContent = st.version;
    } else if (st.state === 'failed') {
      setRadioFwStatus(`Failed: ${st.error}`, 'error');
    }
    break;
  }
  radioFwBtn.disabled = !radioFwImage;
});
