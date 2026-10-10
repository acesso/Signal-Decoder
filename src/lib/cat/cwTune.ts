/**
 * CW Tune — retune-suggestion logic for the one-click TUNE button.
 *
 * The TUNE sequence itself (MD3 → TU1 → TX … RX → TU0 → restore mode) lives in
 * useRadioCAT, next to setPTT, so it can be mutually exclusive with every
 * other transmitter. This module only decides when the operator should be
 * nudged to tune again: an antenna tuner's match (and so the SWR it shows)
 * depends on frequency, so it goes stale after a large VFO move or a move to
 * another band. Kept separate so a live SWR reading from the bridge can later
 * replace or refine the heuristic without touching the CAT hook.
 */

import { freqMhzToBand } from '../ft/parser';

/** A one-click TUNE ends on its own after this long (web app only — the
 *  radio's TX time-out stays the hardware backstop). Long enough for an
 *  automatic tuner to find a match. */
export const TUNE_MAX_MS = 5000;

/** Whole seconds left on a running TUNE (rounded up, never negative). */
export function tuneSecondsLeft(endsAt: number | null, now: number): number | null {
  if (endsAt === null) return null;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

/** Drift window (kHz) = band frequency (MHz) × 3.5 — e.g. ±24.8 kHz at
 *  7.074 MHz, ±49.3 kHz at 14.074 MHz, ±98.3 kHz at 28.074 MHz. */
export const RETUNE_KHZ_PER_MHZ = 3.5;

export function retuneWindowHz(hz: number): number {
  return (hz / 1e6) * RETUNE_KHZ_PER_MHZ * 1000;
}

export type RetuneReason = 'never' | 'band' | 'drift';

export interface RetuneSuggestion {
  suggest: boolean;
  reason: RetuneReason | null;
  /** Drift window around the last tuned frequency (Hz), null if never tuned. */
  windowHz: number | null;
}

/**
 * Compare the current VFO with the frequency of the last tune.
 *  - never tuned this session → 'never' (a plain suggestion, not an alert)
 *  - crossed an amateur band edge (IARU R2 on HF, via the app's ADIF band
 *    table) → 'band', however small the move
 *  - moved further than the drift window of the tuned frequency → 'drift'
 */
export function retuneSuggestion(currentHz: number, lastTuneHz: number | null): RetuneSuggestion {
  if (lastTuneHz === null || lastTuneHz <= 0) return { suggest: true, reason: 'never', windowHz: null };
  const windowHz = retuneWindowHz(lastTuneHz);
  if (currentHz <= 0) return { suggest: false, reason: null, windowHz };
  if (freqMhzToBand(currentHz / 1e6) !== freqMhzToBand(lastTuneHz / 1e6)) {
    return { suggest: true, reason: 'band', windowHz };
  }
  if (Math.abs(currentHz - lastTuneHz) > windowHz) return { suggest: true, reason: 'drift', windowHz };
  return { suggest: false, reason: null, windowHz };
}
