import { checkSymbolExtractBufferBudget, SYMBOL_EXTRACT_MAX_SAMPLES_LEN } from '../symbolExtractBudget';

const CONFIRMED_DEVICE_LIMIT_128MB = 128 * 1024 * 1024; // WebGPU's spec-guaranteed default maxStorageBufferBindingSize

describe('checkSymbolExtractBufferBudget', () => {
  test('a realistic batch (hundreds of candidates) fits the 128 MiB default limit', () => {
    expect(checkSymbolExtractBufferBudget(500, CONFIRMED_DEVICE_LIMIT_128MB)).toBeNull();
  });

  test('SYMBOL_EXTRACT_MAX_SAMPLES_LEN covers extract()\'s own 79*32+32=2592-sample requirement with real headroom', () => {
    // Regression guard for a real bug caught on real GPU hardware: an
    // earlier revision set MAX_SAMPLES_LEN=2752, which silently truncated
    // (zero-padded) real signal data for any candidate whose `off` was
    // large enough that off+2592 exceeded 2752 — confirmed against this
    // repo's own fixture (bestOff=304, needing 2896 samples).
    expect(SYMBOL_EXTRACT_MAX_SAMPLES_LEN).toBeGreaterThanOrEqual(2592 + 304);
  });

  test('rejects a batch that would exceed maxStorageBufferBindingSize', () => {
    const tinyLimit = 1024; // far too small for even one candidate's samples buffer
    const err = checkSymbolExtractBufferBudget(1, tinyLimit);
    expect(err).not.toBeNull();
    expect(err).toContain('Max candidates in one dispatch on this device');
  });

  test('boundary is exact for the samples buffer size', () => {
    const samplesBytesPerCandidate = SYMBOL_EXTRACT_MAX_SAMPLES_LEN * 4;
    const c79BytesPerCandidate = 79 * 8 * 2 * 4;
    const worstPerCandidate = Math.max(samplesBytesPerCandidate, c79BytesPerCandidate);
    expect(checkSymbolExtractBufferBudget(10, worstPerCandidate * 10)).toBeNull();
    expect(checkSymbolExtractBufferBudget(10, worstPerCandidate * 10 - 1)).not.toBeNull();
  });

  test('scales linearly with batch size', () => {
    const err100 = checkSymbolExtractBufferBudget(100, 1024 * 1024); // 1 MiB, too small for 100 candidates
    const err1 = checkSymbolExtractBufferBudget(1, 1024 * 1024);
    expect(err100).not.toBeNull();
    expect(err1).toBeNull(); // one candidate's buffers (~16.4 KiB samples + ~2.5 KiB c79) fit easily in 1 MiB
  });
});
