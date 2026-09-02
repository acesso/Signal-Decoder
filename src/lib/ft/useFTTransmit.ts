// Port of src/hooks/useFTTransmit.ts (Next.js app) — encodes and transmits
// FT8/FT4 messages via Web Audio (optionally through a CAT-controlled
// radio's PTT), with a TX queue, auto-CQ, and audio device/gain selection.
// Kept close to the original's imperative timing logic verbatim (the
// comments explaining UTC-window/consecutive-TX/auto-CQ-cadence logic are
// load-bearing, not stylistic).
import { createSignal } from 'solid-js'
import { FTMode, FT_WINDOW_SECONDS, FT_SUPPORTED } from '$decoder-lib/ft/decoder'
import { audioRecorder } from '$decoder-lib/audio/ringRecorder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { speakerSink, type AudioSinkKind, type AudioSinkHandle } from '$decoder-lib/audio/audioSource'
import { downsampleBandlimited, makeBandlimitedResampleState, floatToInt16 } from '$decoder-lib/cat/useAudioBridge'

export interface TxQueueEntry {
  id: string;
  message: string;
  label: string;
  /** Pinned TX audio frequency for THIS entry (honors a station's QSY
   *  request per conversation) — overrides the panel's global Audio Hz,
   *  which stays untouched. Under Fake Split this becomes the DESIRED tone
   *  used to compute a VFO delta rather than what's actually encoded — see
   *  fakeSplitEncodedHz below and the Fake Split design doc. */
  audioHz?: number;
  // Populated as soon as the entry is enqueued — loop never waits for encoding
  samples: Float32Array | null;
  encodeStatus: 'pending' | 'ready' | 'error';
  encodeError?: string;
  /** The tone `samples` was ACTUALLY encoded at when Fake Split was on at
   *  encode time (always the panel's Audio Hz then, per Fake Split's
   *  design — see runLoop's fake-split branch), so a later Audio Hz change
   *  can't desync "what's baked into the samples" from "what delta we
   *  compute for the VFO retune." Undefined when Fake Split was off at
   *  encode time (encodeHz was audioHz ?? getBaseFrequency() as normal). */
  fakeSplitEncodedHz?: number;
}

export interface SentEntry {
  id: string;
  message: string;
  label: string;
  windowStart: Date;
  vfoHz: number;
  audioHz: number;
  error?: string;
}

export type TxStatus = 'idle' | 'waiting' | 'playing';

export interface FTTransmitState {
  status: TxStatus;
  queue: TxQueueEntry[];
  sent: SentEntry[];
  autoCQ: boolean;
  autoCQIntervalMin: number;
  autoPTT: boolean;
  allowConsecutiveTx: boolean;
  /** Fake Split (see doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md): on TX,
   *  encodes audio at a FIXED sweet-spot tone (fakeSplitSweetSpotHz) instead
   *  of the operator's chosen Audio Hz / entry.audioHz, and retunes the VFO
   *  via CAT to make up the difference — so the operator's intended TX
   *  frequency is preserved on air while the audio itself stays at a tone
   *  known to minimize harmonics/IMD on typical SSB TX audio chains.
   *  Requires a live, frequency-reporting CAT connection — the panel gates
   *  the chip on that, this flag alone doesn't imply CAT is actually usable
   *  right now. */
  fakeSplit: boolean;
  /** Fixed audio tone Fake Split always encodes at — see fakeSplit's own
   *  comment. Configurable (not hardcoded) since a radio's actual filter
   *  response can differ; defaults to DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ. */
  fakeSplitSweetSpotHz: number;
  /** FT8-only: restrict TX to one parity of window pair (even: :00/:30,
   *  odd: :15/:45) — see doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md. */
  txWindowParity: 'even' | 'odd';
  error: string | null;
  outputDeviceId: string;
  txGain: number;
  sinkIdSupported: boolean;
  preKeyMs: number;
  postKeyMs: number;
  /** epoch ms of the next window boundary the loop has confirmed it will
   *  actually transmit on (head-of-queue entry or auto-CQ) — null once a
   *  window's skip/send decision has been made but nothing will send at the
   *  upcoming boundary (forced listen window, empty queue, auto-CQ not due).
   *  The UI reads this instead of guessing from queue length/allowConsecutiveTx,
   *  so the countdown reflects the loop's ACTUAL decision for the current
   *  cycle rather than resetting at a boundary nothing sends on, only to
   *  restart the countdown a full window later. */
  nextTxAtMs: number | null;
  /** What's actually cached in each of the bridge's TX_SLOT_COUNT buffer
   *  pool slots, for a "what's staged for bridge TX" panel — see
   *  bridgeSlotInfo()'s own comment for why this is browser-tracked state
   *  (the firmware only knows raw PCM + a hash, never message text).
   *  Always TX_SLOT_COUNT entries, index === slot; message is '' for a
   *  slot nothing has been assigned to yet. */
  bridgeSlots: BridgeSlotInfo[];
}

export interface BridgeSlotInfo {
  slot: number;
  message: string;
  label: string;
  /** Set the moment an upload is issued for this (message, slot) pair —
   *  NOT re-checked against the hash-skip cache, so this can be true even
   *  when uploadToBridgeSlot() ends up skipping the actual HTTP call
   *  because the content was already there; "uploaded" here means "this
   *  slot's stated message/label are believed accurate," which holds
   *  either way. False only for a slot that's never been assigned a
   *  message at all (the initial state, or right after POST /tx-clear). */
  uploaded: boolean;
  /** TX audio frequency this slot's waveform was ENCODED at, 0 when
   *  unknown. Descriptive only — the frequency is already baked into the
   *  samples themselves, so this is a label, not something playback reads.
   *  Uploaded to the device alongside the audio and read back by
   *  refreshSlotHashCache(), which is what lets a freshly loaded page
   *  (or a different browser entirely) describe slots it never staged
   *  itself — see that function's own comment. */
  audioHz: number;
}

// ── localStorage persistence ──────────────────────────────────────────────────

const LS_CALL            = 'ft_mycall';
const LS_GRID            = 'ft_mygrid';
const LS_OUTPUT          = 'ft_output_device';
const LS_AUDIO_SINK      = 'ft_audio_sink_kind';
const LS_GAIN            = 'ft_tx_gain';
const LS_AUTOPTT         = 'ft_auto_ptt';
const LS_CONSECUTIVE_TX  = 'ft_consecutive_tx';
const LS_FAKE_SPLIT      = 'ft_fake_split';
const LS_FAKE_SPLIT_SWEET_SPOT_HZ = 'ft_fake_split_sweet_spot_hz';
const LS_TX_WINDOW_PARITY = 'ft_tx_window_parity';

// Fake Split's fixed "sweet spot" audio tone — see
// doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md. This is a FIXED reference
// point independent of the operator's chosen TX frequency (Audio Hz /
// entry.audioHz, i.e. wherever they clicked on the waterfall) — conflating
// the two was the original design's bug (both resolved to the same
// getBaseFrequency() value, so the VFO delta was always zero for ordinary
// traffic). 1750 Hz is the center of WSJT-X's own 1500-2000 Hz range,
// chosen for the same documented reason WSJT-X uses that range: low tones'
// harmonics can land back inside the transmit passband and cause splatter,
// so a tone safely away from both the passband edges and DC minimizes
// harmonic/IMD risk on typical SSB transceiver TX audio chains. Configurable
// (not hardcoded) since a given radio's actual filter response can differ.
export const DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ = 1750;
const FAKE_SPLIT_SWEET_SPOT_MIN_HZ = 300;  // matches the passband floor most SSB TX audio chains enforce
const FAKE_SPLIT_SWEET_SPOT_MAX_HZ = 2800; // matches the passband ceiling — see the design doc's research
export function loadFakeSplitSweetSpotHz(): number {
  if (typeof window === 'undefined') return DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ;
  const n = parseInt(localStorage.getItem(LS_FAKE_SPLIT_SWEET_SPOT_HZ) ?? '', 10);
  return Number.isFinite(n) && n >= FAKE_SPLIT_SWEET_SPOT_MIN_HZ && n <= FAKE_SPLIT_SWEET_SPOT_MAX_HZ
    ? n : DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ;
}
export function saveFakeSplitSweetSpotHz(v: number) {
  const clamped = Math.max(FAKE_SPLIT_SWEET_SPOT_MIN_HZ, Math.min(FAKE_SPLIT_SWEET_SPOT_MAX_HZ, Math.round(v)));
  if (typeof window !== 'undefined') localStorage.setItem(LS_FAKE_SPLIT_SWEET_SPOT_HZ, String(clamped));
}

// Guard delay after Fake Split's VFO retune is CAT-confirmed but before
// audio/PTT proceeds. A confirmed SET only proves the radio ACKNOWLEDGED
// the new frequency, not that its synthesizer/PLL has finished physically
// settling on it — keying immediately risks the first symbol(s) going out
// chirped or off-frequency. No source (WSJT-X's own docs included) gives a
// universal number for this; it's genuinely radio/synthesizer-specific.
// Ships as a conservative default pending real-hardware measurement across
// at least the TS-480-direct-serial and ESP32-bridge paths — see
// doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md's "Remaining open question."
const FAKE_SPLIT_SETTLE_MS = 75;

