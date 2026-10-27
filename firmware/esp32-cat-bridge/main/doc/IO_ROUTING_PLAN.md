# RX/TX routing and bridge capabilities: plan

Status: implemented 2026-10-26 on `feat/bridge-esp32s3` (see "Done" at the end); validated against the code first. Owner: the web app as the main control panel; the bridges as devices it configures.

## Goal

- **Web app, any mix of sources:**
  - RX: demodulated audio and raw I/Q, each from any capable source: a bridge input, a PC sound card, WebUSB, or the mic.
  - TX: to a PC sound card, or to a bridge output (scheduled through the slot pool).
- **Bridges describe themselves:**
  - PA monitoring (sense, emergency);
  - DSP they can do (I/Q passband decimation, spectrum);
  - input channels and output channels, each with its chip and options.
- **The bridge does its own DSP when it can** (I/Q passband decimation). Otherwise the web app does it.
- **The web app sets the routing; the bridge persists it** across reboots, and its own control page shows the same state.
- **New hardware means a new capability description,** not new web app code.

## What exists today

| Area | Today | Where |
|---|---|---|
| RX source choice | One "Audio source" dropdown for every decoder: `auto`, `microphone`, `bridge-audio`, `bridge-iq`, `soundcard-iq`, `usb-iq` | `src/lib/audio/audioSource.ts:30`, `App.tsx:392` |
| Raw I/Q sources | Bridge (`/iq-data`, or `/iq-passband` + `/iq-spectrum`), sound card, WebUSB, all through one `useIQBridge` | `useIQBridge.ts:409` |
| TX sinks | Speaker (PC output device via `setSinkId`) or bridge slot pool (`/tx-audio`, `/tx-play`, `/tx-status`, `/tx-stop`), chosen per mode (FT, RTTY; SSTV has no bridge sink) | `useFTTransmit.ts`, `bridgeSlots.ts`, `FTTransmitPanel.tsx:1055` |
| Capability discovery | Flat feature strings in `GET /info`, checked one by one (`hasFeature`); `board` name | `RadioCATPanel.tsx:1624`, `http_control.c` |
| PA monitoring | Feature `pa_watchdog` covers both sense and emergency; the panel shows sense and a clear-emergency button | `RadioCATPanel.tsx:1710-1785` |
| Bridge DSP | Inferred from `iq_spectrum` + `iq_passband`, which sets `bridgeDsp` | `useIQBridge.ts:369` |
| Two-ADC routing (S3) | `/iq-config` `source` and `/audio-source`; selects in the panel and the control page | `audio_monitor_s3.c`, `iq_dsp.c` |
| Persistence on the bridge | NVS for Wi-Fi, CAT baud, A1S codec settings, `rx_slot`, `tx_slot`, sample rate, input mode | `bridge_settings.h` |
| Persistence in the app | localStorage: source override, I/Q DSP toggles, passband, per-mode TX sink and output device | see the keys in `useIQBridge.ts:76-122`, `useFTTransmit.ts:140` |

## Gaps

### Web app

1. **RX audio and RX I/Q can't come from different sources.** One override value feeds every decoder, and sound card, USB and bridge I/Q share one `useIQBridge`. The design needs two independent selections:
   - the audio input (for audio decoders and monitoring);
   - the I/Q input (for the waterfall and I/Q demodulation).
   - Each one draws from the bridge inputs that support it, plus the local devices.
2. **The bridge input type is a reboot-time mode** (`input_mode` on the A1S, with a reboot). On the S3 both run at once. The app should read that from the capability description ("concurrent: yes/no") instead of special-casing `bridgeDsp`.
3. **TX sink is chosen per mode,** in each transmit panel. The design wants one TX selection: a sound card output device, or a bridge output, with modes overriding it only by exception. Scheduling (slots) remains the bridge mechanism.
4. **The ADC selects appear when `/audio-source` answers,** not from a capability. They also hard-code the chip names and rates in the UI (`BridgeAdc` type).
5. **PA:** sense and emergency are one flag, so a bridge with sense only can't be described.

### Bridge firmware

