// Country inference from callsign prefix (ITU allocations / DXCC practice).
// Used as a location fallback when a station's grid was never heard — it can
// give a country + flag, but never a map position.
import { flagEmoji } from './lookup';

// [prefix or A-Z/0-9 range, ISO-3166 alpha-2]. Ranges share their stem and
// vary only the last character ("PP-PY" → PP…PY). Longest match wins.
const ALLOC: Array<[string, string]> = [
  // North America
  ['AA-AL', 'US'], ['K', 'US'], ['N', 'US'], ['W', 'US'],
  ['VA-VG', 'CA'], ['VO', 'CA'], ['VX-VY', 'CA'], ['XJ-XO', 'CA'], ['CF-CK', 'CA'], ['CY-CZ', 'CA'],
  ['XA-XI', 'MX'],
  // Central America & Caribbean
  ['TG', 'GT'], ['TI', 'CR'], ['HO-HP', 'PA'], ['HQ-HR', 'HN'], ['HT', 'NI'], ['YN', 'NI'],
  ['HU', 'SV'], ['YS', 'SV'], ['HH', 'HT'], ['HI', 'DO'], ['CL-CM', 'CU'], ['CO', 'CU'],
  ['6Y', 'JM'], ['8P', 'BB'], ['9Y-9Z', 'TT'], ['V3', 'BZ'],
  // South America
  ['PP-PY', 'BR'], ['ZV-ZZ', 'BR'],
  ['LO-LW', 'AR'], ['AY-AZ', 'AR'], ['L2-L9', 'AR'],
  ['CA-CE', 'CL'], ['CV-CX', 'UY'], ['CP', 'BO'], ['OA-OC', 'PE'],
  ['HC-HD', 'EC'], ['HJ-HK', 'CO'], ['YV-YY', 'VE'], ['ZP', 'PY'], ['8R', 'GY'], ['PZ', 'SR'],
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
  // Oceania
  ['VH-VN', 'AU'], ['AX', 'AU'], ['ZK-ZM', 'NZ'], ['P2', 'PG'], ['YJ', 'VU'], ['5W', 'WS'],
  // Africa
  ['CN', 'MA'], ['7R', 'DZ'], ['7T-7Y', 'DZ'], ['3V', 'TN'], ['5A', 'LY'], ['SU', 'EG'], ['ST', 'SD'],
  ['ET', 'ET'], ['5Y-5Z', 'KE'], ['5X', 'UG'], ['5H', 'TZ'], ['9J', 'ZM'], ['7Q', 'MW'], ['Z2', 'ZW'],
  ['A2', 'BW'], ['V5', 'NA'], ['7P', 'LS'], ['ZR-ZU', 'ZA'], ['5R', 'MG'], ['3B', 'MU'],
  ['9G', 'GH'], ['5N', 'NG'], ['6V-6W', 'SN'], ['TJ', 'CM'], ['TR', 'GA'], ['9Q-9T', 'CD'],
  ['EL', 'LR'], ['9X', 'RW'], ['9U', 'BI'], ['D2', 'AO'], ['C9', 'MZ'], ['TT', 'TD'],
  ['5T', 'MR'], ['5U', 'NE'], ['5V', 'TG'], ['TU', 'CI'], ['XT', 'BF'], ['TY', 'BJ'], ['TZ', 'ML'], ['3X', 'GN'],
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
  for (let len = Math.min(2, base.length); len >= 1; len--) {
    const cc = PREFIX_CC.get(base.slice(0, len));
    if (cc) {
      result = { country: countryName(cc), countryCode: cc, flag: flagEmoji(cc) };
      break;
    }
  }
  cache.set(base, result);
  return result;
}