// Window-parity guard (FT8 only — see doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md):
// two consecutive 15s windows make one WSJT-X-style 30s period; parity 0 =
// the pair starting at :00/:30 ("even"), 1 = :15/:45 ("odd"). Exported as a
// standalone pure function (rather than left inline in runLoop) so this
// epoch-alignment math — verified once against known UTC boundaries, not
// just assumed — has a direct unit test rather than only being exercised
// indirectly through the full async TX loop. FT4/FT2 windows don't divide
// into a clean 2-way parity (4 and 8 slots per 30s respectively), so this
// only ever restricts FT8.
export function isWrongWindowParity(
  currentWindowStart: number,
  windowMs: number,
  mode: FTMode,
  txWindowParity: 'even' | 'odd',
): boolean {
  if (mode !== 'FT8') return false;
  const windowParity = Math.floor(currentWindowStart / windowMs) % 2;
  return windowParity !== (txWindowParity === 'even' ? 0 : 1);
}
const LS_BASE_FREQ       = 'ft_base_freq';
const LS_AUTOCQ_INTERVAL = 'ft_autocq_interval_min';
const LS_PREKEY_MS       = 'ft_prekey_ms';
const LS_POSTKEY_MS      = 'ft_postkey_ms';
const LS_SUSPEND_IQ_TX   = 'ft_suspend_iq_during_tx';

export const DEFAULT_BASE_FREQ = 1850;
export function loadBaseFreq(): number {
  if (typeof window === 'undefined') return DEFAULT_BASE_FREQ;
  const stored = localStorage.getItem(LS_BASE_FREQ);
  return stored !== null ? parseInt(stored, 10) : DEFAULT_BASE_FREQ;
}
export function saveBaseFreq(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_BASE_FREQ, String(v));
}

export function loadMyCall(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_CALL) ?? '';
}
export function saveMyCall(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_CALL, v);
}
export function loadMyGrid(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_GRID) ?? '';
}
export function saveMyGrid(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_GRID, v);
}
export function loadOutputDevice(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_OUTPUT) ?? '';
}
export function saveOutputDevice(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_OUTPUT, v);
}
// null = no explicit choice ever saved — callers use this to distinguish
// "never touched" (still eligible for auto-pick-bridge-on-connect) from an
// operator's deliberate choice of 'speaker' (which must stick).
export function loadAudioSinkKind(): AudioSinkKind | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(LS_AUDIO_SINK);
  return stored === 'bridge' || stored === 'speaker' ? stored : null;
}
export function saveAudioSinkKind(v: AudioSinkKind) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUDIO_SINK, v);
}
const DEFAULT_GAIN = Math.pow(10, -50 / 20); // -50 dB
export function loadTxGain(): number {
  if (typeof window === 'undefined') return DEFAULT_GAIN;
  const stored = localStorage.getItem(LS_GAIN);
  return stored !== null ? parseFloat(stored) : DEFAULT_GAIN;
}
export function saveTxGain(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_GAIN, String(v));
}
export function loadAutoPTT(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOPTT) === 'true';
}
export function saveAutoPTT(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOPTT, String(v));
}
// Real-hardware profiling of the ESP32 bridge found that WiFi's dynamic
// packet-buffer allocator and I2S's DMA descriptors draw from the same
// physical memory pool, so streaming /iq-data concurrently with TX
// measurably degrades TX audio quality — a hardware/IDF limitation, not a
// bug this codebase can fully fix (see the bridge firmware's WiFi buffer
// count reduction, which helps but doesn't eliminate it). Defaults ON:
// suspending the I/Q spectrum connection for the duration of each TX
// window sidesteps the contention entirely at the cost of a spectrum-view
// gap while transmitting.
export function loadSuspendIQDuringTx(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = localStorage.getItem(LS_SUSPEND_IQ_TX);
  return stored !== null ? stored === 'true' : true;
}
export function saveSuspendIQDuringTx(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_SUSPEND_IQ_TX, String(v));
}
export function loadAllowConsecutiveTx(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_CONSECUTIVE_TX) === 'true';
}
export function saveAllowConsecutiveTx(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_CONSECUTIVE_TX, String(v));
}

// Fake Split — see FTTransmitState.fakeSplit's own comment and
// doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md. Off by default: it retunes
// the VFO on every TX, which is only safe with a CAT link the operator has
// deliberately connected.
export function loadFakeSplit(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_FAKE_SPLIT) === 'true';
}
export function saveFakeSplit(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_FAKE_SPLIT, String(v));
}

// TX window parity — see FTTransmitState.txWindowParity's own comment.
// Always restricts to one parity or the other (no separate "off"/"any"
// state — allowConsecutiveTx already covers "don't restrict windows").
// Defaults to 'even': WSJT-X's own "Tx even/1st" is the more commonly-seen
// default in the wild.
export function loadTxWindowParity(): 'even' | 'odd' {
  if (typeof window === 'undefined') return 'even';
  return localStorage.getItem(LS_TX_WINDOW_PARITY) === 'odd' ? 'odd' : 'even';
}
export function saveTxWindowParity(v: 'even' | 'odd') {
  if (typeof window !== 'undefined') localStorage.setItem(LS_TX_WINDOW_PARITY, v);
}

// Minimum gap between unattended auto-CQ transmissions. Left unchecked, the
// TX loop would send a CQ in every eligible window (as often as every ~15s
// for FT8) — far too aggressive for a beacon nobody is watching. Default 5
// minutes is a reasonable, still-discoverable cadence; 1..60 min range.
export const DEFAULT_AUTOCQ_INTERVAL_MIN = 5;
export function loadAutoCQIntervalMin(): number {
  if (typeof window === 'undefined') return DEFAULT_AUTOCQ_INTERVAL_MIN;
  const stored = localStorage.getItem(LS_AUTOCQ_INTERVAL);
  const n = stored !== null ? parseInt(stored, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AUTOCQ_INTERVAL_MIN;
}
export function saveAutoCQIntervalMin(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOCQ_INTERVAL, String(v));
}

// Restoring auto-CQ=on cannot transmit by itself: the TX engine still starts
// stopped and must be armed manually each session.
const LS_AUTOCQ = 'ft_autocq';
export function loadAutoCQ(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOCQ) === 'true';
}
export function saveAutoCQ(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOCQ, String(v));
}

// Pre-key (warm-up) and post-key (cool-down/hang) delays around PTT, for
// external PAs/relays that need time to switch before RF audio starts (and to
// stay keyed briefly after audio ends, e.g. a relay's release bounce). PTT
// keys at the normal window boundary as always; preKeyMs then delays audio
// start by that much (so transmissions start slightly late rather than early
// — keying early without shifting playback requires reworking the window-
// boundary bookkeeping, which turned out fragile and was reverted). Default 0
// (off) — most setups (audio-only, VOX, solid-state PAs) don't need this.
const MAX_PREKEY_MS  = 2000;
const MAX_POSTKEY_MS = 2000;
export function loadPreKeyMs(): number {
  if (typeof window === 'undefined') return 0;
  const n = parseInt(localStorage.getItem(LS_PREKEY_MS) ?? '', 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_PREKEY_MS, n)) : 0;
}
export function savePreKeyMs(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_PREKEY_MS, String(v));
}
export function loadPostKeyMs(): number {
  if (typeof window === 'undefined') return 0;
  const n = parseInt(localStorage.getItem(LS_POSTKEY_MS) ?? '', 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_POSTKEY_MS, n)) : 0;
}
export function savePostKeyMs(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_POSTKEY_MS, String(v));
}

const LS_AUTOREPLY = 'ft_auto_reply';
export function loadAutoReply(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOREPLY) === 'true';
}
export function saveAutoReply(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOREPLY, String(v));
}

// ── Encoder worker ────────────────────────────────────────────────────────────

let encWorker: Worker | null = null;
let encNextId = 0;
const encPending = new Map<number, (samples: Float32Array, error?: string) => void>();

function getEncodeWorker(): Worker {
  if (!encWorker) {
    encWorker = new Worker(new URL('./encoder.worker.ts', import.meta.url), { type: 'module' });
    encWorker.onmessage = (e: MessageEvent) => {
      const { id, samples, error } = e.data;
      encPending.get(id)?.(samples, error);
      encPending.delete(id);
    };
  }
  return encWorker;
}

function encodeAsync(
  msg: string,
  mode: FTMode,
  sampleRate: number,
  baseFrequency: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const id = encNextId++;
    encPending.set(id, (samples, error) => {
      if (error) reject(new Error(error));
      else resolve(samples);
    });
    getEncodeWorker().postMessage({ id, msg, mode, sampleRate, baseFrequency });
  });
}

// ── Bridge buffer playback (uploads the whole message once, plays from the
// ESP32's own RAM) ────────────────────────────────────────────────────────────
// Replaces streaming TX audio live over /audio's WebSocket, chunk by chunk in
// real time — confirmed on real hardware to be "noisy, cutting and full of
// unwanted artifacts": any single WiFi-jitter-delayed chunk glitches the
// audio at that exact instant, and there is no buffering margin on either
// end to absorb it (see bridgeSink()'s own comment for how the old path
// worked). Uploading the ENTIRE already-encoded message once turns TX audio
// delivery into a one-shot transfer (which can tolerate ordinary WiFi
// latency/retransmission just fine) instead of a live stream (which can't
// tolerate ANY single chunk's delay). The firmware stores the upload in its
// own PSRAM and plays it out from a dedicated task at the correct rate —
// see the ESP32 firmware's /tx-audio, /tx-play, /tx-status, /tx-stop
// endpoints (http_control.h's doc comment).
//
// Fixed at MIC_SEND_SAMPLE_RATE_HZ (16000), matching the wire rate the old
// live-streaming path already used and the firmware's audio_rx_callback()
// already upsamples from — encodeAsync() itself runs at 12000Hz (ENC_RATE
// below), so this resamples once, up front, on the WHOLE message at once
// (not per-chunk — there's no streaming state to carry across calls here,
// unlike the live-mic path's makeBandlimitedResampleState() which really
// does need per-chunk continuity).
const BRIDGE_PLAYBACK_RATE_HZ = 16000;

