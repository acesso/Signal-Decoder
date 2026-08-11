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
  } catch (err) {
    if (!silent) showMsg(`Failed to load status: ${err.message}`, 'error');
  }
}

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

refreshStatus(true);
scanNetworks();
startStatusAutoRefresh();
