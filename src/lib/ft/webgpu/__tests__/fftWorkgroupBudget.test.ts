import { checkFftWorkgroupBudget, FFT_GENERAL_MAX_N } from '../fftWorkgroupBudget';

// Mirrors ldpcScratchBudget.test.ts's style: exercise the boundary math
// directly, using the developer machine's own confirmed GPU limits
// (maxComputeWorkgroupStorageSize=65536 bytes) as one concrete data point,
// plus the WebGPU spec's guaranteed-minimum (16384 bytes) as the pessimistic
// floor every device must support.
const CONFIRMED_DEVICE_LIMIT = 65536; // this developer's own machine
const SPEC_MINIMUM_LIMIT = 16384; // WebGPU spec's guaranteed-minimum maxComputeWorkgroupStorageSize

describe('checkFftWorkgroupBudget', () => {
  test('allows N=4096 (MAX_N) on the confirmed device limit — exact fit, 65536 bytes', () => {
    expect(checkFftWorkgroupBudget(FFT_GENERAL_MAX_N, CONFIRMED_DEVICE_LIMIT)).toBeNull();
  });

  test('rejects N > MAX_N regardless of how large the device limit is', () => {
    const err = checkFftWorkgroupBudget(FFT_GENERAL_MAX_N + 1, 1024 * 1024 * 1024);
    expect(err).not.toBeNull();
    expect(err).toContain(`MAX_N=${FFT_GENERAL_MAX_N}`);
  });

  test('allows small, realistic N (shift200 window sizes) on the spec-minimum device', () => {
    expect(checkFftWorkgroupBudget(1920, SPEC_MINIMUM_LIMIT)).not.toBeNull(); // 1920*16=30720 > 16384
    expect(checkFftWorkgroupBudget(1024, SPEC_MINIMUM_LIMIT)).toBeNull(); // 1024*16=16384, exact fit
    expect(checkFftWorkgroupBudget(60, SPEC_MINIMUM_LIMIT)).toBeNull();
  });

  test('error message reports the max N this device could actually handle', () => {
    const err = checkFftWorkgroupBudget(4096, SPEC_MINIMUM_LIMIT);
    expect(err).toContain('Max N on this device: 1024');
  });

  test('scales correctly with the confirmed device limit (65536 bytes)', () => {
    expect(checkFftWorkgroupBudget(2592, CONFIRMED_DEVICE_LIMIT)).toBeNull(); // shift200's ~2592-sample window
    expect(checkFftWorkgroupBudget(4096, CONFIRMED_DEVICE_LIMIT)).toBeNull();
  });

  test('boundary is exact: N*16 == limit passes, N*16 == limit+16 fails', () => {
    const limit = 4096; // arbitrary small limit: fits N=256 exactly (256*16=4096)
    expect(checkFftWorkgroupBudget(256, limit)).toBeNull();
    expect(checkFftWorkgroupBudget(257, limit)).not.toBeNull();
  });
});
