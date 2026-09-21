/**
 * TX playback rate probe — diagnoses the bridge-sink "message plays twice"
 * report WITHOUT needing a serial console (the bridge is only reachable
 * over WiFi).
 *
 * Background: a captured trace showed the app issuing exactly ONE
 * POST /tx-play, then the firmware reporting itself busy for 25.763s on a
 * 12.64s FT8 waveform — a ratio of 2.038. One playback running at half
 * speed sounds on air exactly like the message repeating back to back.
 *
 * This script re-plays a slot the bridge ALREADY holds and polls
 * GET /tx-status throughout, which separates the candidate causes:
 *
 *   position_ms tracks wall clock 1:1, total ~= duration_ms
 *       -> playback is fine; the problem is elsewhere (report back).
 *   position_ms advances at ~HALF wall-clock rate
 *       -> the playback loop's chunk cycle is taking ~2x real time. Each
 *          esp_codec_dev_write() is blocking for twice the audio it
 *          represents, i.e. the codec is consuming at half the rate the
 *          buffer assumes. Prime suspects: the codec running at a
 *          different sample rate than MIC_SEND_SAMPLE_RATE_HZ assumes, or
 *          a second writer interleaving into the same I2S channel.
 *   position_ms hits duration_ms quickly but `playing` stays true
 *       -> playback finished; the silence-flush tail is what's long.
 *
 * Usage (bridge reachable over WiFi; does NOT transmit unless the radio is
 * keyed — this plays audio out the bridge's codec exactly as a real TX
 * would, so either key down deliberately or accept it goes nowhere):
 *
 *   npx tsx scripts/tx-playback-rate-probe.ts http://<bridge-ip> [slot]
 *
 * Defaults to whichever slot GET /tx-status reports as ready.
 */

type SlotStatus = {
  slot: number; ready: boolean; bytes: number; duration_ms: number;
  hash: string; audio_hz: number; message: string; label: string;
};
type TxStatus = {
  slots: SlotStatus[];
  playing_slot: number; playing: boolean;
  position_ms: number; duration_ms: number;
};

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: npx tsx scripts/tx-playback-rate-probe.ts http://<bridge-ip> [slot]');
  process.exit(1);
}
const slotArg = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;

async function getStatus(): Promise<TxStatus> {
  const res = await fetch(`${base}/tx-status`);
  if (!res.ok) throw new Error(`/tx-status -> HTTP ${res.status}`);
  return await res.json() as TxStatus;
}

async function main() {
  console.log(`bridge: ${base}`);

  // Sample rate matters: the buffer is Int16 @16kHz, and audio_rx_callback()
  // upsamples to whatever the codec is actually configured for. A codec rate
  // mismatch is one of the two prime suspects for a 2x stretch.
  try {
    const info = await (await fetch(`${base}/status`)).json();
    console.log('codec sample_rate_hz :', info.sample_rate_hz ?? info.sampleRateHz ?? '(not reported)');
    console.log('input_mode           :', info.input_mode ?? info.inputMode ?? '(not reported)');
  } catch { console.log('(could not read /status)'); }

  const pre = await getStatus();
  if (pre.playing) {
    console.error(`bridge is already playing slot ${pre.playing_slot} — aborting so we do not disturb it`);
    process.exit(1);
  }

  const ready = pre.slots.filter(s => s.ready);
  if (ready.length === 0) {
    console.error('no slot is ready — stage a message from the app first, then re-run');
    process.exit(1);
  }
  const slot = slotArg ?? ready[0].slot;
  const chosen = pre.slots.find(s => s.slot === slot);
  if (!chosen || !chosen.ready) {
    console.error(`slot ${slot} is not ready. Ready slots: ${ready.map(s => s.slot).join(', ')}`);
    process.exit(1);
    throw new Error('unreachable'); // narrows `chosen` for TS past process.exit
  }

  const nominalMs = chosen.duration_ms;
  console.log(`\nslot ${slot}: "${chosen.message}" (${chosen.label})`);
  console.log(`bytes=${chosen.bytes}  firmware-reported duration_ms=${nominalMs}`);
  // bytes / 2 = Int16 samples; at 16kHz that is the true audio length.
  console.log(`implied length @16kHz: ${((chosen.bytes / 2) / 16000).toFixed(3)}s\n`);

  const t0 = Date.now();
  const playRes = await fetch(`${base}/tx-play?slot=${slot}`, { method: 'POST' });
  if (!playRes.ok) {
    console.error(`/tx-play -> HTTP ${playRes.status}: ${await playRes.text()}`);
    process.exit(1);
  }
  console.log('POST /tx-play ok:', await playRes.text());
  console.log('\n   wall(s)  position_ms  playing  ratio(pos/wall)');

  let sawPlaying = false;
  let lastLine = '';
  for (;;) {
    await new Promise(r => setTimeout(r, 250));
    const wall = (Date.now() - t0) / 1000;
    let st: TxStatus;
    try { st = await getStatus(); } catch (e) { console.log(`   ${wall.toFixed(2)}  <status poll failed: ${(e as Error).message}>`); continue; }

    const isOurs = st.playing && st.playing_slot === slot;
    if (isOurs) sawPlaying = true;
    // position_ms/1000 vs wall clock: 1.0 means real-time playback,
    // ~0.5 means the audio is coming out at half speed.
    const ratio = wall > 0 ? (st.position_ms / 1000) / wall : 0;
    lastLine = `   ${wall.toFixed(2).padStart(7)}  ${String(st.position_ms).padStart(11)}  ${String(isOurs).padStart(7)}  ${ratio.toFixed(3)}`;
    console.log(lastLine);

    if (sawPlaying && !isOurs) {
      const total = (Date.now() - t0) / 1000;
      console.log('\n── result ──────────────────────────────────────────────');
      console.log(`nominal duration   : ${(nominalMs / 1000).toFixed(3)}s`);
      console.log(`actual wall time   : ${total.toFixed(3)}s`);
      console.log(`stretch factor     : ${(total / (nominalMs / 1000)).toFixed(3)}x`);
      if (total / (nominalMs / 1000) > 1.5) {
        console.log('\n=> CONFIRMED: playback runs slow. One over takes ~2 window-lengths,');
        console.log('   which on air is indistinguishable from the message repeating.');
        console.log('   The position_ms ratio column above says where: a steady ~0.5');
        console.log('   means the codec consumes at half the assumed rate.');
      } else {
        console.log('\n=> Playback timing looks correct here. The doubling is NOT');
        console.log('   reproducible via a bare /tx-play, so something about the app\'s');
        console.log('   TX window (PTT, fake split, I/Q suspend) is involved.');
      }
      return;
    }
    if (wall > (nominalMs / 1000) * 4 + 10) {
      console.log('\n=> gave up waiting — playback never reported finished.');
      return;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
