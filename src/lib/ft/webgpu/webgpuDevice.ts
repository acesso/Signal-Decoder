/// <reference types="@webgpu/types" />
// Shared WebGPU device singleton — used by both webgpuCoarseSearch.ts and
// webgpuLdpcDecode.ts so the two feasibility-prototype pipelines don't each
// request their own adapter/device.
export async function isWebGpuAvailable(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

let cachedDevice: GPUDevice | null = null;

// adapter.requestDevice() with NO requiredLimits grants only the WebGPU
// spec's guaranteed-MINIMUM limits for every limit not explicitly named
// (e.g. maxComputeWorkgroupStorageSize=16384), not the adapter's actual
// reported capability (adapter.limits, which can be far higher — confirmed
// on real hardware: adapter reports 65536, but a bare requestDevice() only
// grants 16384, discovered when fftGeneralFused.wgsl's real-GPU
// verification failed at N=1920 despite the adapter supporting it).
//
// adapter.limits (a GPUSupportedLimits instance) CANNOT be spread or
// Object.keys()'d — its properties are getters on the prototype, not own
// enumerable properties, so `{ ...adapter.limits }` silently produces an
// EMPTY object (confirmed directly: spreadOwnKeyCount === 0 on real
// hardware) rather than throwing or copying anything. That empty object is
// indistinguishable from "no requiredLimits" to requestDevice(), which is
// why an earlier version of this fix looked like it should work (TS even
// infers a full literal type for the spread result — a type-level artifact
// of GPUSupportedLimits' declared shape, not evidence the runtime spread
// does anything) but measurably didn't change the granted device's limits
// at all. Every needed limit name must be read off the adapter explicitly,
// by name, instead.
const LIMIT_NAMES = [
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension',
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxBindGroups',
  'maxBindingsPerBindGroup',
] as const;

export async function getDevice(): Promise<GPUDevice> {
  if (cachedDevice) return cachedDevice;
  if (!('gpu' in navigator)) throw new Error('WebGPU not available in this browser');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter available');
  const requiredLimits: Record<string, number> = {};
  for (const name of LIMIT_NAMES) {
    const value = adapter.limits[name];
    if (typeof value === 'number') requiredLimits[name] = value;
  }
  const device = await adapter.requestDevice({ requiredLimits });
  cachedDevice = device;
  return device;
}
