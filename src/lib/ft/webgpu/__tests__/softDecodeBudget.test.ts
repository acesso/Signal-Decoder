import { checkSoftDecodeWorkgroupBudget, SOFT_DECODE_FIXED_WORKGROUP_BYTES } from '../softDecodeBudget';

const SPEC_MINIMUM_LIMIT = 16384; // WebGPU spec's guaranteed-minimum maxComputeWorkgroupStorageSize
const CONFIRMED_DEVICE_LIMIT = 65536; // this developer's own machine (matches searchBothBudget.test.ts's own constant)

describe('checkSoftDecodeWorkgroupBudget', () => {
  test('fixed footprint is small and fits even the WebGPU spec-guaranteed minimum', () => {
    // Unlike searchBoth.wgsl/fftGeneralFused.wgsl, this kernel's workgroup
    // memory does NOT scale with a runtime N — it's always exactly 79/632-
    // element f32 arrays (mm, n79_re, n79_im, maxes_re, maxes_im), so this
    // should comfortably fit on every real device WebGPU targets.
    expect(SOFT_DECODE_FIXED_WORKGROUP_BYTES).toBeLessThan(SPEC_MINIMUM_LIMIT);
    expect(checkSoftDecodeWorkgroupBudget(SPEC_MINIMUM_LIMIT)).toBeNull();
  });

  test('fits the confirmed device limit with a lot of headroom', () => {
    expect(checkSoftDecodeWorkgroupBudget(CONFIRMED_DEVICE_LIMIT)).toBeNull();
  });

  test('rejects only a device limit smaller than the fixed footprint itself', () => {
    expect(checkSoftDecodeWorkgroupBudget(SOFT_DECODE_FIXED_WORKGROUP_BYTES)).toBeNull();
    const err = checkSoftDecodeWorkgroupBudget(SOFT_DECODE_FIXED_WORKGROUP_BYTES - 1);
    expect(err).not.toBeNull();
    expect(err).toContain('cannot run at all on this device');
  });
});
