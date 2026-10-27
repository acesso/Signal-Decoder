// The radio's TX audio report (uSDX BLACK_BRICK TX_DIAG): pushed after every
// SSB key-up, and every ~0.5 s while keyed in diagnostic mode.
//
//   TA<mic peak>,<envelope peak>,<clip %>,<envelope avg>,<gated %>;
//
//   mic peak   mic-ADC deviation in counts (~1.07 mV each); ~480 is the rail
//   envelope   before the drive shift: full power needs >= 255 >> drive
//   clip %     share of samples at full power (100 = full power throughout)
//   gated %    share with the carrier switched off by the low-level gate
//
// All four skip the first ~100 ms after key-down (input settling).

export interface TxReport {
  micPeak: number
  envPeak: number
  clipPct: number
  envAvg: number
  gatedPct: number
}

export type TxReportLevel = 'ok' | 'warn' | 'bad'

export interface TxAssessment {
  level: TxReportLevel
  /** A few words for the chip, e.g. "full power". */
  summary: string
  /** Mic peak as a share of the ADC rail, 0..100+. */
  micPct: number
  /** What to change, when anything. */
  advice: string | null
}

/** The mic ADC's rail in counts (it saturates at 512; ~480 is where clipping starts). */
export const TX_MIC_RAIL = 480

export function parseTxReport(frame: string): TxReport | null {
  const m = /^TA(\d+),(\d+),(\d+),(\d+),(\d+);?$/.exec(frame.trim())
  if (!m) return null
  const [micPeak, envPeak, clipPct, envAvg, gatedPct] = m.slice(1).map(Number)
  return { micPeak, envPeak, clipPct, envAvg, gatedPct }
}

/** Judges a report for a constant-envelope digital mode (FT8 and the like):
 *  the mic input should stay clear of its rail, and the carrier at full power
 *  with nothing gated. `drive` is the radio's TX drive (DR, 0..8). */
export function assessTxReport(r: TxReport, drive: number | null): TxAssessment {
  const micPct = Math.round((r.micPeak / TX_MIC_RAIL) * 100)
  const fullPowerEnv = 255 >> Math.max(0, Math.min(8, drive ?? 2))
  if (r.micPeak >= TX_MIC_RAIL - 10) {
    return { level: 'bad', summary: 'mic clipping', micPct, advice: 'The radio\'s mic input is clipping, which distorts the signal: lower the TX level by about 6 dB.' }
  }
  if (r.gatedPct > 0) {
    return { level: 'warn', summary: `carrier off ${r.gatedPct}%`, micPct, advice: 'The level is so low that the radio switched the carrier off for part of the transmission: raise the TX level.' }
  }
  if (r.envPeak < fullPowerEnv) {
    return { level: 'warn', summary: 'below full power', micPct, advice: 'The audio never reached full power: raise the TX level a few dB.' }
  }
  if (r.clipPct < 90) {
    return { level: 'warn', summary: `full power ${r.clipPct}%`, micPct, advice: 'Full power for only part of the transmission: raise the TX level a little.' }
  }
  if (micPct > 80) {
    return { level: 'warn', summary: 'close to clipping', micPct, advice: 'Full power, but the mic input is near its rail: lower the TX level about 3 dB for margin.' }
  }
  return { level: 'ok', summary: 'full power', micPct, advice: null }
}
