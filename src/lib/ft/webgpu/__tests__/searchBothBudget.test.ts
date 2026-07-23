import {
  checkSearchBothWorkgroupBudget,
  SEARCH_BOTH_MAX_N,
  SEARCH_BOTH_MAX_HZ,
  SEARCH_BOTH_MAX_OFF,
  SEARCH_BOTH_FIXED_WORKGROUP_BYTES,
} from '../searchBothBudget';

// Regression test for a REAL bug caught on real GPU hardware (Dawn native,
// this developer's own confirmed maxComputeWorkgroupStorageSize=65536
// bytes): an earlier version of this check computed FFT-scratch bytes from
// a candidate's RUNTIME n (e.g. 2592), which silently under-counted the
// kernel's actual usage — searchBoth.wgsl's buf_a/buf_b/score_buf are FIXED
// MAX_N/MAX_HZ/MAX_OFF-sized arrays regardless of any candidate's smaller
// actual size, so the kernel's real workgroup-memory footprint is
// CONSTANT, not proportional to n. The old check let a 2592-sample
// candidate pass on a 65536-byte device (2592*16+256=41728 bytes, seemingly
// fine) while the kernel's real footprint (MAX_N=4096 back then, 65792
// bytes) exceeded the device's actual limit, causing CreateComputePipeline
// to fail WebGPU VALIDATION silently — every dispatch became a no-op,
// every readback came back exactly zero. This suite now exercises the
// FIXED-footprint check directly.
const CONFIRMED_DEVICE_LIMIT = 65536; // this developer's own machine
const SPEC_MINIMUM_LIMIT = 16384; // WebGPU spec's guaranteed-minimum maxComputeWorkgroupStorageSize

describe('checkSearchBothWorkgroupBudget', () => {
  test('the FIXED footprint (MAX_N/MAX_HZ/MAX_OFF, not runtime n/hzCount/offCount) fits the confirmed device limit with headroom', () => {
    expect(SEARCH_BOTH_FIXED_WORKGROUP_BYTES).toBeLessThanOrEqual(CONFIRMED_DEVICE_LIMIT);
    expect(checkSearchBothWorkgroupBudget(2592, 5, 6, CONFIRMED_DEVICE_LIMIT)).toBeNull();
  });

  test('regression: a small runtime n/hzCount/offCount does NOT mask the kernel fixed, larger real footprint', () => {
    // Even a tiny candidate (n=60, hzCount=1, offCount=1) must be judged
    // against the FIXED footprint, not its own small size — this is
    // exactly the bug: the old check would have computed 60*16+256=1216
    // bytes and wrongly passed on a device too small for the kernel's
    // actual (fixed, much larger) footprint.
    const tinyDeviceLimit = 2000; // large enough for a tiny candidate's OWN size, too small for the fixed footprint
    const err = checkSearchBothWorkgroupBudget(60, 1, 1, tinyDeviceLimit);
    expect(err).not.toBeNull();
    expect(err).toContain('FIXED workgroup-shared-memory footprint');
    expect(err).toContain(`${SEARCH_BOTH_FIXED_WORKGROUP_BYTES} bytes`);
  });

  test('rejects N > MAX_N regardless of device limit', () => {
    const err = checkSearchBothWorkgroupBudget(SEARCH_BOTH_MAX_N + 1, 5, 6, 1024 * 1024 * 1024);
    expect(err).not.toBeNull();
    expect(err).toContain(`MAX_N=${SEARCH_BOTH_MAX_N}`);
  });

  test('rejects hzCount/offCount past their fixed array sizes', () => {
    expect(checkSearchBothWorkgroupBudget(1024, SEARCH_BOTH_MAX_HZ + 1, 6, 1024 * 1024 * 1024)).toContain(
      `MAX_HZ=${SEARCH_BOTH_MAX_HZ}`,
    );
    expect(checkSearchBothWorkgroupBudget(1024, 5, SEARCH_BOTH_MAX_OFF + 1, 1024 * 1024 * 1024)).toContain(
      `MAX_OFF=${SEARCH_BOTH_MAX_OFF}`,
    );
  });

  test('allows small, realistic N on a device that can fit the fixed footprint', () => {
    expect(checkSearchBothWorkgroupBudget(1920, 5, 6, 1024 * 1024)).toBeNull();
    expect(checkSearchBothWorkgroupBudget(60, 5, 6, 1024 * 1024)).toBeNull();
  });

  test('rejects everything on the WebGPU spec-minimum device (the fixed footprint far exceeds 16384 bytes)', () => {
    const err = checkSearchBothWorkgroupBudget(60, 1, 1, SPEC_MINIMUM_LIMIT);
    expect(err).not.toBeNull();
    expect(err).toContain('This kernel cannot run at all on this device');
  });

  test('boundary is exact: fixed footprint == limit passes, == limit-1 fails', () => {
    expect(checkSearchBothWorkgroupBudget(60, 5, 6, SEARCH_BOTH_FIXED_WORKGROUP_BYTES)).toBeNull();
    expect(checkSearchBothWorkgroupBudget(60, 5, 6, SEARCH_BOTH_FIXED_WORKGROUP_BYTES - 1)).not.toBeNull();
  });

  test('scales correctly with the confirmed device limit for N=MAX_N (still bounded by the fixed footprint, not N)', () => {
    expect(
      checkSearchBothWorkgroupBudget(SEARCH_BOTH_MAX_N, SEARCH_BOTH_MAX_HZ, SEARCH_BOTH_MAX_OFF, CONFIRMED_DEVICE_LIMIT),
    ).toBeNull();
  });
});
