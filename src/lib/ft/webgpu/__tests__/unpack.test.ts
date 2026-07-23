import { unpack, resetCallsignHashes } from '../unpack';
import { ldpcDecode } from '../ldpcDecode';
import fixture from './fixtures/fineSyncPipeline.json';
import realDecodes from './fixtures/ldpcRealDecodes.json';

describe('unpack', () => {
  beforeEach(() => resetCallsignHashes());

  test('reproduces a real ft8mon decoded message exactly (via the full LDPC decode)', () => {
    const ll174 = new Float64Array(fixture.pipeline.ll174);
    const result = ldpcDecode(ll174, 25);
    expect(result.ok).toBe(83);

    const a77 = Array.from(result.plain).slice(0, 77);
    const msg = unpack(a77);
    expect(msg).toBe('GJ0KYZ RK9AX  MO05');
  });

  test('reproduces all real captured ft8mon decodes (19 fixtures) as readable text without throwing', () => {
    // These fixtures don't carry the ORIGINAL text ft8mon reported (only
    // LLR/plain/ok were captured), so this can't assert exact message
    // text — it asserts the unpacker runs cleanly (no exceptions, no
    // garbage) across a real diversity of captured real-world messages,
    // which is what actually exercises unpackcall's many branches
    // (plain calls, CQ, hashed calls, compound calls) rather than just
    // one hand-picked example.
    for (const fixture of realDecodes as Array<{ filename: string; llr: number[]; plain: number[]; ok: number }>) {
      const a77 = fixture.plain.slice(0, 77);
      expect(() => unpack(a77)).not.toThrow();
      const msg = unpack(a77);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test('CQ message unpacks with the CQ prefix', () => {
    // Construct a minimal valid i3=1 CQ-shaped message bit pattern:
    // call1=2 (CQ token), rover1=0, call2=some real-shaped call, rover2=0,
    // ir=0, grid=some valid grid index, i3=1.
    const a77 = new Array(77).fill(0);
    // call1 = 2 (CQ), 28 bits MSB-first
    const call1Bits = (2).toString(2).padStart(28, '0').split('').map(Number);
    for (let i = 0; i < 28; i++) a77[i] = call1Bits[i];
    // i3 = 1, last 3 bits
    const i3Bits = (1).toString(2).padStart(3, '0').split('').map(Number);
    for (let i = 0; i < 3; i++) a77[74 + i] = i3Bits[i];

    const msg = unpack(a77);
    expect(msg.startsWith('CQ')).toBe(true);
  });
});
