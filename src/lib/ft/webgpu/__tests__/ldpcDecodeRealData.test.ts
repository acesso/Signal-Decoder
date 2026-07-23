import { ldpcDecode } from '../ldpcDecode';
import { ldpcDecodeF32 } from '../ldpcDecodeF32';
import realDecodes from './fixtures/ldpcRealDecodes.json';

// Real LLR inputs captured from ft8mon's own WASM decoder (temporary
// fprintf(stderr) instrumentation around the decode() call site in
// lib/ft8mon/ft8.cc, removed after capture) on real reference WAVs from
// lib/ft8_lib/test/wav/ — each fixture is a genuine successful decode
// (ldpc_ok=83, CRC-valid), used here to confirm the TS port (both f64 and
// the f32-precision variant used to validate the WGSL kernel) reproduces
// ft8mon's exact bit-for-bit output on real, not synthetic, data.
describe('ldpcDecode / ldpcDecodeF32 vs real ft8mon decodes', () => {
  for (const fixture of realDecodes as Array<{ filename: string; llr: number[]; plain: number[]; ok: number }>) {
    test(`${fixture.filename}: f64 and f32 both reproduce ft8mon's exact output`, () => {
      const llr = new Float64Array(fixture.llr);

      const f64Result = ldpcDecode(llr, 25);
      expect(f64Result.ok).toBe(fixture.ok);
      expect(Array.from(f64Result.plain)).toEqual(fixture.plain);

      const f32Result = ldpcDecodeF32(llr, 25);
      expect(f32Result.ok).toBe(fixture.ok);
      expect(Array.from(f32Result.plain)).toEqual(fixture.plain);
    });
  }
});
