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
    if (typeof status.rx_slot_right === 'boolean') updateRxSlotButtons(status.rx_slot_right);
    if (typeof status.led_enabled === 'boolean') updateLedEnableButtons(status.led_enabled);
    if (typeof status.alc_enabled === 'boolean') updateAlcButtons(status.alc_enabled);
    if (typeof status.noise_gate_enabled === 'boolean') updateNoiseGateButtons(status.noise_gate_enabled);
    if (typeof status.cpu_freq_mhz === 'number') updateCpuFreqButtons(status.cpu_freq_mhz);
    if (typeof status.wifi_tx_power_quarter_dbm === 'number') updateWifiTxPowerButtons(status.wifi_tx_power_quarter_dbm);
    if (typeof status.adc_hpf_enabled === 'boolean') updateAdcHpfButtons(status.adc_hpf_enabled);
    if (typeof status.sample_rate_hz === 'number') updateSampleRateButtons(status.sample_rate_hz);
    if (typeof status.speaker_amp_enabled === 'boolean') updateSpeakerAmpButtons(status.speaker_amp_enabled);
    if (typeof status.mic_gain_db === 'number') updateMicGainSlider(status.mic_gain_db);
    if (typeof status.cat_log_enabled === 'boolean') updateCatLogEnableButtons(status.cat_log_enabled);
  } catch (err) {
    if (!silent) showMsg(`Failed to load status: ${err.message}`, 'error');
  }

  try {
    const info = await (await fetch('/info')).json();
    document.getElementById('s-fw').textContent = info.firmware_version;
  } catch (err) {
    if (!silent) showMsg(`Failed to load firmware info: ${err.message}`, 'error');
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
const rxSlotBtns = document.querySelectorAll('[data-rx-slot]');

function updateRxSlotButtons(isRight) {
  rxSlotBtns.forEach((btn) => btn.classList.toggle('active', (btn.dataset.rxSlot === 'right') === isRight));
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
    updateRxSlotButtons(result.right);
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

// ── Sample rate ────────────────────────────────────────────────────────────
// The /audio WebSocket's wire rate IS the codec/I2S hardware's own rate —
// unlike every other toggle on this page, changing this persists to NVS
// AND REBOOTS the bridge to apply (a live I2S/codec reclock was
// deliberately avoided — see bridge_config.h), so this needs a confirm
// prompt the other live-switchable controls don't.
const sampleRateBtns = document.querySelectorAll('[data-sample-rate]');

function updateSampleRateButtons(hz) {
  sampleRateBtns.forEach((btn) => btn.classList.toggle('active', Number(btn.dataset.sampleRate) === hz));
}

async function setSampleRate(hz) {
  if (!confirm(`Change sample rate to ${hz} Hz? This saves the setting and restarts the bridge (~5-10s) to apply it.`)) return;
  try {
    const res = await fetch('/sample-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hz }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

async function refreshSystemStats() {
  try {
    const res = await fetch('/system-stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stats = await res.json();

    updateCpuFreqButtons(stats.cpu_freq_mhz);
    document.getElementById('cpu-heap-free').textContent = fmtBytes(stats.heap_free);
    document.getElementById('cpu-heap-min').textContent = fmtBytes(stats.heap_min_free);
    document.getElementById('cpu-heap-total').textContent = fmtBytes(stats.heap_total);

    cpuTaskBody.innerHTML = '';
    for (const task of stats.tasks || []) {
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
  playCtx = new AudioContext();
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
  sniffPlayCtx = new AudioContext();
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

const catLog = document.getElementById('cat-log');
const catLogPause = document.getElementById('cat-log-pause');
const catSendForm = document.getElementById('cat-send-form');
const catSendInput = document.getElementById('cat-send-input');
const catBaudSelect = document.getElementById('cat-baud-select');
const catBaudApplyBtn = document.getElementById('cat-baud-apply-btn');

let catWs = null;
let catRadioBuf = '';

// Commands arriving together in the SAME WebSocket message (e.g. the web
// app's batched poll "FA;MD;AG0;...;AL;", sent as one query) share a
// single log LINE — one timestamp/arrow, each command as its own small
// pill within that line — rather than one DOM row per command; a 12-
// command batch used to read as 12 stacked lines, which buried the "these
// all went out together" fact the batching itself is trying to show.
// catCurrentBatchLine/Arrow track the line currently being appended to;
// null whenever the next frame should start a fresh line (a genuinely new
// batch, or the very first frame ever).
let catCurrentBatchLine = null;
let catCurrentBatchArrow = null;

function appendCatFrame(direction, frame, isBatchStart) {
  if (catLogPause.checked) return;

  if (isBatchStart || !catCurrentBatchLine) {
    const line = document.createElement('div');
    line.className = 'cat-log-line';

    const time = document.createElement('span');
    time.className = 'cat-log-time';
    time.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });

    const arrow = document.createElement('span');
    arrow.className = `arrow arrow-${direction}`;
    arrow.textContent = direction === 'in' ? '←' : '→';
    arrow.title = direction === 'in' ? 'from radio' : 'to radio';

    const commands = document.createElement('span');
    commands.className = 'cat-log-frame';

    line.append(time, arrow, commands);
    catLog.appendChild(line);
    catCurrentBatchLine = commands;
    catCurrentBatchArrow = direction;
  }

  // A direction change without an explicit new batch shouldn't happen in
  // practice (feedCatBuf is only ever called with one direction per
  // call), but if it ever did, starting a fresh line is safer than
  // silently mislabeling a command with the wrong arrow.
  if (catCurrentBatchArrow !== direction) {
    catCurrentBatchLine = null;
    appendCatFrame(direction, frame, true);
    return;
  }

  const cmd = document.createElement('span');
  cmd.className = 'cat-log-cmd';
  cmd.textContent = frame;
  catCurrentBatchLine.appendChild(cmd);

  while (catLog.childElementCount > CAT_LOG_MAX_LINES) {
    catLog.removeChild(catLog.firstChild);
  }
  catLog.scrollTop = catLog.scrollHeight;
}

// Splits one WebSocket message's raw bytes on ';' into complete frames,
// carrying any partial trailing frame over in `buf` for the NEXT message
// (a CAT frame doesn't always align with a message boundary — see the
// LCD/UART pin-share quirk in the firmware README, which can split a
// frame's bytes across two separate reads). Only the first complete frame
// actually starting within THIS call is marked as a batch start — a
// frame that's the leftover tail of a previous call's partial buffer
// belongs to that earlier batch, not a new one.
function feedCatBuf(buf, chunk, direction) {
  const startedEmpty = buf.length === 0;
  buf += chunk;
  let start = 0;
  let first = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === ';') {
      appendCatFrame(direction, buf.slice(start, i + 1), first && startedEmpty);
      first = false;
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
  // Routed through feedCatBuf (starting from an always-empty buffer, since
  // a manual send is always one fresh, complete batch) rather than a
  // direct appendCatFrame call — so typing e.g. "FA;SM;" here splits into
  // two lines under one batch-start marker, consistent with how the same
  // two commands would render if the radio (or another client) had sent
  // them together in one message.
  feedCatBuf('', raw.endsWith(';') ? raw : raw + ';', 'out');
  catSendInput.value = '';
});

document.getElementById('cat-log-clear-btn').addEventListener('click', () => {
  catLog.innerHTML = '';
  // Otherwise the next frame would silently append into a batch line that
  // no longer exists in the DOM (removed by innerHTML above) instead of
  // starting a fresh one.
  catCurrentBatchLine = null;
  catCurrentBatchArrow = null;
});

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

  const arrow = document.createElement('span');
  const direction = entry.from_radio ? 'in' : 'out';
  arrow.className = `arrow arrow-${direction}`;
  arrow.textContent = direction === 'in' ? '←' : '→';
  arrow.title = direction === 'in' ? 'from radio' : 'to radio';

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
    freqAxisMaxAmpEl: document.getElementById(`quality-${prefix}-freq-max-amp`),
    freqAxisMidAmpEl: document.getElementById(`quality-${prefix}-freq-mid-amp`),
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
// signal they actually have.
function updateFreqAxisLabels(st) {
  const maxFreq = Number(st.freqRangeInput.value);
  st.freqRangeValEl.textContent = `${maxFreq} Hz`;
  const fmt = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${Math.round(hz)}`);
  st.freqAxisEls[0].textContent = fmt(maxFreq * 0.25);
  st.freqAxisEls[1].textContent = fmt(maxFreq * 0.5);
  st.freqAxisEls[2].textContent = fmt(maxFreq * 0.75);
  st.freqAxisEls[3].textContent = `${fmt(maxFreq)} Hz`;
  if (st.freqAxisMaxAmpEl) st.freqAxisMaxAmpEl.textContent = `${fmt(maxFreq)} Hz`;
  if (st.freqAxisMidAmpEl) st.freqAxisMidAmpEl.textContent = fmt(maxFreq * 0.5);
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

// Simple scrolling waterfall: shift the existing image left by 1px each
// frame edge-in via drawImage-of-self, then paint one new column of pixels
// on the right from the current spectrum. Column-wise (not row-wise like
// GLSpectrogram's texture) since that's the cheap direction for a plain
// 2D canvas — shifting whole-canvas pixel data via getImageData/putImageData
// every frame would be far more main-thread work than this page needs.
// gamma < 1 boosts faint signal into visible color range (more contrast on
// quiet passbands); gamma > 1 compresses it (less sensitive to noise floor).
function drawWaterfallColumn(canvas, data, binCount, gamma) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const n = Math.min(binCount, data.length);
  ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);
  for (let y = 0; y < h; y++) {
    const bf = (1 - y / h) * (n - 1);
    const b0 = Math.floor(bf), b1 = Math.min(b0 + 1, n - 1);
    const raw = (data[b0] * (1 - (bf - b0)) + data[b1] * (bf - b0)) / 255;
    const v = Math.pow(Math.max(0, Math.min(1, raw)), gamma);
    // turbo-ish cheap gradient: dark blue -> green -> yellow -> red
    const r = Math.round(Math.min(255, Math.max(0, 510 * (v - 0.5))));
    const g = Math.round(Math.min(255, Math.max(0, 510 * Math.min(v, 1 - v) + 60)));
    const b = Math.round(Math.min(255, Math.max(0, 255 - 510 * v)));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(w - 1, y, 1, 1);
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
  requestAnimationFrame(qualityTick);
}
requestAnimationFrame(qualityTick);

refreshStatus(true);
scanNetworks();
startStatusAutoRefresh();
