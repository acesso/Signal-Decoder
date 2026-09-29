// The ESP32 bridge's TX slot pool — upload a complete waveform to one of the
// firmware's four PSRAM slots, then trigger playback from the device's own
// RAM. Extracted verbatim from useFTTransmit.ts, which owned all of this
// while FT8/FT4 was the only mode that could transmit through the bridge.
//
// Nothing here is FT-specific: a slot holds Int16 PCM at
// BRIDGE_PLAYBACK_RATE_HZ plus free-text metadata, and the firmware neither
// knows nor cares which mode produced it. That is what lets RTTY (and SSTV
// later) stage into the same pool — see doc/BRIDGE_SLOT_TX_DESIGN.md.
//
// Slots are a SHARED, GLOBAL resource on one device. Two consequences run
// through this whole module:
//   - Allocation is first-free, not fixed per mode (see findFreeSlot). FT8's
//     TX_SLOT_AUTOCQ/TX_SLOT_QUEUE_LOOKAHEAD are that mode's own policy, and
//     must not overwrite a slot another mode staged.
//   - The owning mode is recorded in each slot's on-device `label`
//     (see modeLabel/parseModeLabel), because the device is the only thing
//     that survives a page reload, a different browser, or a cleared cache.
import { downsampleBandlimited, makeBandlimitedResampleState, floatToInt16 } from '$decoder-lib/cat/useAudioBridge';

/** What's actually cached in each of the bridge's TX_SLOT_COUNT buffer pool
 *  slots, for a "what's staged for bridge TX" panel. */
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
export const BRIDGE_PLAYBACK_RATE_HZ = 16000;

