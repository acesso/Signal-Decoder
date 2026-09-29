/**
 * Persisted settings for PSK Reporter spotting.
 *
 * The reporting station's callsign and locator are deliberately NOT stored
 * here: they already live under `ft_mycall` / `ft_mygrid` (see
 * src/lib/ft/useFTTransmit.ts) and are shared with the transmit panel. Only
 * what is specific to reporting is kept in this blob.
 */
import { loadObject, saveObject } from '../../storage'
import { DEFAULT_INTERVAL_MINUTES, clampIntervalMinutes, type SendCadence } from './spotQueue'

const LS_KEY = 'psk_reporter_v1'

export interface PskReporterSettings {
  enabled: boolean
  /** Optional free-form antenna description, sent with the receiver record. */
  antenna: string
  /** 'window' uploads as each decode window closes; 'interval' every N minutes. */
  cadenceMode: SendCadence['mode']
  /** Only consulted in 'interval' mode. */
  intervalMinutes: number
  /**
   * Random, stable per browser. PSK Reporter uses it to tell reporters apart
   * behind a shared NAT address, so it must survive reloads — regenerating it
   * each session would make this reporter look like many.
   */
  sessionId: number
}

const DEFAULTS: PskReporterSettings = {
  enabled: false,
  antenna: '',
  // The protocol's own recommendation, so it is what an untouched install does.
  cadenceMode: 'interval',
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  sessionId: 0,
}

function randomSessionId(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0]
  }
  return Math.floor(Math.random() * 0xffffffff)
}

/** Loads settings, minting and persisting a session id on first use. */
export function loadPskSettings(): PskReporterSettings {
  const raw = loadObject(LS_KEY, DEFAULTS)
  const stored: PskReporterSettings = {
    ...raw,
    cadenceMode: raw.cadenceMode === 'window' ? 'window' : 'interval',
    intervalMinutes: clampIntervalMinutes(raw.intervalMinutes),
  }
  if (!stored.sessionId) {
    const seeded = { ...stored, sessionId: randomSessionId() }
    savePskSettings(seeded)
    return seeded
  }
  return stored
}

export function savePskSettings(settings: PskReporterSettings): void {
  saveObject(LS_KEY, settings)
}