// ws://host/cat -> http://host/... — same rewrite useIQBridge.ts's
// fetchBridgeIQInfo() and useRadioCAT.ts's BridgeStatus already do
// independently; duplicated locally rather than shared for the same reason
// noted in those files (this hook has no natural shared-module boundary
// with either).
function bridgeHttpUrl(catWsUrl: string, pathname: string, query?: string): string | null {
  try {
    const u = new URL(catWsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = pathname;
    if (query) u.search = query;
    return u.toString();
  } catch {
    return null;
  }
}

// The firmware's TX buffer pool (v0.6.0+, see http_control.h's POST
// /tx-audio doc comment) — 4 independent slots so the browser can
// pre-stage several candidate messages without one upload clobbering
// another. Slot roles are fixed, not dynamically negotiated: 0 is the
// standing auto-CQ buffer (re-checked, not blindly re-uploaded, every
// cycle — see uploadAutoCQIfBridgeSink()'s own comment for why), 1-2 are
// queue lookahead (the head of the queue and the one behind it — realistic
// FT8/FT4 operation rarely has more than one "about to transmit soon"
// queued entry at a time, per the play loop's own queue[0]-only logic
// below, so 2 lookahead slots is comfortably more than the common case
// needs), 3 is spare headroom for a future use (e.g. a manually-pinned
// "reply" slot) rather than actively assigned today.
// Matches the firmware's TX_SLOT_COUNT (audio_monitor.h) — not fetched
// dynamically, same "fixed, not negotiated" reasoning as
// BRIDGE_PLAYBACK_RATE_HZ above; a firmware old enough to have a different
// count wouldn't have the /tx-* endpoints at all (see the wire-protocol
// versioning note on BRIDGE_FIRMWARE_VERSION 0.6.0 in bridge_config.h).
const TX_SLOT_COUNT = 4;
const TX_SLOT_AUTOCQ = 0;
const TX_SLOT_QUEUE_LOOKAHEAD = [1, 2] as const;

function emptyBridgeSlots(): BridgeSlotInfo[] {
  return Array.from({ length: TX_SLOT_COUNT }, (_, slot) => ({ slot, message: '', label: '', uploaded: false, audioHz: 0 }));
}

// Matches the firmware's esp_rom_crc32_le() exactly (standard zlib/PNG/
// IEEE-802.3 CRC32, poly 0xEDB88320, init/final XOR 0xFFFFFFFF) — needed
// so the browser can compare against a slot's already-uploaded hash
// (GET /tx-status) and skip re-uploading identical content, not for any
// cryptographic purpose. Table-driven for speed on a ~480KB buffer; the
// table itself is tiny (256 * 4 bytes) and built once, lazily, on first use.
let crc32Table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crc32Table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crc32Table = t;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

// Converts already-gained, already-resampled samples to the wire format
// (Int16, BRIDGE_PLAYBACK_RATE_HZ) — split out from uploadToBridgeSlot() so
// the hash can be computed and compared against a slot's already-uploaded
// content BEFORE paying for an HTTP round-trip, not just before the
// conversion work.
function toBridgeWireFormat(samples: Float32Array, fromRateHz: number, gain: number): Int16Array<ArrayBuffer> {
  // gain: applied here — encodeAsync()'s raw output (via @e04/ft8ts's
  // generateFT8Waveform()) is a bare Math.sin() waveform, already at FULL
  // SCALE (±1.0) with zero headroom. The local-speaker path always had
  // "TX Level" (this same gain, via gainNode.gain.value) between that raw
  // waveform and any real output; this path had NOTHING — real-hardware
  // testing (2026-08-25) confirmed exactly the symptom that predicts: the
  // bridge's own audio-quality sniffer measured hundreds of clip events in
  // a 10s window. Applied BEFORE resampling (not after) so the windowed-
  // sinc kernel's own ringing/overshoot on a full-scale input has less
  // headroom to exceed [-1,1] itself before floatToInt16()'s clamp; either
  // order is mathematically equivalent gain-wise (both stages are linear),
  // this just gives the resample step some margin to work with instead of
  // scaling its output back down after the fact.
  const gained = gain === 1 ? samples : samples.map(s => s * gain);
  const resampled = fromRateHz === BRIDGE_PLAYBACK_RATE_HZ
    ? gained
    : downsampleBandlimited(gained, fromRateHz, BRIDGE_PLAYBACK_RATE_HZ, makeBandlimitedResampleState());
  return floatToInt16(resampled);
}

// Per-slot last-known-uploaded hash, keyed by wsUrl (a session can only
// ever be talking to one bridge at a time in practice, but keying by URL
// rather than a bare array avoids a stale cache surviving a bridge switch
// mid-session). Populated from either this function's own successful
// upload or a GET /tx-status read (see refreshSlotHashCache() below) —
// either way, "what does the device currently have in this slot" per
// TX_SLOT_AUTOCQ/TX_SLOT_QUEUE_LOOKAHEAD's own comment.
const slotHashCache = new Map<string, Map<number, string>>();
function slotHashCacheFor(wsUrl: string): Map<number, string> {
  let m = slotHashCache.get(wsUrl);
  if (!m) { m = new Map(); slotHashCache.set(wsUrl, m); }
  return m;
}

// Resolves to the slot that actually holds this content once the upload
// completes — which is NOT always the slot that was asked for. The caller
// doesn't need to know whether the upload itself succeeded (see this
// function's own comment history: a failed upload just means the eventual
// /tx-play call 400s, which the play loop already treats as "nothing to
// send"), but it DOES need the resolved slot so it can play the right one.
//
// Content-addressed reuse: the bridge's slots are a content cache, and the
// hash is over the exact wire bytes, so two slots holding the same hash
// hold byte-identical audio. When ANY slot already has this content, there
// is nothing to gain from uploading a second copy — a ~400KB POST over the
// same local WiFi that carries the live RX audio stream, for a waveform the
// device can already play. So we skip the upload and return the slot that
// has it. Callers must play the RETURNED slot, not the requested one.
//
// The one thing this deliberately does not do is evict or rewrite the
// requested slot: leaving stale content there is harmless (nothing plays a
// slot without resolving through here first) and clearing it would cost an
// extra round-trip to save PSRAM that isn't under pressure.
async function uploadToBridgeSlot(
  wsUrl: string,
  slot: number,
  samples: Float32Array,
  fromRateHz: number,
  gain: number,
  // Descriptive metadata stored on the device beside the audio and echoed
  // by GET /tx-status — see BridgeSlotInfo's own comment for why this
  // travels with the upload rather than living only in browser state: the
  // hash is one-way, so nothing that didn't perform the upload itself
  // (a reloaded page, another browser, the bridge's own control page)
  // could otherwise say what a slot holds. audioHz is a LABEL for what was
  // encoded — the frequency is already baked into `samples` themselves.
  meta?: { message: string; label: string; audioHz: number },
): Promise<number> {
  const query = [`slot=${slot}`];
  if (meta) {
    if (meta.message) query.push(`message=${encodeURIComponent(meta.message)}`);
    if (meta.label) query.push(`label=${encodeURIComponent(meta.label)}`);
    if (meta.audioHz > 0) query.push(`hz=${Math.round(meta.audioHz)}`);
  }
  const url = bridgeHttpUrl(wsUrl, '/tx-audio', query.join('&'));
  if (!url) return slot;
  const int16 = toBridgeWireFormat(samples, fromRateHz, gain);
  const hash = hex8(crc32(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)));
  const cache = slotHashCacheFor(wsUrl);
  if (cache.get(slot) === hash) return slot; // this slot already has exactly this content
  // Some OTHER slot already holds byte-identical audio — play that one
  // instead of spending an upload duplicating it (see the header comment).
  for (const [otherSlot, otherHash] of cache) {
    if (otherHash === hash) return otherSlot;
  }
  try {
    const res = await fetch(url, { method: 'POST', body: int16.buffer });
    if (res.ok) { cache.set(slot, hash); return slot; }
    cache.delete(slot); // unknown state — don't skip a future retry based on a stale/wrong assumption
  } catch {
    cache.delete(slot);
  }
  return slot;
}

// One-shot GET /tx-status read used to seed slotHashCache with whatever
// the bridge ACTUALLY has right now — without this, a page reload (or a
// mid-session bridge reconnect) would have no way to know slot 0 already
// holds the exact auto-CQ waveform from before, and would re-upload it on
// the very next cycle even though nothing changed. Best-effort: a failed
// read just means the cache stays cold and the next upload attempt pays
// for one real round-trip instead of skipping — same fallback shape as
// every other best-effort call in this file.
//
// Also returns each ready slot's stored descriptive metadata so the caller
// can repopulate state.bridgeSlots. This is what lets a freshly loaded
// page describe slots it never staged itself: everything in bridgeSlots is
// otherwise in-memory bookkeeping written at upload time, so a reload
// (or a different browser, or a cleared cache) would leave real, staged
// slots showing as blank. The device is the only thing that survives all
// of those, which is exactly why the metadata lives there rather than in
// localStorage.
async function refreshSlotHashCache(wsUrl: string): Promise<BridgeSlotInfo[] | null> {
  const url = bridgeHttpUrl(wsUrl, '/tx-status');
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as {
      slots?: { slot: number; ready: boolean; hash: string; message?: string; label?: string; audio_hz?: number }[];
    };
    const cache = slotHashCacheFor(wsUrl);
    const restored: BridgeSlotInfo[] = [];
    for (const s of data.slots ?? []) {
      if (s.ready) cache.set(s.slot, s.hash);
      else cache.delete(s.slot);
      restored.push({
        slot: s.slot,
        message: s.message ?? '',
        label: s.label ?? '',
        // A ready slot genuinely holds audio, whatever this page knows
        // about it — reporting uploaded:false there would misdescribe the
        // device's real state just because this browser session didn't
        // happen to be the one that staged it.
        uploaded: s.ready,
        audioHz: s.audio_hz ?? 0,
      });
    }
    return restored;
  } catch {
    // Best-effort — see this function's own comment.
    return null;
  }
}

