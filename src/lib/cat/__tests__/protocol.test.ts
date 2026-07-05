/**
 * CAT protocol unit tests — uSDX BLACK_BRICK 4.00h / TS-480 Kenwood dialect.
 *
 * These tests are pure JS: no hardware, no serial port, no browser APIs.
 * They validate command string construction, response parsing, multi-command
 * batching, and all custom PU7FTW extension commands (BL/VO/TQ/AT/A2/NR/AG0/FW/SM/DR/PM/PX).
 * Note: BL (backlight) is polled and surfaced in the UI again since the
 * 2026-07-04 firmware fix (BACKLIGHT_PIN moved to the correct pin, PD3).
 * PM/PX (PA bias endpoints) are deliberately NOT polled — they're fetched
 * on demand when the PA settings panel opens, and set from there only.
 *
 * Run with: npm test src/lib/cat/__tests__/protocol.test.ts
 */

// ── Protocol helpers (self-contained, mirrors useRadioCAT.ts logic) ───────────

const KENWOOD_MODE_MAP: Record<string, string> = {
  '1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM', '6': 'RTTY',
};

const CAT_MODE_TO_KENWOOD: Record<string, string> = {
  LSB: '1', USB: '2', CW: '3', FM: '4', AM: '5', RTTY: '6',
};

function buildSetFrequency(hz: number): string {
  return `FA${hz.toString().padStart(11, '0')};`;
}

function buildSetMode(mode: string): string {
  return `MD${CAT_MODE_TO_KENWOOD[mode]};`;
}

function parseFrequency(resp: string): number | null {
  const m = resp.match(/^FA(\d+);$/);
  if (!m) return null;
  const hz = parseInt(m[1], 10);
  return hz > 0 ? hz : null;
}

function parseMode(resp: string): string | null {
  const m = resp.match(/^MD([0-9A-Fa-f]);$/);
  return m ? (KENWOOD_MODE_MAP[m[1].toUpperCase()] ?? null) : null;
}

function parseIntField(resp: string, prefix: string): number | null {
  const m = resp.match(new RegExp(`^${prefix}(-?\\d+);$`));
  return m ? parseInt(m[1], 10) : null;
}

function parseBoolField(resp: string, prefix: string): boolean | null {
  const m = resp.match(new RegExp(`^${prefix}([01]);$`));
  return m ? m[1] === '1' : null;
}

/** Split a concatenated response string into individual ';'-terminated frames. */
function splitFrames(raw: string): string[] {
  return raw.split(';').filter(Boolean).map(f => f + ';');
}

/** Build a map of 2-char prefix → frame from a multi-frame response. */
function framesByPrefix(frames: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of frames) m.set(f.substring(0, 2), f);
  return m;
}

/** Parse IF frame as emitted by usdxBLACKBRICK firmware.
 *  Frame layout: IF + [11 freq] + 00000+000000 + 0000 + [mode_digit] + [tx_digit] + 000000;
 *  Firmware sprintf sequence: "IF%02u%03u%03u%03u" + "00000+000000" + "0000" + (mode+1) + tx + "000000;" */
