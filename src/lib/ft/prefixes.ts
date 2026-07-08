// Country inference from callsign prefix (ITU allocations / DXCC practice).
// Used as a location fallback when a station's grid was never heard — it can
// give a country + flag, but never a map position.
import { flagEmoji } from './lookup';

// [prefix or A-Z/0-9 range, ISO-3166 alpha-2]. Ranges share their stem and
// vary only the last character ("PP-PY" → PP…PY). Longest match wins — list
// order doesn't matter, callsignCountry() tries 3-char then 2-char then
// 1-char. A handful of real DXCC entities only differ at 3 chars from a
// neighbor already covered by a shorter entry (VP2/VP5/VP6/VP8/VP9, 3D2 vs
// 3DA, ZD7/8/9, HB vs HB0) — those are listed explicitly as 3-char entries
// so they resolve to the right country instead of silently inheriting
// whichever 1-2 char block would otherwise match.
const ALLOC: Array<[string, string]> = [
  // North America
  ['AA-AL', 'US'], ['K', 'US'], ['N', 'US'], ['W', 'US'],
  ['VA-VG', 'CA'], ['VO', 'CA'], ['VX-VY', 'CA'], ['XJ-XO', 'CA'], ['CF-CK', 'CA'], ['CY-CZ', 'CA'],
  ['XA-XI', 'MX'],
  // Central America & Caribbean
  ['TG', 'GT'], ['TI', 'CR'], ['HO-HP', 'PA'], ['HQ-HR', 'HN'], ['HT', 'NI'], ['YN', 'NI'],
  ['HU', 'SV'], ['YS', 'SV'], ['HH', 'HT'], ['HI', 'DO'], ['CL-CM', 'CU'], ['CO', 'CU'],
  ['6Y', 'JM'], ['8P', 'BB'], ['9Y-9Z', 'TT'], ['V3', 'BZ'],
  ['C6', 'BS'], ['V2', 'AG'], ['V4', 'KN'], ['J3', 'GD'], ['J6', 'LC'], ['J7', 'DM'], ['J8', 'VC'],
  ['FG', 'GP'], ['FM', 'MQ'], ['FJ', 'BL'], ['FS', 'MF'], ['FP', 'PM'],
  ['P4', 'AW'], ['PJ', 'CW'], ['ZF', 'KY'],
  ['VP2', 'AI'], ['VP5', 'TC'], ['VP9', 'BM'],
  // South America
  ['PP-PY', 'BR'], ['ZV-ZZ', 'BR'],
  ['LO-LW', 'AR'], ['AY-AZ', 'AR'], ['L2-L9', 'AR'],
  ['CA-CE', 'CL'], ['CV-CX', 'UY'], ['CP', 'BO'], ['OA-OC', 'PE'],
  ['HC-HD', 'EC'], ['HJ-HK', 'CO'], ['YV-YY', 'VE'], ['ZP', 'PY'], ['8R', 'GY'], ['PZ', 'SR'],
  ['FY', 'GF'], ['3G', 'CL'], ['XQ-XR', 'CL'], ['VP8', 'FK'],
  // Europe
  ['G', 'GB'], ['M', 'GB'], ['2', 'GB'],
  ['EI-EJ', 'IE'], ['F', 'FR'], ['TK', 'FR'],
  ['DA-DR', 'DE'], ['I', 'IT'], ['EA-EH', 'ES'], ['AM-AO', 'ES'], ['CQ-CU', 'PT'],
  ['ON-OT', 'BE'], ['PA-PI', 'NL'], ['LX', 'LU'], ['HB', 'CH'], ['HE', 'CH'], ['OE', 'AT'],
  ['OU-OZ', 'DK'], ['OY', 'FO'], ['TF', 'IS'], ['LA-LN', 'NO'], ['JW-JX', 'NO'],
  ['SA-SM', 'SE'], ['OF-OJ', 'FI'], ['ES', 'EE'], ['YL', 'LV'], ['LY', 'LT'],
  ['SN-SR', 'PL'], ['HF', 'PL'], ['3Z', 'PL'], ['OK-OL', 'CZ'], ['OM', 'SK'],
  ['HA', 'HU'], ['HG', 'HU'], ['YO-YR', 'RO'], ['LZ', 'BG'], ['SV-SZ', 'GR'], ['5B', 'CY'],
  ['9A', 'HR'], ['S5', 'SI'], ['E7', 'BA'], ['YT-YU', 'RS'], ['4O', 'ME'], ['Z3', 'MK'], ['ZA', 'AL'],
  ['9H', 'MT'], ['3A', 'MC'], ['HV', 'VA'],
  ['EU-EW', 'BY'], ['EM-EO', 'UA'], ['UR-UZ', 'UA'], ['ER', 'MD'],
  ['R', 'RU'], ['UA-UI', 'RU'],
  ['C3', 'AD'], ['HB0', 'LI'], ['T7', 'SM'], ['ZB', 'GI'],
  // Asia & Middle East
  ['TA-TC', 'TR'], ['YM', 'TR'], ['4X', 'IL'], ['4Z', 'IL'], ['OD', 'LB'], ['YK', 'SY'], ['JY', 'JO'],
  ['HZ', 'SA'], ['7Z', 'SA'], ['8Z', 'SA'], ['A4', 'OM'], ['A6', 'AE'], ['A7', 'QA'], ['A9', 'BH'], ['9K', 'KW'],
  ['YA', 'AF'], ['YI', 'IQ'], ['EP-EQ', 'IR'], ['EK', 'AM'], ['4J-4K', 'AZ'], ['4L', 'GE'],
  ['UN-UQ', 'KZ'], ['UJ-UM', 'UZ'], ['EX', 'KG'], ['EY', 'TJ'], ['EZ', 'TM'],
  ['AP-AS', 'PK'], ['VU', 'IN'], ['AT-AW', 'IN'], ['4S', 'LK'], ['9N', 'NP'], ['S2', 'BD'],
  ['JA-JS', 'JP'], ['7J-7N', 'JP'], ['8J-8N', 'JP'], ['HL', 'KR'], ['DS-DT', 'KR'], ['6K-6N', 'KR'],
  ['BV', 'TW'], ['B', 'CN'], ['VR', 'HK'],
  ['HS', 'TH'], ['E2', 'TH'], ['XV', 'VN'], ['3W', 'VN'], ['XU', 'KH'], ['XW', 'LA'], ['XZ', 'MM'],
  ['9M', 'MY'], ['9W', 'MY'], ['9V', 'SG'], ['YB-YH', 'ID'], ['7A-7I', 'ID'], ['8A-8I', 'ID'],
  ['DU-DZ', 'PH'], ['4D-4I', 'PH'],
  ['A5', 'BT'], ['8Q', 'MV'], ['V8', 'BN'], ['JT-JV', 'MN'], ['HM', 'KP'], ['P5-P9', 'KP'],
  ['7O', 'YE'], ['4W', 'TL'], ['E3', 'ER'], ['E4', 'PS'], ['XX', 'MO'],
  // Oceania
  ['VH-VN', 'AU'], ['AX', 'AU'], ['ZK-ZM', 'NZ'], ['P2', 'PG'], ['YJ', 'VU'], ['5W', 'WS'],
  ['FK', 'NC'], ['FO', 'PF'], ['FW', 'WF'], ['V6', 'FM'], ['V7', 'MH'], ['T8', 'PW'],
  ['C2', 'NR'], ['T2', 'TV'], ['T3', 'KI'], ['A3', 'TO'], ['E5', 'CK'], ['E6', 'NU'], ['H4', 'SB'],
  ['3D2', 'FJ'],
  // Africa
  ['CN', 'MA'], ['7R', 'DZ'], ['7T-7Y', 'DZ'], ['3V', 'TN'], ['5A', 'LY'], ['SU', 'EG'], ['ST', 'SD'],
  ['ET', 'ET'], ['5Y-5Z', 'KE'], ['5X', 'UG'], ['5H', 'TZ'], ['9J', 'ZM'], ['7Q', 'MW'], ['Z2', 'ZW'],
  ['A2', 'BW'], ['V5', 'NA'], ['7P', 'LS'], ['ZR-ZU', 'ZA'], ['5R', 'MG'], ['3B', 'MU'],
  ['9G', 'GH'], ['5N', 'NG'], ['6V-6W', 'SN'], ['TJ', 'CM'], ['TR', 'GA'], ['9Q-9T', 'CD'],
  ['EL', 'LR'], ['9X', 'RW'], ['9U', 'BI'], ['D2', 'AO'], ['C9', 'MZ'], ['TT', 'TD'],
  ['5T', 'MR'], ['5U', 'NE'], ['5V', 'TG'], ['TU', 'CI'], ['XT', 'BF'], ['TY', 'BJ'], ['TZ', 'ML'], ['3X', 'GN'],
  ['Z8', 'SS'], ['J2', 'DJ'], ['T5', 'SO'], ['6O', 'SO'], ['TN', 'CG'], ['TL', 'CF'], ['3C', 'GQ'],
  ['9L', 'SL'], ['J5', 'GW'], ['C5', 'GM'], ['D4', 'CV'], ['3DA', 'SZ'], ['S7', 'SC'], ['D6', 'KM'],
  ['S9', 'ST'], ['FR', 'RE'], ['FH', 'YT'],
  ['ZD7', 'SH'], ['ZD8', 'AC'], ['ZD9', 'TA'],
];