// ws://host/cat -> http://host/... — same rewrite useIQBridge.ts's
// fetchBridgeIQInfo() and useRadioCAT.ts's BridgeStatus already do
// independently; duplicated locally rather than shared for the same reason
// noted in those files (this hook has no natural shared-module boundary
// with either).
export function bridgeHttpUrl(catWsUrl: string, pathname: string, query?: string): string | null {
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
// another.
//
// Slot roles used to be fixed per FT's own needs (0 auto-CQ, 1-2 queue
// lookahead, 3 spare). They are NOT any more: the pool is shared across
// modes, so an operator can stage a RTTY exchange, switch to FT8, and
// still find it there. Allocation is first-free (findFreeSlot) and the
// owning mode is recorded in each slot's on-device label — see this
// module's own header and doc/BRIDGE_SLOT_TX_DESIGN.md.
//
// Matches the firmware's TX_SLOT_COUNT (audio_monitor.h) — not fetched
// dynamically, same "fixed, not negotiated" reasoning as
// BRIDGE_PLAYBACK_RATE_HZ above; a firmware old enough to have a different
// count wouldn't have the /tx-* endpoints at all (see the wire-protocol
// versioning note on BRIDGE_FIRMWARE_VERSION 0.6.0 in bridge_config.h).
export const TX_SLOT_COUNT = 4;

// How long after POST /tx-play a reported playing:false can still mean "the
// playback task hasn't been scheduled yet" rather than "playback finished".
// The firmware flips its playing flag from inside that task, not in the HTTP
// handler, so there is a real window where 200-OK has come back but status
// still reads false (see playBridgeSlotAndWait's own comment). Generous
// relative to the ESP32's actual task-start latency (single-digit ms) because
// erring long only costs a few idle polls inside a window we are committed to
// transmitting in anyway, while erring short replays the message on air.
const TX_PLAY_START_GRACE_MS = 1500;

export function emptyBridgeSlots(): BridgeSlotInfo[] {
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
export function toBridgeWireFormat(samples: Float32Array, fromRateHz: number, gain: number): Int16Array<ArrayBuffer> {
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
// either way, "what does the device currently have in this slot".
const slotHashCache = new Map<string, Map<number, string>>();
export function slotHashCacheFor(wsUrl: string): Map<number, string> {
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
export async function uploadToBridgeSlot(
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
export async function refreshSlotHashCache(wsUrl: string): Promise<BridgeSlotInfo[] | null> {
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
export async function playBridgeSlotAndWait(wsUrl: string, slot: number, isRunning: () => boolean): Promise<boolean> {
  const playUrl = bridgeHttpUrl(wsUrl, '/tx-play', `slot=${slot}`);
  const statusUrl = bridgeHttpUrl(wsUrl, '/tx-status');
  if (!playUrl || !statusUrl) return false;
  // /tx-play answers {"slot":N,"playing":true,"duration_ms":U} — duration_ms
  // is how long the firmware says this slot's audio runs for. Captured here
  // because it's the only trustworthy lower bound on "playback is still in
  // flight": see the startup-race comment on the poll loop below.
  let durationMs = 0;
  try {
    const playRes = await fetch(playUrl, { method: 'POST' });
    if (!playRes.ok) return false;
    try {
      const played = await playRes.json() as { duration_ms?: number };
      if (typeof played.duration_ms === 'number' && played.duration_ms > 0) durationMs = played.duration_ms;
    } catch { /* older firmware without a JSON body — fall back to the grace period below */ }
  } catch {
    return false;
  }
  // Poll interval short enough that "how long did TX actually take" stays
  // accurate to a fraction of a second (matters for this loop's own
  // post-key-hold timing immediately after), long enough not to spam the
  // bridge's httpd worker over what's otherwise an idle WiFi link for the
  // whole ~1.4-15s a message plays.
  const POLL_MS = 150;
  // Startup race: the firmware sets its `playing` flag from INSIDE the
  // spawned playback task, NOT in the /tx-play httpd handler (see
  // s_tx_play_task_alive_slot's comment in audio_monitor.c). So /tx-status
  // legitimately reports playing:false for a moment AFTER /tx-play has
  // returned 200, until that task is scheduled. Believing that first
  // false meant "finished" returned from here ~150ms into a 12.6s FT8
  // window — the TX loop then fell through to its next iteration while
  // still inside the SAME window and, with the queue entry not yet
  // removed, keyed up and played the identical message again, over and
  // over, for the rest of the window. Hence: playing:false only counts as
  // "finished" once we've actually SEEN playback start, or once enough
  // time has passed that it can no longer plausibly be starting up.
  const startedByMs = Date.now() + Math.max(durationMs, 0) + TX_PLAY_START_GRACE_MS;
  let sawPlaying = false;
  for (;;) {
    if (!isRunning()) return true; // caller is stopping — don't keep polling a session nobody's waiting on
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    try {
      const res = await fetch(statusUrl);
      // A dropped bridge or a failed status poll mid-playback isn't worth
      // retrying indefinitely — but it is NOT evidence that playback
      // finished, so it must not shortcut the wait either. Keep the loop's
      // own timing intact by treating it the same as "still playing" until
      // the duration we were promised has elapsed; only then give up.
      if (!res.ok) {
        if (Date.now() >= startedByMs) return true;
        continue;
      }
      const data = await res.json() as { playing?: boolean; playing_slot?: number };
      if (data.playing && data.playing_slot === slot) { sawPlaying = true; continue; }
      // Not (or no longer) playing our slot. Genuine completion only if we
      // ever saw it running; otherwise we're still in the startup window
      // and must keep waiting until it can't be startup any more.
      if (sawPlaying || Date.now() >= startedByMs) return true;
    } catch {
      if (Date.now() >= startedByMs) return true;
    }
  }
}

// ── Cross-mode slot ownership ────────────────────────────────────────────────
// The device stores a 32-byte free-text `label` per slot, already uploaded
// and echoed back by GET /tx-status. Prefixing it with the owning mode makes
// the shared pool self-describing with NO firmware change — which matters
// because the device is the only thing that survives a page reload, a
// different browser, or a cleared cache (see refreshSlotHashCache()).
//
//   "FT8 · CQ (auto)"          15 bytes
//   "RTTY · CQ contest"        17 bytes
//   "SSTV · PD120 test card"   22 bytes
//
// 32 bytes is tight, so the descriptive half is truncated rather than
// allowed to push the mode tag off the end: knowing WHICH mode owns a slot
// is what prevents one mode clobbering another's staged audio, while the
// description is only ever a human label.
export type SlotMode = 'FT8' | 'FT4' | 'RTTY' | 'SSTV';

const MODE_SEP = ' · ';
/** Firmware's per-slot label capacity (http_control.c). */
export const SLOT_LABEL_MAX = 31; // 32 bytes incl. NUL

export function modeLabel(mode: SlotMode, description: string): string {
  const prefix = `${mode}${MODE_SEP}`;
  const room = SLOT_LABEL_MAX - prefix.length;
  if (room <= 0) return prefix.slice(0, SLOT_LABEL_MAX);
  return prefix + description.slice(0, room);
}

/** Splits a label written by modeLabel() back into its parts. A label from
 *  an older firmware/session that carries no mode tag reads as mode null and
 *  the whole string as the description — it is still someone's staged audio,
 *  so callers must treat an untagged occupied slot as owned, not free. */
export function parseModeLabel(label: string): { mode: SlotMode | null; description: string } {
  const sep = label.indexOf(MODE_SEP);
  if (sep > 0) {
    const tag = label.slice(0, sep);
    if (tag === 'FT8' || tag === 'FT4' || tag === 'RTTY' || tag === 'SSTV') {
      return { mode: tag, description: label.slice(sep + MODE_SEP.length) };
    }
  }
  return { mode: null, description: label };
}

/** First-free allocation across the shared pool.
 *
 *  Returns the lowest slot index nothing has staged, or null when the pool
 *  is full. A full pool is a NORMAL state, not an error: four slots against
 *  FT wanting up to three plus an operator staging RTTY messages will run
 *  out in ordinary contest use, so callers surface it rather than throwing.
 *
 *  `prefer` lets a caller re-stage into a slot it already owns (re-uploading
 *  a changed auto-CQ, say) instead of leaking a new slot per edit.
 */
export function findFreeSlot(slots: BridgeSlotInfo[], prefer?: number): number | null {
  if (prefer !== undefined && prefer >= 0 && prefer < TX_SLOT_COUNT) {
    const p = slots.find(s => s.slot === prefer);
    if (!p || !p.uploaded) return prefer;
  }
  for (let i = 0; i < TX_SLOT_COUNT; i++) {
    const s = slots.find(x => x.slot === i);
    if (!s || !s.uploaded) return i;
  }
  return null;
}

/** Best-effort POST /tx-stop — halts whatever the device is currently
 *  playing, whichever slot it came from.
 *
 *  Needed because a browser-side "stop" is otherwise only half a stop: the
 *  audio lives in the ESP32's own PSRAM and is played by a firmware task, so
 *  abandoning the status poll (or dropping PTT) leaves the device happily
 *  transmitting to the end of the buffer. */
export async function stopBridgePlayback(wsUrl: string): Promise<void> {
  const url = bridgeHttpUrl(wsUrl, '/tx-stop');
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    // Best-effort — same fallback shape as every other /tx-* call here.
  }
}

/** Best-effort POST /tx-clear plus local hash-cache eviction. Clearing the
 *  cache matters as much as the device call: without it a later re-upload to
 *  this slot would be skipped on a stale "already matches" comparison against
 *  content that no longer exists on-device. */
export async function clearBridgeSlotOnDevice(wsUrl: string, slot: number): Promise<void> {
  slotHashCacheFor(wsUrl).delete(slot);
  const url = bridgeHttpUrl(wsUrl, '/tx-clear', `slot=${slot}`);
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    // Best-effort — same fallback shape as every other /tx-* call here.
  }
}
