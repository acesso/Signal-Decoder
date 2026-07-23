import { checkOsdWorkgroupBudget, checkOsdScratchBudget, OSD_B_STRIDE, OSD_FIXED_WORKGROUP_BYTES } from '../osdWorkgroupBudget';

const MIB = 1024 * 1024;
const DEFAULT_LIMIT = 128 * MIB; // WebGPU spec's guaranteed-minimum maxStorageBufferBindingSize
const MIN_WORKGROUP_STORAGE = 16384; // WebGPU spec's guaranteed-minimum maxComputeWorkgroupStorageSize

describe('checkOsdWorkgroupBudget', () => {
  test('OSD_FIXED_WORKGROUP_BYTES matches the hand-computed accounting (gen1_inv + 5 small arrays)', () => {
    // 91*91 i32 (gen1_inv) + 174 i32 (which) + 174 i32 (strength_bits) +
    // 91 i32 (y1) + 91 i32 (xplain) + 91 i32 (best_plain), all *4 bytes.
    expect(OSD_FIXED_WORKGROUP_BYTES).toBe((91 * 91 + 174 + 174 + 91 + 91 + 91) * 4);
  });

  test('fits comfortably within the WebGPU spec guaranteed-minimum maxComputeWorkgroupStorageSize (16384 bytes)', () => {
    // NOTE: this kernel's fixed footprint (~35KB) actually EXCEEDS the
    // spec-guaranteed minimum -- this device-specific check exists
    // precisely so a caller on a low-limit device gets a clear thrown
    // error instead of silent GPU pipeline-creation failure, same as
    // searchBoth's own MAX_N/MAX_HZ/MAX_OFF being sized for a REAL
    // device's confirmed 65536-byte limit, not the spec floor.
    expect(checkOsdWorkgroupBudget(MIN_WORKGROUP_STORAGE)).not.toBeNull();
  });

  test('fits within a real confirmed device limit (65536 bytes, this session\'s own hardware)', () => {
    expect(checkOsdWorkgroupBudget(65536)).toBeNull();
  });

  test('rejects a device limit smaller than the fixed footprint, with a clear message', () => {
    const err = checkOsdWorkgroupBudget(1000);
    expect(err).not.toBeNull();
    expect(err).toContain(String(OSD_FIXED_WORKGROUP_BYTES));
    expect(err).toContain('1000 bytes');
  });
});

describe('checkOsdScratchBudget', () => {
  test('OSD_B_STRIDE matches the hand-computed accounting (174 rows x 182 cols)', () => {
    expect(OSD_B_STRIDE).toBe(174 * 182);
  });

  test('allows realistic candidate counts under the default 128 MiB limit', () => {
    expect(checkOsdScratchBudget(1, DEFAULT_LIMIT)).toBeNull();
    expect(checkOsdScratchBudget(100, DEFAULT_LIMIT)).toBeNull();
    expect(checkOsdScratchBudget(1000, DEFAULT_LIMIT)).toBeNull();
  });

  test('rejects past the real ceiling for the default 128 MiB limit', () => {
    const maxFit = Math.floor(DEFAULT_LIMIT / (OSD_B_STRIDE * 4));
    expect(checkOsdScratchBudget(maxFit, DEFAULT_LIMIT)).toBeNull();
    expect(checkOsdScratchBudget(maxFit + 1, DEFAULT_LIMIT)).not.toBeNull();
  });

  test('error message reports the max candidates this device could actually handle', () => {
    const err = checkOsdScratchBudget(5000, DEFAULT_LIMIT);
    const maxFit = Math.floor(DEFAULT_LIMIT / (OSD_B_STRIDE * 4));
    expect(err).toContain(`Max candidates in one dispatch on this device: ${maxFit}`);
  });

  test('scales correctly with a larger device limit', () => {
    const largeLimit = 1024 * MIB;
    const maxFitDefault = Math.floor(DEFAULT_LIMIT / (OSD_B_STRIDE * 4));
    expect(checkOsdScratchBudget(maxFitDefault + 500, largeLimit)).toBeNull();
    expect(checkOsdScratchBudget(999999, largeLimit)).not.toBeNull();
  });
});
