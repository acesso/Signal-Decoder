// Staging: encode now, hold it in one of the bridge's TX slots, transmit on
// the operator's command. RTTY wants this today and SSTV will want it, so it
// lives here rather than inside either mode — see
// doc/BRIDGE_SLOT_TX_DESIGN.md.
//
// This is NOT the same shape as FT8's bridge TX. FT pre-uploads because it is
// racing a 15-second window boundary; staging exists because the operator
// wants messages WAITING, and wants transmitting to be one click on a
// known-good buffer. That matters for contest and remote operation: the
// upload is a deliberate, visible step, and the transmission is a separate
// act on a slot that is already proven to be on the device.
//
// The one capability this cannot offer is live keying. A slot is a complete
// buffer uploaded before playback begins, so there is nothing to stage until
// the message is finished — see RTTYTransmitPanel's own note to the operator.
import { createSignal, type Accessor } from 'solid-js';
import {
  TX_SLOT_COUNT,
  clearBridgeSlotOnDevice,
  emptyBridgeSlots,
  findFreeSlot,
  modeLabel,
  parseModeLabel,
  playBridgeSlotAndWait,
  refreshSlotHashCache,
  stopBridgePlayback,
  uploadToBridgeSlot,
  type BridgeSlotInfo,
  type SlotMode,
} from './bridgeSlots';

/** Per-slot progress, for a pool view. 'playing' is this session's own
 *  transmission; a slot another mode or an earlier session staged simply
 *  reads 'ready', since the device reports what it holds but not who is
 *  about to play it. */
export type SlotPhase = 'empty' | 'encoding' | 'uploading' | 'ready' | 'playing';

export interface StagedSlot extends BridgeSlotInfo {
  phase: SlotPhase;
  /** Playback length in seconds, 0 when unknown (e.g. a slot restored from
   *  the device, which reports bytes but not the encode-time duration). */
  durationSec: number;
  /** Which mode staged this, parsed from the device-side label. null for a
   *  slot written before mode tagging, or by something else entirely. */
  mode: SlotMode | null;
  /** The label with its mode tag stripped — what to actually show. */
  description: string;
}

export interface StagingResult {
  ok: boolean;
  slot?: number;
  error?: string;
}

export interface SlotStagingOptions<P> {
  /** The bridge's CAT WebSocket URL; undefined when no bridge is connected.
   *  Read live rather than captured, since it usually resolves after mount. */
  getWsUrl: () => string | undefined;
  /** Mode tag written into each staged slot's on-device label. */
  mode: SlotMode;
  /** The only mode-specific part: payload -> audio. RTTY supplies its
   *  Baudot/ASCII FSK encoder, SSTV would supply its image encoder. */
  encode: (payload: P) => Promise<{ samples: Float32Array; sampleRateHz: number }>;
  /** TX gain applied on the way to the wire, matching the local-speaker
   *  path's own gain so switching sinks doesn't change level. */
  getGain: () => number;
}

export interface SlotStaging<P> {
  slots: Accessor<StagedSlot[]>;
  busy: Accessor<boolean>;
  error: Accessor<string | null>;
  /** Encode, upload, and hold. Resolves with the slot actually used, which
   *  may differ from any preference when the pool is contended. */
  stage: (payload: P, message: string, description: string) => Promise<StagingResult>;
  /** Play a staged slot and resolve when the device reports it finished.
   *  PTT is the caller's business — see RTTYTransmitPanel, which brackets
   *  this exactly as FT8's TX loop does. */
  send: (slot: number, isRunning?: () => boolean) => Promise<boolean>;
  clear: (slot: number) => Promise<void>;
  /** Halt whatever the device is playing. A browser-side stop alone would
   *  leave the ESP32 transmitting the rest of its buffer. */
  stopPlayback: () => Promise<void>;
  /** Ask the device what it actually holds. The device is the only thing
   *  that survives a reload, a different browser, or a cleared cache, so
   *  this is what lets the pool view describe slots this session never
   *  staged — including another mode's. */
  refresh: () => Promise<void>;
}

function emptyStaged(): StagedSlot[] {
  return emptyBridgeSlots().map(s => ({ ...s, phase: 'empty' as SlotPhase, durationSec: 0, mode: null, description: '' }));
}

