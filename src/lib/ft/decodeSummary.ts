// What the FT decoder is doing, for the bridge's LCD (lib/lcd/views/ftDecodes.ts
// and the session view): one signal for the page, set by FTDecoder from its
// window results, read by the LCD views wherever they are drawn.
import { createRoot, createSignal } from 'solid-js'

export interface DecodedLine {
  msg: string
  snr: number
  /** Addressed to my callsign. */
  toMe: boolean
}

export interface DecodeSummary {
  /** The decoder is listening. */
  recording: boolean
  /** A window is being decoded now. */
  decoding: boolean
  /** The newest finished window: when, how many messages, how long its decode took. */
  last: { windowStartMs: number; count: number; decodeMs: number } | null
  /** Stations heard transmitting in the last STATIONS_MS. */
  stations: number
  /** The newest decoded messages, newest window first, strongest first within a window. */
  recent: DecodedLine[]
}

/** How far back "stations heard" looks. */
export const STATIONS_MS = 10 * 60_000

export const [decodeSummary, setDecodeSummary] = createRoot(() => createSignal<DecodeSummary | null>(null))
