// Callsign prefix → ISO 3166-1 alpha-2 country code.
// Longest-prefix match: try 3-char prefix, then 2-char, then 1-char.
// Source: ITU Table of International Callsign Prefixes (covering common ham bands).

const PREFIX_MAP: Record<string, string> = {
  // Brazil
  PP: 'BR', PQ: 'BR', PR: 'BR', PS: 'BR', PT: 'BR', PU: 'BR', PV: 'BR', PW: 'BR', PX: 'BR', PY: 'BR', PZ: 'BR',
  // United States
  AA: 'US', AB: 'US', AC: 'US', AD: 'US', AE: 'US', AF: 'US', AG: 'US', AH: 'US', AI: 'US', AJ: 'US', AK: 'US',
  AL: 'US', AM: 'US', AN: 'US',
  K: 'US', N: 'US', W: 'US',
  WA: 'US', WB: 'US', WC: 'US', WD: 'US', WE: 'US', WF: 'US', WG: 'US', WH: 'US', WI: 'US', WJ: 'US',
  WK: 'US', WL: 'US', WM: 'US', WN: 'US', WO: 'US', WP: 'US', WQ: 'US', WR: 'US', WS: 'US', WT: 'US',
  WU: 'US', WV: 'US', WW: 'US', WX: 'US', WY: 'US', WZ: 'US',
  NA: 'US', NB: 'US', NC: 'US', ND: 'US', NE: 'US', NF: 'US', NG: 'US', NH: 'US', NI: 'US', NJ: 'US',
  NK: 'US', NL: 'US', NM: 'US', NN: 'US', NO: 'US', NP: 'US', NQ: 'US', NR: 'US', NS: 'US', NT: 'US',
  NU: 'US', NV: 'US', NW: 'US', NX: 'US', NY: 'US', NZ: 'US',
  // Canada
  VA: 'CA', VB: 'CA', VC: 'CA', VD: 'CA', VE: 'CA', VF: 'CA', VG: 'CA',
  VY: 'CA', VO: 'CA', VX: 'CA',
  // United Kingdom
  G: 'GB', M: 'GB',
  GA: 'GB', GB: 'GB', GC: 'GB', GD: 'GB', GE: 'GB', GF: 'GB', GG: 'GB', GH: 'GB', GI: 'GB', GJ: 'GB',
  GK: 'GB', GL: 'GB', GM: 'GB', GN: 'GB', GO: 'GB', GP: 'GB', GQ: 'GB', GR: 'GB', GS: 'GB', GT: 'GB',
  GU: 'GB', GV: 'GB', GW: 'GB', GX: 'GB', GY: 'GB', GZ: 'GB',
  MA: 'GB', MB: 'GB', MC: 'GB', MD: 'GB', ME: 'GB', MF: 'GB', MG: 'GB', MH: 'GB', MI: 'GB', MJ: 'GB',
  MK: 'GB', MM: 'GB', MN: 'GB', MO: 'GB', MP: 'GB', MQ: 'GB', MR: 'GB', MS: 'GB', MT: 'GB',
  MU: 'GB', MV: 'GB', MW: 'GB', MX: 'GB', MY: 'GB', MZ: 'GB',
  // Germany
  DA: 'DE', DB: 'DE', DC: 'DE', DD: 'DE', DE: 'DE', DF: 'DE', DG: 'DE', DH: 'DE', DI: 'DE', DJ: 'DE',
  DK: 'DE', DL: 'DE', DM: 'DE', DN: 'DE',
  // France
  F: 'FR', TM: 'FR',
  FA: 'FR', FB: 'FR', FC: 'FR', FD: 'FR', FE: 'FR', FF: 'FR', FG: 'FR', FH: 'FR', FI: 'FR', FJ: 'FR',
  FK: 'FR', FL: 'FR', FM: 'FR', FN: 'FR', FO: 'FR', FP: 'FR', FQ: 'FR', FR: 'FR', FS: 'FR', FT: 'FR',
  FU: 'FR', FV: 'FR', FW: 'FR', FX: 'FR', FY: 'FR', FZ: 'FR',
  // Italy
  I: 'IT',
  IA: 'IT', IB: 'IT', IC: 'IT', ID: 'IT', IE: 'IT', IF: 'IT', IG: 'IT', IH: 'IT', II: 'IT', IJ: 'IT',
  IK: 'IT', IL: 'IT', IM: 'IT', IN: 'IT', IO: 'IT', IP: 'IT', IQ: 'IT', IR: 'IT', IS: 'IT', IT: 'IT',
  IU: 'IT', IV: 'IT', IW: 'IT', IX: 'IT', IY: 'IT', IZ: 'IT',
  // Spain
  EA: 'ES', EB: 'ES', EC: 'ES', ED: 'ES', EE: 'ES', EF: 'ES', EG: 'ES', EH: 'ES',
  // Netherlands
  PA: 'NL', PB: 'NL', PC: 'NL', PD: 'NL', PE: 'NL', PF: 'NL', PG: 'NL', PH: 'NL',
  // Russia
  R: 'RU', UA: 'RU', UB: 'RU', UC: 'RU', UD: 'RU', UE: 'RU', UF: 'RU', UG: 'RU',
  RA: 'RU', RB: 'RU', RC: 'RU', RD: 'RU', RE: 'RU', RF: 'RU', RG: 'RU', RH: 'RU', RI: 'RU', RJ: 'RU',
  RK: 'RU', RL: 'RU', RM: 'RU', RN: 'RU', RO: 'RU', RP: 'RU', RQ: 'RU', RR: 'RU', RS: 'RU', RT: 'RU',
  RU: 'RU', RV: 'RU', RW: 'RU', RX: 'RU', RY: 'RU', RZ: 'RU',
  // Japan
  JA: 'JP', JB: 'JP', JC: 'JP', JD: 'JP', JE: 'JP', JF: 'JP', JG: 'JP', JH: 'JP', JI: 'JP', JJ: 'JP',
  JK: 'JP', JL: 'JP', JM: 'JP', JN: 'JP', JO: 'JP', JP: 'JP', JQ: 'JP', JR: 'JP', JS: 'JP',
  // Australia
  VH: 'AU', VI: 'AU', VJ: 'AU', VK: 'AU', VL: 'AU', VM: 'AU', VN: 'AU',
  // Argentina
  LO: 'AR', LP: 'AR', LQ: 'AR', LR: 'AR', LS: 'AR', LT: 'AR', LU: 'AR', LV: 'AR', LW: 'AR',
  // Mexico
  XA: 'MX', XB: 'MX', XC: 'MX', XD: 'MX', XE: 'MX', XF: 'MX', XG: 'MX', XH: 'MX',
  // South Africa
  ZR: 'ZA', ZS: 'ZA', ZT: 'ZA', ZU: 'ZA',
  // Portugal
  CR: 'PT', CS: 'PT', CT: 'PT', CU: 'PT',
  // Sweden
  SA: 'SE', SB: 'SE', SC: 'SE', SD: 'SE', SE: 'SE', SF: 'SE', SG: 'SE', SH: 'SE', SI: 'SE', SJ: 'SE',
  SK: 'SE', SL: 'SE', SM: 'SE',
  // Norway
  LA: 'NO', LB: 'NO', LC: 'NO', LD: 'NO', LE: 'NO', LF: 'NO', LG: 'NO',
  // Finland
  OF: 'FI', OG: 'FI', OH: 'FI', OI: 'FI', OJ: 'FI',
  // Poland
  SP: 'PL', SQ: 'PL', SR: 'PL',
  // Czech Republic
  OK: 'CZ', OL: 'CZ',
  // Austria
  OE: 'AT',
  // Switzerland
  HB: 'CH', HE: 'CH',
  // Belgium
  ON: 'BE', OO: 'BE', OP: 'BE', OQ: 'BE', OR: 'BE', OS: 'BE', OT: 'BE',
  // Denmark
  OZ: 'DK', OU: 'DK', OV: 'DK',
  // Greece
  SV: 'GR', SW: 'GR', SX: 'GR', SY: 'GR', SZ: 'GR',
  // Hungary
  HA: 'HU', HG: 'HU',
  // Romania
  YO: 'RO', YP: 'RO', YQ: 'RO', YR: 'RO',
  // Ukraine
  UR: 'UA', US: 'UA', UT: 'UA', UU: 'UA', UV: 'UA', UW: 'UA', UX: 'UA', UY: 'UA', UZ: 'UA',
  // China
  BA: 'CN', BB: 'CN', BC: 'CN', BD: 'CN', BE: 'CN', BF: 'CN', BG: 'CN', BH: 'CN', BI: 'CN', BJ: 'CN',
  BK: 'CN', BL: 'CN', BM: 'CN', BN: 'CN', BO: 'CN', BP: 'CN', BQ: 'CN', BR: 'CN', BS: 'CN', BT: 'CN',
  BU: 'CN', BV: 'CN', BW: 'CN', BX: 'CN', BY: 'CN', BZ: 'CN',
  // India
  AT: 'IN', AU: 'IN', AV: 'IN', AW: 'IN',
  VT: 'IN', VU: 'IN',
  // Indonesia
  YB: 'ID', YC: 'ID', YD: 'ID', YE: 'ID', YF: 'ID', YG: 'ID', YH: 'ID',
  // South Korea
  HL: 'KR', DS: 'KR', DT: 'KR',
  // New Zealand
  ZK: 'NZ', ZL: 'NZ', ZM: 'NZ',
  // Israel
  '4X': 'IL', '4Z': 'IL',
  // Chile
  CA: 'CL', CB: 'CL', CC: 'CL', CD: 'CL', CE: 'CL',
  // Colombia
  HJ: 'CO', HK: 'CO',
  // Venezuela
  YV: 'VE', YW: 'VE', YX: 'VE', YY: 'VE',
  // Uruguay
  CV: 'UY', CW: 'UY', CX: 'UY',
  // Peru
  OA: 'PE', OB: 'PE', OC: 'PE',
  // Ecuador
  HC: 'EC', HD: 'EC',
  // Paraguay
  ZP: 'PY',
  // Bolivia
  CP: 'BO',
};

// Country code → flag emoji via regional indicator symbols
function countryToFlag(cc: string): string {
  return [...cc.toUpperCase()].map(c =>
    String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0))
  ).join('');
}

// Longest-prefix match against PREFIX_MAP (3 chars → 2 → 1)
export function callsignToFlag(callsign: string): string {
  const cs = callsign.toUpperCase().replace(/\/.*$/, ''); // strip /P, /M etc
  for (let len = 3; len >= 1; len--) {
    const prefix = cs.slice(0, len);
    const cc = PREFIX_MAP[prefix];
    if (cc) return countryToFlag(cc);
  }
  return '';
}
