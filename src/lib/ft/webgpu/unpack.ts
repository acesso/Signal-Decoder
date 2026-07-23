// FT8 message unpacking: 77 payload bits (of the 174-bit LDPC codeword,
// after CRC validation) -> human-readable message text. Mirrors
// lib/ft8mon/unpack.cc exactly (unpackcall, unpackgrid, unpack_1,
// unpack_4, unpack_0_0, unpack_3, unpack_0_3, unpack/dispatch) — pure
// bit-manipulation, no WASM dependency. The only "state" is a callsign
// hash table (remember_call/hashes12/hashes22), which is a plain
// in-memory dictionary that fills up as more messages are decoded across
// a session — same behavior ft8mon's own hashes12/hashes22 maps have (not
// persisted across page loads, not shared with the WASM decoder's own
// separate hash tables).
//
// Uses BigInt instead of C++'s __int128 for the wide bit-shifting `un()`
// helper (up to 71 bits needed for unpack_0_0's free-text field).

const CHARS38 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';

/** un(): most-significant-bit-first bit slice of a77[start..start+len) as
 *  an unsigned integer — mirrors unpack.cc:12-24 exactly (BigInt instead
 *  of __int128, since JS has no native 128-bit integer type). */
function un(a77: number[] | Uint8Array, start: number, len: number): bigint {
  let x = 0n;
  for (let i = 0; i < len; i++) {
    x <<= 1n;
    x |= BigInt(a77[start + i]);
  }
  return x;
}
function unNumber(a77: number[] | Uint8Array, start: number, len: number): number {
  return Number(un(a77, start, len));
}

// --- Callsign hash tables (ihashcall/remember_call, unpack.cc:26-55, 197-206) ---
const hashes12 = new Map<number, string>();
const hashes22 = new Map<number, string>();

function ihashcall(callIn: string, m: number): number {
  let call = callIn.trim();
  const chars = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';
  while (call.length < 11) call += ' ';

  let x = 0n;
  for (let i = 0; i < 11; i++) {
    const c = call[i];
    const j = chars.indexOf(c);
    if (j < 0) throw new Error(`ihashcall: invalid character '${c}' in callsign`);
    x = 38n * x + BigInt(j);
  }
  x = x * 47055833459n;
  // Emulate unsigned 64-bit right shift (x >> (64-m)) — BigInt has no
  // fixed width, so mask to 64 bits first, matching C++'s unsigned long
  // long wraparound behavior exactly.
  x = x & 0xffffffffffffffffn;
  x = x >> BigInt(64 - m);
  return Number(x);
}

function rememberCall(call: string): void {
  if (call.length >= 3 && call[0] !== '<') {
    hashes22.set(ihashcall(call, 22), call);
    hashes12.set(ihashcall(call, 12), call);
  }
}

/** Clears the callsign hash tables — exposed for tests; a real session
 *  should let these accumulate naturally as more messages decode (matches
 *  ft8mon's own hashes12/hashes22 lifetime, which persists for the life of
 *  the process/worker). */
export function resetCallsignHashes(): void {
  hashes12.clear();
  hashes22.clear();
}

const NGBASE = 180 * 180;
const NTOKENS = 2063592;
const MAX22 = 4194304;

/** unpackcall(): 28-bit packed callsign -> text (unpack.cc:65-136). */
function unpackcall(xIn: number): string {
  const c1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const c2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const c3 = '0123456789';
  const c4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  let x = xIn;
  if (x === 0) return 'DE';
  if (x === 1) return 'QRZ';
  if (x === 2) return 'CQ';
  if (x <= 1002) return `CQ ${x - 3}`;
  if (x <= 532443) {
    x -= 1003;
    const ci1 = Math.floor(x / (27 * 27 * 27));
    x %= 27 * 27 * 27;
    const ci2 = Math.floor(x / (27 * 27));
    x %= 27 * 27;
    const ci3 = Math.floor(x / 27);
    x %= 27;
    const ci4 = x;
    return `CQ ${c4[ci1]}${c4[ci2]}${c4[ci3]}${c4[ci4]}`;
  }

  if (x < NTOKENS) return '<TOKEN>';

  x -= NTOKENS;

  if (x < MAX22) {
    return hashes22.get(x) ?? '<...22>';
  }

  x -= MAX22;

  const a = new Array(6);
  a[5] = c4[x % 27]; x = Math.floor(x / 27);
  a[4] = c4[x % 27]; x = Math.floor(x / 27);
  a[3] = c4[x % 27]; x = Math.floor(x / 27);
  a[2] = c3[x % 10]; x = Math.floor(x / 10);
  a[1] = c2[x % 36]; x = Math.floor(x / 36);
  a[0] = c1[x];
  return a.join('');
}