export function createSlotStaging<P>(opts: SlotStagingOptions<P>): SlotStaging<P> {
  const [slots, setSlots] = createSignal<StagedSlot[]>(emptyStaged());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function patch(slot: number, patchFn: (s: StagedSlot) => StagedSlot) {
    setSlots(prev => prev.map(s => (s.slot === slot ? patchFn(s) : s)));
  }

  async function refresh(): Promise<void> {
    const wsUrl = opts.getWsUrl();
    if (!wsUrl) return;
    const restored = await refreshSlotHashCache(wsUrl);
    if (!restored) return;
    setSlots(prev => prev.map(prevSlot => {
      const r = restored.find(x => x.slot === prevSlot.slot);
      if (!r) return prevSlot;
      const { mode, description } = parseModeLabel(r.label);
      return {
        ...r,
        phase: r.uploaded ? 'ready' : 'empty',
        // The device stores audio and metadata, not the encode-time
        // duration, so a restored slot keeps whatever this session already
        // knew and otherwise reports 0 rather than inventing a number.
        durationSec: r.uploaded ? prevSlot.durationSec : 0,
        mode,
        description,
      };
    }));
  }

  async function stage(payload: P, message: string, description: string): Promise<StagingResult> {
    const wsUrl = opts.getWsUrl();
    if (!wsUrl) {
      const e = 'No bridge connected';
      setError(e);
      return { ok: false, error: e };
    }
    // Pick the slot BEFORE encoding so a full pool costs nothing and is
    // reported immediately, rather than after a multi-second encode.
    const slot = findFreeSlot(slots());
    if (slot === null) {
      const e = `All ${TX_SLOT_COUNT} bridge slots are full — clear one to stage this message`;
      setError(e);
      return { ok: false, error: e };
    }

    setBusy(true);
    setError(null);
    patch(slot, s => ({ ...s, phase: 'encoding', message, description, mode: opts.mode }));
    try {
      const { samples, sampleRateHz } = await opts.encode(payload);
      patch(slot, s => ({ ...s, phase: 'uploading' }));

      const label = modeLabel(opts.mode, description);
      const resolved = await uploadToBridgeSlot(wsUrl, slot, samples, sampleRateHz, opts.getGain(), {
        message,
        label,
        audioHz: 0, // RTTY/SSTV bake their own tones in; there is no single "audio Hz" to report
      });
      const durationSec = samples.length / sampleRateHz;

      // uploadToBridgeSlot() may redirect to a slot already holding
      // byte-identical audio — record against what it actually resolved to,
      // and undo the optimistic marking of the slot we asked for.
      //
      // The redirect target can belong to another mode, since the hash is
      // over wire bytes and knows nothing about labels. That is safe to PLAY
      // (the audio really is identical) but it means our label now describes
      // a slot someone else staged. We take the label rather than leave a
      // stale one: whoever asked to stage this content most recently is the
      // better description of what the slot is for, and the audio is the same
      // either way. The practical case is narrow — two modes would have to
      // produce bit-identical waveforms, which across RTTY/FT8/SSTV encoders
      // essentially means re-staging your own message.
      if (resolved !== slot) patch(slot, s => ({ ...s, phase: s.uploaded ? 'ready' : 'empty', message: s.uploaded ? s.message : '', description: s.uploaded ? s.description : '', mode: s.uploaded ? s.mode : null }));
      patch(resolved, s => ({ ...s, slot: resolved, phase: 'ready', uploaded: true, message, label, description, mode: opts.mode, durationSec }));
      return { ok: true, slot: resolved };
    } catch (err) {
      const e = err instanceof Error ? err.message : 'Encode/upload failed';
      setError(e);
      patch(slot, s => ({ ...s, phase: 'empty', uploaded: false, message: '', description: '', mode: null }));
      return { ok: false, error: e };
    } finally {
      setBusy(false);
    }
  }

  async function send(slot: number, isRunning: () => boolean = () => true): Promise<boolean> {
    const wsUrl = opts.getWsUrl();
    if (!wsUrl) {
      setError('No bridge connected');
      return false;
    }
    setError(null);
    patch(slot, s => ({ ...s, phase: 'playing' }));
    try {
      const ok = await playBridgeSlotAndWait(wsUrl, slot, isRunning);
      if (!ok) setError('Bridge playback failed — nothing staged in that slot, or the bridge is unreachable');
      return ok;
    } finally {
      // Back to ready, not empty: playing a slot does not consume it, which
      // is the point for a contest operator sending the same exchange
      // repeatedly.
      patch(slot, s => ({ ...s, phase: s.uploaded ? 'ready' : 'empty' }));
    }
  }

  async function clear(slot: number): Promise<void> {
    patch(slot, s => ({ ...s, phase: 'empty', uploaded: false, message: '', label: '', description: '', mode: null, durationSec: 0 }));
    const wsUrl = opts.getWsUrl();
    if (!wsUrl) return;
    await clearBridgeSlotOnDevice(wsUrl, slot);
  }

  async function stopPlayback(): Promise<void> {
    const wsUrl = opts.getWsUrl();
    if (!wsUrl) return;
    await stopBridgePlayback(wsUrl);
  }

  return { slots, busy, error, stage, send, clear, refresh, stopPlayback };
}