6. **No structured capability description.** `/info` has only flat feature strings and the board name. Missing: inputs and outputs with chip, jack, kinds (audio, I/Q), rates, channels, bits; the DSP it offers (passband rates, FFT sizes, corrections); PA sense and emergency separately.
7. **No single routing object.** Routing is spread over `/iq-config` `source`, `/audio-source`, `/rx-slot`, `/tx-slot` and (A1S) `/input-mode`.
8. **Persistence gaps on the S3:**
   - The I/Q and audio source selections are not saved.
   - **Bug:** `rx_slot` and `tx_slot` are saved to NVS by `/rx-slot` and `/tx-slot`, but `audio_monitor_s3.c` never reads them at boot. They silently reset to left / both.
   - The `/iq-config` processing settings (center, passband rate, corrections) aren't saved either. The app re-sends them on connect, so this one only matters for the control page.
9. **The control page doesn't follow changes made elsewhere** until it's reloaded. It reads state once (and on its own actions).

## Proposed design

### `GET /capabilities` (new; versioned; both boards)

```json
{
  "version": 1,
  "board": "s3",
  "pa": { "sense": true, "emergency": true },
  "concurrent_inputs": true,
  "inputs": [
    { "id": "wm8782",  "chip": "WM8782",  "jack": "I/Q",     "kinds": ["iq", "audio"], "rates": [96000], "channels": ["I", "Q"],          "bits": 24 },
    { "id": "pcm1808", "chip": "PCM1808", "jack": "RX/loop", "kinds": ["audio", "iq"], "rates": [48000], "channels": ["RX", "loop"],      "bits": 24 }
  ],
  "outputs": [
    { "id": "pcm5102a", "chip": "PCM5102A", "jack": "TX", "kinds": ["audio"], "rates": [48000], "channels": ["left", "right", "both"],
      "delivery": ["slots", "stream"], "slots": 4, "slot_rate": 16000 }
  ],
  "dsp": {
    "iq_spectrum": { "fft_sizes": [1024, 2048, 4096], "rows_per_s": [1, 30] },
    "iq_passband": { "rates": [6000, 12000, 24000] },
    "iq_corrections": ["none", "swap", "negateI", "negateQ"],
    "dc_removal": true,
    "imbalance_correction": false
  }
}
```

- **The A1S answers too:**
  - one input (`es8388`, kinds `audio` or `iq`) and one output (`es8388`);
  - `concurrent_inputs: false`, so switching kind needs a reboot;
  - no `dsp` block.
- **`/info` feature strings stay** for older app builds. They are additive-only.

### `GET/PUT /routing` (new; persisted in NVS; both boards)

```json
{
  "iq":    { "input": "wm8782",  "channels": ["I", "Q"] },
  "audio": { "input": "pcm1808", "channel": "RX" },
  "tx":    { "output": "pcm5102a", "channel": "both" }
}
```

- **Validation:** checked against `/capabilities`. An input not usable for that kind is refused with 400 and a reason.
- **On the A1S,** a change of input kind answers with `"reboot_required": true`.
- **The existing endpoints become thin aliases** of `/routing` and keep working: `/iq-config` `source`, `/audio-source`, `/rx-slot`, `/tx-slot`, `/input-mode`.
- **The control page reads `/routing`** and polls it with the status refresh, so a change made in the web app shows up there within seconds.

### Web app

- **On connect:** read `/capabilities`, falling back to `/info` features for old firmware, and build the source lists from it.
- **RX panel, two selections:**
  - **I/Q:** bridge inputs that list `iq`, the sound card, WebUSB;
  - **Audio:** bridge inputs that list `audio`, the sound card, the mic.
  - **Decoders** take audio from either the audio selection or the demodulated I/Q, with today's Auto as the default.
- **DSP placement:** if the I/Q source is a bridge with `dsp.iq_passband`, use `/iq-passband` + `/iq-spectrum`. Otherwise, take raw I/Q and decimate in the browser, as today.
- **TX:** one selection with two choices, a sound card output device or a bridge output (with channel). It's shared by FT, RTTY and SSTV:
  - **Bridge output:** goes through the slot pool, which keeps scheduling. SSTV would gain a bridge sink.
  - **Sound card:** goes through `setSinkId`.