/** unpackgrid(): 15-bit grid/report field -> text (unpack.cc:142-195). */
function unpackgrid(ngIn: number, ir: number, i3: number): string {
  if (i3 !== 1 && i3 !== 2) throw new Error(`unpackgrid: expected i3 in {1,2}, got ${i3}`);

  let ng = ngIn;
  if (ng < NGBASE) {
    const x1 = Math.floor(ng / (18 * 10 * 10));
    ng %= 18 * 10 * 10;
    const x2 = Math.floor(ng / (10 * 10));
    ng %= 10 * 10;
    const x3 = Math.floor(ng / 10);
    ng %= 10;
    const x4 = ng;
    return String.fromCharCode(65 + x1) + String.fromCharCode(65 + x2) + String.fromCharCode(48 + x3) + String.fromCharCode(48 + x4);
  }

  ng -= NGBASE;
  if (ng === 1) return '   ';
  if (ng === 2) return 'RRR ';
  if (ng === 3) return 'RR73';
  if (ng === 4) return '73  ';

  const db = ng - 35;
  const prefix = ir ? 'R' : '';
  if (db >= 0) return `${prefix}+${String(db).padStart(2, '0')}`;
  return `${prefix}-${String(-db).padStart(2, '0')}`;
}

/** unpack_1() (unpack.cc:270-309): the common "call1 call2 grid/report"
 *  message shape (i3 in {1,2}). */
function unpack1(a77: number[] | Uint8Array): string {
  let i = 0;
  const call1 = unNumber(a77, i, 28); i += 28;
  const rover1 = a77[i]; i += 1;
  const call2 = unNumber(a77, i, 28); i += 28;
  const rover2 = a77[i]; i += 1;
  const ir = a77[i]; i += 1;
  const grid = unNumber(a77, i, 15); i += 15;
  const i3 = unNumber(a77, i, 3); i += 3;
  if ((i3 !== 1 && i3 !== 2) || i !== 77) throw new Error(`unpack1: bad i3=${i3} or bit count i=${i}`);

  const call1text = unpackcall(call1);
  const call2text = unpackcall(call2);
  const gridtext = unpackgrid(grid, ir, i3);

  rememberCall(call1text);
  rememberCall(call2text);

  const pr = i3 === 1 ? '/R' : '/P';
  return `${call1text}${rover1 ? pr : ''} ${call2text}${rover2 ? pr : ''} ${gridtext}`;
}

/** unpack_4() (unpack.cc:216-265): a call too long for 28 bits (i3=4),
 *  encoded as 11 raw characters + a 12-bit hash of the other station. */
function unpack4(a77: number[] | Uint8Array): string {
  const n58Start = un(a77, 12, 58);
  let n58 = n58Start;
  const callChars = new Array(11);
  for (let i = 0; i < 11; i++) {
    callChars[10 - i] = CHARS38[Number(n58 % 38n)];
    n58 = n58 / 38n;
  }
  const call = callChars.join('');
  rememberCall(call);

  if (unNumber(a77, 73, 1) === 1) return `CQ ${call}`;

  const x12 = unNumber(a77, 0, 12);
  const ocall = hashes12.get(x12) ?? '<...12>';

  const swap = a77[70];
  let msg = swap ? `${call} ${ocall}` : `${ocall} ${call}`;

  const suffix = unNumber(a77, 71, 2);
  if (suffix === 1) msg += ' RRR';
  else if (suffix === 2) msg += ' RR73';
  else if (suffix === 3) msg += ' 73';

  return msg;
}

/** unpack_0_0() (unpack.cc:315-327): free text, 71 bits / 13 chars of a
 *  42-character alphabet, reversed. */
function unpack00(a77: number[] | Uint8Array): string {
  const cc = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
  let x = un(a77, 0, 71);
  const msg = Array.from('0123456789123');
  for (let i = 0; i < 13; i++) {
    msg[13 - 1 - i] = cc[Number(x % 42n)];
    x = x / 42n;
  }
  return msg.join('');
}

const RU_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'NB', 'NS', 'QC', 'ON', 'MB', 'SK', 'AB', 'BC', 'NWT', 'NF',
  'LB', 'NU', 'YT', 'PEI', 'DC',
];

