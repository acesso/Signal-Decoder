import {
  checkSubtractWorkgroupBudget,
  checkSubtractBufferBudget,
  SUBTRACT_FIXED_WORKGROUP_BYTES,
  SUBTRACT_MAX_WINDOW_LEN,
} from '../subtractWorkgroupBudget';

describe('checkSubtractWorkgroupBudget', () => {
  test('passes for any real WebGPU device (spec-guaranteed minimum is 16384 bytes)', () => {
    expect(checkSubtractWorkgroupBudget(16384)).toBeNull();
  });

  test('fixed footprint is small (632 bytes: 79 f32 amps + 79 f32 phases)', () => {
    expect(SUBTRACT_FIXED_WORKGROUP_BYTES).toBe(79 * 4 * 2);
  });

  test('fails if hypothetically given a device below the fixed footprint', () => {
    expect(checkSubtractWorkgroupBudget(100)).not.toBeNull();
  });
});

describe('checkSubtractBufferBudget', () => {
  test('passes for a reasonable batch size on a real device', () => {
    // 60 candidates * 155008 samples * 4 bytes * 2 buffers (moved+residual)
    // -- but the check only concerns ONE buffer's worth per candidate here,
    // matching the module's own accounting (see its doc comment).
    expect(checkSubtractBufferBudget(60, 256 * 1024 * 1024)).toBeNull();
  });

  test('fails and reports max batch size when over budget', () => {
    const err = checkSubtractBufferBudget(100000, 128 * 1024 * 1024);
    expect(err).not.toBeNull();
    expect(err).toContain('Max candidates in one dispatch');
  });

  test('MAX_WINDOW_LEN has headroom above the bare minimum (79*1920+1920=153600)', () => {
    expect(SUBTRACT_MAX_WINDOW_LEN).toBeGreaterThanOrEqual(79 * 1920 + 1920);
  });
});
