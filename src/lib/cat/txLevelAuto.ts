// Automatic TX level: sets the TX audio level (the bridge's DAC level, the TX
// Level slider) from the radio's TX audio report (TA, txReport.ts), never the
// radio's drive or PA bias.
//
// The radio's envelope scales with the audio level (seen live: -26/-22/-20/
// -16 dB gave 154/241/305/480), and full power needs an envelope of
// 255 >> drive. So one report is enough to compute the level that puts the
// envelope a chosen margin above full power:
//   level = current + 20 log10(target / envelope)
// with the mic input kept under a cap. Two ways to use it:
//   calibrate()  a dry run in the radio's diagnostic mode with the bridge's
//                test tone: nothing goes on air (button "Auto level");
//   followStep() after each real TX, one small step from its key-up report
//                ("Follow"), never during a transmission.

import { TX_GATED_EDGE_PCT, TX_MIC_RAIL, type TxReport } from './txReport'

/** The envelope target: this far above full power (6 dB = twice the envelope). */
export const ENV_MARGIN_DB = 6
/** The mic input kept at or under this share of its rail by calibration. */
export const MIC_CAL_MAX = 0.6
/** Follow lowers the level above this share of the rail. */
export const MIC_FOLLOW_MAX = 0.8
/** Follow brings the level down when the envelope is this far above full power. */
export const ENV_HIGH_DB = 12
/** The level Follow and calibration may set, dB. */
export const LEVEL_MIN_DB = -40
export const LEVEL_MAX_DB = -6
/** Steps Follow takes. */
export const STEP_UP_DB = 2
export const STEP_DOWN_DB = 3
export const STEP_TRIM_DB = 1
/** A mic peak under this many counts: no audio reached the radio. */
export const NO_AUDIO_COUNTS = 8

/** The envelope full power needs at this drive (0..8). */
export function fullPowerEnv(drive: number | null): number {
  return 255 >> Math.max(0, Math.min(8, drive ?? 2))
}

const clampLevel = (db: number) => Math.max(LEVEL_MIN_DB, Math.min(LEVEL_MAX_DB, Math.round(db)))
const toDb = (ratio: number) => 20 * Math.log10(ratio)

export type CalibrationResult =
  | { ok: true; db: number; envTarget: number }
  | { ok: false; reason: 'no-audio' }

/** The level that puts the envelope ENV_MARGIN_DB above full power, the mic under its cap. */
export function calibratedLevel(currentDb: number, r: TxReport, drive: number | null): CalibrationResult {
  if (r.micPeak < NO_AUDIO_COUNTS || r.envPeak < 1) return { ok: false, reason: 'no-audio' }
  const envTarget = Math.max(1, fullPowerEnv(drive)) * 10 ** (ENV_MARGIN_DB / 20)
  const forEnv = currentDb + toDb(envTarget / r.envPeak)
  const forMic = currentDb + toDb((MIC_CAL_MAX * TX_MIC_RAIL) / r.micPeak)
  return { ok: true, db: clampLevel(Math.min(forEnv, forMic)), envTarget: Math.round(envTarget) }
}

/** Follow: the step (dB, 0 = none) to take after a TX with this key-up report. */
export function followStep(currentDb: number, r: TxReport, drive: number | null): number {
  if (r.micPeak < NO_AUDIO_COUNTS) return 0 // no audio at all: a cable, not a level; leave it
  const full = Math.max(1, fullPowerEnv(drive))
  let step = 0
  if (r.micPeak >= MIC_FOLLOW_MAX * TX_MIC_RAIL || r.micPeak >= TX_MIC_RAIL - 10) step = -STEP_DOWN_DB
  // A little gating at the edges of a full-power TX is not the level (TX_GATED_EDGE_PCT).
  else if (r.gatedPct > TX_GATED_EDGE_PCT || r.envPeak < full || r.clipPct < 90) step = STEP_UP_DB
  else if (r.envPeak > full * 10 ** (ENV_HIGH_DB / 20)) step = -STEP_TRIM_DB
  return clampLevel(currentDb + step) - currentDb
}

// ── The dry calibration run ──────────────────────────────────────────────────

export interface CalibrationDeps {
  /** The radio in LSB/USB, connected, not transmitting, diagnostic mode supported. */
  ready(): string | null
  /** Diagnostic mode on/off, confirmed by the radio. */
  setDiag(on: boolean): Promise<boolean>
  diagIsOn(): boolean
  setPTT(on: boolean): Promise<void>
  /** The bridge's test tone at hz (full scale), or off. Throws when the bridge refuses. */
  tone(hz: number | null): Promise<void>
  /** The newest TA report and when it came (ms epoch), or null. */
  report(): { r: TxReport; at: number } | null
  level(): number
  setLevel(db: number): void
  drive(): number | null
  sleep(ms: number): Promise<void>
  now(): number
}

export type CalibrationOutcome =
  | { ok: true; fromDb: number; toDb: number; envPeak: number; envTarget: number; micPct: number }
  | { ok: false; error: string }

/** How long each dry window is keyed: a few TA reports (one every ~0.5 s). */
const KEYED_MS = 2_200

/** One dry keyed window at the current level: the last TA report it brought, or null. */
async function dryWindow(d: CalibrationDeps, hz: number): Promise<TxReport | null> {
  await d.tone(hz)
  await d.sleep(500) // the tone, and a level just set (the bridge POSTs it 250 ms later), reach the DAC
  const start = d.now()
  await d.setPTT(true)
  await d.sleep(KEYED_MS)
  await d.setPTT(false)
  await d.tone(null)
  const last = d.report()
  return last && last.at > start ? last.r : null
}

/**
 * The "Auto level" button: diagnostic mode (no RF), the bridge's tone at hz,
 * a keyed window, the level computed from its report, a second window to
 * check (and correct once more). Always leaves the radio un-keyed, the tone
 * off and diagnostic mode as it was.
 */
export async function calibrate(d: CalibrationDeps, hz: number): Promise<CalibrationOutcome> {
  const notReady = d.ready()
  if (notReady) return { ok: false, error: notReady }
  const fromDb = d.level()
  const wasDiag = d.diagIsOn()
  try {
    if (!wasDiag && !(await d.setDiag(true))) return { ok: false, error: 'The radio did not confirm diagnostic mode (DG1), so nothing was keyed.' }
    let r: TxReport | null = null
    let target = 0
    for (let pass = 0; pass < 2; pass++) {
      r = await dryWindow(d, hz)
      if (!r) return { ok: false, error: 'No TX audio report (TA) came from the radio while keyed.' }
      const res = calibratedLevel(d.level(), r, d.drive())
      if (!res.ok) return { ok: false, error: 'No audio reached the radio: check the TX audio cable from the bridge to the radio.' }
      target = res.envTarget
      if (res.db === d.level()) break
      d.setLevel(res.db)
    }
    const last = (await dryWindow(d, hz)) ?? r!
    return { ok: true, fromDb, toDb: d.level(), envPeak: last.envPeak, envTarget: target, micPct: Math.round((last.micPeak / TX_MIC_RAIL) * 100) }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Calibration failed.' }
  } finally {
    await d.setPTT(false).catch(() => {})
    await d.tone(null).catch(() => {})
    if (!wasDiag) await d.setDiag(false).catch(() => false)
  }
}
