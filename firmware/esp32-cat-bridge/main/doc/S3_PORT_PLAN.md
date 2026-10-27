# ESP32-S3 bridge board: plan

Branch `feat/bridge-esp32s3`, a long-lived branch. This file is the plan of record: update it when a decision changes.

## Goal

A second bridge board built from discrete converters on an ESP32-S3-N16R8 dev board. The AI-Thinker ESP32-A1S (ES8388) stays supported in the same firmware as the reference and backup board.

| Part | Job |
|---|---|
| WM8782 module (premium ADC) | I/Q from the radio, 96 kHz by default, 192 kHz on the roadmap |
| PCM1808 module | Per-channel choice: radio RX audio, audio loop (the radio mic line after the isolated path), or off |
| PCM5102 module | TX audio to the radio mic through the galvanically isolated path. Line out only, no speaker |
| UART1 | CAT to the uSDX |
| UART0 / UART2 | Tuner and frequency-sensing module: generic lines, 9600 8N1 by default, raw WebSocket pass-through, no UI yet (last priority) |
| GPIO | PA sense, PA emergency, onboard RGB status LED |

## Board facts (probed 2026-10-11)

- ESP32-S3 (QFN56), revision v0.2, 40 MHz crystal, MAC 7c:4f:ad:b7:b8:88.
- 16 MB flash: an XMC XM25QH128A (JEDEC ID 20 70 18).
  - ESP-IDF 5.3.2's bootloader refuses this A-series part ("XMC flash startup fail") and reboot-loops. A bootloader component (`bootloader_components/xmc_a_flash`) skips the XMC C-series start-up flow for exactly this ID.
  - The bootloader can't set the quad-enable bit, so flash runs in DIO mode.
- 8 MB in-package octal PSRAM at 80 MHz, so GPIO33–37 are unavailable. A full write/read check passes.
- **Memory setup:** chosen by benchmark, applied in the probe and to be carried into the bridge.

  | Setting | PSRAM to internal | Random PSRAM read | Other core's stall during a flash write | Free internal RAM |
  |---|---|---|---|---|
  | Defaults (16 KB instruction cache, 32 KB data cache, 32-byte lines) | 61 MB/s | 525 ns | 25 ms | 283 KB |
  | Largest caches, 64-byte data lines | 88 MB/s | 685 ns | 28 ms | 236 KB |
  | **Largest caches and code run from PSRAM** | **88 MB/s** | **685 ns** | **0.06 ms** | **235 KB** |

  - Running code from PSRAM ends the flash-write stalls, so OTA, NVS and CAT-log writes can't glitch audio. It is also faster than this board's DIO-only flash.
  - 64 KB data cache with 32-byte lines gave no throughput gain (61 MB/s): the line size is what matters, and audio is sequential.
  - Octal PSRAM at 120 MHz stays off: ESP-IDF marks it experimental and temperature-sensitive.
- Two USB-C ports: the native USB (USB-Serial/JTAG, used for console and flashing) and a USB-UART bridge on GPIO43/44.
- LEDs:
  - The onboard RGB LED (WS2812) is on **GPIO48**: the original DevKitC-1 layout.
  - The red one that is always on is power.
  - The green one is the USB-UART bridge's TX light on GPIO43, confirmed by toggling the pin. It blinks while flashing because the boot ROM also prints on UART0.
  - The one that never blinks is that bridge's RX light, which only lights when a computer sends into the second USB port.
- The board's own AMS1117 regulator is fed from either USB port.
- The WM8782 module gets a dedicated TPS7A4700 regulator, fed from the same 5 V.

Pins to avoid: 19/20 (USB), 26–32 (flash), 33–37 (PSRAM), 43/44 (USB-UART bridge), and the strapping pins 0/3/45/46.

## WM8782 module settings

Header: `B LR D CLK G`. DIP S1 levers have three positions: + / 0 (pin floating) / −.

| Lever | + | 0 | − | Setting |
|---|---|---|---|---|
| 1: clock role | master | — | slave | **+ (master)** |
| 2: format | left-justified | I2S | right-justified | **0 (I2S)** |
| 3: rate | 96 / 88.2 kHz | 192 / 176.4 kHz | 48 / 44.1 kHz | **+ (96 kHz)** |
| 4: word length | 20-bit | 24-bit | 16-bit | **0 (24-bit)** |

