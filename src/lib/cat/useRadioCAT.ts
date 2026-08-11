// Port of src/hooks/useRadioCAT.ts (Next.js app) — Solid factory function
// instead of a React hook. Web Serial port handles, timers, counters, and
// the internal command queue are plain closure variables (no signals needed,
// nothing here drives JSX directly); `state` is the one reactive signal the
// UI reads from.

import { createSignal, onCleanup } from 'solid-js'

// Web Serial API ambient types (not yet in lib.dom.d.ts for all TS versions)
declare global {
  interface SerialPort {
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
  }
  interface SerialOptions {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    flowControl?: 'none' | 'hardware';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CATMode = 'USB' | 'LSB' | 'AM' | 'FM' | 'CW' | 'RTTY';

/** Rig dialect. 'generic' speaks plain TS-480; 'usdx-blackbrick' adds the
 *  PU7FTW custom extension commands (VO/AT/A2/NR/AG0/FW/SM/DR) and batches its poll. */
export type RigProfile = 'generic' | 'usdx-blackbrick';

/** Physical link to the radio's CAT port. 'serial' is a direct Web Serial
 *  connection (USB-serial cable into this machine). 'websocket' goes through
 *  the ESP32 CAT bridge (firmware/esp32-cat-bridge) over Wi-Fi — the bridge
 *  relays the exact same byte stream to/from the radio's UART, so the wire
 *  protocol and all the parsing/queueing below are identical either way;
 *  only how bytes get in and out of the browser differs. */
export type CATTransportKind = 'serial' | 'websocket';

export interface CATConnectionConfig {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  /** How long to wait for a reply to a single CAT command (ms) */
  timeoutMs: number;
  /** How often to poll the radio for freq/mode updates (ms) */
  pollIntervalMs: number;
  /** Enable CAT debug logging to the browser console */
  debug: boolean;
  /** Rig dialect — controls which CAT commands are available/polled */
  rigProfile: RigProfile;
  /** Physical link — defaults to 'serial' if omitted (existing callers/tests
   *  unaffected). 'websocket' requires wsUrl. */
  transport?: CATTransportKind;
  /** ws:// URL of the ESP32 CAT bridge's /cat endpoint, e.g.
   *  "ws://usdx-bridge.local/cat". Only used when transport is 'websocket'. */
  wsUrl?: string;
}

export interface RadioState {
  connected: boolean;
  frequency: number | null;
  mode: CATMode | null;
  ptt: boolean;
  error: string | null;
  /** false on SSR, true once mounted in a supporting browser */
  isSupported: boolean;
  /** uSDX BLACK_BRICK extension state — null unless rigProfile is 'usdx-blackbrick' */
  volume: number | null;
  att1: number | null;
  att2: number | null;
  nr: number | null;
  /** AGC state: 0=OFF, 1=ON (single algorithm: M0PUB fast-attack/slow-decay).
   *  Since firmware 2026-07-06 the old Fast/Slow tri-state is gone and the CAT
   *  command rejects values above 1 (echo returns the old value). */
  agc: number | null;
  /** AGC target level, 1..14 (AL command). Output peaks are held between
   *  level*256 and level*384; default 4 = the original 1024..1536 window.
   *  Higher = louder audio before the AGC clamps. */
  agcLevel: number | null;
  /** Filter bandwidth index: 0=Full, 1=3000Hz, 2=2400Hz, 3=1800Hz, 4=500Hz, 5=200Hz, 6=100Hz, 7=50Hz */
  filter: number | null;
  /** S-meter reading in dBm. Read-only — there is no corresponding setter. */
  sMeter: number | null;
  /** TX drive/power level, 0..8 (linear). */
  drive: number | null;
  /** LCD backlight: 0=off, 1=on. */
  backlight: number | null;
  /** Firmware version reported by the radio itself (FV; command, e.g. "4.01a").
   *  null until the post-connect query answers — the UI gates the PU7FTW
   *  extension controls on this instead of hardcoding a version anywhere. */
  firmwareVersion: string | null;
  /** CAT auto-report state (AI; — menu "CAT auto rep", firmware ≥4.02a).
   *  Discovered ONCE at connect (like firmwareVersion); false on older
   *  firmware (always AI0;). While true, polling stops entirely — the radio
   *  pushes settings changes and throttled S-meter telemetry itself; toggles
   *  at the rig arrive as unsolicited AIn; announces. Deliberately NOT
   *  user-controllable from the UI: it's a radio menu option, the app just
   *  discovers and follows it. */
  autoReport: boolean | null;
  /** Set when a PTT-OFF (RX;) command fails to get a confirmed RX0; reply
   *  from the radio after CONFIRM_RETRIES attempts, over the 'websocket'
   *  transport (see setPTT). This is NOT the radio's own TOT/time-out-timer
   *  safety net (TT; — a hardware-level backstop that force-unkeys
   *  regardless of CAT) — it's a faster, CAT-link-level signal that the
   *  bridge/link itself may have failed to deliver the unkey command, so
   *  the operator can react immediately (e.g. power-cycle the radio)
   *  instead of waiting on the TOT. The app keeps retrying RX; in the
   *  background even after this fires; cleared automatically the moment a
   *  confirmed RX0; comes back. Deliberately NOT cleared by setPTT(true) —
   *  arming TX again while this alarm is active would defeat its purpose. */
  pttConfirmAlarm: boolean;
}

/** PA bias PWM endpoints (see PM/PX commands) — not polled; fetched on demand. */
export interface PABias {
  /** PWM at zero drive (idle bias), 0..max-1 */
  min: number;
  /** PWM at full drive, min..255 */
  max: number;
}

/** The compile-time defaults a factory reset (SR2;) would restore — reported
 *  by the radio itself via FD; so the UI never hardcodes (or lies about) them. */
export interface FactoryDefaults {
  volume: number;
  att1: number;
  att2: number;
  nr: number;
  agc: number;
  filter: number;
  drive: number;
  backlight: number;
  paMin: number;
  paMax: number;
  mode: CATMode | null;
}

export interface RadioCATControls {
  state: () => RadioState;
  connect: (config: CATConnectionConfig) => Promise<void>;
  disconnect: () => void;
  setFrequency: (hz: number) => Promise<void>;
  setMode: (mode: CATMode) => Promise<void>;
  setPTT: (tx: boolean) => Promise<void>;
  setVolume: (n: number) => Promise<void>;
  setAtt1: (n: number) => Promise<void>;
  setAtt2: (n: number) => Promise<void>;
  setNR: (n: number) => Promise<void>;
  setAGC: (n: number) => Promise<void>;
  setAgcLevel: (n: number) => Promise<void>;
  setFilter: (n: number) => Promise<void>;
  setDrive: (n: number) => Promise<void>;
  setBacklight: (n: number) => Promise<void>;
  /** One-shot query of both PA bias endpoints (PM;PX;). Not part of the poll
   *  loop — call when opening the PA settings panel so the user sees the
   *  radio's current values before changing them. */
  getPABias: () => Promise<PABias | null>;
  /** SET one PA bias endpoint and resolve with the value the radio confirmed
   *  (its echo), or null on timeout/rejection. Firmware clamps: min < max, max ≤ 255. */
  setPABias: (which: 'min' | 'max', n: number) => Promise<number | null>;
  /** One-shot query of the TX time-out guard (TT;), 0..255 seconds, 0 =
   *  disabled. Not part of the poll loop — call when opening the advanced
   *  settings panel, same pattern as getPABias. */
  getTxTimeout: () => Promise<number | null>;
  /** SET the TX time-out guard and resolve with the radio-confirmed value
   *  (its echo, or the old value if the SET was rejected). */
  setTxTimeout: (n: number) => Promise<number | null>;
  /** Soft-restart the radio (SR; — watchdog reset, equivalent to a power
   *  cycle). Resolves true once the radio acks with SR1;. The rig drops off
   *  the wire for a few seconds while it reboots; the poll loop rides through
   *  the timeouts and picks the state back up automatically. */
  resetRadio: () => Promise<boolean>;
  /** One-shot FD; query: what a factory reset would restore. Not polled —
   *  call once when the advanced settings panel opens. */
  getFactoryDefaults: () => Promise<FactoryDefaults | null>;
  /** Factory reset (SR2;): wipes ALL stored settings (band memories,
   *  calibration included) to compile-time defaults and reboots the radio.
   *  Resolves true once the radio acks with SR2;. */
  factoryResetRadio: () => Promise<boolean>;
  /** Reference-oscillator value in Hz (si5351.fxtal, menu "Ref frq") — the
   *  frequency-calibration constant. Not polled; used by the calibration wizard. */
  getRefFreq: () => Promise<number | null>;
  /** SET the reference oscillator (14–28 MHz; firmware rejects out-of-range and
   *  echoes the old value). Resolves with the radio-confirmed value. */
  setRefFreq: (hz: number) => Promise<number | null>;
  /** One-shot GET /status against the ESP32 CAT bridge itself (Wi-Fi RSSI/
   *  SSID/uptime/client count) — a plain HTTP fetch, not a CAT command, so
   *  it works whether or not the CAT link to the radio is currently
   *  connected. Only meaningful for the 'websocket' transport; resolves null
   *  if wsUrl isn't set, the bridge doesn't answer, or the transport is
   *  'serial' (no bridge to ask). Not polled — call when the advanced
   *  settings panel's bridge section opens, same pattern as getPABias. */
  getBridgeStatus: (wsUrl: string) => Promise<BridgeStatus | null>;
  /** POST /reset against the ESP32 CAT bridge — reboots the bridge itself
   *  (not the radio). Resolves true once the bridge acknowledges the
   *  request; the bridge drops off Wi-Fi for a few seconds while it
   *  restarts. Independent of CAT connection state, same as getBridgeStatus. */
  resetBridge: (wsUrl: string) => Promise<boolean>;
  /** One-shot GET /info: the bridge's firmware version + capability list.
   *  Call once when the bridge panel opens (alongside getBridgeStatus) to
   *  decide which of the controls below to show — an older bridge simply
   *  won't report "backlight"/"wifi_config" in its features, so gate on
   *  that instead of comparing version strings. Resolves null on the same
   *  conditions as getBridgeStatus. */
  getBridgeInfo: (wsUrl: string) => Promise<BridgeInfo | null>;
  /** POST /backlight — sets the bridge's LCD backlight PWM duty (0..255,
   *  see LCD_BACKLIGHT_MAX_DUTY in the firmware) immediately AND persists it
   *  as the new boot default. Only meaningful if getBridgeInfo().features
   *  includes "backlight". Resolves the duty the bridge confirmed (its
   *  echo) and whether the save to flash succeeded, or null on failure. */
  setBridgeBacklight: (wsUrl: string, duty: number) => Promise<{ duty: number; saved: boolean } | null>;
  /** POST /wifi-config — persists a new Wi-Fi SSID/password to the bridge's
   *  NVS flash and reboots it to apply (the bridge drops off the current
   *  Wi-Fi network entirely once it restarts onto the new one — this
   *  resolves true once the bridge ACKS the save, not once it's actually
   *  reconnected on the new network, since the caller has no way to reach
   *  it there without knowing the new network's own address). Only
   *  meaningful if getBridgeInfo().features includes "wifi_config". */
  setBridgeWifiConfig: (wsUrl: string, ssid: string, password: string) => Promise<boolean>;
  /** POST /contrast — sets the bridge's LCD contrast (PCD8544 Vop register,
   *  0..127, see LCD_CONTRAST_MAX in the firmware) immediately AND persists
   *  it as the new boot default. Pure software (same SPI bus already
   *  driving the framebuffer) — no extra hardware needed. Only meaningful
   *  if getBridgeInfo().features includes "contrast". Resolves the vop the
   *  bridge confirmed and whether the save to flash succeeded, or null on failure. */
  setBridgeContrast: (wsUrl: string, vop: number) => Promise<{ vop: number; saved: boolean } | null>;
  /** POST /cat-baud — sets the bridge's CAT UART baud rate (one of
   *  9600/19200/38400/57600) immediately, no reboot needed, AND persists it
   *  to the bridge's NVS as the new boot default. There's no CAT command
   *  that reports or changes the radio's own baud (it's a local-menu-only
   *  setting there), so this exists purely for the operator to keep the
   *  bridge in sync by hand after changing it on the radio. Only meaningful
   *  if getBridgeInfo().features includes "cat_baud". */
  setBridgeCatBaud: (wsUrl: string, baud: number) => Promise<{ baud: number; saved: boolean } | null>;
}

/** Snapshot of the ESP32 CAT bridge's own status — distinct from RadioState,
 *  which is the radio's state as seen through the bridge. Sourced from the
 *  bridge's GET /status (see firmware/esp32-cat-bridge/main/http_control.c). */
export interface BridgeStatus {
  /** 'ap_fallback' means the bridge couldn't join its configured Wi-Fi
   *  network and is now broadcasting its own recovery AP at 192.168.4.1
   *  (see wifi_net.c) — join that AP directly to fix the settings. */
  wifiState: 'connected' | 'connecting' | 'disconnected' | 'ap_fallback';
  ssid: string;
  /** Live RSSI in dBm, refreshed at request time by the bridge (not a stale poll). */
  rssi: number;
  ip: string;
  wsClients: number;
  wsMaxClients: number;
  /** Whether the bridge has heard from the radio itself recently — the same
   *  "RIG:link/silent" signal shown on the bridge's own LCD. */
  radioLinked: boolean;
  /** Current CAT UART baud rate — one of 9600/19200/38400/57600 (the uSDX
   *  firmware's own CAT_BAUD menu options). Only meaningful if
   *  getBridgeInfo().features includes "cat_baud". */
  catBaud: number;
  uptimeSeconds: number;
}

/** Bridge firmware version + capability list, from GET /info. Features are
 *  additive-only on the firmware side (see bridge_config.h's versioning
 *  note) — the web app should always gate controls on feature PRESENCE,
 *  never assume an absent feature will show up if you just wait/retry. */
export interface BridgeInfo {
  firmwareVersion: string;
  features: string[];
}

// ws://host:port/cat -> http://host:port — the bridge's REST endpoints live
// on the same httpd instance as the WebSocket, just plain HTTP routes.
function bridgeHttpBase(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

// ── Kenwood TS-series CAT protocol ───────────────────────────────────────────
// Query freq:  FA;   → FA00014225000;  (11-digit Hz, VFO A)
// Set freq:    FA00014225000;           (no echo)
// Query mode:  MD;   → MD2;            (1=LSB 2=USB 3=CW 4=FM 5=AM 6=RTTY)
// Set mode:    MD2;                     (no echo)
// PTT on:      TX;                      (no echo)
// PTT off:     RX;                      (no echo)

// ── uSDX BLACK_BRICK — PU7FTW custom extensions ────────────────────────
// Not part of the TS-480 spec. All SET commands echo the new value as a GET
// reply, and are safe to include in a multi-command string (e.g. "VO;AT;A2;").
// Query volume: VO;    → VOn;      (-1..16, -1 = mute)
// Set volume:   VOn;   → VOn;
// Query ATT1:   AT;    → ATn;      (0..7)
// Set ATT1:     ATn;   → ATn;
// Query ATT2:   A2;    → A2n;      (0..16)
// Set ATT2:     A2n;   → A2n;
// Query NR:     NR;    → NRn;      (0..8, 0 = off)
// Set NR:       NRn;   → NRn;
// Query AGC:    AG0;   → AG0n;     (0=OFF, 1=ON — single M0PUB algorithm since
//                                   firmware 2026-07-06; SET rejects n>1 and
//                                   echoes the old value)
// Set AGC:      AG0n;  → AG0n;     (n in 0..1)
// Query AGC level: AL; → ALn;      (1..14 — AGC target window: peaks held in
// Set AGC level:  ALn; → ALn;       [n*256..n*384], default 4; out-of-range
//                                   SETs are ignored, echo returns old value)
// Query filter: FW;    → FWn;      (0=Full 1=3000 2=2400 3=1800 4=500 5=200 6=100 7=50 Hz)
// Set filter:   FWn;   → FWn;      (n in 0..7)
// Query S-meter: SM;   → SMn;      (signed dBm, read-only — no SM SET. During TX
//                                   replies an empty "SM;": no RX signal to measure.
//                                   With auto-report on, the firmware also PUSHES
//                                   SMn; on change, ≤1 frame/300ms — the app's
//                                   S-meter stays live without any polling.)
// Query TX drive: DR;  → DRn;      (0..8, linear)
// Set TX drive:   DRn; → DRn;
// Query backlight: BL; → BLn;      (0=off, 1=on. Physical effect confirmed after
//                                   the 2026-07-04 firmware fix moved BACKLIGHT_PIN
//                                   to the correct pin, PD3.)
// Set backlight:   BLn; → BLn;
// Restart radio:  SR;  → SR1;      (acks, then watchdog-resets the MCU — a full
//                                   soft power-cycle; radio is offline ~2-3s and
//                                   re-announces with its boot IF; frame)
// Factory reset:  SR2; → SR2;      (acks, invalidates the stored settings
//                                   version and reboots — the boot-time version
//                                   mismatch then rewrites ALL params with
//                                   compile-time defaults: full wipe incl. band
//                                   memories and ref-freq calibration)
// Ref frequency: XF; → XFnnnnnnnn;  (si5351.fxtal in Hz, the "Ref frq"
// Set ref freq:  XFnnnnnnnn; → echo  calibration value; SET accepts 14–28 MHz,
//                                   applies live (retune) and saves to EEPROM;
//                                   out-of-range echoes the old value. Used by
//                                   the calibration wizard — never polled.)
// Query factory defaults: FD; → FD<vol>,<att>,<att2>,<nr>,<agc>,<filt>,<drive>,
//                                <backlight>,<pwm_min>,<pwm_max>,<md>;
//                                   (one frame, values snapshotted at boot from
//                                   the firmware's real initializers; md is the
//                                   Kenwood mode digit. Not polled — fetched
//                                   once when the advanced panel opens.)
// Query PA bias:  PM; → PMn;  PX; → PXn;   (PWM lookup-table endpoints: PM = idle
// Set PA bias:    PMn;/PXn;  → echo         bias 0..max-1, PX = full-drive 0..255,
//                                   min < max enforced by firmware; out-of-range
//                                   SETs are ignored and the echo returns the old
//                                   value. NOT polled — changing them rebuilds the
//                                   PA PWM LUT, so they're fetched/set on demand
//                                   from the PA settings panel only.)
// Query firmware version: FV; → FV4.01a; (read-only — the app gates extension
//                                   features on this instead of hardcoding)
// Query auto-report: AI; → AIn;    (0=off 1=on — menu "CAT auto rep", firmware
// Set auto-report: AI0;/AI1; → echo ≥4.02a. When on, the radio pushes the
//                                   standard GET reply frame for any setting
//                                   changed at the rig itself PLUS throttled
//                                   S-meter telemetry (≤1 frame/300ms, on
//                                   change), and the app stops polling
//                                   entirely. Queried ONCE at connect time —
//                                   older firmware always answers AI0; and the
//                                   app keeps long-polling: retro-compatible.
//                                   The app never SETs it — it's a radio menu
//                                   option; toggling it at the rig is announced
//                                   with an unsolicited AIn; frame, and a
//                                   silence watchdog re-asks AI; only if
//                                   nothing at all has arrived for a while.)
// Query TX timeout: TT; → TTn;    (0..255 s, 0 = disabled — TOT guardrail that
// Set TX timeout:  TTn; → TTn;     force-unkeys a stuck TX; out-of-range SETs
//                                   are ignored, echo returns the old value.
//                                   NOT polled — fetched/set on demand from
//                                   the advanced settings panel only.)
// The firmware supports serialized/batched queries in one write, e.g.
// "FA;MD;AG0;FW;VO;AT;A2;NR;SM;DR;BL;AL;" — replies come back concatenated in the same order.

// Used only while CAT auto-report is off/unknown — with auto-report active the
// radio pushes every change (settings + throttled S-meter) and no poll runs.
const BLACKBRICK_POLL_CMDS = ['FA;', 'MD;', 'AG0;', 'FW;', 'VO;', 'AT;', 'A2;', 'NR;', 'SM;', 'DR;', 'BL;', 'AL;'];

const KENWOOD_MODE_MAP: Record<string, CATMode> = {
  '1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM', '6': 'RTTY',
  '7': 'CW',  '9': 'RTTY',
};

const CAT_MODE_TO_KENWOOD: Record<CATMode, string> = {
  LSB: '1', USB: '2', CW: '3', FM: '4', AM: '5', RTTY: '6',
};

// ── Serial command queue ──────────────────────────────────────────────────────

interface QueueEntry {
  bytes: Uint8Array;
  /** 2-char response prefixes expected, in order; null = fire-and-forget.
   *  Multiple prefixes = a serialized/batched command string (e.g. "FA;MD;VO;")
   *  whose replies are collected and joined before resolving. */
  prefixes: string[] | null;
  /** Replies collected so far, for entries with prefixes.length > 1 */
  collected: string[];
  isPoll: boolean;
  resolve: (resp: string) => void;
  reject:  (err: Error)   => void;
  timer:   ReturnType<typeof setTimeout> | null;
}

// How long after a user set-command to suppress poll overwrites for that field.
const SET_GRACE_MS = 1500;

// Wait mode (auto-report active): if NOTHING has arrived from the radio for
// this long, one AI; query re-checks the link and the auto-report flag — the
// only way to get stranded in wait mode is an AI0 announce (feature turned
// off at the rig) lost to line noise, and this recovers from it. It is not a
// poll: on a live band the throttled S-meter pushes keep resetting the clock.
const SILENCE_RECHECK_MS = 15_000;

// ── Factory ──────────────────────────────────────────────────────────────────

export function useRadioCAT(): RadioCATControls {
  const [state, setState] = createSignal<RadioState>({
    connected: false, frequency: null, mode: null,
    ptt: false, error: null,
    isSupported: typeof navigator !== 'undefined' && 'serial' in navigator,
    volume: null, att1: null, att2: null, nr: null,
    agc: null, agcLevel: null, filter: null, sMeter: null, drive: null,
    backlight: null, firmwareVersion: null, autoReport: null,
    pttConfirmAlarm: false,
  });

  let port:      SerialPort | null = null;
  // Minimal shape both transports satisfy — a real WritableStreamDefaultWriter
  // for Web Serial, or a small WebSocket-backed adapter (see openWebSocket
  // below). Everything downstream (drainQueue/disconnect) only ever calls
  // .write()/.close() — close() is a no-op for the WS adapter since tearing
  // down the WebSocket itself (via the `ws` variable) is the real teardown.
  let writer:    { write(data: Uint8Array): Promise<void>; close(): Promise<void> } | null = null;
  let reader:    ReadableStreamDefaultReader<Uint8Array> | null = null;
  let ws:        WebSocket | null = null;
  let rxBuf = '';
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollRunning = false;
  let timeoutMs      = 50;
  let pollIntervalMs = 100;
  let debug = false;
  let rigProfile: RigProfile = 'generic';
  // Hoisted from connect()'s local so the confirm-with-retry setters below
  // can gate on it — confirmation is only meaningful/enabled over the
  // bridge ('websocket'): a direct 'serial' connection already IS the CAT
  // link, so there's no separate bridge hop that could silently swallow a
  // command the way a flaky Wi-Fi/WebSocket relay could.
  let transportKind: CATTransportKind = 'serial';
  // True while the radio's CAT auto-report (AI) is on — polling stops
  // entirely; the radio pushes settings changes and throttled SM telemetry.
  let autoReportActive = false;
  // Timestamp of the last bytes received — drives the wait-mode silence watchdog.
  let lastRxAt = 0;
  const encoder = new TextEncoder();

  let queue: QueueEntry[] = [];
  let inflight: QueueEntry | null = null;
  // True while a deliberate disconnect() is tearing the port down — lets the
  // read loop distinguish "user clicked Disconnect" from "port vanished".
  let closing = false;

  const lastSet = {
    frequency: 0, mode: 0, volume: 0, att1: 0, att2: 0, nr: 0, agc: 0, agcLevel: 0, filter: 0, drive: 0, backlight: 0,
  };

  const log = (level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]) => {
    if (!debug && level === 'debug') return;
    console[level]('[CAT]', ...args);
  };

  // ── Queue machinery ───────────────────────────────────────────────────────

  const drainQueue = () => {
    // If no writer, reject all queued commands immediately rather than letting them hang
    if (!writer) {
      const err = new Error('CAT not connected');
      while (queue.length > 0) queue.shift()!.reject(err);
      return;
    }
    if (inflight || queue.length === 0) return;
    const entry = queue.shift()!;
    inflight = entry;

    const cmdStr = new TextDecoder().decode(entry.bytes).trim();
    const qLen = queue.length; // already shifted, so this is remaining

    if (entry.prefixes === null) {
      log('debug', 'write ←', cmdStr, `[q:${qLen}]`);
      writer.write(entry.bytes).then(() => {
        entry.resolve('');
        inflight = null;
        drainQueue();
      }).catch(err => {
        log('warn', 'write error:', err);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
        inflight = null;
        drainQueue();
      });
      return;
    }

    // Batched multi-command strings return one reply per sub-command from the
    // same read window, but need proportionally more time for the radio to
    // process and emit all of them.
    const entryTimeoutMs = timeoutMs * entry.prefixes.length;
    log('debug', 'query ←', cmdStr, `(timeout ${entryTimeoutMs}ms) [q:${qLen}]`);

    entry.timer = setTimeout(() => {
      // Flush any partial rx data — a timeout means the radio's response was
      // lost or garbled; stale bytes in the buffer would corrupt the next reply.
      if (rxBuf.length > 0) {
        log('debug', 'timeout: flushing rx buffer:', JSON.stringify(rxBuf));
        rxBuf = '';
      }
      log('debug', 'timeout for', cmdStr);
      inflight = null;
      entry.resolve('__timeout__');
      drainQueue();
    }, entryTimeoutMs);

    writer.write(entry.bytes).catch(err => {
      if (entry.timer) clearTimeout(entry.timer);
      log('warn', 'write error during query:', err);
      inflight = null;
      entry.reject(err instanceof Error ? err : new Error(String(err)));
      drainQueue();
    });
  };

  const handleResponse = (msg: string) => {
    const inf = inflight;
    if (!inf || inf.prefixes === null) {
      // Nothing awaited — auto-report frame (radio-side change), a SET echo,
      // or the radio's boot IF; announce. Apply it if it parses as a report.
      if (applyReportFrame(msg)) log('debug', 'report →', msg.trim());
      else log('debug', 'unsolicited →', msg.trim());
      return;
    }
    const expected = inf.prefixes[inf.collected.length];
    if (msg.substring(0, 2) !== expected) {
      // Not the awaited reply — the radio can interleave an auto-report frame
      // between batch replies (its report pass runs between received chars).
      if (applyReportFrame(msg)) log('debug', 'report (interleaved) →', msg.trim(), '(waiting for', expected + ')');
      else log('debug', 'unexpected →', msg.trim(), '(waiting for', expected + ')');
      return;
    }
    inf.collected.push(msg);
    if (inf.collected.length < inf.prefixes.length) {
      log('debug', 'partial →', msg.trim(), `[${inf.collected.length}/${inf.prefixes.length}]`);
      return;
    }
    log('debug', 'response →', inf.collected.join(''), `[q:${queue.length}]`);
    if (inf.timer) clearTimeout(inf.timer);
    inflight = null;
    inf.resolve(inf.collected.join(''));
    drainQueue();
  };

  const dropQueuedPolls = () => {
    const dropped = queue.filter(e => e.isPoll);
    if (dropped.length) log('debug', 'dropping', dropped.length, 'queued poll(s)');
    queue = queue.filter(e => !e.isPoll);
    for (const e of dropped) e.resolve('__dropped__');
  };

  const query = (cmd: string, isPoll = false): Promise<string> => {
    // Deduplicate: if an identical command is already queued, skip it
    if (queue.some(e => e.isPoll === isPoll && new TextDecoder().decode(e.bytes) === cmd)) {
      return Promise.resolve('__dedup__');
    }
    return new Promise<string>((resolve, reject) => {
      queue.push({
        bytes:  encoder.encode(cmd),
        prefixes: [cmd.substring(0, 2)],
        collected: [],
        isPoll, resolve, reject, timer: null,
      });
      drainQueue();
    });
  };

  // Sends a serialized multi-command string (e.g. "FA;MD;VO;") in a single
  // write and collects each reply in order, joined back into one string.
  // Used to batch the poll into one round-trip instead of one per field.
  const queryBatch = (cmds: string[], isPoll = false): Promise<string> => {
    const cmdStr = cmds.join('');
    if (queue.some(e => e.isPoll === isPoll && new TextDecoder().decode(e.bytes) === cmdStr)) {
      return Promise.resolve('__dedup__');
    }
    return new Promise<string>((resolve, reject) => {
      queue.push({
        bytes:  encoder.encode(cmdStr),
        prefixes: cmds.map(c => c.substring(0, 2)),
        collected: [],
        isPoll, resolve, reject, timer: null,
      });
      drainQueue();
    });
  };

  const write = (cmd: string): Promise<void> => {
    dropQueuedPolls();
    return new Promise<void>((resolve, reject) => {
      queue.push({
        bytes:  encoder.encode(cmd),
        prefixes: null, collected: [],
        isPoll: false,
        resolve: () => resolve(), reject, timer: null,
      });
      drainQueue();
    });
  };

  // ── Confirmed SET: send, verify the radio actually applied it, retry ────────
  // Over the 'websocket' transport, the browser<->radio path has an extra
  // hop (the ESP32 bridge) that a plain write() can't see fail — a dropped
  // Wi-Fi packet or a bridge hiccup would otherwise leave the UI showing a
  // value the radio never actually received. confirmedSet() closes that gap
  // by re-querying the radio after every SET and only trusting the UI state
  // to the readback, retrying the whole SET+verify cycle on mismatch/timeout.
  //
  // Over 'serial' (a direct Web Serial connection), the browser already IS
  // one end of the CAT link — there's no extra hop to fail silently — so
  // this still runs (uniform behavior, and it's cheap: one extra query) but
  // failures there would indicate a real radio/cable problem worth surfacing
  // the same way.
  const CONFIRM_RETRIES = 3;

  // Generic confirm-with-retry, two shapes depending on whether the SET
  // command itself carries a usable reply:
  //   - hasEcho=true:  the SET is sent via query() and its OWN reply is what
  //     `accept()` checks (e.g. PU7FTW extension commands, which echo the
  //     effective value in the same frame — VOn; -> VOn;).
  //   - hasEcho=false: FA/MD/TX/RX have no such echo (per the Kenwood spec —
  //     see the protocol notes above), so the SET is sent via write() (fire-
  //     and-forget, no wait) and confirmation comes from a SEPARATE
  //     `verifyCmd` query afterward, checked by `accept()`.
  // Retries the WHOLE cycle (SET + verify) up to CONFIRM_RETRIES times.
  async function confirmedSet(
    sendCmd: string,
    opts: { hasEcho: true } | { hasEcho: false; verifyCmd: string },
    accept: (reply: string) => boolean,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= CONFIRM_RETRIES; attempt++) {
      let reply = '';
      try {
        reply = opts.hasEcho ? await query(sendCmd) : (await write(sendCmd), await query(opts.verifyCmd));
      } catch { reply = ''; }
      if (reply && reply !== '__timeout__' && reply !== '__disconnected__' && accept(reply)) return true;
      log('warn', `confirmedSet: ${sendCmd} → "${reply}" did not confirm (attempt ${attempt}/${CONFIRM_RETRIES})`);
    }
    return false;
  }

  // ── WebSocket transport (ESP32 CAT bridge) ──────────────────────────────
  // Bridges a binary WebSocket into the same writer/reader shapes the serial
  // path uses, so startReadLoop/drainQueue below need no transport-specific
  // branching — they just see "something with .write()" and "something with
  // .read()". The bridge itself (firmware/esp32-cat-bridge) is byte-
  // transparent: it relays whatever comes over the socket straight to the
  // radio's UART and back, so the Kenwood frames flowing through here are
  // identical to the Web Serial path.

  const openWebSocket = (url: string): Promise<{
    socket: WebSocket;
    writer: { write(data: Uint8Array): Promise<void>; close(): Promise<void> };
    reader: ReadableStreamDefaultReader<Uint8Array>;
  }> => {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';

      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      });

      const onOpen = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onErrorBeforeOpen);
        const socketWriter = {
          write: (data: Uint8Array): Promise<void> => {
            if (socket.readyState !== WebSocket.OPEN) {
              return Promise.reject(new Error('CAT bridge socket not open'));
            }
            // WebSocket.send()'s TS signature wants an ArrayBuffer-backed view
            // specifically (not the wider ArrayBufferLike | SharedArrayBuffer
            // union Uint8Array's type allows) — slice() copies into a fresh
            // plain ArrayBuffer, which also protects against `data`'s
            // underlying buffer being mutated/reused by the caller (the queue
            // never reuses buffers today, but this keeps the transport safe
            // regardless).
            socket.send(data.slice().buffer);
            return Promise.resolve();
          },
          close: (): Promise<void> => Promise.resolve(), // real teardown is socket.close() in disconnect()
        };
        resolve({ socket, writer: socketWriter, reader: stream.getReader() });
      };
      const onErrorBeforeOpen = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onErrorBeforeOpen);
        reject(new Error('Could not connect to CAT bridge at ' + url));
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onErrorBeforeOpen);

      // These fire only after onOpen has resolved (post-handshake) — the
      // stream controller exists by construction (start() runs synchronously
      // during `new ReadableStream(...)` above, before this listener can fire).
      socket.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
        if (data && streamController) streamController.enqueue(data);
      });
      socket.addEventListener('close', () => {
        try { streamController?.close(); } catch { /* already closed */ }
      });
      socket.addEventListener('error', () => {
        // Post-open errors surface as a stream error so startReadLoop's catch
        // block logs and its finally block runs the same "connection lost"
        // path used for a dropped serial port.
        try { streamController?.error(new Error('CAT bridge WebSocket error')); } catch { /* already closed */ }
      });
    });
  };

  // ── Serial read loop ─────────────────────────────────────────────────────

  const startReadLoop = (r: ReadableStreamDefaultReader<Uint8Array>) => {
    const dec = new TextDecoder();
    (async () => {
      log('debug', 'read loop started');
      try {
        for (;;) {
          const { value, done } = await r.read();
          if (done) { log('debug', 'read loop: stream done'); break; }
          lastRxAt = Date.now();
          rxBuf += dec.decode(value, { stream: true });
          // Guard against unbounded growth from a radio sending malformed data
          // with no ';' terminator — a Kenwood response is at most ~20 bytes.
          if (rxBuf.length > 256) {
            log('warn', 'rx buffer overflow, flushing:', JSON.stringify(rxBuf));
            rxBuf = '';
          }
          let i: number;
          while ((i = rxBuf.indexOf(';')) !== -1) {
            const msg = rxBuf.slice(0, i + 1);
            rxBuf = rxBuf.slice(i + 1);
            handleResponse(msg);
          }
        }
      } catch (e) {
        log('debug', 'read loop ended:', e);
      } finally {
        // The loop only exits when the stream ends. If nobody called
        // disconnect(), the link was yanked out from under us (USB unplugged/
        // device re-enumerated for serial; bridge rebooted or Wi-Fi dropped
        // for the WebSocket transport) — tear down cleanly and surface a
        // friendly warning instead of an unhandled NetworkError.
        if (!closing && (port || ws)) {
          log('warn', ws
            ? 'CAT bridge connection lost (Wi-Fi dropped / bridge rebooted)'
            : 'serial port lost unexpectedly (cable unplugged / device re-enumerated)');
          disconnect();
          setState(prev => ({
            ...prev,
            error: ws
              ? 'Radio connection lost — CAT bridge unreachable. Reconnect when it’s back.'
              : 'Radio connection lost — CAT cable unplugged or port closed. Reconnect when it’s back.',
          }));
        }
      }
    })();
  };

  // ── Parse helpers ────────────────────────────────────────────────────────

  const parseFrequency = (resp: string): number | null => {
    const m = resp.match(/^FA(\d+);$/);
    if (!m) return null;
    const hz = parseInt(m[1], 10);
    return hz > 0 ? hz : null;
  };

  const parseMode = (resp: string): CATMode | null => {
    const m = resp.match(/^MD([0-9A-Fa-f]);$/);
    return m ? (KENWOOD_MODE_MAP[m[1].toUpperCase()] ?? null) : null;
  };

  const parseIntField = (resp: string, prefix: string): number | null => {
    const m = resp.match(new RegExp(`^${prefix}(-?\\d+);$`));
    return m ? parseInt(m[1], 10) : null;
  };

  // ── CAT auto-report (AI) ─────────────────────────────────────────────────

  // Record an AI answer/announce and switch the poll loop's mode accordingly.
  const applyAutoReportState = (active: boolean) => {
    if (active !== autoReportActive) {
      autoReportActive = active;
      log('info', active
        ? 'CAT auto-report on (AI1) — polling stops, radio pushes changes'
        : 'CAT auto-report off (AI0) — falling back to full long poll');
      // Entering wait mode: query the complete current state ONCE — the
      // pushes only cover changes from here on, and at connect time the AI
      // discovery usually wins the race against the first long poll, so
      // without this the UI would start empty. (Leaving wait mode needs
      // nothing: the resumed long poll refreshes everything on its own.)
      if (active) void refreshBlackbrickState(false);
    }
    setState(prev => prev.autoReport === active ? prev : ({ ...prev, autoReport: active }));
  };

  // Apply an unsolicited GET-format frame pushed by the radio (firmware
  // ≥4.02a auto-report, or a SET echo we didn't await). Returns true if the
  // frame was recognized as a state report. Fields we just SET ourselves are
  // ignored for SET_GRACE_MS — the UI already shows the target value and a
  // trailing echo of an older SET must not flicker it backwards.
  const applyReportFrame = (msg: string): boolean => {
    const graceOver = (key: keyof typeof lastSet) => Date.now() - lastSet[key] > SET_GRACE_MS;
    const freq = parseFrequency(msg);
    if (freq !== null) {
      if (graceOver('frequency')) setState(prev => ({ ...prev, frequency: freq }));
      return true;
    }
    const mode = parseMode(msg);
    if (mode !== null) {
      if (graceOver('mode')) setState(prev => ({ ...prev, mode }));
      return true;
    }
    if (msg.startsWith('AI')) {
      const v = parseIntField(msg, 'AI');
      if (v === null) return false;
      applyAutoReportState(v >= 1);
      return true;
    }
    if (msg.startsWith('AG0')) {
      const v = parseIntField(msg, 'AG0');
      if (v === null) return false;
      if (graceOver('agc')) setState(prev => ({ ...prev, agc: v }));
      return true;
    }
    if (msg.startsWith('SM')) {
      // Pushed S-meter telemetry (throttled by the firmware) — read-only,
      // no set-grace needed; an empty "SM;" is never pushed, only polled.
      const v = parseIntField(msg, 'SM');
      if (v === null) return false;
      setState(prev => ({ ...prev, sMeter: v }));
      return true;
    }
    const numFields = [
      ['VO', 'volume'], ['AT', 'att1'], ['A2', 'att2'], ['NR', 'nr'], ['FW', 'filter'],
      ['DR', 'drive'], ['BL', 'backlight'], ['AL', 'agcLevel'],
    ] as const;
    for (const [prefix, key] of numFields) {
      if (!msg.startsWith(prefix)) continue;
      const v = parseIntField(msg, prefix);
      if (v === null) return false;
      if (graceOver(key)) setState(prev => ({ ...prev, [key]: v }));
      return true;
    }
    return false;
  };

  // One batched query of every polled field, applied to state. Runs on every
  // long-poll cycle, and ONCE when entering auto-report wait mode — the pushes
  // only cover *changes*, so wait mode must start from a full snapshot.
  const refreshBlackbrickState = async (isPoll: boolean) => {
    const now = Date.now();
    const ls  = lastSet;
    // Serialized batch — one round-trip for every polled field instead
    // of one per command, per the firmware's multi-command support.
    let resp = '';
    try { resp = await queryBatch(BLACKBRICK_POLL_CMDS, isPoll); } catch { resp = ''; }
    const frames = resp.split(';').filter(Boolean).map(f => f + ';');
    const byPrefix = new Map<string, string>();
    for (const f of frames) byPrefix.set(f.substring(0, 2), f);

    // AG0 replies as "AG0n;" — prefix is "AG", not "AG0"
    const agcRaw = [...byPrefix.entries()].find(([k]) => k === 'AG')?.[1] ?? null;
    const freq      = byPrefix.has('FA') ? parseFrequency(byPrefix.get('FA')!) : null;
    const mode      = byPrefix.has('MD') ? parseMode(byPrefix.get('MD')!) : null;
    const agc       = agcRaw ? parseIntField(agcRaw, 'AG0') : null;
    const filter    = byPrefix.has('FW') ? parseIntField(byPrefix.get('FW')!, 'FW') : null;
    const volume    = byPrefix.has('VO') ? parseIntField(byPrefix.get('VO')!, 'VO') : null;
    const att1      = byPrefix.has('AT') ? parseIntField(byPrefix.get('AT')!, 'AT') : null;
    const att2      = byPrefix.has('A2') ? parseIntField(byPrefix.get('A2')!, 'A2') : null;
    const nr        = byPrefix.has('NR') ? parseIntField(byPrefix.get('NR')!, 'NR') : null;
    // SM is special: during TX the firmware replies an empty "SM;" (nothing to
    // measure — the ADC samples the mic). Frame present but valueless → reading
    // is genuinely unavailable (null). Frame absent → dropped by line noise,
    // keep the previous value.
    const smRaw     = byPrefix.get('SM') ?? null;
    const sMeter    = smRaw ? parseIntField(smRaw, 'SM') : null;
    const drive     = byPrefix.has('DR') ? parseIntField(byPrefix.get('DR')!, 'DR') : null;
    const backlight = byPrefix.has('BL') ? parseIntField(byPrefix.get('BL')!, 'BL') : null;
    const agcLevel  = byPrefix.has('AL') ? parseIntField(byPrefix.get('AL')!, 'AL') : null;

    log('debug', isPoll ? 'poll(batch)' : 'state refresh', '— freq:', freq, 'mode:', mode, 'agc:', agc, 'agcLvl:', agcLevel, 'filt:', filter,
      'vol:', volume, 'att1:', att1, 'att2:', att2, 'nr:', nr, 'sm:', sMeter, 'drive:', drive, 'bl:', backlight, `[q:${queue.length}]`);

    setState(prev => ({
      ...prev,
      frequency: freq   !== null && (now - ls.frequency > SET_GRACE_MS) ? freq   : prev.frequency,
      mode:      mode   !== null && (now - ls.mode      > SET_GRACE_MS) ? mode   : prev.mode,
      agc:       agc    !== null && (now - ls.agc       > SET_GRACE_MS) ? agc    : prev.agc,
      agcLevel:  agcLevel !== null && (now - ls.agcLevel > SET_GRACE_MS) ? agcLevel : prev.agcLevel,
      filter:    filter !== null && (now - ls.filter    > SET_GRACE_MS) ? filter : prev.filter,
      volume:    volume !== null && (now - ls.volume    > SET_GRACE_MS) ? volume : prev.volume,
      att1:      att1   !== null && (now - ls.att1      > SET_GRACE_MS) ? att1   : prev.att1,
      att2:      att2   !== null && (now - ls.att2      > SET_GRACE_MS) ? att2   : prev.att2,
      nr:        nr     !== null && (now - ls.nr        > SET_GRACE_MS) ? nr     : prev.nr,
      drive:     drive  !== null && (now - ls.drive     > SET_GRACE_MS) ? drive  : prev.drive,
      backlight: backlight !== null && (now - ls.backlight > SET_GRACE_MS) ? backlight : prev.backlight,
      // sMeter is read-only telemetry — no grace period needed, always take the latest poll value.
      sMeter:    smRaw !== null ? sMeter : prev.sMeter,
    }));
  };

  // ── Poll loop — self-scheduling setTimeout so the next poll only fires
  // after the current one fully completes. This prevents poll buildup when
  // the radio is slow or the USB-serial stack stalls. ─────────────────────

  const schedulePoll = () => {
    if (pollTimer !== null) return; // already scheduled
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!writer || pollRunning) {
        // Port gone or previous poll still running — reschedule and skip
        schedulePoll();
        return;
      }
      pollRunning = true;
      try {
        if (queue.some(e => !e.isPoll)) {
          // A user command (PTT/freq/mode) is pending — skip this poll cycle
          return;
        }
        const now = Date.now();
        const ls  = lastSet;

        if (rigProfile === 'usdx-blackbrick' && autoReportActive) {
          // Wait mode: no polling at all — the radio pushes settings changes
          // and throttled SM telemetry, handled by applyReportFrame() in the
          // read path. Only the silence watchdog runs here (see
          // SILENCE_RECHECK_MS): one AI; query after total radio silence.
          if (Date.now() - lastRxAt > SILENCE_RECHECK_MS) {
            log('debug', 'wait mode: radio silent, re-checking AI');
            let resp = '';
            try { resp = await query('AI;', true); } catch { resp = ''; }
            const v = parseIntField(resp, 'AI');
            if (v !== null) applyAutoReportState(v >= 1);
            else lastRxAt = Date.now(); // no answer — back off a full window rather than re-asking every tick; a lost port is handled by the read loop
          }
          return;
        }

        if (rigProfile === 'usdx-blackbrick') {
          await refreshBlackbrickState(true);
        } else {
          const safeQuery = async (cmd: string): Promise<string> => {
            try { return await query(cmd, true); } catch { return ''; }
          };
          const fr  = await safeQuery('FA;');
          const mr  = await safeQuery('MD;');
          const freq = parseFrequency(fr);
          const mode = parseMode(mr);
          log('debug', 'poll — freq:', freq, 'mode:', mode, `[q:${queue.length}]`);
          if (freq !== null || mode !== null) {
            setState(prev => ({
              ...prev,
              frequency: freq !== null && (now - ls.frequency > SET_GRACE_MS) ? freq : prev.frequency,
              mode:      mode !== null && (now - ls.mode      > SET_GRACE_MS) ? mode : prev.mode,
            }));
          }
        }
      } finally {
        pollRunning = false;
        // Only reschedule if still connected
        if (writer) schedulePoll();
      }
    }, pollIntervalMs);
  };

  // ── Public API ───────────────────────────────────────────────────────────

  function disconnect() {
    log('info', 'disconnecting');
    closing = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    pollRunning = false;
    if (inflight) {
      if (inflight.timer) clearTimeout(inflight.timer);
      inflight.resolve('__disconnected__');
      inflight = null;
    }
    for (const e of queue) e.resolve('__disconnected__');
    queue = [];
    // cancel()/close() return PROMISES — a bare try/catch only stops the
    // synchronous throw. When the USB device is already gone they reject
    // asynchronously ("NetworkError: Port has been closed"), which used to
    // escape as an unhandled runtime error. Swallow both failure paths.
    try { reader?.cancel().catch(() => {}); } catch { /* ignore */ }
    try { writer?.close().catch(() => {});  } catch { /* ignore */ }
    try { port?.close().catch(() => {});    } catch { /* ignore */ }
    try { ws?.close();                      } catch { /* ignore */ }
    reader = null;
    writer = null;
    port   = null;
    ws     = null;
    rxBuf  = '';
    autoReportActive = false;
    setState(prev => ({
      ...prev, connected: false, frequency: null, mode: null, ptt: false, error: null,
      volume: null, att1: null, att2: null, nr: null, agc: null, agcLevel: null, filter: null, sMeter: null, drive: null,
      backlight: null, firmwareVersion: null, autoReport: null, pttConfirmAlarm: false,
    }));
  }

  const connect = async (config: CATConnectionConfig) => {
    debug = config.debug;
    const transport = config.transport ?? 'serial';
    transportKind = transport;
    // Dev-only: the performance testbed sets window.__catUseMock to run the
    // full CAT pipeline against a simulated radio (also enables CAT in
    // browsers without Web Serial, e.g. Firefox). Dynamic import keeps the
    // mock out of production bundles.
    const useMock = import.meta.env.DEV
      && typeof window !== 'undefined'
      && (window as unknown as Record<string, unknown>).__catUseMock === true;
    if (transport === 'serial' && !useMock && !('serial' in navigator)) {
      setState(prev => ({ ...prev, error: 'Web Serial API not supported in this browser' }));
      return;
    }
    if (transport === 'websocket' && !config.wsUrl) {
      setState(prev => ({ ...prev, error: 'CAT bridge address is required for the WebSocket transport' }));
      return;
    }
    log('info', transport === 'websocket'
      ? `connecting via CAT bridge — ${config.wsUrl} timeout:${config.timeoutMs}ms debug:${config.debug} profile:${config.rigProfile}`
      : `connecting — ${config.baudRate} ${config.dataBits}${config.parity === 'none' ? 'N' : config.parity[0].toUpperCase()}${config.stopBits} timeout:${config.timeoutMs}ms debug:${config.debug} profile:${config.rigProfile}${useMock ? ' [MOCK]' : ''}`);
    try {
      if (transport === 'websocket') {
        const { socket, writer: w, reader: r } = await openWebSocket(config.wsUrl!);
        timeoutMs      = config.timeoutMs;
        pollIntervalMs = config.pollIntervalMs;
        rigProfile     = config.rigProfile;
        closing = false;  // fresh session — read-loop exit now means "bridge lost"
        autoReportActive = false;  // re-discovered by the first full poll (AI;)
        ws     = socket;
        writer = w;
        reader = r;
        startReadLoop(r);
      } else {
        let p: SerialPort;
        if (useMock) {
          const { createMockSerialPort } = await import('$decoder-lib/cat/mockSerial');
          p = createMockSerialPort() as unknown as SerialPort;
        } else {
          const serial = (navigator as Navigator & { serial: { requestPort(): Promise<SerialPort> } }).serial;
          p = await serial.requestPort();
        }
        await p.open({
          baudRate: config.baudRate, dataBits: config.dataBits,
          stopBits: config.stopBits, parity: config.parity, flowControl: 'none',
        });
        if (!p.writable || !p.readable) throw new Error('Port streams unavailable');
        timeoutMs      = config.timeoutMs;
        pollIntervalMs = config.pollIntervalMs;
        rigProfile     = config.rigProfile;
        closing = false;  // fresh session — read-loop exit now means "port lost"
        autoReportActive = false;  // re-discovered by the first full poll (AI;)
        port   = p;
        writer = p.writable.getWriter();
        const r = p.readable.getReader();
        reader = r;
        startReadLoop(r);
      }
      setState(prev => ({ ...prev, connected: true, error: null }));
      log('info', 'polling every', config.pollIntervalMs + 'ms');
      schedulePoll();
      if (config.rigProfile === 'usdx-blackbrick') {
        // Ask the radio which firmware it runs (FV;) — retried a few times since
        // the reply can be eaten by the LCD/UART pin-share noise. The UI shows
        // the PU7FTW extension controls only once this answers, so a stock rig
        // on the blackbrick preset degrades gracefully to generic TS-480.
        (async () => {
          for (let i = 0; i < 3; i++) {
            let resp = '';
            try { resp = await query('FV;'); } catch { /* retry */ }
            const m = resp.match(/FV(\d\.\d\d[a-z]?);/);
            if (m) { log('info', 'firmware version:', m[1]); setState(prev => ({ ...prev, firmwareVersion: m[1] })); return; }
            await new Promise(res => setTimeout(res, 300));
          }
          log('warn', 'radio did not answer FV; — PU7FTW extensions hidden');
        })();
        // One-shot CAT auto-report discovery (AI; — same retry pattern as FV).
        // Deliberately queried only here, at connection time: older firmware
        // always answers AI0; (→ keep long-polling), and later toggles at the
        // rig are announced with an unsolicited AIn; frame, so re-polling the
        // capability would be wasted traffic.
        (async () => {
          for (let i = 0; i < 3; i++) {
            let resp = '';
            try { resp = await query('AI;'); } catch { /* retry */ }
            const v = parseIntField(resp, 'AI');
            if (v !== null) { applyAutoReportState(v >= 1); return; }
            await new Promise(res => setTimeout(res, 300));
          }
          log('warn', 'radio did not answer AI; — assuming no auto-report (long poll)');
        })();
      }
    } catch (err) {
      log('info', 'connection failed:', err);
      setState(prev => ({
        ...prev, connected: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      }));
    }
  };

  const setFrequency = async (hz: number) => {
    lastSet.frequency = Date.now();
    log('info', 'setFrequency →', hz, 'Hz');
    setState(prev => ({ ...prev, frequency: hz })); // optimistic — perceived responsiveness
    const cmd = `FA${hz.toString().padStart(11, '0')};`;
    if (transportKind !== 'websocket') { await write(cmd); return; }
    // FA; SET has no echo (see the protocol notes above) — confirm via a
    // separate readback query, retried as a whole SET+verify cycle.
    const confirmed = await confirmedSet(cmd, { hasEcho: false, verifyCmd: 'FA;' },
      (reply) => parseFrequency(reply) === hz);
    if (!confirmed) {
      log('warn', 'setFrequency: bridge could not confirm the radio applied', hz, 'Hz after', CONFIRM_RETRIES, 'attempts');
      setState(prev => ({ ...prev, error: `Frequency change to ${hz} Hz was not confirmed by the radio — link may be unreliable.` }));
      // Don't silently keep showing the unconfirmed value — re-poll to show
      // whatever the radio is ACTUALLY on, next poll tick will correct it.
    }
  };

  const setMode = async (mode: CATMode) => {
    lastSet.mode = Date.now();
    log('info', 'setMode →', mode);
    setState(prev => ({ ...prev, mode })); // optimistic — perceived responsiveness
    const cmd = `MD${CAT_MODE_TO_KENWOOD[mode]};`;
    if (transportKind !== 'websocket') { await write(cmd); return; }
    // MD; SET has no echo either — same confirm-via-readback pattern as frequency.
    const confirmed = await confirmedSet(cmd, { hasEcho: false, verifyCmd: 'MD;' },
      (reply) => parseMode(reply) === mode);
    if (!confirmed) {
      log('warn', 'setMode: bridge could not confirm the radio applied', mode, 'after', CONFIRM_RETRIES, 'attempts');
      setState(prev => ({ ...prev, error: `Mode change to ${mode} was not confirmed by the radio — link may be unreliable.` }));
    }
  };

  // PTT is the one safety-critical setter: see RadioState.pttConfirmAlarm.
  // Deliberately asymmetric between TX and RX —
  //   - TX (keying up): shown optimistically. The PA already keys the
  //     instant the SET reaches the radio regardless of what the UI shows,
  //     so an optimistic UI here costs nothing safety-wise, only cosmetics.
  //   - RX (un-keying): NEVER shown as confirmed until the radio's own
  //     RX0; reply proves it. Claiming "safely off" before it's actually
  //     off is the exact failure mode this whole feature exists to prevent.
  //     On repeated failure to confirm RX, ptt stays true (never optimistic)
  //     and pttConfirmAlarm fires — the radio's own TOT (TT;) is a separate,
  //     slower hardware backstop, not a reason to stay quiet here.
  const setPTT = async (tx: boolean) => {
    log('info', 'setPTT →', tx ? 'TX' : 'RX');
    if (transportKind !== 'websocket') {
      setState(prev => ({ ...prev, ptt: tx }));
      await write(tx ? 'TX;' : 'RX;');
      return;
    }
    if (tx) {
      setState(prev => ({ ...prev, ptt: true })); // optimistic, see above
      const confirmed = await confirmedSet('TX;', { hasEcho: false, verifyCmd: 'TX;' },
        (reply) => reply.startsWith('TX'));
      if (!confirmed) {
        log('warn', 'setPTT(true): bridge could not confirm the radio keyed TX after', CONFIRM_RETRIES, 'attempts');
        setState(prev => ({ ...prev, error: 'Could not confirm the radio keyed TX — CAT link may be unreliable.' }));
      }
      return;
    }
    // RX: keep retrying beyond the initial confirmedSet() call — this is
    // the one place "give up after 3 and move on" is not acceptable.
    const confirmed = await confirmedSet('RX;', { hasEcho: false, verifyCmd: 'RX;' },
      (reply) => reply.startsWith('RX'));
    if (confirmed) {
      setState(prev => ({ ...prev, ptt: false, pttConfirmAlarm: false }));
      return;
    }
    log('error', 'setPTT(false): RADIO DID NOT CONFIRM RX AFTER', CONFIRM_RETRIES, 'ATTEMPTS — raising pttConfirmAlarm');
    setState(prev => ({ ...prev, pttConfirmAlarm: true })); // ptt stays whatever it was — NOT set to false
    // Keep trying in the background (fire-and-forget) until it confirms —
    // the alarm stays up and ptt stays untouched until a real RX0; arrives.
    void (async () => {
      for (;;) {
        const ok = await confirmedSet('RX;', { hasEcho: false, verifyCmd: 'RX;' }, (reply) => reply.startsWith('RX'));
        if (ok) {
          setState(prev => ({ ...prev, ptt: false, pttConfirmAlarm: false }));
          return;
        }
        if (!writer) return; // disconnected — stop retrying into a dead link
        await new Promise(res => setTimeout(res, 1000));
      }
    })();
  };

  // Shared factory for the PU7FTW extension setters below — all follow the
  // identical shape: SET a numeric field, and the firmware always echoes
  // the EFFECTIVE value in the same reply (the old value if the SET was
  // rejected as out-of-range — see the protocol notes above). That echo is
  // exactly what confirmedSet(hasEcho: true) checks, no separate verify
  // query needed, unlike FA/MD/TX/RX which have no echo at all.
  //
  // Over 'serial', kept as the original fire-and-forget write() (unchanged
  // behavior) — confirmation is gated to 'websocket' where the bridge hop
  // can silently drop a command a direct connection can't.
  function makeExtensionSetter(
    prefix: string,
    stateKey: keyof Pick<RadioState, 'volume' | 'att1' | 'att2' | 'nr' | 'agc' | 'agcLevel' | 'filter' | 'drive' | 'backlight'>,
    lastSetKey: keyof typeof lastSet,
  ) {
    return async (n: number) => {
      lastSet[lastSetKey] = Date.now();
      log('info', `set${String(stateKey)} →`, n);
      setState(prev => ({ ...prev, [stateKey]: n })); // optimistic — perceived responsiveness
      const cmd = `${prefix}${n};`;
      if (transportKind !== 'websocket') { await write(cmd); return; }
      const confirmed = await confirmedSet(cmd, { hasEcho: true },
        (reply) => parseIntField(reply, prefix) === n);
      if (!confirmed) {
        log('warn', `set${String(stateKey)}: bridge could not confirm the radio applied`, n, 'after', CONFIRM_RETRIES, 'attempts');
        setState(prev => ({ ...prev, error: `Setting change (${prefix}${n}) was not confirmed by the radio — link may be unreliable.` }));
      }
    };
  }

  const setVolume    = makeExtensionSetter('VO', 'volume', 'volume');
  const setAtt1      = makeExtensionSetter('AT', 'att1', 'att1');
  const setAtt2      = makeExtensionSetter('A2', 'att2', 'att2');
  const setNR        = makeExtensionSetter('NR', 'nr', 'nr');
  const setAGC       = makeExtensionSetter('AG0', 'agc', 'agc');
  const setAgcLevel  = makeExtensionSetter('AL', 'agcLevel', 'agcLevel');
  const setFilter    = makeExtensionSetter('FW', 'filter', 'filter');
  const setDrive     = makeExtensionSetter('DR', 'drive', 'drive');
  const setBacklight = makeExtensionSetter('BL', 'backlight', 'backlight');

  // ── PA bias (PM/PX) — on-demand only, never polled ─────────────────────────

  const getPABias = async (): Promise<PABias | null> => {
    log('info', 'getPABias');
    let resp = '';
    try { resp = await queryBatch(['PM;', 'PX;']); } catch { return null; }
    const min = parseIntField(resp.match(/PM\d+;/)?.[0] ?? '', 'PM');
    const max = parseIntField(resp.match(/PX\d+;/)?.[0] ?? '', 'PX');
    return min !== null && max !== null ? { min, max } : null;
  };

  const setPABias = async (which: 'min' | 'max', n: number): Promise<number | null> => {
    const prefix = which === 'min' ? 'PM' : 'PX';
    log('info', 'setPABias →', which, n);
    let resp = '';
    try { resp = await query(`${prefix}${n};`); } catch { return null; }
    // The firmware echoes the effective value — the old one if the SET was
    // rejected (out of range / min≥max) — so the caller can show the truth.
    return parseIntField(resp, prefix);
  };

  // ── TX timeout (TT) — on-demand only, never polled ─────────────────────────

  const getTxTimeout = async (): Promise<number | null> => {
    log('info', 'getTxTimeout');
    let resp = '';
    try { resp = await query('TT;'); } catch { return null; }
    return parseIntField(resp, 'TT');
  };

  const setTxTimeout = async (n: number): Promise<number | null> => {
    log('info', 'setTxTimeout →', n);
    let resp = '';
    try { resp = await query(`TT${n};`); } catch { return null; }
    // The firmware echoes the effective value — the old one if the SET was
    // rejected (out of range) — so the caller can show the truth.
    return parseIntField(resp, 'TT');
  };

  const resetRadio = async (): Promise<boolean> => {
    log('info', 'resetRadio — soft restart (SR;)');
    let resp = '';
    try { resp = await query('SR;'); } catch { return false; }
    // After the SR1; ack the radio reboots: polls time out for a few seconds,
    // then the batched poll refreshes every field — nothing else to do here.
    return parseIntField(resp, 'SR') === 1;
  };

  const getFactoryDefaults = async (): Promise<FactoryDefaults | null> => {
    log('info', 'getFactoryDefaults (FD;)');
    let resp = '';
    try { resp = await query('FD;'); } catch { return null; }
    const m = resp.match(/^FD(-?\d+(?:,-?\d+){10});$/);
    if (!m) return null;
    const v = m[1].split(',').map(Number);
    return {
      volume: v[0], att1: v[1], att2: v[2], nr: v[3], agc: v[4],
      filter: v[5], drive: v[6], backlight: v[7], paMin: v[8], paMax: v[9],
      mode: KENWOOD_MODE_MAP[String(v[10])] ?? null,
    };
  };

  const factoryResetRadio = async (): Promise<boolean> => {
    log('info', 'factoryResetRadio — SR2; (full settings wipe + reboot)');
    let resp = '';
    try { resp = await query('SR2;'); } catch { return false; }
    return parseIntField(resp, 'SR') === 2;
  };

  const getRefFreq = async (): Promise<number | null> => {
    log('info', 'getRefFreq (XF;)');
    let resp = '';
    try { resp = await query('XF;'); } catch { return null; }
    return parseIntField(resp, 'XF');
  };

  const setRefFreq = async (hz: number): Promise<number | null> => {
    log('info', 'setRefFreq →', hz, 'Hz');
    let resp = '';
    try { resp = await query(`XF${Math.round(hz)};`); } catch { return null; }
    // Firmware echoes the effective value — the old one if the SET was rejected.
    return parseIntField(resp, 'XF');
  };

  // ── ESP32 CAT bridge status/control — plain HTTP, independent of the CAT
  // queue/connection above (the bridge answers these even if the radio
  // itself is unreachable) ────────────────────────────────────────────────

  const getBridgeStatus = async (wsUrl: string): Promise<BridgeStatus | null> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return null;
    log('info', 'getBridgeStatus ←', base + '/status');
    try {
      const resp = await fetch(base + '/status', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (typeof j.wifi_state !== 'string' || typeof j.rssi !== 'number') return null;
      return {
        wifiState: j.wifi_state, ssid: String(j.ssid ?? ''), rssi: j.rssi,
        ip: String(j.ip ?? ''), wsClients: Number(j.ws_clients) || 0,
        wsMaxClients: Number(j.ws_max_clients) || 0,
        radioLinked: j.radio_linked === true, catBaud: Number(j.cat_baud) || 0,
        uptimeSeconds: Number(j.uptime_s) || 0,
      };
    } catch (err) {
      log('warn', 'getBridgeStatus failed:', err);
      return null;
    }
  };

  const resetBridge = async (wsUrl: string): Promise<boolean> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return false;
    log('info', 'resetBridge →', base + '/reset');
    try {
      const resp = await fetch(base + '/reset', { method: 'POST', signal: AbortSignal.timeout(5000) });
      return resp.ok;
    } catch (err) {
      log('warn', 'resetBridge failed:', err);
      return false;
    }
  };

  const getBridgeInfo = async (wsUrl: string): Promise<BridgeInfo | null> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return null;
    log('info', 'getBridgeInfo ←', base + '/info');
    try {
      const resp = await fetch(base + '/info', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (typeof j.firmware_version !== 'string' || !Array.isArray(j.features)) return null;
      return { firmwareVersion: j.firmware_version, features: j.features.map(String) };
    } catch (err) {
      log('warn', 'getBridgeInfo failed:', err);
      return null;
    }
  };

  const setBridgeBacklight = async (wsUrl: string, duty: number): Promise<{ duty: number; saved: boolean } | null> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return null;
    log('info', 'setBridgeBacklight →', duty);
    try {
      const resp = await fetch(base + '/backlight', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duty: Math.round(duty) }),
      });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (typeof j.duty !== 'number') return null;
      return { duty: j.duty, saved: j.saved === true };
    } catch (err) {
      log('warn', 'setBridgeBacklight failed:', err);
      return null;
    }
  };

  const setBridgeWifiConfig = async (wsUrl: string, ssid: string, password: string): Promise<boolean> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return false;
    log('info', 'setBridgeWifiConfig → ssid:', ssid);
    try {
      const resp = await fetch(base + '/wifi-config', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid, password }),
      });
      return resp.ok;
    } catch (err) {
      log('warn', 'setBridgeWifiConfig failed:', err);
      return false;
    }
  };

  const setBridgeContrast = async (wsUrl: string, vop: number): Promise<{ vop: number; saved: boolean } | null> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return null;
    log('info', 'setBridgeContrast →', vop);
    try {
      const resp = await fetch(base + '/contrast', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vop: Math.round(vop) }),
      });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (typeof j.vop !== 'number') return null;
      return { vop: j.vop, saved: j.saved === true };
    } catch (err) {
      log('warn', 'setBridgeContrast failed:', err);
      return null;
    }
  };

  // POST /cat-baud — no reboot, unlike setBridgeWifiConfig: the radio's own
  // baud is a local-menu-only setting with no CAT command to announce a
  // change (see the firmware README), so this must apply live the moment
  // you've changed it on the radio, not after a restart.
  const setBridgeCatBaud = async (wsUrl: string, baud: number): Promise<{ baud: number; saved: boolean } | null> => {
    const base = bridgeHttpBase(wsUrl);
    if (!base) return null;
    log('info', 'setBridgeCatBaud →', baud);
    try {
      const resp = await fetch(base + '/cat-baud', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baud }),
      });
      if (!resp.ok) return null;
      const j = await resp.json();
      if (typeof j.baud !== 'number') return null;
      return { baud: j.baud, saved: j.saved === true };
    } catch (err) {
      log('warn', 'setBridgeCatBaud failed:', err);
      return null;
    }
  };

  onCleanup(() => { disconnect(); });

  return {
    state, connect, disconnect, setFrequency, setMode, setPTT,
    setVolume, setAtt1, setAtt2, setNR, setAGC, setAgcLevel, setFilter, setDrive,
    setBacklight, getPABias, setPABias, getTxTimeout, setTxTimeout, resetRadio,
    getFactoryDefaults, factoryResetRadio, getRefFreq, setRefFreq,
    getBridgeStatus, resetBridge, getBridgeInfo, setBridgeBacklight, setBridgeWifiConfig, setBridgeContrast,
    setBridgeCatBaud,
  };
}
