// Deterministic per-callsign colour: the same callsign always gets the same
// colour, in every session, on every band, in every browser — derived from
// the callsign text itself with nothing stored anywhere.
//
// Replaces an insertion-order scheme (a 15-entry palette indexed by
// contacts.size),
// where a station's colour depended on WHEN it was first heard. The same
// operator came up a different colour every session, changed colour when
// the contact list was cleared, and swapped with someone else if two
// stations happened to be heard in a different order — so colour carried no
// usable identity across time, which is the one thing it should carry.
//
// Hashing into the old 15-entry palette would have fixed the stability but
// kept its real limit: with 15 buckets, a normal session of 40-60 stations
// has every colour reused three or four times over, so two stations sharing
// a colour says nothing. Generating the colour instead gives ~1000 usable
// distinct values from the same visual family.

// FNV-1a, 32-bit. Chosen over a hand-rolled `h = h*31 + c` for a real
// reason: simple multiply-shift hashes distribute short, highly-similar
// ASCII strings badly, and callsigns are exactly that — 4-6 characters from
// a restricted alphabet, often differing in one position (PU7FTW / PU7FTX,
// K1ABC / K1ABD). FNV-1a's per-byte XOR-then-multiply avalanches those
// single-character differences across the whole word, which is what keeps
// neighbouring callsigns from landing on neighbouring hues.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // Math.imul, not `h * 0x01000193` — the product exceeds 2^53 and plain
    // float multiplication silently loses the low bits that carry all the
    // entropy here.
    h = Math.imul(h, 0x01000193)
  }
  // Final avalanche (the xorshift-multiply finisher from MurmurHash3's
  // fmix32). FNV-1a alone leaves its HIGH bits weakly mixed with respect to
  // the LAST bytes fed in — a trailing-character difference (K1ABC/K1ABD,
  // W9XYZ/W9XYY, the single most common near-twin shape in callsigns) only
  // passes through one multiply, so those pairs landed on hues 18deg apart:
  // nominally different, visually the same. This spreads every input bit
  // across all 32 output bits, so which slice the hue is taken from stops
  // mattering. Measured on five representative twin pairs: worst-case hue
  // separation went from 18deg to 99deg.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// Hue is quantised into HUE_STEPS bands rather than used continuously: two
// hues 2° apart are indistinguishable, so spreading over a continuum only
// creates pairs that LOOK identical while being nominally different. Steps
// of ~9° are around the smallest difference that still reads as a different
// colour at these saturations.
const HUE_STEPS = 40

// Yellow-greens through to oranges (roughly 50°-90°) go muddy at this
// lightness on a dark background, and the 55°-70° band in particular is
// where a "yellow" reads as the app's own warning/held colour (#e3b341).
// Excluded rather than compressed: remapping them into the neighbouring
// bands would double those bands' collision rate, which is worse than
// having 40 hues instead of 46.
const HUE_EXCLUDE: [number, number][] = [[50, 92]]

// Saturation and lightness bands matched to the old hand-picked palette's
// measured
// range (s 59-100%, mean 90; l 53-90%, mean 70) so a generated colour is
// visually at home beside the hand-picked ones this replaces, and stays
// legible as text on the #0d1117/#161b22 surfaces it is drawn on. Kept
// narrow deliberately: hue does the identifying, and letting lightness roam
// would produce some colours that fail against the background while adding
// little real separation.
const SAT_STEPS = 3
const SAT_MIN = 68
const SAT_RANGE = 30 // 68, 78, 88
const LIGHT_STEPS = 3
const LIGHT_MIN = 60
const LIGHT_RANGE = 18 // 60, 66, 72

// The usable hues, computed ONCE. Walking the circle at a fixed stride and
// dropping the excluded bands leaves fewer than HUE_STEPS entries, so the
// hash's modulo has to be taken against THIS array's real length — an
// earlier version took it modulo HUE_STEPS and then indexed this array with
// `% usable.length`, which folded the top few steps back onto the first few
// hues and made those hues twice as likely as the rest (measured: some
// colours hit 29 times where 8 was expected).
const USABLE_HUES: number[] = (() => {
  const out: number[] = []
  const stride = 360 / HUE_STEPS
  for (let i = 0; i < HUE_STEPS; i++) {
    const h = Math.round(i * stride)
    if (HUE_EXCLUDE.some(([lo, hi]) => h >= lo && h <= hi)) continue
    out.push(h)
  }
  return out
})()

/** Total distinct colours this can produce. */
export const CALLSIGN_COLOR_SPACE = USABLE_HUES.length * SAT_STEPS * LIGHT_STEPS

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100
  const lN = l / 100
  const c = (1 - Math.abs(2 * lN - 1)) * sN
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lN - c / 2
  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return (
    '#' +
    rgb
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
      .join('')
  )
}

// Normalising the key is what makes the guarantee hold in practice.
// Callsigns reach here from several paths (decoded messages, an ADIF
// import, the QSO log, a typed entry) with inconsistent case and, for
// portable operation, suffixes. PU7FTW and pu7ftw must not be two colours.
//
// Compound calls (PU7FTW/P, VP2E/K1ABC) deliberately keep their FULL string
// as the key rather than being reduced to a base call: the app treats them
// as distinct contacts everywhere else (see isNearTwin/mergeContacts), and
// giving a portable operation the same colour as the home station would
// make two separate rows in the contacts list look like one.
function normalizeKey(callsign: string): string {
  return callsign.trim().toUpperCase()
}

/**
 * The colour for a callsign. Pure and stable: same input, same output,
 * forever, with no persistence and no dependence on what else has been
 * heard. Returns a hex string ready for a CSS colour.
 */
export function callsignColor(callsign: string): string {
  const key = normalizeKey(callsign)
  if (!key) return '#8b949e' // the app's own "unknown peer" grey
  const h = fnv1a32(key)
  // Three NON-OVERLAPPING slices, so hue/saturation/lightness vary
  // independently rather than moving together (which would collapse the
  // space into a single 1-D ramp). Hue takes the top bits — the ones FNV's
  // final multiply has mixed most — and is taken modulo the real number of
  // usable hues, not HUE_STEPS.
  const hueStep = (h >>> 16) % USABLE_HUES.length
  const satStep = (h >>> 8) % SAT_STEPS
  const lightStep = h % LIGHT_STEPS
  return hslToHex(
    USABLE_HUES[hueStep],
    SAT_MIN + (satStep * SAT_RANGE) / (SAT_STEPS - 1),
    LIGHT_MIN + (lightStep * LIGHT_RANGE) / (LIGHT_STEPS - 1),
  )
}
