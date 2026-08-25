// Direct RX audio-quality/linearity check against the bridge's raw
// /iq-data WebSocket — connects, captures raw I/Q for a fixed duration,
// and reports statistics aimed at spotting the "cutting/paper-crackling"
// symptom directly in the digitized data: sample-to-sample discontinuity
// (a proxy for clicks/dropouts), clipping, and DC/level stability. Run
// this BEFORE attempting a decode, per the intended workflow: confirm the
// raw signal is clean first, only then try FT8 decode.
//
// Usage: npx tsx scripts/rx-quality-check.ts [bridge-ip] [duration-seconds]
import { writeFileSync } from 'node:fs';

const BRIDGE_IP = process.argv[2] || '192.168.0.8';
const DURATION_S = Number(process.argv[3] || 20);

async function main() {
  const statsBefore = await fetch(`http://${BRIDGE_IP}/system-stats`).then((r) => r.json()).catch(() => null);
  const statusBefore: any = await fetch(`http://${BRIDGE_IP}/status`).then((r) => r.json());
  console.log(`bridge: input_mode=${statusBefore.input_mode} sample_rate=${statusBefore.sample_rate_hz} cpu=${statusBefore.cpu_freq_mhz}MHz`);
  if (statsBefore) {
    console.log(`RX timing before capture: max_loop_interval=${statsBefore.rx_max_loop_interval_us}us max_read=${statsBefore.rx_max_read_duration_us}us max_broadcast=${statsBefore.rx_max_broadcast_duration_us}us (n=${statsBefore.rx_loop_count})`);
  }

  const ws = new WebSocket(`ws://${BRIDGE_IP}/iq-data`);
  ws.binaryType = 'arraybuffer';

  const iSamples: number[] = [];
  const qSamples: number[] = [];
  let frameCount = 0;

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS connect failed'));
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
  console.log(`connected — capturing ${DURATION_S}s...`);

  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const int16 = new Int16Array(ev.data);
    frameCount++;
    for (let n = 0; n + 1 < int16.length; n += 2) {
      iSamples.push(int16[n]);
      qSamples.push(int16[n + 1]);
    }
  };

  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  ws.close();
  await new Promise((r) => setTimeout(r, 300));

  const statsAfter = await fetch(`http://${BRIDGE_IP}/system-stats`).then((r) => r.json()).catch(() => null);
  if (statsAfter) {
    console.log(`RX timing DURING capture: max_loop_interval=${statsAfter.rx_max_loop_interval_us}us max_read=${statsAfter.rx_max_read_duration_us}us max_broadcast=${statsAfter.rx_max_broadcast_duration_us}us (n=${statsAfter.rx_loop_count})`);
  }

  console.log(`\ncaptured ${frameCount} frames, ${iSamples.length} sample pairs`);
  if (iSamples.length < 1000) {
    console.log('too few samples captured — aborting analysis');
    return;
  }

  // 1. Clipping check
  const clipThreshold = 32760;
  let clipCount = 0;
  for (const v of iSamples) if (Math.abs(v) >= clipThreshold) clipCount++;
  for (const v of qSamples) if (Math.abs(v) >= clipThreshold) clipCount++;
  console.log(`clipping (>=${clipThreshold}): ${clipCount} samples (${((clipCount / (iSamples.length * 2)) * 100).toFixed(3)}%)`);

  // 2. DC offset
  const meanI = iSamples.reduce((a, b) => a + b, 0) / iSamples.length;
  const meanQ = qSamples.reduce((a, b) => a + b, 0) / qSamples.length;
  console.log(`DC offset: I=${meanI.toFixed(1)} Q=${meanQ.toFixed(1)}`);

  // 3. RMS level
  const rmsI = Math.sqrt(iSamples.reduce((a, b) => a + b * b, 0) / iSamples.length);
  const rmsQ = Math.sqrt(qSamples.reduce((a, b) => a + b * b, 0) / qSamples.length);
  console.log(`RMS level: I=${rmsI.toFixed(1)} Q=${rmsQ.toFixed(1)} (full scale=32768)`);

  // 4. Discontinuity detection — a real click/dropout shows up as a sample-
  // to-sample jump much larger than the signal's own typical slew rate.
  // Compute the 2nd derivative (jump-in-slope) and flag outliers relative
  // to a robust (median-based) baseline, which is insensitive to the
  // signal's own legitimate amplitude/frequency content.
  function discontinuityReport(samples: number[], label: string) {
    const diffs: number[] = [];
    for (let i = 1; i < samples.length; i++) diffs.push(Math.abs(samples[i] - samples[i - 1]));
    const sorted = [...diffs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];
    // Outlier threshold: 10x the median jump (robust, not mean+stddev,
    // since a legitimate strong tone already has non-Gaussian jump
    // distribution) — anything beyond this is a candidate discontinuity.
    const outlierThreshold = Math.max(median * 10, 500);
    let outlierCount = 0;
    const outlierPositions: number[] = [];
    for (let i = 0; i < diffs.length; i++) {
      if (diffs[i] > outlierThreshold) {
        outlierCount++;
        if (outlierPositions.length < 20) outlierPositions.push(i);
      }
    }
    console.log(`[${label}] sample-to-sample jump: median=${median.toFixed(1)} p99=${p99.toFixed(1)} max=${max.toFixed(1)}`);
    console.log(`[${label}] discontinuities (jump > ${outlierThreshold.toFixed(0)}): ${outlierCount} (${((outlierCount / diffs.length) * 100).toFixed(4)}%)`);
    if (outlierPositions.length > 0) {
      console.log(`[${label}] first outlier positions (sample index): ${outlierPositions.join(', ')}`);
    }
    return { median, p99, max, outlierCount };
  }
  const discI = discontinuityReport(iSamples, 'I');
  const discQ = discontinuityReport(qSamples, 'Q');

  // 5. Save raw capture for offline spectral analysis if needed.
  const outPath = `/tmp/rx-quality-capture-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ sampleRateHz: statusBefore.sample_rate_hz, iSamples, qSamples }));
  console.log(`\nraw capture saved to ${outPath}`);

  console.log('\n=== VERDICT ===');
  const totalOutliers = discI.outlierCount + discQ.outlierCount;
  if (clipCount > 0) console.log('WARNING: clipping detected — signal level too hot');
  if (totalOutliers > frameCount) {
    console.log(`LIKELY CRACKLING PRESENT: ${totalOutliers} discontinuities across ${frameCount} frames (more than 1 per frame on average)`);
  } else if (totalOutliers > 0) {
    console.log(`Some discontinuities present (${totalOutliers}) but infrequent — may or may not be audible`);
  } else {
    console.log('No significant discontinuities detected — signal looks clean');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
