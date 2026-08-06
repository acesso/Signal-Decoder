import { encodeBaudotChars, encodeAsciiChars, encodeRTTYSamples, encodeRTTYText } from '../encoder';
import { RTTYDecoder, type RTTYConfig } from '../decoder';

const BASE_CONFIG: RTTYConfig = {
  centerFreq: 1500,
  carrierShift: 450,
  baudRate: 50,
  bitsPerChar: 5,
  parity: 'none',
  stopBits: 1.5,
  reverseShift: false,
};

const SAMPLE_RATE = 8000;

function decodeAll(decoder: RTTYDecoder, samples: Float32Array): string {
  const CHUNK = 4096;
  let out = '';
  for (let i = 0; i < samples.length; i += CHUNK) {
    out += decoder.processSamples(samples.subarray(i, i + CHUNK));
  }
  return out;
}

describe('encodeBaudotChars', () => {
  test('encodes plain letters without extra shifts (idle state is LTRS)', () => {
    const { codes, dropped } = encodeBaudotChars('CQ');
    expect(dropped).toEqual([]);
    expect(codes.length).toBe(2); // no shift codes needed, both letters are in LTRS
  });

  test('inserts a FIGS shift before digits and an LTRS shift back after', () => {
    const { codes } = encodeBaudotChars('A1B');
    // A(ltrs) -> FIGS shift -> 1 -> LTRS shift -> B
    expect(codes.length).toBe(5);
  });

  test('does not re-shift for consecutive figures', () => {
    const { codes } = encodeBaudotChars('123');
    // one FIGS shift, three digit codes, one trailing LTRS shift
    expect(codes.length).toBe(5);
  });

  test('reports characters with no Baudot representation as dropped', () => {
    const { dropped } = encodeBaudotChars('A~B');
    expect(dropped).toEqual(['~']);
  });

  test('substitutes common typographic punctuation instead of dropping it', () => {
    const { dropped } = encodeBaudotChars('’');
    expect(dropped).toEqual([]);
  });
});

describe('encodeAsciiChars', () => {
  test('keeps printable ASCII range', () => {
    const { codes, dropped } = encodeAsciiChars('Hello!');
    expect(dropped).toEqual([]);
    expect(codes.length).toBe(6);
  });

  test('drops non-printable characters', () => {
    const { dropped } = encodeAsciiChars('A\x01B');
    expect(dropped).toEqual(['\x01']);
  });
});

describe('encodeRTTYSamples + RTTYDecoder round-trip', () => {
  test('decodes a short message back exactly (Baudot, USB)', () => {
    const message = 'CQ CQ DE TEST';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, BASE_CONFIG, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, BASE_CONFIG);
    const out = decodeAll(decoder, samples);

    expect(out.replace(/\s+/g, ' ').trim()).toBe(message);
  });

  test('round-trips with reverseShift (LSB) too', () => {
    const config: RTTYConfig = { ...BASE_CONFIG, reverseShift: true };
    const message = 'HELLO WORLD';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, config, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, config);
    const out = decodeAll(decoder, samples);

    expect(out.replace(/\s+/g, ' ').trim()).toBe(message);
  });

  test('round-trips digits/punctuation via FIGS shift', () => {
    const message = 'CALL 73 DE STA1';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, BASE_CONFIG, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, BASE_CONFIG);
    const out = decodeAll(decoder, samples);

    expect(out.replace(/\s+/g, ' ').trim()).toBe(message);
  });

  test('round-trips at a different baud rate and carrier shift', () => {
    const config: RTTYConfig = { ...BASE_CONFIG, baudRate: 45.45, carrierShift: 170 };
    const message = 'TESTING 170HZ SHIFT';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, config, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, config);
    const out = decodeAll(decoder, samples);

    expect(out.replace(/\s+/g, ' ').trim()).toBe(message);
  });

  test('round-trips 8-bit ASCII mode', () => {
    const config: RTTYConfig = { ...BASE_CONFIG, bitsPerChar: 8, parity: 'none' };
    const message = 'Hello, ASCII!';
    const { codes } = encodeAsciiChars(message);
    const samples = encodeRTTYSamples(codes, config, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, config);
    const out = decodeAll(decoder, samples);

    expect(out).toBe(message);
  });
});

describe('encodeRTTYText', () => {
  test('picks Baudot for 5-bit config and ASCII otherwise', () => {
    const baudot = encodeRTTYText('HI', BASE_CONFIG, SAMPLE_RATE);
    expect(baudot.samples.length).toBeGreaterThan(0);

    const ascii = encodeRTTYText('HI', { ...BASE_CONFIG, bitsPerChar: 8 }, SAMPLE_RATE);
    expect(ascii.samples.length).toBeGreaterThan(0);
  });

  test('surfaces dropped characters instead of silently mangling the message', () => {
    const { dropped } = encodeRTTYText('A~B', BASE_CONFIG, SAMPLE_RATE);
    expect(dropped).toEqual(['~']);
  });
});

describe('RTTYDecoder.setSquelch', () => {
  test('closed squelch blocks decode entirely, even with a valid signal present', () => {
    const message = 'CQ CQ DE TEST';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, BASE_CONFIG, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, BASE_CONFIG);
    decoder.setSquelch(true);
    const out = decodeAll(decoder, samples);

    expect(out).toBe('');
  });

  test('reopening squelch mid-stream lets the rest of the message decode', () => {
    const message = 'REOPEN TEST MESSAGE HERE';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, BASE_CONFIG, SAMPLE_RATE, 0.3, 0.3);

    const decoder = new RTTYDecoder(SAMPLE_RATE, BASE_CONFIG);
    decoder.setSquelch(true);
    // Feed the first half closed (nothing should decode), then reopen for the rest.
    const half = Math.floor(samples.length / 2);
    decodeAll(decoder, samples.subarray(0, half));
    decoder.setSquelch(false);
    const out = decodeAll(decoder, samples.subarray(half));

    // Whatever full characters remain after the reopen point should decode
    // cleanly — not asserting on the exact prefix since the cut can land
    // mid-character, but SOME of the tail message must come through.
    expect(out.length).toBeGreaterThan(0);
    expect(message.replace(/\s+/g, ' ')).toContain(out.replace(/\s+/g, ' ').trim().split(' ').pop());
  });

  test('does not affect decode when never engaged', () => {
    const message = 'NORMAL DECODE';
    const { codes } = encodeBaudotChars(message);
    const samples = encodeRTTYSamples(codes, BASE_CONFIG, SAMPLE_RATE);

    const decoder = new RTTYDecoder(SAMPLE_RATE, BASE_CONFIG);
    decoder.setSquelch(false);
    const out = decodeAll(decoder, samples);

    expect(out.replace(/\s+/g, ' ').trim()).toBe(message);
  });
});