// Triggers remote playback of a specific slot and resolves once the
// firmware reports it's no longer playing (either finished naturally or
// was stopped) — polls /tx-status rather than trying to predict playback
// duration client-side, so this stays correct even if the firmware's
// actual playback rate drifts slightly from the nominal
// BRIDGE_PLAYBACK_RATE_HZ. Returns false if nothing could be played at all
// (no buffer uploaded to this slot, bridge unreachable, another slot
// already playing, or the /tx-play call itself failed) — the caller treats
// that the same as "audio playback failed" on the local-speaker path.
async function playBridgeSlotAndWait(wsUrl: string, slot: number, isRunning: () => boolean): Promise<boolean> {
  const playUrl = bridgeHttpUrl(wsUrl, '/tx-play', `slot=${slot}`);
  const statusUrl = bridgeHttpUrl(wsUrl, '/tx-status');
  if (!playUrl || !statusUrl) return false;
  try {
    const playRes = await fetch(playUrl, { method: 'POST' });
    if (!playRes.ok) return false;
  } catch {
    return false;
  }
  // Poll interval short enough that "how long did TX actually take" stays
  // accurate to a fraction of a second (matters for this loop's own
  // post-key-hold timing immediately after), long enough not to spam the
  // bridge's httpd worker over what's otherwise an idle WiFi link for the
  // whole ~1.4-15s a message plays.
  const POLL_MS = 150;
  for (;;) {
    if (!isRunning()) return true; // caller is stopping — don't keep polling a session nobody's waiting on
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    try {
      const res = await fetch(statusUrl);
      if (!res.ok) return true; // bridge dropped mid-playback — nothing more to wait for
      const data = await res.json() as { playing?: boolean; playing_slot?: number };
      if (!data.playing || data.playing_slot !== slot) return true;
    } catch {
      return true; // same reasoning — a status-poll failure mid-playback isn't worth retrying indefinitely
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────
// React's useFTTransmit(mode, baseFrequency, vfoFrequency, onSetPTT) took its
// params positionally and re-synced them via per-param useEffects in the
// calling component. Solid has no automatic dependency tracking on plain
// function args, so this factory instead reads live values through getter
// functions supplied once at creation — the caller's own createEffect(s)
// naturally keep them current without any extra sync plumbing.
export function createFTTransmit(
  getMode: () => FTMode,
  getBaseFrequency: () => number,
  getVfoFrequency: () => number,
  getOnSetPTT: () => ((tx: boolean) => Promise<void>) | undefined,
  // Fake Split's VFO retune (see doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md)
  // — separate from getOnSetPTT rather than folded into it, since it needs
  // to run and be AWAITED strictly before PTT keys (a retune that hasn't
  // landed yet must not let audio start), and separate from
  // getOnTxWindowStart/End below since those exist for an unrelated
  // concern (suspending the I/Q bridge) that doesn't need to block TX.
  // Undefined when no CAT frequency-set is wired up (mirrors getOnSetPTT).
  getOnSetFrequency: () => ((hz: number) => Promise<void>) | undefined = () => undefined,
  // Where TX audio plays — the local speaker (default, matches all prior
  // behavior when omitted) or the ESP32 bridge, uploaded once and played
  // from its own RAM (see uploadIfBridgeSink()/playBridgeSlotAndWait()'s
  // own comments). getBridgeWsUrl only needs to resolve when
  // getAudioSinkKind() returns 'bridge' — it's rewritten to the bridge's
  // plain HTTP control endpoints (bridgeHttpUrl()), not used to open a
  // second WebSocket.
  getAudioSinkKind: () => AudioSinkKind = () => 'speaker',
  getBridgeWsUrl: () => string | undefined = () => undefined,
  // Brackets each keyed TX window (same span as onSetPTT true/false above)
  // so the caller can suspend/resume the bridge's I/Q spectrum connection —
  // see loadSuspendIQDuringTx()'s comment for why. Called unconditionally;
  // it's the caller's job (App.tsx) to check the setting and no-op when
  // it's off or nothing's connected.
  getOnTxWindowStart: () => (() => void) | undefined = () => undefined,
  getOnTxWindowEnd: () => (() => void) | undefined = () => undefined,
  // Fired once per completed transmission with what actually went out.
  //
  // A transmission normally re-enters the contact store by being decoded off
  // the air like any other signal (txTap below feeds the local capture path).
  // The bridge sink has no such loop — the firmware plays the audio from its
  // own PSRAM, so nothing local ever hears it — which left the QSO log with
  // only the other station's half of every bridge-sink exchange. The caller
  // (App.tsx) forwards this to FTDecoder's injectSentMessage(); see that
  // function's comment for the full rationale.
  //
  // Fired for BOTH sinks, not just 'bridge': injection is idempotent for
  // logging purposes (mergeContacts/qsoLogUpsert merge by callsign + time
  // overlap, and extractQSORecords derives RST_SENT from the message text
  // rather than by counting duplicates), and a speaker-sink operator whose
  // rig mutes RX during TX — most of them — has exactly the same gap. Making
  // it unconditional means the log no longer depends on the rig hearing
  // itself, which was never guaranteed on either path.
  getOnSentMessage: () => ((msg: string, windowStart: Date, vfoHz: number, audioHz: number) => void) | undefined = () => undefined,
) {
  const [state, setState] = createSignal<FTTransmitState>({
    status: 'idle',
    queue: [],
    sent: [],
    autoCQ: loadAutoCQ(),
    autoCQIntervalMin: loadAutoCQIntervalMin(),
    autoPTT: loadAutoPTT(),
    allowConsecutiveTx: loadAllowConsecutiveTx(),
    fakeSplit: loadFakeSplit(),
    fakeSplitSweetSpotHz: loadFakeSplitSweetSpotHz(),
    txWindowParity: loadTxWindowParity(),
    error: null,
    outputDeviceId: loadOutputDevice(),
    txGain: loadTxGain(),
    sinkIdSupported: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    preKeyMs: loadPreKeyMs(),
    postKeyMs: loadPostKeyMs(),
    nextTxAtMs: null,
    bridgeSlots: emptyBridgeSlots(),
  });

  let isRunning          = false;
  let outputDevice       = loadOutputDevice();
  let autoCQOn           = loadAutoCQ();
  let autoCQIntervalMin  = loadAutoCQIntervalMin();
  let lastAutoCQAtMs     = 0; // epoch ms of the last auto-CQ transmission, 0 = none sent yet this session
  let autoPTTOn          = loadAutoPTT();
  let allowConsecutiveTx = loadAllowConsecutiveTx();
  let fakeSplitOn        = loadFakeSplit();
  let fakeSplitSweetSpotHz = loadFakeSplitSweetSpotHz();
  let txWindowParity: 'even' | 'odd' = loadTxWindowParity();
  let preKeyMs           = loadPreKeyMs();
  let postKeyMs          = loadPostKeyMs();
  let lastTxWindow       = -1; // epoch ms of last window we transmitted in
  let gain               = loadTxGain();
  let gainNode: GainNode | null = null;
  let txTap: CaptureNode | null = null;
  let queue: TxQueueEntry[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let audioCtx: AudioContext | null = null;
  // Rebuilt (see ensureSink()) whenever the operator's chosen sink kind
  // changes, or lazily on first playback — not eagerly in start(), since
  // getAudioBridge()/getAudioSinkKind() can change mid-session (the panel's
  // own <select>) and a stale sink would otherwise keep routing to the
  // wrong place until the next stop()/start() cycle.
  let sink: AudioSinkHandle | null = null;
  let sinkKind: AudioSinkKind | null = null;

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
      timers.add(t);
    });
  }

  // Fire-and-forget upload of freshly-encoded samples to one of the
  // bridge's 4 TX slots, only when the operator has actually selected the
  // bridge as the TX output right now — see uploadToBridgeSlot()'s own
  // comment for why "upload as soon as encoded" (here) rather than "upload
  // at the moment of TX" was chosen: keeps the timing-critical PTT-key
  // window free of any WiFi upload latency. A message that never actually
  // gets transmitted (e.g. superseded before its window) still gets
  // uploaded — acceptable; a 144-404KB POST over local WiFi is cheap, and
  // the hash-skip check means re-uploading identical content (e.g. an
  // unchanged auto-CQ waveform every cycle) costs nothing beyond the
  // GET-status-free comparison already done client-side.
  // audioHz is the frequency these samples were ENCODED at — passed
  // through to the device as slot metadata (see uploadToBridgeSlot()), not
  // used for anything locally.
  function uploadIfBridgeSink(slot: number, message: string, label: string, samples: Float32Array, sourceRateHz: number, audioHz: number) {
    if (getAudioSinkKind() !== 'bridge') {
      // Nothing will be uploaded, so the requested slot is the only
      // meaningful place to record this locally.
      setBridgeSlotInfo(slot, message, label, true, audioHz);
      return;
    }
    const wsUrl = getBridgeWsUrl();
    if (!wsUrl) { setBridgeSlotInfo(slot, message, label, true, audioHz); return; }
    // Record against the slot the upload RESOLVED to — when identical
    // content already lives in another slot, uploadToBridgeSlot() reuses it
    // and never writes the requested one, so marking the requested slot
    // ready would describe a slot the device didn't actually fill.
    void uploadToBridgeSlot(wsUrl, slot, samples, sourceRateHz, gain, { message, label, audioHz })
      .then(resolved => setBridgeSlotInfo(resolved, message, label, true, audioHz));
  }

  // Updates state.bridgeSlots for one slot. Called unconditionally from
  // uploadIfBridgeSink() regardless of the CURRENT sink kind,
  // deliberately: an operator watching the slot panel while on 'speaker'
  // should still see what WOULD be staged if they switched to 'bridge' —
  // the label reflects "what this slot is assigned to," not "what's
  // currently sitting in the device's PSRAM."
  function setBridgeSlotInfo(slot: number, message: string, label: string, uploaded: boolean, audioHz = 0) {
    setState(prev => ({
      ...prev,
      bridgeSlots: prev.bridgeSlots.map(s => s.slot === slot ? { slot, message, label, uploaded, audioHz } : s),
    }));
  }

  // Replaces state.bridgeSlots with what the DEVICE reports it's holding,
  // and seeds the hash-skip cache in the same round-trip (see
  // refreshSlotHashCache()). Called on start(), and exposed so the TX panel
  // can also call it directly — a page that just loaded has empty
  // bridgeSlots and no way to describe already-staged slots until it asks
  // the device, which is the whole reason the metadata is stored there.
  async function syncBridgeSlotsFromDevice(): Promise<void> {
    const wsUrl = getBridgeWsUrl();
    if (!wsUrl) return;
    const restored = await refreshSlotHashCache(wsUrl);
    if (!restored || restored.length === 0) return;
    setState(prev => ({
      ...prev,
      bridgeSlots: prev.bridgeSlots.map(s => restored.find(r => r.slot === s.slot) ?? s),
    }));
  }

  // Which lookahead slot (see TX_SLOT_QUEUE_LOOKAHEAD's own comment) a
  // just-encoded queue entry should upload to — its POSITION in the queue
  // at the moment encoding finishes, not a role fixed at enqueue time,
  // since entries ahead of it can be dequeued/transmitted before this one
  // is. Returns null for any position beyond the lookahead pool's depth —
  // those entries simply don't get a bridge pre-upload and fall back to
  // uploading at actual TX time (see the play loop's own fallback below),
  // same as this whole feature not existing for a queue deeper than 2.
  function lookaheadSlotForQueuePosition(entryId: string): number | null {
    const idx = queue.findIndex(e => e.id === entryId);
    if (idx < 0 || idx >= TX_SLOT_QUEUE_LOOKAHEAD.length) return null;
    return TX_SLOT_QUEUE_LOOKAHEAD[idx];
  }

  // ── Encode on enqueue ─────────────────────────────────────────────────────
  // Start encoding the moment a message is added. By the time the window
  // arrives (~seconds away), samples are already ready in the entry.

  // Per-entry generation counters — a re-encode of the SAME queued entry
  // (e.g. syncParams() re-encoding every stale entry after a base-freq
  // change) supersedes any still-in-flight encode for that entry.
  // Real-hardware finding this fixes (2026-08-28): several separate,
  // legitimate TX-marker drag-release commits in quick succession each
  // correctly triggered exactly one re-encode of every stale entry (the
  // committed gate worked), but with no cancellation, EVERY one of those
  // per-commit encodes still ran to completion and uploaded — the single-
  // threaded encode worker just queued them up and drained them
  // sequentially, saturating the bridge's WiFi link with several minutes'
  // worth of uploads for what the operator experienced as a few quick
  // marker nudges.
  const encodeGenerationByEntryId = new Map<string, number>();

  function startEncode(entry: TxQueueEntry) {
    const ENC_RATE = 12000;
    const myGeneration = (encodeGenerationByEntryId.get(entry.id) ?? 0) + 1;
    encodeGenerationByEntryId.set(entry.id, myGeneration);
    // Fake Split always encodes at the FIXED sweet-spot tone (independent of
    // the operator's chosen Audio Hz / entry.audioHz — see fakeSplitSweetSpotHz's
    // own comment for why those must NOT be the same value), ignoring the
    // entry's own target tone for the ENCODE itself; that target is instead
    // recovered as a VFO delta computed at TX time (runLoop, below) from
    // entry.audioHz vs. fakeSplitEncodedHz. This is the one case where
    // encodeHz and entry.audioHz deliberately diverge.
    const fakeSplitEncodedHz = fakeSplitOn ? fakeSplitSweetSpotHz : undefined;
    const encodeHz = fakeSplitEncodedHz ?? entry.audioHz ?? getBaseFrequency();
    encodeAsync(entry.message, getMode(), ENC_RATE, encodeHz)
      .then(samples => {
        if (encodeGenerationByEntryId.get(entry.id) !== myGeneration) return; // superseded by a newer re-encode of this same entry
        const slot = lookaheadSlotForQueuePosition(entry.id);
        if (slot !== null) uploadIfBridgeSink(slot, entry.message, entry.label, samples, ENC_RATE, encodeHz);
        setState(prev => {
          const q = prev.queue.map(e =>
            e.id === entry.id ? { ...e, samples, encodeStatus: 'ready' as const, fakeSplitEncodedHz } : e
          );
          queue = q;
          return { ...prev, queue: q };
        });
      })
      .catch(err => {
        if (encodeGenerationByEntryId.get(entry.id) !== myGeneration) return; // superseded — a newer re-encode owns this entry's status now
        const encodeError = err instanceof Error ? err.message : String(err);
        setState(prev => {
          const q = prev.queue.map(e =>
            e.id === entry.id ? { ...e, encodeStatus: 'error' as const, encodeError } : e
          );
          queue = q;
          return { ...prev, queue: q };
        });
      });
  }

  // ── Auto-CQ sample cache ──────────────────────────────────────────────────
  // The CQ message is encoded eagerly and cached outside the queue so the loop
  // can play it immediately without injecting a queue entry (which would add
  // a full window of latency and cause duplicate-key issues in the UI).

  let autoCQSamples: Float32Array | null = null;
  let autoCQMsgCached  = '';   // message text that was last encoded
  let autoCQModeCached = '';   // mode that was encoded for
  let autoCQFreqCached = 0;    // baseFreq that was encoded for
  // Set only when autoCQSamples was encoded under Fake Split — mirrors
  // TxQueueEntry.fakeSplitEncodedHz. Needed so runLoop's delta computation
  // for auto-CQ compares against what was ACTUALLY baked into
  // autoCQSamples (the sweet spot), not getBaseFrequency() — auto-CQ has
  // no per-entry audioHz override, but it still needs its own VFO shift
  // whenever Fake Split is on, same as any other entry: getBaseFrequency()
  // is auto-CQ's target frequency, and the sweet spot is what it's encoded
  // at, and those are different values whenever Fake Split is enabled.
  let autoCQFakeSplitEncodedHz: number | undefined;
  let autoCQMessage    = '';
  // Bumped by every rebuildAutoCQCache() call — lets an in-flight encode's
  // own .then() notice a NEWER call has already superseded it and skip
  // BOTH the state write and the /tx-audio upload, not just the write (the
  // freq/mode/msg equality check above already did that, but real hardware
  // testing found repeated legitimate commits — several separate drag-
  // release cycles in quick succession, each syncParams() call correctly
  // firing exactly once per drag per the committed gate — still queued one
  // real encode+upload per commit, with no way for a newer commit to
  // cancel an older one still draining through the single-threaded encode
  // worker. This generation counter is a stronger, more direct guard than
  // comparing captured freq/mode/msg values, which can spuriously PASS if
  // an operator's later drag happens to land back on a frequency an
  // earlier, now-irrelevant encode also targeted.
  let autoCQGeneration = 0;

  function rebuildAutoCQCache(msg: string) {
    if (!msg) { autoCQSamples = null; autoCQMsgCached = ''; return; }
    const myGeneration = ++autoCQGeneration;
    autoCQSamples = null; // invalidate while encoding
    autoCQMsgCached  = msg;
    autoCQModeCached = getMode();
    autoCQFreqCached = getBaseFrequency();
    // Same divergence as startEncode(): under Fake Split, ENCODE at the
    // fixed sweet spot (not getBaseFrequency(), auto-CQ's actual target),
    // and remember which so runLoop's delta computation for auto-CQ has
    // something real to compare against — see autoCQFakeSplitEncodedHz's
    // own comment. autoCQFreqCached still tracks getBaseFrequency() (the
    // TARGET, used for cache-invalidation below) regardless.
    const encodedFakeSplitHz = fakeSplitOn ? fakeSplitSweetSpotHz : undefined;
    const encodeHz = encodedFakeSplitHz ?? autoCQFreqCached;
    encodeAsync(msg, getMode(), 12000, encodeHz)
      .then(samples => {
        // Superseded by a newer rebuildAutoCQCache() call while this one
        // was still encoding — skip both the state write and the upload
        // outright, regardless of whether freq/mode/msg happen to still
        // match (see autoCQGeneration's own comment for why that
        // comparison alone isn't a strong enough guard).
        if (myGeneration !== autoCQGeneration) return;
        // Only store if message/mode/freq/Fake-Split-state haven't changed
        // since we started — a mid-encode fakeSplit toggle or sweet-spot
        // change must not let a stale (wrong-tone) waveform through.
        if (
          autoCQMsgCached  === msg &&
          autoCQModeCached === getMode() &&
          autoCQFreqCached === getBaseFrequency() &&
          encodedFakeSplitHz === (fakeSplitOn ? fakeSplitSweetSpotHz : undefined)
        ) {
          autoCQSamples = samples;
          autoCQFakeSplitEncodedHz = encodedFakeSplitHz;
          uploadIfBridgeSink(TX_SLOT_AUTOCQ, msg, 'CQ (auto)', samples, 12000, encodeHz);
        }
      })
      .catch(() => { autoCQSamples = null; });
  }

  // ── Audio context ─────────────────────────────────────────────────────────

  async function getAudioContext(): Promise<AudioContext> {
    const ctx = audioCtx!;
    const deviceId = outputDevice;
    if (deviceId && 'setSinkId' in ctx) {
      try {
        // @ts-expect-error — setSinkId not yet in TS lib
        await ctx.setSinkId(deviceId);
      } catch { /* device unplugged */ }
    }
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  // ── Sent log helpers ──────────────────────────────────────────────────────
  // Collapse a repeat of the most-recent message (same text, no error) into
  // one row — prevents the log from filling with repeated auto-CQ rows — but
  // REPLACE it so windowStart reflects the latest transmission: auto-reply
  // decides whose turn it is by comparing this timestamp against the peer's
  // last message, and a stale one would misread a retry as already answered.
  // Cap at 50 entries total.

  function dedupeAndCapSent(entry: SentEntry, prev: SentEntry[]): SentEntry[] {
    if (!entry.error && prev.length > 0 && prev[0].message === entry.message) {
      return [entry, ...prev.slice(1)]; // refresh the row in place
    }
    return [entry, ...prev].slice(0, 50);
  }

  // ── Transmit loop ─────────────────────────────────────────────────────────

  async function runLoop() {
    // Sleep to the next UTC window boundary. Always skip at least one full
    // window on startup to avoid transmitting mid-window.
    const sleepToNextBoundary = (windowSec: number, skipExtra = false): Promise<void> => {
      const windowMs  = windowSec * 1000;
      const nowMs     = Date.now();
      const elapsed   = nowMs % windowMs;
      const remaining = windowMs - elapsed;
      // If we're within 50ms of a boundary, skip to the one after
      const wait = (remaining <= 50 || skipExtra) ? remaining + windowMs : remaining;
      return sleep(wait);
    };

    await sleepToNextBoundary(FT_WINDOW_SECONDS[getMode()], true);

    while (isRunning) {
      const windowSec = FT_WINDOW_SECONDS[getMode()];
      const windowMs  = windowSec * 1000;

      // We are now at a window boundary. Decide what this window does.
      setState(prev => ({ ...prev, status: 'waiting' }));

      // Consecutive-TX guard: if we transmitted in the immediately preceding window,
      // this window is a forced listen window.
      const nowMs              = Date.now();
      const currentWindowStart = nowMs - (nowMs % windowMs);
      const prevWindowStart    = currentWindowStart - windowMs;
      const wrongParity        = isWrongWindowParity(currentWindowStart, windowMs, getMode(), txWindowParity);
      const skipForListen      = wrongParity || (!allowConsecutiveTx &&
        (lastTxWindow === prevWindowStart || lastTxWindow === currentWindowStart));

      if (skipForListen) {
        // Nothing will transmit at the upcoming boundary — the UI's countdown
        // must not show time-to-that-boundary as if it were a real chance.
        setState(prev => ({ ...prev, nextTxAtMs: null }));
        await sleepToNextBoundary(windowSec);
        if (!isRunning) break;
        continue;
      }

      // Decide what to transmit this window.
      // Queued entries take priority; auto-CQ fills in when the queue is empty
      // AND at most once per configured interval — otherwise an unattended
      // beacon would key up in every eligible window (every ~15s on FT8).
      const queuedEntry     = queue[0] ?? null;
      const autoCQDueMs     = lastAutoCQAtMs + autoCQIntervalMin * 60_000;
      const autoCQDue       = nowMs >= autoCQDueMs;
      const useAutoCQ       = !queuedEntry && autoCQOn && !!autoCQSamples && autoCQDue;

      if (!queuedEntry && !useAutoCQ) {
        // Same as above: this window's decision is locked in as "nothing to
        // send" (empty queue, or auto-CQ not due yet) — a message queued a
        // moment from now can't go out until the NEXT-next boundary, so the
        // countdown shouldn't imply the upcoming one is live.
        setState(prev => ({ ...prev, nextTxAtMs: null }));
        await sleepToNextBoundary(windowSec);
        if (!isRunning) break;
        continue;
      }

      // Committed to transmitting at this window's boundary (currentWindowStart).
      setState(prev => ({ ...prev, nextTxAtMs: currentWindowStart }));

      // ── Resolve samples ───────────────────────────────────────────────────
      let samples: Float32Array | null = null;
      let txMessage = '';
      let txLabel   = '';
      let txId      = '';
      let txAudioHz = getBaseFrequency();
      // Set only when this transmission was encoded under Fake Split (see
      // startEncode's/rebuildAutoCQCache's own comments) — mirrors
      // TxQueueEntry.fakeSplitEncodedHz for whichever source (queue entry
      // or auto-CQ cache) actually supplied `samples` below.
      let fakeSplitEncodedHz: number | undefined;

      if (useAutoCQ) {
        samples   = autoCQSamples;
        txMessage = autoCQMsgCached;
        txLabel   = 'CQ (auto)';
        txId      = ''; // filled in below from windowStart
        fakeSplitEncodedHz = autoCQFakeSplitEncodedHz;
      } else {
        // Re-read from queue — entry may have been dequeued or its samples updated
        const live = queue.find(e => e.id === queuedEntry!.id) ?? queuedEntry!;

        if (live.encodeStatus === 'error') {
          const sent: SentEntry = {
            id: live.id, message: live.message, label: live.label,
            windowStart: new Date(),
            vfoHz: getVfoFrequency(), audioHz: live.audioHz ?? getBaseFrequency(),
            error: live.encodeError,
          };
          setState(prev => ({
            ...prev,
            queue: prev.queue.filter(q => q.id !== live.id),
            sent: dedupeAndCapSent(sent, prev.sent),
            error: live.encodeError ?? 'Encode error',
          }));
          queue = queue.filter(q => q.id !== live.id);
          continue;
        }

        // If still encoding, wait briefly (rare — encode starts on enqueue)
        if (live.encodeStatus === 'pending' || !live.samples) {
          await sleep(200);
          if (!isRunning) break;
        }

        const finalEntry = queue.find(e => e.id === live.id) ?? live;
        if (!finalEntry.samples) continue;

        samples   = finalEntry.samples;
        txMessage = finalEntry.message;
        txLabel   = finalEntry.label;
        txId      = finalEntry.id;
        txAudioHz = finalEntry.audioHz ?? getBaseFrequency();
        fakeSplitEncodedHz = finalEntry.fakeSplitEncodedHz;
      }

      if (!samples) continue;

      const windowStart    = new Date();
      const windowStartMs  = windowStart.getTime();
      const txWindowBucket = windowStartMs - (windowStartMs % windowMs);
      lastTxWindow = txWindowBucket;
      // For auto-CQ, generate a unique sent-log id from exact playback time
      if (useAutoCQ) { txId = `autocq-${windowStartMs}`; lastAutoCQAtMs = windowStartMs; }
      setState(prev => ({ ...prev, status: 'playing', error: null }));

      // Fake Split (see doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md): retune
      // the VFO BEFORE PTT keys so the operator's actual intended TX
      // frequency (their Audio Hz / the entry's pinned audioHz — txAudioHz)
      // is preserved on air, even though `samples` was encoded at the FIXED
      // sweet spot instead (see startEncode's/rebuildAutoCQCache's own
      // comments — those two are deliberately different values now).
      // Awaited: an unconfirmed/unsettled retune must not let audio start,
      // or the first symbol(s) go out at the wrong frequency with no local
      // sign anything went wrong. Restored after PTT-off, below.
      let fakeSplitOriginalVfoHz: number | null = null;
      const onSetFrequency = getOnSetFrequency();
      if (fakeSplitOn && onSetFrequency) {
        const desiredHz = txAudioHz; // what SHOULD go out over the air
        // fakeSplitEncodedHz reflects what `samples` was ACTUALLY encoded
        // at, captured at encode time — NOT re-read from the live
        // fakeSplitSweetSpotHz setting here, and deliberately not defaulted
        // to getBaseFrequency() on a miss either: doing either would silently
        // compute a delta against the WRONG baseline the moment Fake Split
        // was toggled on/changed after this entry was already encoded (a
        // real race — syncParams()'s re-encode is debounced/async, not
        // synchronous with the toggle). Missing entirely means "not
        // encoded under Fake Split yet" — skip the shift outright rather
        // than transmit at the sweet spot's audio while shifting the VFO by
        // a bogus amount.
        if (fakeSplitEncodedHz !== undefined) {
          const delta = desiredHz - fakeSplitEncodedHz;
          if (delta !== 0) {
            const originalVfoHz = getVfoFrequency();
            try {
              await Promise.race([
                onSetFrequency(originalVfoHz + delta),
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Fake Split retune timeout')), 1500)),
              ]);
              fakeSplitOriginalVfoHz = originalVfoHz;
              if (FAKE_SPLIT_SETTLE_MS > 0) await sleep(FAKE_SPLIT_SETTLE_MS);
            } catch {
              // CAT not connected, timed out, or unconfirmed — proceed
              // without the shift rather than silently transmit
              // off-frequency AND blow the window; the operator sees this
              // via the normal "not confirmed" CAT error surfacing (see
              // useRadioCAT's noteConfirmFailure), not a separate Fake
              // Split error path.
            }
          }
        }
      }

      getOnTxWindowStart()?.();

      // Auto-PTT on — race with a 500ms timeout so a non-responsive CAT never blocks TX
      const onSetPTT = getOnSetPTT();
      if (autoPTTOn && onSetPTT) {
        try {
          await Promise.race([
            onSetPTT(true),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }

      // Pre-key (warm-up) hold: give an external PA/relay time to switch
      // before RF audio starts. This delays audio start by preKeyMs relative
      // to the window boundary (simpler and safer than trying to key early
      // without shifting playback — see git history for why that approach
      // was reverted). Only meaningful with Auto-PTT actually wired up.
      if (preKeyMs > 0 && autoPTTOn && onSetPTT) await sleep(preKeyMs);
      if (!isRunning) break;

      // Bridge sink: no local Web Audio playback at all — the message was
      // already uploaded to one of the bridge's 4 TX slots the moment it
      // finished encoding (see uploadIfBridgeSink()/
      // lookaheadSlotForQueuePosition()), so TX here is normally just "tell
      // the firmware to play what it already has, and wait" — see
      // playBridgeSlotAndWait()'s own comment for why this polls
      // /tx-status rather than the local AudioBufferSourceNode path below,
      // which is ONLY for the 'speaker' sink now.
      //
      // slot resolution: useAutoCQ always maps to TX_SLOT_AUTOCQ. A queued
      // entry is always queue[0] here (queuedEntry was read as queue[0]
      // earlier this same iteration and nothing dequeues ahead of it
      // between then and here), so it always maps to
      // TX_SLOT_QUEUE_LOOKAHEAD[0] — EXCEPT the rare case this whole
      // pre-upload scheme doesn't cover: the sink was 'speaker' (or no
      // bridge wsUrl existed) at encode time and only switched to 'bridge'
      // moments before this window, so nothing was ever uploaded. Rather
      // than silently fail in that case, upload right here, at the cost of
      // reintroducing this one transmission's upload latency into the
      // critical path — exactly the tradeoff this feature exists to avoid
      // in the COMMON case, accepted here only as a fallback for the
      // uncommon one.
      if (getAudioSinkKind() === 'bridge') {
        const wsUrl = getBridgeWsUrl();
        const wantSlot = useAutoCQ ? TX_SLOT_AUTOCQ : TX_SLOT_QUEUE_LOOKAHEAD[0];
        // uploadToBridgeSlot() may redirect us to a different slot that
        // already holds byte-identical audio — always play what it returns.
        let slot = wantSlot;
        if (wsUrl) {
          slot = await uploadToBridgeSlot(wsUrl, wantSlot, samples, 12000, gain, { message: txMessage, label: txLabel, audioHz: txAudioHz });
          setBridgeSlotInfo(slot, txMessage, txLabel, true, txAudioHz);
        }
        const ok = wsUrl && await playBridgeSlotAndWait(wsUrl, slot, () => isRunning);
        if (!ok) {
          setState(prev => ({ ...prev, error: 'Bridge playback failed — falling back requires switching output to Local speaker' }));
        }
      } else {
        try {
          const ctx = await getAudioContext();
          if (gainNode) ensureSink(ctx, gainNode);
          const owned = new Float32Array(samples.length);
          owned.set(samples);
          const buf = ctx.createBuffer(1, owned.length, 12000);
          buf.copyToChannel(owned, 0);

          await new Promise<void>(resolve => {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(gainNode ?? ctx.destination);
            if (txTap) src.connect(txTap.node);
            src.onended = () => resolve();
            src.start(ctx.currentTime);
          });
        } catch (err) {
          setState(prev => ({
            ...prev,
            error: err instanceof Error ? err.message : 'Audio playback failed',
          }));
        }
      }

      // Post-key hold (cool-down): keep PTT up briefly after audio ends before
      // unkeying, e.g. to let an external PA/relay settle before it drops.
      // Only meaningful with Auto-PTT actually wired up.
      if (postKeyMs > 0 && autoPTTOn && onSetPTT) await sleep(postKeyMs);

      // Auto-PTT off
      const onSetPTTOff = getOnSetPTT();
      if (autoPTTOn && onSetPTTOff) {
        try {
          await Promise.race([
            onSetPTTOff(false),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }

      // Fake Split: restore the RX dial frequency now that TX has ended.
      // Fired right after PTT-off resolves/rejects rather than chained onto
      // its own confirmation — setPTT(false) can retry forever in the
      // background on a stuck radio (see useRadioCAT's pttConfirmAlarm),
      // and the VFO restore must not wait on that. Awaited for symmetry
      // with the pre-TX retune, but nothing downstream blocks on it the way
      // audio start blocks on the pre-TX one.
      if (fakeSplitOriginalVfoHz !== null && onSetFrequency) {
        try {
          await Promise.race([
            onSetFrequency(fakeSplitOriginalVfoHz),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Fake Split restore timeout')), 1500)),
          ]);
        } catch { /* CAT not connected or timed out — next poll/manual check will surface the mismatch */ }
      }

      getOnTxWindowEnd()?.();

      const sentVfoHz = fakeSplitOriginalVfoHz ?? getVfoFrequency();
      const sent: SentEntry = {
        id: txId, message: txMessage, label: txLabel, windowStart,
        vfoHz: sentVfoHz, audioHz: txAudioHz,
      };
      // Record what we just sent into the contact store / QSO log. Guarded so
      // a throwing consumer can never break the TX loop itself — a failed log
      // update must not stop the operator from transmitting the next window.
      try {
        getOnSentMessage()?.(txMessage, windowStart, sentVfoHz, txAudioHz);
      } catch { /* logging must never interrupt TX */ }
      setState(prev => ({
        ...prev, status: 'waiting',
        // Auto-CQ entries never enter the queue, so only filter for real entries
        queue: useAutoCQ ? prev.queue : prev.queue.filter(q => q.id !== txId),
        sent: dedupeAndCapSent(sent, prev.sent),
      }));
      if (!useAutoCQ) {
        queue = queue.filter(q => q.id !== txId);
      }
    }
    setState(prev => ({ ...prev, status: 'idle' }));
  }

  // Invalidate the auto-CQ cache when mode or baseFreq changes so the cached
  // waveform stays current. The original synced this via per-param
  // useEffects on the hook's `mode`/`baseFrequency` args; here the calling
  // component drives it explicitly (see syncParams()) since this factory has
  // no dependency tracking of its own on the getter functions.
  let lastSyncedMode = getMode();
  let lastSyncedFreq = getBaseFrequency();
  // Tracked alongside mode/freq: what a stale entry should be re-encoded AT
  // (encodeHz — sweet spot vs. target) depends on these too, not just on
  // getBaseFrequency() itself. Initialized eagerly so a syncParams() call
  // made before setFakeSplit()/setFakeSplitSweetSpotHz() ever ran doesn't
  // spuriously see a "change" on its first real invocation.
  let lastSyncedFakeSplit = fakeSplitOn;
  let lastSyncedSweetSpot = fakeSplitSweetSpotHz;
  function syncParams() {
    const mode = getMode();
    const freq = getBaseFrequency();
    const modeChanged = mode !== lastSyncedMode;
    const freqChanged = freq !== lastSyncedFreq;
    // A Fake Split on/off flip or sweet-spot change alone (Audio Hz and
    // mode both unchanged) still means every already-encoded entry's
    // encodeHz is now wrong — see startEncode's own comment on why
    // encodeHz and entry.audioHz/getBaseFrequency() diverge under Fake
    // Split. Tracked separately from freqChanged because it invalidates
    // MORE than a plain freq change does (see fakeSplitChanged's use
    // below) — a pinned per-entry audioHz normally survives a freq-only
    // change, but must NOT survive a Fake Split toggle, since Fake Split
    // changes what tone gets encoded regardless of any per-entry pin.
    const fakeSplitChanged = fakeSplitOn !== lastSyncedFakeSplit ||
      (fakeSplitOn && fakeSplitSweetSpotHz !== lastSyncedSweetSpot);
    if (modeChanged || freqChanged || fakeSplitChanged) {
      lastSyncedMode = mode;
      lastSyncedFreq = freq;
      lastSyncedFakeSplit = fakeSplitOn;
      lastSyncedSweetSpot = fakeSplitSweetSpotHz;
      if (autoCQMessage) rebuildAutoCQCache(autoCQMessage);
      // Queued entries were encoded with the params captured at enqueue time —
      // a later Audio Hz (or mode) change must re-encode them, or they'd still
      // transmit on the old frequency. Entries with a pinned per-conversation
      // audioHz don't follow the global Audio Hz, so a freq-only change leaves
      // them alone; a mode change (or a Fake Split change — see
      // fakeSplitChanged above) invalidates everything. Mark stale entries
      // pending first so the TX loop can't send old samples mid-re-encode;
      // the encode worker is FIFO, so a re-encode's result always lands after
      // any in-flight first encode for the same entry.
      const stale = queue.filter(e => modeChanged || fakeSplitChanged || e.audioHz === undefined);
      if (stale.length > 0) {
        const staleIds = new Set(stale.map(e => e.id));
        setState(prev => {
          const q = prev.queue.map(e =>
            staleIds.has(e.id) ? { ...e, samples: null, encodeStatus: 'pending' as const } : e
          );
          queue = q;
          return { ...prev, queue: q };
        });
        for (const e of queue) if (staleIds.has(e.id)) startEncode(e);
      }
    }
  }

  // ── Sink (speaker only now) ────────────────────────────────────────────────
  // The 'bridge' AudioSinkKind no longer routes through here at all — see
  // uploadIfBridgeSink()/playBridgeSlotAndWait()'s own comments: bridge TX
  // audio is uploaded once and played from the ESP32's own RAM, with no
  // local Web Audio graph involved (that's the whole point — no live stream
  // for WiFi jitter to glitch). This function only ever needs to build the
  // speaker sink now, but is kept (rather than inlined) since start()/the
  // play loop's speaker branch both still need somewhere to (re-)build it
  // lazily on first real use.
  function ensureSink(ctx: AudioContext, node: GainNode): void {
    if (sink && sinkKind === 'speaker') return;
    node.disconnect();
    sink?.release();
    sink = speakerSink(ctx);
    sinkKind = 'speaker';
    sink.connectSource(node);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function start() {
    if (isRunning) return;
    if (!FT_SUPPORTED[getMode()]) return;
    // Best-effort seed of slotHashCache from whatever the bridge already
    // has — see refreshSlotHashCache()'s own comment for why this matters
    // (without it, a fresh page load has no way to know slot 0 already
    // holds the exact auto-CQ waveform from a previous session, and
    // re-uploads it needlessly on the very next cycle). Harmless to call
    // even when the sink is 'speaker' or no bridge is configured —
    // bridgeHttpUrl() itself no-ops on an invalid/missing wsUrl.
    void syncBridgeSlotsFromDevice();
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = gain;
      sink = null;
      sinkKind = null;
      ensureSink(audioCtx, gainNode);

      // Ring-buffer tap for the global "Rec" feature. Each playback source
      // also connects to this node (pre-gain, so the recording level doesn't
      // depend on the TX gain setting); its own output stays silent — the
      // node's own output is never connected onward, only this capture path
      // reads from it. AudioWorkletNode (unlike the old ScriptProcessorNode)
      // runs its capture on the audio thread, not the main thread — this tap
      // is literally the only record of what was actually played out, so a
      // main-thread stall silently corrupting/dropping it here would be
      // invisible until someone tried to verify a past transmission.
      const ctx = audioCtx;
      txTap = await createCaptureNode(ctx, 4096, (samples) => {
        audioRecorder.write('output', samples, ctx.sampleRate);
      });
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    isRunning = true;
    runLoop();
  }

  function stop() {
    isRunning = false;
    clearTimers();
    if (txTap) {
      txTap.disconnect();
      txTap = null;
    }
    sink?.release();
    sink = null;
    sinkKind = null;
    audioCtx?.close().catch(() => null);
    audioCtx = null;
    if (autoPTTOn) {
      getOnSetPTT()?.(false).catch(() => null);
    }
    // Safety net: if stop() lands mid-TX-window (operator hit Stop while
    // keyed), make sure the I/Q connection getOnTxWindowStart() suspended
    // actually resumes — the normal getOnTxWindowEnd() call after PTT-off
    // in the loop above never runs when the loop is aborted this way.
    getOnTxWindowEnd()?.();
  }

  function enqueue(entry: Omit<TxQueueEntry, 'samples' | 'encodeStatus'>) {
    const full: TxQueueEntry = { ...entry, samples: null, encodeStatus: 'pending' };
    startEncode(full);
    setState(prev => {
      const q = [...prev.queue, full];
      queue = q;
      return { ...prev, queue: q };
    });
  }

  // Prepend to queue — for auto-reply so it plays before other queued entries
  function enqueueFirst(entry: Omit<TxQueueEntry, 'samples' | 'encodeStatus'>) {
    const full: TxQueueEntry = { ...entry, samples: null, encodeStatus: 'pending' };
    startEncode(full);
    setState(prev => {
      const q = [full, ...prev.queue];
      queue = q;
      return { ...prev, queue: q };
    });
  }

  function dequeue(id: string) {
    setState(prev => {
      const q = prev.queue.filter(e => e.id !== id);
      queue = q;
      return { ...prev, queue: q };
    });
  }

  function moveUp(id: string) {
    setState(prev => {
      const idx = prev.queue.findIndex(e => e.id === id);
      if (idx <= 0) return prev;
      const q = [...prev.queue];
      [q[idx - 1], q[idx]] = [q[idx], q[idx - 1]];
      queue = q;
      return { ...prev, queue: q };
    });
  }

  function setAutoCQ(v: boolean) {
    autoCQOn = v;
    saveAutoCQ(v);
    // Reset the cooldown on enable so the first CQ fires on the next eligible
    // window instead of waiting out a stale interval from a previous session.
    if (v) lastAutoCQAtMs = 0;
    setState(prev => ({ ...prev, autoCQ: v }));
  }

  function setAutoCQIntervalMin(v: number) {
    const clamped = Math.max(1, Math.min(60, Math.round(v)));
    autoCQIntervalMin = clamped;
    saveAutoCQIntervalMin(clamped);
    setState(prev => ({ ...prev, autoCQIntervalMin: clamped }));
  }

  function setPreKeyMs(v: number) {
    const clamped = Math.max(0, Math.min(MAX_PREKEY_MS, Math.round(v)));
    preKeyMs = clamped;
    savePreKeyMs(clamped);
    setState(prev => ({ ...prev, preKeyMs: clamped }));
  }

  function setPostKeyMs(v: number) {
    const clamped = Math.max(0, Math.min(MAX_POSTKEY_MS, Math.round(v)));
    postKeyMs = clamped;
    savePostKeyMs(clamped);
    setState(prev => ({ ...prev, postKeyMs: clamped }));
  }

  function setAutoCQMessage(msg: string) {
    autoCQMessage = msg;
    rebuildAutoCQCache(msg);
  }

  function setOutputDevice(deviceId: string) {
    outputDevice = deviceId;
    saveOutputDevice(deviceId);
    setState(prev => ({ ...prev, outputDeviceId: deviceId }));
  }

  function setTxGain(v: number) {
    gain = v;
    if (gainNode) gainNode.gain.value = v;
    saveTxGain(v);
    setState(prev => ({ ...prev, txGain: v }));
  }

  function setAutoPTT(v: boolean) {
    autoPTTOn = v;
    saveAutoPTT(v);
    setState(prev => ({ ...prev, autoPTT: v }));
  }

  function setAllowConsecutiveTx(v: boolean) {
    allowConsecutiveTx = v;
    saveAllowConsecutiveTx(v);
    setState(prev => ({ ...prev, allowConsecutiveTx: v }));
  }

  function setFakeSplit(v: boolean) {
    fakeSplitOn = v;
    saveFakeSplit(v);
    setState(prev => ({ ...prev, fakeSplit: v }));
  }

  function setFakeSplitSweetSpotHz(v: number) {
    saveFakeSplitSweetSpotHz(v); // clamps internally
    fakeSplitSweetSpotHz = loadFakeSplitSweetSpotHz(); // re-read the clamped value
    setState(prev => ({ ...prev, fakeSplitSweetSpotHz }));
  }

  function setTxWindowParity(v: 'even' | 'odd') {
    txWindowParity = v;
    saveTxWindowParity(v);
    setState(prev => ({ ...prev, txWindowParity: v }));
  }

  function clearSent() {
    setState(prev => ({ ...prev, sent: [] }));
  }

  // Removes a slot's cached message — see BridgeSlotInfo's own comment for
  // why this needs a real firmware call (POST /tx-clear), not just wiping
  // the local label: without it, the device would still happily play
  // stale audio for a slot the operator explicitly asked to forget. Clears
  // the local hash cache too so a later re-upload to this slot (e.g. the
  // queue reassigning it to a new entry) isn't skipped on a stale "already
  // matches" comparison against content that no longer exists on-device.
  // Best-effort against the bridge (same fallback shape as every other
  // /tx-* call in this file) — the local state clears either way, since an
  // operator clicking "remove" wants the panel to reflect that regardless
  // of whether the bridge round-trip itself succeeds.
  // Requeue a message that is already staged in one of the bridge's TX
  // slots, so it goes out on the next available window.
  //
  // The point is cross-session reuse: slot metadata (message/label/Hz) lives
  // on the DEVICE alongside the audio, so syncBridgeSlotsFromDevice() can
  // repopulate it on mount — which means an operator who reloads the page,
  // opens a different browser, or comes back the next day can still see and
  // resend what a previous session staged, with no local record of it at all.
  // Without this, a staged slot could only be inspected or cleared; actually
  // sending it again meant retyping the message by hand.
  //
  // Deliberately re-encodes locally rather than just triggering /tx-play on
  // that slot directly. Three reasons:
  //   - The TX loop is built around a queue entry carrying its own samples
  //     (window timing, PTT bracketing, the sent log, self-logging). Playing a
  //     slot out-of-band would bypass all of it.
  //   - The queue's lookahead assigns slots by queue POSITION
  //     (lookaheadSlotForQueuePosition), so the requeued entry may legitimately
  //     end up staged in a different slot than the one it came from.
  //   - FT8 encoding is deterministic: same message + mode + Hz gives
  //     byte-identical audio. uploadToBridgeSlot() hashes before uploading, so
  //     if the content really is unchanged the upload is skipped and the round
  //     trip costs nothing.
  //
  // audioHz is pinned from the slot rather than left to follow the panel's
  // global Audio Hz — the slot records what it was encoded at, and an operator
  // resending a staged message means that message, not a copy retuned to
  // wherever the marker happens to sit now. A slot with no recorded Hz (0,
  // e.g. staged by an older firmware) falls back to the panel default.
  //
  // Returns false when the slot holds nothing to send; the caller is expected
  // to only offer this for a slot whose `uploaded` is true.
  function enqueueBridgeSlot(slot: number): boolean {
    const info = state().bridgeSlots.find(s => s.slot === slot);
    if (!info?.uploaded || !info.message) return false;
    enqueue({
      // Random suffix, not a timestamp: two requeues of the same slot inside
      // the same millisecond would otherwise collide, and every queue
      // operation (dequeue/moveUp/the loop's own lookups) addresses entries
      // by id.
      id: `slot${slot}-${Math.random().toString(36).slice(2, 9)}`,
      message: info.message,
      label: info.label || info.message,
      audioHz: info.audioHz > 0 ? info.audioHz : undefined,
    });
    return true;
  }

  async function clearBridgeSlot(slot: number): Promise<void> {
    setBridgeSlotInfo(slot, '', '', false);
    const wsUrl = getBridgeWsUrl();
    if (!wsUrl) return;
    slotHashCacheFor(wsUrl).delete(slot);
    const url = bridgeHttpUrl(wsUrl, '/tx-clear', `slot=${slot}`);
    if (!url) return;
    try {
      await fetch(url, { method: 'POST' });
    } catch {
      // Best-effort — see this function's own comment.
    }
  }

  function destroy() {
    stop();
  }

  return {
    state,
    start,
    stop,
    enqueue,
    enqueueFirst,
    dequeue,
    moveUp,
    setAutoCQ,
    setAutoCQIntervalMin,
    setAutoCQMessage,
    setOutputDevice,
    setTxGain,
    setAutoPTT,
    setAllowConsecutiveTx,
    setFakeSplit,
    setFakeSplitSweetSpotHz,
    setTxWindowParity,
    setPreKeyMs,
    setPostKeyMs,
    clearSent,
    clearBridgeSlot,
    enqueueBridgeSlot,
    syncBridgeSlotsFromDevice,
    syncParams,
    destroy,
    get isRunning() { return isRunning; },
  };
}

export type FTTransmit = ReturnType<typeof createFTTransmit>;