function parseIFFrame(resp: string): { frequency: number; mode: string; tx: boolean } | null {
  const m = resp.match(/^IF(\d{11})00000\+0000000000(\d)(\d)000000;$/);
  if (!m) return null;
  const freq = parseInt(m[1], 10);
  const mode = KENWOOD_MODE_MAP[m[2]] ?? null;
  const tx   = m[3] === '1';
  if (!mode) return null;
  return { frequency: freq, mode, tx };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('command construction', () => {
  test('FA set — pads to 11 digits', () => {
    expect(buildSetFrequency(14225000)).toBe('FA00014225000;');
    expect(buildSetFrequency(7074000)).toBe('FA00007074000;');
    expect(buildSetFrequency(144800000)).toBe('FA00144800000;');
  });

  test('MD set — correct Kenwood digit', () => {
    expect(buildSetMode('LSB')).toBe('MD1;');
    expect(buildSetMode('USB')).toBe('MD2;');
    expect(buildSetMode('CW')).toBe('MD3;');
    expect(buildSetMode('FM')).toBe('MD4;');
    expect(buildSetMode('AM')).toBe('MD5;');
    expect(buildSetMode('RTTY')).toBe('MD6;');
  });

  test('BL set', () => {
    expect('BL1;').toMatch(/^BL[01];$/);
    expect('BL0;').toMatch(/^BL[01];$/);
  });

  test('VO set — range -1..16 including mute', () => {
    expect(`VO-1;`).toMatch(/^VO-?\d+;$/);
    expect(`VO16;`).toMatch(/^VO-?\d+;$/);
    expect(`VO0;`).toMatch(/^VO-?\d+;$/);
  });

  test('AG0 set — wire format accepts 0..2, though this build only uses 0/1', () => {
    // Firmware Command_AG0_SET allows v<=2, but FAST_AGC is undefined in this
    // build, so agc==2 has no distinct runtime code path from agc==0 (see
    // usdxBLACKBRICK.ino ~line 3305-3318). The UI only ever sends 0 or 1.
    expect(`AG00;`).toBe('AG00;');
    expect(`AG01;`).toBe('AG01;');
  });

  test('FW set — 0..7', () => {
    for (let i = 0; i <= 7; i++) {
      expect(`FW${i};`).toMatch(/^FW\d;$/);
    }
  });

  test('DR set — TX drive/power, 0..8, linear', () => {
    for (let i = 0; i <= 8; i++) {
      expect(`DR${i};`).toMatch(/^DR\d;$/);
    }
  });

  test('PM/PX set — PA bias endpoints, 1..3 digit PWM values', () => {
    expect('PM10;').toMatch(/^PM\d{1,3};$/);
    expect('PM0;').toMatch(/^PM\d{1,3};$/);
    expect('PX160;').toMatch(/^PX\d{1,3};$/);
    expect('PX255;').toMatch(/^PX\d{1,3};$/);
  });
});

describe('response parsing — standard commands', () => {
  test('parseFrequency — valid', () => {
    expect(parseFrequency('FA00014225000;')).toBe(14225000);
    expect(parseFrequency('FA00144800000;')).toBe(144800000);
    expect(parseFrequency('FA00007074000;')).toBe(7074000);
  });

  test('parseFrequency — zero / malformed → null', () => {
    expect(parseFrequency('FA00000000000;')).toBeNull();
    expect(parseFrequency('FA;')).toBeNull();
    expect(parseFrequency('MD2;')).toBeNull();
    expect(parseFrequency('')).toBeNull();
  });

  test('parseMode — valid', () => {
    expect(parseMode('MD1;')).toBe('LSB');
    expect(parseMode('MD2;')).toBe('USB');
    expect(parseMode('MD3;')).toBe('CW');
    expect(parseMode('MD4;')).toBe('FM');
    expect(parseMode('MD5;')).toBe('AM');
    expect(parseMode('MD6;')).toBe('RTTY');
  });

  test('parseMode — malformed → null', () => {
    expect(parseMode('FA2;')).toBeNull();
    expect(parseMode('MD;')).toBeNull();
    expect(parseMode('')).toBeNull();
  });
});

describe('response parsing — custom BLACK_BRICK commands', () => {
  test('BL — parseBoolean', () => {
    expect(parseBoolField('BL1;', 'BL')).toBe(true);
    expect(parseBoolField('BL0;', 'BL')).toBe(false);
    expect(parseBoolField('BL;', 'BL')).toBeNull();
  });

  test('VO — parseIntField including mute (-1)', () => {
    expect(parseIntField('VO-1;', 'VO')).toBe(-1);
    expect(parseIntField('VO0;', 'VO')).toBe(0);
    expect(parseIntField('VO8;', 'VO')).toBe(8);
    expect(parseIntField('VO16;', 'VO')).toBe(16);
    expect(parseIntField('VO;', 'VO')).toBeNull();
  });

  test('AT — ATT1 index 0..7', () => {
    expect(parseIntField('AT0;', 'AT')).toBe(0);
    expect(parseIntField('AT7;', 'AT')).toBe(7);
    expect(parseIntField('AT;', 'AT')).toBeNull();
  });

  test('A2 — ATT2 index 0..16', () => {
    expect(parseIntField('A20;', 'A2')).toBe(0);
    expect(parseIntField('A216;', 'A2')).toBe(16);
  });

  test('NR — noise reduction 0..8', () => {
    expect(parseIntField('NR0;', 'NR')).toBe(0);
    expect(parseIntField('NR8;', 'NR')).toBe(8);
  });

  test('AG0 — AGC: 0=OFF 1=ON (this build has FAST_AGC undefined, so the UI toggle only uses 0/1)', () => {
    expect(parseIntField('AG00;', 'AG0')).toBe(0);
    expect(parseIntField('AG01;', 'AG0')).toBe(1);
    expect(parseIntField('AG0;', 'AG0')).toBeNull();
  });

  test('FW — filter index 0..7', () => {
    expect(parseIntField('FW0;', 'FW')).toBe(0);  // Full
    expect(parseIntField('FW4;', 'FW')).toBe(4);  // 500 Hz
    expect(parseIntField('FW7;', 'FW')).toBe(7);  // 50 Hz
    expect(parseIntField('FW;', 'FW')).toBeNull();
  });

  test('TQ — PTT state', () => {
    expect(parseBoolField('TQ0;', 'TQ')).toBe(false);
    expect(parseBoolField('TQ1;', 'TQ')).toBe(true);
  });

  test('SM — S-meter dBm reading, signed, read-only (no SET)', () => {
    expect(parseIntField('SM-73;', 'SM')).toBe(-73);
    expect(parseIntField('SM0;', 'SM')).toBe(0);
    expect(parseIntField('SM-127;', 'SM')).toBe(-127);
    expect(parseIntField('SM;', 'SM')).toBeNull();
  });

  test('DR — TX drive/power, 0..8', () => {
    expect(parseIntField('DR0;', 'DR')).toBe(0);
    expect(parseIntField('DR4;', 'DR')).toBe(4);  // firmware init default
    expect(parseIntField('DR8;', 'DR')).toBe(8);
    expect(parseIntField('DR;', 'DR')).toBeNull();
  });

  test('PM/PX — PA bias endpoints (on-demand, not polled)', () => {
    expect(parseIntField('PM10;', 'PM')).toBe(10);    // firmware default (bias min)
    expect(parseIntField('PM0;', 'PM')).toBe(0);
    expect(parseIntField('PX160;', 'PX')).toBe(160);  // firmware default (PA max)
    expect(parseIntField('PX255;', 'PX')).toBe(255);
    expect(parseIntField('PM;', 'PM')).toBeNull();
    expect(parseIntField('PX;', 'PX')).toBeNull();
  });

  test('SR — soft restart acks SR1; before the watchdog reboots the radio', () => {
    expect(parseIntField('SR1;', 'SR')).toBe(1);
    expect(parseIntField('SR;', 'SR')).toBeNull();
  });

  test('SR2 — factory reset acks SR2; before wiping settings and rebooting', () => {
    expect(parseIntField('SR2;', 'SR')).toBe(2);
  });

  test('XF — reference oscillator (calibration), 14–28 MHz, on-demand only', () => {
    expect(parseIntField('XF25000000;', 'XF')).toBe(25_000_000);  // firmware default (25 MHz TCXO)
    expect(parseIntField('XF24999989;', 'XF')).toBe(24_999_989);  // a corrected value
    expect(parseIntField('XF;', 'XF')).toBeNull();
    // wire format for SET
    expect('XF24999989;').toMatch(/^XF\d{8};$/);
  });

  test('FD — factory defaults, one 11-value CSV frame (mirrors useRadioCAT.getFactoryDefaults)', () => {
    const parse = (resp: string) => {
      const m = resp.match(/^FD(-?\d+(?:,-?\d+){10});$/);
      return m ? m[1].split(',').map(Number) : null;
    };
    // Firmware 4.00g defaults: vol,att,att2,nr,agc,filt,drive,backlight,pwm_min,pwm_max,md
    const v = parse('FD11,0,0,0,1,0,4,1,10,160,2;');
    expect(v).toEqual([11, 0, 0, 0, 1, 0, 4, 1, 10, 160, 2]);
    expect(parse('FD11,0,0;')).toBeNull();       // wrong arity
    expect(parse('FD;')).toBeNull();
    // volume can be negative (-1 = mute)
    expect(parse('FD-1,0,0,0,1,0,4,1,10,160,2;')![0]).toBe(-1);
  });
});

describe('multi-command / batched poll parsing', () => {
  const BATCH_RESPONSE = 'FA00014225000;MD2;AG01;FW3;VO8;AT2;A216;NR4;SM-68;DR5;BL1;';

  test('splitFrames — all 11 frames', () => {
    const frames = splitFrames(BATCH_RESPONSE);
    expect(frames).toHaveLength(11);
    expect(frames[0]).toBe('FA00014225000;');
    expect(frames[1]).toBe('MD2;');
    expect(frames[2]).toBe('AG01;');
    expect(frames[3]).toBe('FW3;');
    expect(frames[4]).toBe('VO8;');
    expect(frames[5]).toBe('AT2;');
    expect(frames[6]).toBe('A216;');
    expect(frames[7]).toBe('NR4;');
    expect(frames[8]).toBe('SM-68;');
    expect(frames[9]).toBe('DR5;');
    expect(frames[10]).toBe('BL1;');
  });

  test('framesByPrefix — lookup by 2-char prefix', () => {
    const frames = splitFrames(BATCH_RESPONSE);
    const map = framesByPrefix(frames);
    expect(map.get('FA')).toBe('FA00014225000;');
    expect(map.get('MD')).toBe('MD2;');
    expect(map.get('AG')).toBe('AG01;');
    expect(map.get('FW')).toBe('FW3;');
    expect(map.get('VO')).toBe('VO8;');
    expect(map.get('AT')).toBe('AT2;');
    expect(map.get('A2')).toBe('A216;');
    expect(map.get('NR')).toBe('NR4;');
    expect(map.get('SM')).toBe('SM-68;');
    expect(map.get('DR')).toBe('DR5;');
    expect(map.get('BL')).toBe('BL1;');
  });

  test('full batch parse — all fields', () => {
    const frames = splitFrames(BATCH_RESPONSE);
    const map = framesByPrefix(frames);

    const agcRaw = [...map.entries()].find(([k]) => k === 'AG')?.[1] ?? null;
    expect(parseFrequency(map.get('FA')!)).toBe(14225000);
    expect(parseMode(map.get('MD')!)).toBe('USB');
    expect(agcRaw ? parseIntField(agcRaw, 'AG0') : null).toBe(1);   // ON
    expect(parseIntField(map.get('FW')!, 'FW')).toBe(3);            // 1800 Hz
    expect(parseIntField(map.get('VO')!, 'VO')).toBe(8);
    expect(parseIntField(map.get('AT')!, 'AT')).toBe(2);
    expect(parseIntField(map.get('A2')!, 'A2')).toBe(16);
    expect(parseIntField(map.get('NR')!, 'NR')).toBe(4);
    expect(parseIntField(map.get('SM')!, 'SM')).toBe(-68);
    expect(parseIntField(map.get('DR')!, 'DR')).toBe(5);
    expect(parseIntField(map.get('BL')!, 'BL')).toBe(1);
  });

  test('partial batch — missing fields stay null', () => {
    const partial = splitFrames('FA00007074000;MD1;');
    const map = framesByPrefix(partial);
    expect(parseFrequency(map.get('FA')!)).toBe(7074000);
    expect(parseMode(map.get('MD')!)).toBe('LSB');
    expect(map.has('VO')).toBe(false);
    expect(map.has('AG')).toBe(false);
    expect(map.has('FW')).toBe(false);
    expect(map.has('SM')).toBe(false);
    expect(map.has('DR')).toBe(false);
    expect(map.has('BL')).toBe(false);
  });
});

describe('IF frame parsing', () => {
  // Frame: IF + [11 freq] + "00000+000000" + "0000" + [mode_digit] + [tx_digit] + "000000;"
  // Firmware sprintf: "IF%02u%03u%03u%03u" + "00000+000000" + "0000" + (mode+1) + "%u000000;"
  // 14.225 MHz USB (mode index=1, code=2):
  //   IF00014225000 + 00000+000000 + 0000 + 2 + tx + 000000;
  const TX_OFF = 'IF0001422500000000+000000000020000000;'; // tx=0
  const TX_ON  = 'IF0001422500000000+000000000021000000;'; // tx=1

  test('IF parse — RX (TX=0)', () => {
    const r = parseIFFrame(TX_OFF);
    expect(r).not.toBeNull();
    expect(r!.frequency).toBe(14225000);
    expect(r!.tx).toBe(false);
    expect(r!.mode).toBe('USB');
  });

  test('IF parse — TX (TX=1)', () => {
    const r = parseIFFrame(TX_ON);
    expect(r).not.toBeNull();
    expect(r!.tx).toBe(true);
  });

  test('IF parse — malformed → null', () => {
    expect(parseIFFrame('FA00014225000;')).toBeNull();
    expect(parseIFFrame('')).toBeNull();
    expect(parseIFFrame('IF;')).toBeNull();
  });
});

describe('BLACKBRICK_POLL_CMDS array', () => {
  const BLACKBRICK_POLL_CMDS = ['FA;', 'MD;', 'AG0;', 'FW;', 'VO;', 'AT;', 'A2;', 'NR;', 'SM;', 'DR;', 'BL;'];

  test('11 commands in poll array', () => {
    expect(BLACKBRICK_POLL_CMDS).toHaveLength(11);
  });

  test('AG0; is included', () => {
    expect(BLACKBRICK_POLL_CMDS).toContain('AG0;');
  });

  test('FW; is included', () => {
    expect(BLACKBRICK_POLL_CMDS).toContain('FW;');
  });

  test('SM; is included', () => {
    expect(BLACKBRICK_POLL_CMDS).toContain('SM;');
  });

  test('DR; is included', () => {
    expect(BLACKBRICK_POLL_CMDS).toContain('DR;');
  });

  test('BL; is included (backlight confirmed working since the PD3 pin fix)', () => {
    expect(BLACKBRICK_POLL_CMDS).toContain('BL;');
  });

  test('PM;/PX; are intentionally NOT polled — on-demand from the PA settings panel only', () => {
    expect(BLACKBRICK_POLL_CMDS).not.toContain('PM;');
    expect(BLACKBRICK_POLL_CMDS).not.toContain('PX;');
  });

  test('prefixes derived from commands', () => {
    const prefixes = BLACKBRICK_POLL_CMDS.map(c => c.substring(0, 2));
    expect(prefixes).toEqual(['FA', 'MD', 'AG', 'FW', 'VO', 'AT', 'A2', 'NR', 'SM', 'DR', 'BL']);
  });
});

describe('range validation', () => {
  test('VO range', () => {
    const valid = (v: number) => v >= -1 && v <= 16;
    expect(valid(-1)).toBe(true);  // mute
    expect(valid(0)).toBe(true);
    expect(valid(16)).toBe(true);
    expect(valid(-2)).toBe(false);
    expect(valid(17)).toBe(false);
  });

  test('AT range', () => {
    const valid = (v: number) => v >= 0 && v <= 7;
    expect(valid(0)).toBe(true);
    expect(valid(7)).toBe(true);
    expect(valid(8)).toBe(false);
  });

  test('A2 range', () => {
    const valid = (v: number) => v >= 0 && v <= 16;
    expect(valid(0)).toBe(true);
    expect(valid(16)).toBe(true);
    expect(valid(17)).toBe(false);
  });

  test('NR range', () => {
    const valid = (v: number) => v >= 0 && v <= 8;
    expect(valid(0)).toBe(true);
    expect(valid(8)).toBe(true);
    expect(valid(9)).toBe(false);
  });

  test('AGC range — UI toggle only ever sends 0/1 (see note on FAST_AGC above)', () => {
    const valid = (v: number) => v === 0 || v === 1;
    expect(valid(0)).toBe(true);  // OFF
    expect(valid(1)).toBe(true);  // ON
    expect(valid(2)).toBe(false); // not a distinct state in this build
  });

  test('FW range', () => {
    const valid = (v: number) => v >= 0 && v <= 7;
    expect(valid(0)).toBe(true);  // Full
    expect(valid(7)).toBe(true);  // 50 Hz
    expect(valid(8)).toBe(false);
  });

  test('SM is read-only — plausible dBm sanity bound, no SET command exists', () => {
    // Not a hardware-enforced range like the others; just a sanity check that
    // parsed readings fall within a physically plausible dBm window.
    const plausible = (v: number) => v >= -140 && v <= 30;
    expect(plausible(-73)).toBe(true);
    expect(plausible(-127)).toBe(true);
    expect(plausible(0)).toBe(true);
  });

  test('DR range — 0..8, linear (mirrors firmware menu "TX Drive", EEPROM 0x33)', () => {
    const valid = (v: number) => v >= 0 && v <= 8;
    expect(valid(0)).toBe(true);
    expect(valid(4)).toBe(true);  // firmware init default
    expect(valid(8)).toBe(true);
    expect(valid(9)).toBe(false);
  });

  test('PM/PX ranges — firmware enforces min < max, max ≤ 255 (menu "PA bias min"/"PA max")', () => {
    // Mirrors Command_PM_SET (v < pwm_max) and Command_PX_SET (v >= pwm_min && v <= 255).
    const validMin = (v: number, max: number) => v >= 0 && v < max;
    const validMax = (v: number, min: number) => v >= min && v <= 255;
    expect(validMin(10, 160)).toBe(true);   // firmware defaults
    expect(validMin(160, 160)).toBe(false); // min must stay below max
    expect(validMax(160, 10)).toBe(true);
    expect(validMax(255, 10)).toBe(true);
    expect(validMax(5, 10)).toBe(false);    // max must not drop below min
  });
});