Jumpers: J1 = 24 (24.576 MHz crystal), J2 open (no ½ clock), J6 = M (master: the module's crystal clocks the chip).

**Unconfirmed:** that `CLK` carries the crystal out of the module in this setting. The probe measures it once wired.

## Clocking (decided by the probe, 2026-10-11)

The S3 has no audio PLL, and a master clock divided from its 160 MHz PLL is fractional and jittery. Everything therefore runs from the WM8782 module's 24.576 MHz crystal.

**I/Q port (I2S0): the WM8782 is the clock master, and the S3 is a slave.**
- The module makes bit clock and word clock from its crystal (256 fs at 96 kHz, 128 fs at 192 kHz).
- The probe emulated this, with I2S0 as master and I2S1 as slave on the same pads, at 48, 96 and 192 kHz. 24-bit data arrived intact at all three.

**Audio port (I2S1): the S3 is master at 48 kHz, clocked from the crystal.**
- The crystal comes in on GPIO4 as `I2S_CLK_SRC_EXTERNAL`. The PCM1808 gets the same crystal on SCKI (512 fs), and the PCM5102 locks to the bit clock.
- The probe proved the external clock really drives I2S1: a 20.48 MHz pad clock gave exactly 40 kHz instead of 48 kHz. 24-bit full-duplex loopback was intact.

**Why not the S3 as master for I/Q too:**
- The S3's internal MCLK divider can't divide by 1, so 96 kHz from 24.576 MHz needs the bit clock at MCLK/2.
- At that ratio, loopback data came back shifted left by one bit. At MCLK/4 it is clean.

**Result:** one crystal, two ports, never drifting apart.

## Draft pin map

| Function | GPIO |
|---|---|
| External master clock in (module `CLK` via the clock buffer; also to PCM1808 SCKI) | 7 |
| I2S0 WM8782 (module is master): bit clock in / word clock in / data | 4 / 5 / 6 (straight wires from the module's header as mounted, draft 4) |
| I2S1 audio: bit clock / word clock | 16 / 18 |
| I2S1 data in from PCM1808 / data out to PCM5102 | 17 / 15 |
| PCM5102 XSMT (mute) | 8 |
| PA sense (active low, pull-up) / PA emergency | 9 / 14 |
| CAT UART1 TX / RX | 10 / 11 |
| Tuner UART2 TX / RX | 12 / 13 |
| Frequency module UART0 TX / RX | 1 / 2 |
| Onboard RGB LED (WS2812) | 48 |
| Spare | 21, 38–42, 47 (38 is free: the LED is on 48) |

## I/Q on the bridge

Raw I/Q costs about 384 KB/s at 96 kHz and 768 KB/s at 192 kHz. The bridge splits it into two streams, and the web app keeps demodulation, noise reduction and the decoders:

- **Spectrum:** FFT on the S3 (esp-dsp), 8-bit magnitude rows. About 40 KB/s at 4096 bins and 10 rows/s.
- **Passband:** shifted to zero and decimated to a narrow complex stream. About 48 KB/s at 12 kHz.
- Controls: passband centre and width (from the web app's existing passband), spectrum size and row rate.
- Raw `/iq-data` stays as an opt-in mode.

## Phases

1. **Bring-up probe** (`firmware/esp32s3-probe`):
   - Done: chip, PSRAM, flash boot fix, external-clock I2S, slave RX at 48/96/192 kHz.
   - Done: the RGB LED is on GPIO48; memory setup benchmarked.
   - Once wired: measure `CLK`, read both ADCs, play a tone on the DAC.
2. **Board layer** (done 2026-10-11, details below): split the audio code into shared parts plus an ES8388 backend, and build both targets. A1S regression check.
3. **S3 base** (done 2026-10-11, except CAT with a radio attached):
   - Wi-Fi, CAT on UART1, PA watchdog, RGB status LED.
   - 16 MB partition layout with OTA for both the app and the page storage.
   - Console on the native USB port.
4. **S3 audio:** PCM1808 into `/audio`, PCM5102 for TX, audio-loop channels, 24-bit samples scaled to 16-bit for the streams.
5. **S3 I/Q, raw:** WM8782 into `/iq-data` at 96 kHz, alongside audio.
6. **Bridge-side split:** spectrum and passband streams, plus web app support, keeping fallbacks to raw I/Q and to the A1S.
7. **UI per board:** `/info` features describe the running board, and the bridge page hides the ES8388-only controls.
8. **Tuner and frequency serial lines.**
9. **Docs and hardware tests:** at 192 kHz this phase also re-checks the CPU and bandwidth budget.

## Status (2026-10-11)

**Phase 2: one firmware, two boards.**
- The board follows the target (`CONFIG_BRIDGE_BOARD_A1S` / `_S3`).
- Pins are per board in `bridge_config.h`; build defaults are shared plus per chip.
- The S3 builds in `build-s3/` with `sdkconfig.s3`.
- **Audio deferred:** `audio_monitor_s3.c` stands in with no audio. The deeper split of `audio_monitor.c` into shared and ES8388 parts waits for phase 4, when there is S3 audio hardware to test it against.

**Phase 3: S3 base, all working on the board.**
- Wi-Fi at about −66 dBm on the internal antenna; an IPEX antenna is planned.
- mDNS `usdx-bridge-s3.local`, DHCP 192.168.0.8.
- App OTA and page-storage OTA.
- PA watchdog on GPIO14 (sense) / GPIO11 (emergency), idle.
- RGB LED: green = alive, blue = connecting, amber = AP fallback, red = PA emergency.
- Core dump saved to flash on a crash.
- `/bench` results:

  | Measurement | S3 | A1S |
  |---|---|---|
  | PSRAM → internal | 86 MB/s | 25 MB/s |
  | Random PSRAM read | 398 ns | 985 ns |
  | Other core frozen during a flash write | 38 µs | 6 ms |
  | Free internal RAM | 166 KB | 97 KB |

**Fixed on the way:** small task stacks (2 KB) overflowed on the S3. The CAT boot query, the status LED and restart tasks now use 3 KB.

**Not yet tested:** CAT with the radio attached (UART1 on GPIO9 TX / GPIO10 RX).

## Status (2026-10-11, later)

**Phase 6, I/Q processing on the bridge: done against the synthetic test signal.**
- **Bridge:** spectrum and passband streams with I/Q swap/negate and DC removal ahead of them.
- **Web app:** bridge mode, decided by `/info`. The demodulated audio matches the raw path exactly: same 1000 Hz tone at −17.0 dBFS.
- **Imbalance correction** stays raw-path only (option 2, user's choice).
- **Load:** ~27% of one core with both streams.
- **Internal RAM** is down to ~44 KB free. The converter stage needs internal RAM for I2S DMA; the FFT buffers can move to PSRAM then.

**Phase 7, bridge page per board: done.** A board badge and Board row, and controls hidden when `/info` doesn't list their feature.

**Phase 8, serial lines: done.** Tuner and frequency module, loopback-tested at 9600 and 115200.

**Next, needs wiring:** phase 4 (PCM1808/PCM5102) and phase 5 (WM8782 into `iq_dsp_feed()`), then CAT with the radio on UART1.

## Status (2026-10-26)

**The board is built and every converter path is verified** (`hardware/bridge-s3/pre-solder-review.md`, bring-up sections).
- **Clock:** a separate 24.576 MHz oscillator. The WM8782 module's `CLK` header turned out to be too weak a tap to drive anything. The oscillator feeds the WM8782 (`J6` open), the S3's GPIO7 and the PCM1808's SCKI.
- **Buffer:** the clone buffer chip is bypassed.

**Phases 4 and 5, audio and I/Q from the real converters: done.** `audio_monitor_s3.c` replaces the stub.
- **WM8782:** I2S0 slave at 96 kHz.
- **PCM1808 + PCM5102A:** I2S1, master at 48 kHz on the external clock, full duplex.
- **TX:** mic-send, the TX slot pool and the test tone are upsampled ×3 to 48 kHz and queued for a DAC task, which writes silence whenever the queue is empty.
- **Both ADCs run at once, selectable per stream** (feature `adc_source_select`):
  - **I/Q streams:** `/iq-config` `"source"`: `wm8782` (default, 96 kHz), `pcm1808` (48 kHz), `test` or `none`. The DSP follows the source's rate.
  - **`/audio`:** `GET/POST /audio-source`: `pcm1808` (default) or `wm8782` (decimated 96 → 48 kHz). `rx_slot` picks the channel.
  - **Selectors:** in the bridge's control page and the web app's I/Q settings. The waterfall follows the rate in each spectrum row.
  - **Not persisted:** every boot starts with the WM8782 for I/Q and the PCM1808 for audio.
- **Measured over Wi-Fi:**
  - `/audio`: 48,000 samples/s from either ADC; open-input noise −88 dBFS (PCM1808) and −99 dBFS (WM8782).
  - I/Q: no input drops; DSP load 19% at 96 kHz, 10% at 48 kHz.
  - Free internal RAM: 30 KB after start, with the FFT and window moved to PSRAM.

**Still to test:**
- TX audio through the radio path (the DAC path itself passed the loopback).
- CAT with the radio, once the data header is wired.