function expand(spec: string): string[] {
  const [a, b] = spec.split('-');
  if (!b) return [a];
  const stem = a.slice(0, -1);
  const out: string[] = [];
  for (let c = a.charCodeAt(a.length - 1); c <= b.charCodeAt(b.length - 1); c++) {
    out.push(stem + String.fromCharCode(c));
  }
  return out;
}

const PREFIX_CC = new Map<string, string>();
for (const [spec, cc] of ALLOC) {
  for (const p of expand(spec)) PREFIX_CC.set(p, cc);
}

export interface PrefixCountry {
  country: string;
  countryCode: string;
  flag: string;
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(cc: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

const cache = new Map<string, PrefixCountry | null>();

export function callsignCountry(callsign: string): PrefixCountry | null {
  const base = callsign.split('/')[0].toUpperCase();
  const hit = cache.get(base);
  if (hit !== undefined) return hit;
  let result: PrefixCountry | null = null;
  // 3 chars first: a handful of real entities (VP2/VP5/VP8, 3D2 vs 3DA,
  // ZD7/8/9, HB0) only differ from a shorter, already-allocated block at the
  // 3rd character — checking longest-first resolves them correctly instead
  // of always matching their 1-2 char parent.
  for (let len = Math.min(3, base.length); len >= 1; len--) {
    const cc = PREFIX_CC.get(base.slice(0, len));
    if (cc) {
      result = { country: countryName(cc), countryCode: cc, flag: flagEmoji(cc) };
      break;
    }
  }
  cache.set(base, result);
  return result;
}

// Cheap boolean form for the callsign validator — avoids building a
// PrefixCountry/flag/Intl.DisplayNames lookup just to check "is this prefix
// allocated at all". Same longest-match-wins logic as callsignCountry.
export function hasKnownPrefix(callsign: string): boolean {
  const base = callsign.split('/')[0].toUpperCase();
  for (let len = Math.min(3, base.length); len >= 1; len--) {
    if (PREFIX_CC.has(base.slice(0, len))) return true;
  }
  return false;
}

// EXACT match, no progressive shortening — for callers that have already
// determined the precise prefix length implied by a callsign's shape (e.g.
// the parser's standard/nonstandard callsign matchers) and want to know if
// THAT SPECIFIC substring is allocated, not whether some shorter prefix of
// it happens to be. Using hasKnownPrefix's fallback here would wrongly
// accept e.g. "ZZ9" (not itself allocated) just because "ZZ" (Brazil) is.
export function isExactKnownPrefix(prefix: string): boolean {
  return PREFIX_CC.has(prefix.toUpperCase());
}