/** unpack_3() (unpack.cc:348-401): ARRL RTTY Round-Up (i3=3). */
function unpack3(a77: number[] | Uint8Array): string {
  let i = 0;
  const tu = a77[i]; i += 1;
  const call1 = unNumber(a77, i, 28); i += 28;
  const call2 = unNumber(a77, i, 28); i += 28;
  const r = a77[i]; i += 1;
  let rst = unNumber(a77, i, 3); i += 3;
  const serial = unNumber(a77, i, 13); i += 13;

  const call1text = unpackcall(call1);
  const call2text = unpackcall(call2);
  rst = 529 + 10 * rst;

  const statei = serial - 8001;
  let serialstr: string;
  if (serial > 8000 && statei < RU_STATES.length) {
    serialstr = RU_STATES[statei];
  } else {
    serialstr = String(serial).padStart(4, '0');
  }

  let msg = '';
  if (tu) msg += 'TU; ';
  msg += `${call1text} ${call2text} `;
  if (r) msg += 'R ';
  msg += `${rst} `;
  msg += serialstr;

  rememberCall(call1text);
  rememberCall(call2text);
  return msg;
}

const FD_SECTIONS = [
  'AB ', 'AK ', 'AL ', 'AR ', 'AZ ', 'BC ', 'CO ', 'CT ', 'DE ', 'EB ',
  'EMA', 'ENY', 'EPA', 'EWA', 'GA ', 'GTA', 'IA ', 'ID ', 'IL ', 'IN ',
  'KS ', 'KY ', 'LA ', 'LAX', 'MAR', 'MB ', 'MDC', 'ME ', 'MI ', 'MN ',
  'MO ', 'MS ', 'MT ', 'NC ', 'ND ', 'NE ', 'NFL', 'NH ', 'NL ', 'NLI',
  'NM ', 'NNJ', 'NNY', 'NT ', 'NTX', 'NV ', 'OH ', 'OK ', 'ONE', 'ONN',
  'ONS', 'OR ', 'ORG', 'PAC', 'PR ', 'QC ', 'RI ', 'SB ', 'SC ', 'SCV',
  'SD ', 'SDG', 'SF ', 'SFL', 'SJV', 'SK ', 'SNJ', 'STX', 'SV ', 'TN ',
  'UT ', 'VA ', 'VI ', 'VT ', 'WCF', 'WI ', 'WMA', 'WNY', 'WPA', 'WTX',
  'WV ', 'WWA', 'WY ', 'DX ',
];

/** unpack_0_3() (unpack.cc:419-455): ARRL Field Day (i3=0, n3 in {3,4}). */
function unpack03(a77: number[] | Uint8Array, n3: number): string {
  let i = 0;
  const call1 = unNumber(a77, i, 28); i += 28;
  const call2 = unNumber(a77, i, 28); i += 28;
  const r = unNumber(a77, i, 1); i += 1;
  let nTransmitters = unNumber(a77, i, 4);
  if (n3 === 4) nTransmitters += 16;
  i += 4;
  const clss = unNumber(a77, i, 3); i += 3;
  const section = unNumber(a77, i, 7); i += 7;

  let msg = `${unpackcall(call1)} ${unpackcall(call2)} `;
  if (r) msg += 'R ';
  msg += `${nTransmitters + 1}${String.fromCharCode(65 + clss)} `;
  if (section - 1 >= 0 && section - 1 < FD_SECTIONS.length) msg += FD_SECTIONS[section - 1];

  return msg;
}

/** unpack(): dispatches on the message-type field (i3, and n3 for i3=0) —
 *  mirrors unpack.cc:463-497 exactly. `a77` is the 77-bit message payload
 *  (the first 77 of the LDPC-decoded 91 systematic bits — CRC and LDPC
 *  are assumed already validated by the caller, matching ft8mon's own
 *  contract). */
export function unpack(a77: number[] | Uint8Array): string {
  const i3 = unNumber(a77, 74, 3);
  const n3 = unNumber(a77, 71, 3);

  if (i3 === 0 && n3 === 0) return unpack00(a77);
  if (i3 === 0 && (n3 === 3 || n3 === 4)) return unpack03(a77, n3);
  if (i3 === 1 || i3 === 2) return unpack1(a77);
  if (i3 === 3) return unpack3(a77);
  if (i3 === 4) return unpack4(a77);

  return `i3=${i3} n3=${n3}`;
}