- **Routing is stored on the bridge.** The app writes `/routing` and reads it back on connect. Local devices stay in localStorage, since the bridge can't know them.

## Phases

1. **Bridge persistence fixes** (small, S3):
   - restore `rx_slot` and `tx_slot` at boot (the bug above);
   - persist the I/Q and audio source selections.
2. **`/capabilities` on both boards** (firmware only, additive).
3. **`/routing` on both boards,** with the old endpoints as aliases, and the control page reading and polling it.
4. **Web app:** read `/capabilities`; separate audio and I/Q source selections; drop the hard-coded `BridgeAdc` type.
5. **Web app:** one TX selection shared by all modes; an SSTV bridge sink.
6. **Clean-up:** retire the per-mode TX sink settings once phase 5 is stable, migrating the saved values.

Phases 1–3 make the bridge self-describing without breaking the current app. Phases 4–5 are the web-app redesign.

## Open questions

1. **Mic as an RX source:** keep the browser microphone in the audio list (it's there today), or drop it?
2. **Two bridges at once,** for example the A1S for audio and the S3 for I/Q: the design allows it (sources are per input), but the app today holds one bridge connection. In scope?
3. **TX streaming:** the bridge slot pool is the scheduled path. Live `/audio` mic-send stays only for the manual "send mic" button. Is that still what you want?

## Decisions (user, 2026-10-26)

- **Mic:** stays as an RX audio source, as "Sound card / mic".
- **One bridge at a time,** but the app must switch between bridges on the fly.
- **TX:** bridge output = slotted; local sound card = live.
- **The A1S** adopts the model with minimal changes and no DSP.

## Done (2026-10-26)

| Phase | Result |
|---|---|
| 1 | **S3 persistence.** The I/Q and audio source selections are saved. The RX/TX channels are now read back at boot; they used to silently reset. |
| 2 | **`GET /capabilities` on both boards** (firmware 0.11.0). |
| 3 | **`GET/POST /routing` on both boards,** saved to NVS; the older endpoints stay as aliases. The S3 control page reads `/routing` and polls it every 3 s. |
| 4 | **Web app RX:** separate "I/Q" and "Decode audio" selections, migrated from the old single list. Start opens each source independently. Bridge input and channel selects are built from `/capabilities` and write `/routing`. The description is re-read per bridge. |
| 5 | **Web app TX:** one shared output (`txSink.ts`) for FT8/FT4, RTTY and SSTV, migrated from the per-mode keys. SSTV gains the bridge output (slotted). |
| 6 | **Clean-up:** the per-mode keys are now read only once, for migration. |

**Verified on hardware:**
- **S3:**
  - routing survives a reboot;
  - the passband runs from both ADCs;
  - TX tone loopback works;
  - the control page follows external changes within 3.8 s.
- **A1S:**
  - capabilities;
  - refuses audio and I/Q together;
  - switches kind with `reboot_required`, both directions;
  - routing works from a browser, cross-origin.
- **Web app:** 926 tests (8 new), clean type-check, build, and a browser check of the new selects and the migrations.

**Verified with the S3 back online (2026-10-26):**
- **The web app connected to the S3,** in a browser:
  - the Bridge panel lists its two ADCs;
  - switching the I/Q input there updates the bridge's saved routing;
  - Start Decoding (I/Q auto, decode audio auto) opens the spectrum and passband streams.
- **Bridge TX slot on the new backend:** an uploaded 1500 Hz tone played from the device and arrived on the WM8782 through the loopback at −13.8 dB, with silence afterwards.
- **SSTV through the bridge, from the app:**
  - a Robot 36 card (36.9 s) is encoded, uploaded to a slot and played;
  - video tones (~1805 Hz, −16.6 dB) show on the WM8782;
  - the slot is freed when it finishes.
- **Fixed along the way:**
  - browser `POST /iq-config` and `/audio-source` were blocked by a duplicated CORS header, so the app's passband settings never reached the S3;
  - the Bridge panel's I/Q settings were hidden on the S3.

**Still untested:** decoding a real on-air signal with mixed sources; it needs the radio connected.

