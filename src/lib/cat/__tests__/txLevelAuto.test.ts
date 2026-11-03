import { calibrate, calibratedLevel, followStep, fullPowerEnv, type CalibrationDeps } from '../txLevelAuto'
import type { TxReport } from '../txReport'

const ta = (micPeak: number, envPeak: number, gatedPct = 0, clipPct = 100): TxReport => ({ micPeak, envPeak, clipPct, envAvg: envPeak - 10, gatedPct })

test('full power needs 255 >> drive', () => {
  expect([0, 2, 3, 8].map(fullPowerEnv)).toEqual([255, 63, 31, 0])
})

test('calibration: 6 dB over full power, from one report (the live numbers of 2026-10-30)', () => {
  // -22 dB gave mic 138, envelope 241 at drive 2: target 126 -> about -28 dB
  expect(calibratedLevel(-22, ta(138, 241), 2)).toEqual({ ok: true, db: -28, envTarget: 126 })
  // the mic cap wins when the envelope would need a hot mic input
  expect(calibratedLevel(-22, ta(250, 60), 0)).toEqual(expect.objectContaining({ ok: true, db: -21 })) // mic 250 -> 288: +1.2 dB
  expect(calibratedLevel(-22, ta(2, 2), 2)).toEqual({ ok: false, reason: 'no-audio' })
  expect(calibratedLevel(-10, ta(50, 30), 2)).toEqual(expect.objectContaining({ db: -6 })) // both would allow louder: never above -6 dB
})

test('follow: one small step per TX', () => {
  expect(followStep(-28, ta(110, 190), 2)).toBe(0)             // in the band
  expect(followStep(-28, ta(110, 50, 30), 2)).toBe(2)          // carrier gated off
  expect(followStep(-28, ta(110, 190, 1, 99), 2)).toBe(0)      // 1% at the edges of a full-power TX: leave it
  expect(followStep(-28, ta(110, 190, 5, 95), 2)).toBe(2)      // more than the edges
  expect(followStep(-28, ta(110, 40), 2)).toBe(2)              // below full power
  expect(followStep(-28, ta(400, 400), 2)).toBe(-3)            // mic near its rail
  expect(followStep(-28, ta(200, 300), 2)).toBe(-1)            // 13 dB over full power: trim
  expect(followStep(-28, ta(2, 2, 100), 2)).toBe(0)            // no audio at all: a cable, not a level
  expect(followStep(-6, ta(110, 40), 2)).toBe(0)               // at the top already
})

function fakeRig(envPerDb0: number, opts: { diagOk?: boolean } = {}) {
  // envelope and mic scale with the level: env = envPerDb0 * 10^(dB/20)
  let level = -22, t = 0, diag = false, keyed = false, toneOn = false
  let last: { r: TxReport; at: number } | null = null
  const log: string[] = []
  const d: CalibrationDeps = {
    ready: () => null,
    setDiag: async (on) => { log.push(`DG${on ? 1 : 0}`); if (opts.diagOk === false) return false; diag = on; return true },
    diagIsOn: () => diag,
    setPTT: async (on) => { log.push(on ? 'TX' : 'RX'); keyed = on },
    tone: async (hz) => { log.push(hz ? `tone ${hz}` : 'tone off'); toneOn = !!hz },
    report: () => last,
    level: () => level,
    setLevel: (db) => { log.push(`level ${db}`); level = db },
    drive: () => 2,
    sleep: async (ms) => {
      t += ms
      if (keyed && diag && toneOn) {
        const g = 10 ** (level / 20)
        last = { r: ta(Math.round(envPerDb0 * 0.57 * g), Math.round(envPerDb0 * g)), at: t }
      }
    },
    now: () => t,
  }
  return { d, log, level: () => level, diag: () => diag }
}

test('the dry run: diagnostic mode, tone, keyed windows, level set, all undone', async () => {
  const rig = fakeRig(241 * 10 ** (22 / 20))
  const out = await calibrate(rig.d, 850)
  expect(out).toEqual(expect.objectContaining({ ok: true, fromDb: -22, toDb: -28 }))
  expect(rig.log[0]).toBe('DG1')
  expect(rig.log.slice(-3)).toEqual(['RX', 'tone off', 'DG0'])
  expect(rig.diag()).toBe(false)
})

test('no diagnostic mode, no keying', async () => {
  const rig = fakeRig(1000, { diagOk: false })
  const out = await calibrate(rig.d, 850)
  expect(out.ok).toBe(false)
  expect(rig.log).not.toContain('TX')
})

test('no audio at the radio: an error, the level untouched', async () => {
  const rig = fakeRig(0.5)
  const out = await calibrate(rig.d, 850)
  expect(out).toEqual({ ok: false, error: expect.stringContaining('No audio reached the radio') })
  expect(rig.level()).toBe(-22)
  expect(rig.log.slice(-3)).toEqual(['RX', 'tone off', 'DG0'])
})
