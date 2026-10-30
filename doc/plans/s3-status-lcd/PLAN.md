# S3 status display (Nokia 5110/3310 LCD), plan

**Status:** firmware written in bridge 0.13.0 on branch `feat/s3-status-lcd` (2026-10-28): driver, six views, overlays, `/display` endpoints and the control-page card with a live preview. Not yet tested on the glass. S3 bridge only; the A1S gets nothing.

**Decided (user, 2026-10-27):**
- **Mounting:** the module's pin row is soldered straight onto the large pads along the board edge next to the S3, at 90° to the board, display facing outward, hanging up (pin 8, LED, at the antenna end).
- **Backlight:** six small white LEDs, taken as under 20 mA, so GPIO43 drives it directly.
- **Module:** checked, it works.

**Goal:** a small live status screen on the S3 bridge. The bridge sits under the stack, so today its state is only visible in a browser. The screen shows the things most often checked, drawn as graphics (bars, graphs, icons, large digits) rather than lines of text, in several views chosen from the bridge's web page.

## The module

| Front | Back | Pin labels |
|---|---|---|
| ![front](module-front.jpg) | ![back](module-back.jpg) | ![pinout](module-pinout.jpg) |

- **Controller:** PCD8544, 84 × 48 pixels, 1-bit, SPI (write-only).
- **Supply:** 3.3 V, so it connects straight to the S3. Logic draws under 0.5 mA without the backlight.
- **Board:** the red variant, with a right-angle header already fitted. A second, empty 8-hole row on the other edge carries the same signals.
- **Pins, as printed on the back:** 1 VCC, 2 GND, 3 SCE, 4 RST, 5 D/C, 6 DN (MOSI), 7 SCLK, 8 LED.
- **Condition:** checked by the user (2026-10-27): the glass and backlight work. Backlight: six small white LEDs, taken as under 20 mA.
- **Size:** about 45 × 45 mm.

## Where it goes: the board edge beside the S3's free header

The S3's top header (J3) is unused on this board and runs along the board edge. From the antenna end it reads: GND, 43 (TX0), 44 (RX0), 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, GND, GND.

**Mounting:** the module's 8 pins are soldered onto 8 of the large pads along that board edge, so the module stands at 90° to the board, display facing outward. No header.
- **Connections:** six pads join their J3 pins by short bare links on the bottom face, straight across the two hole rows between the pads and J3: parallel, no crossings.
- **The two wires:** GND, along the hole row next to J3 to J3's GND at the USB end (bottom face). VCC, on the top face along the edge row to the hole past J3's antenna end, then on the bottom face under the S3 to its second `3V3` pin (J1).
- **Strength:** with only the pins holding it, a 45 × 45 mm module is a lever on its solder joints. Add a dab of hot glue or a small bracket between the module's back and the board edge.
- **Clearance:** the main board sits 20 mm above. The module hangs outside the bridge board's footprint, so check it also clears the main board's edge and anything below the stack.

**Pin order: the module hangs up.** Hanging up with the display facing out, the module's pins run opposite to J3: pin 8 (LED) is at the antenna end, pin 1 (VCC) toward USB. The six signals take the six J3 pins from 43 to 41; GND and VCC land beside 40 and 39 (unused) and each takes a wire:

| Module pin | Signal | Pad beside | S3 | Notes |
|---|---|---|---|---|
| 8 | LED | J3 TX0 | GPIO43 | direct drive, PWM dimming; the ROM's boot log flickers it, harmless |
| 7 | SCLK | J3 RX0 | GPIO44 | |
| 6 | DN (MOSI) | J3 1 | GPIO1 | |
| 5 | D/C | J3 2 | GPIO2 | |
| 4 | RST | J3 42 | GPIO42 | the firmware resets the display after boot |
| 3 | SCE | J3 41 | GPIO41 | |
| 2 | GND | J3 40 (unused) | GND | wire along the row next to J3, to J3's GND at the USB end |
| 1 | VCC | J3 39 (unused) | 3V3 (J1) | top-face wire to the hole past J3's antenna end, then under the S3 |

- **Hung down instead**, the order would reverse (VCC at the antenna end); the drawing follows the hang-up layout.
- **The picture's orientation doesn't matter:** the firmware rotates it to suit (u8g2 rotation).
- **Pad alignment:** check on the board that the edge pads line up with the hole columns at the same 2.54 mm pitch. If they're offset, the links run at a slight angle, still without crossing.

**Why these pins are free:**
- **43/44:** the firmware's console is on USB-Serial/JTAG (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`), not UART0.
- **1/2:** reserved today for the frequency-module serial line (`S3_FREQ_TX_PIN`/`S3_FREQ_RX_PIN`, UART0), which has no device. That line moves to **GPIO47/21**. GPIO21 is the A1S's PA-enable pin only; on the S3 it is free.
- **41/42:** JTAG pins, free because debugging runs over USB.
- **Avoided:** 35–37 (octal PSRAM), 0/45/46 (strapping), 48 (the RGB status LED), 19/20 (USB).

**Before soldering, on the bottom face:** the J3 socket holes for GND to 41, and the two hole rows between them and the edge pads, must be free of wires.

**Antenna:** this is the S3's antenna end, and the IPEX antenna is fitted there. Route its lead away from the module's metal frame, and compare the Wi-Fi RSSI (`/status`) before and after fitting the screen.

## Checks before building

1. ~~**The glass.**~~ Done: it works.
2. **Backlight:** taken as under 20 mA (six small white LEDs), so GPIO43 drives it directly at its default 20 mA drive strength. If it ever measures more, add a small NPN (e.g. 2N2222 with 1 kΩ to its base).
3. ~~**Contrast.**~~ Done: this unit ignores the Vop and bias commands (raw-command test, 2026-10-28: display on/blank work, Vop 0 and 127 look the same), so its contrast is fixed in hardware. The web page has no contrast controls.

## What it shows

| View | Content |
|---|---|
| **Dashboard** | Large frequency digits and the mode, parsed from the CAT replies the bridge already relays. Icons for TX/RX, the radio link, Wi-Fi strength, client count, PA state. |
| **Spectrum** | Live 84-pixel-wide spectrum from the S3's own FFT, with a peak-hold line. Optionally a dithered 1-bit waterfall under it. |
| **Levels** | Bars with peak hold and clip marks: I/Q left/right (WM8782), RX audio and loop (PCM1808), DAC output (PCM5102A). |
| **System** | CPU sparklines for both cores, internal RAM and PSRAM bars, the chip temperature (internal sensor), uptime. |
| **Network** | Wi-Fi RSSI sparkline, KB/s per stream, WebSocket clients, IP address. |
| **TX** | Slot list, a playback progress bar, the TX channel, the DAC level (`/dac-level`). |
| **Overlays** (over any view) | PA emergency: full screen, inverted, backlight blinking. Wi-Fi setup (AP fallback): network name and IP. Firmware or page upload: progress bar. **Last TX** for a few seconds after key-up, from the radio's `TA` report: full power, below full power or clipping, with the mic peak as a bar (the same judgement as the app's "Last TX" chip, `src/lib/cat/txReport.ts`). |

**Views are switched from the bridge's web page.** Auto-cycle with a set dwell time is an option.

## Firmware outline

- **Driver:** SPI2 at about 4 MHz.
  - The frame is 504 bytes and takes about 1 ms to send.
  - A low-priority task on core 0 redraws 3–5 times a second. The DSP stays alone on core 1.
- **Drawing:** u8g2 (it supports the PCD8544, and there's an ESP-IDF port) for fonts and primitives. Small widgets of our own for bars, sparklines, icons and digits. All views share one frame buffer.
- **Data:** everything shown already exists in the firmware:
  - `/status` and `/system-stats`;
  - the I/Q spectrum rows from `iq_dsp`;
  - the CAT traffic, and the WM8782 rate the reader measures.
- **New pieces in the firmware:**
  - a small parser for the radio's `FA`/`IF`/`MD` and `TA` frames as they pass through the bridge, for the frequency, mode and Last TX;
  - peak meters per ADC channel and on the DAC, for the Levels view (the S3 has none today).
- **Settings in NVS:** view, auto-cycle and dwell time, contrast (Vop), bias, backlight level, invert.
- **HTTP:**
  - `GET/POST /display` for the settings.
  - `GET /display/frame` returns the current 504 bytes, so the web page can mirror the screen.
- **Capabilities:** a `display` feature in `/info` (S3 builds only), plus a `display` entry in `/capabilities`. The A1S doesn't announce it, so nothing shows there.

## Web page

A **Display** card under Hardware settings, on the S3 only:
- the view picker, auto-cycle and dwell time;
- contrast, backlight and invert;
- a live preview: the frame from `/display/frame` drawn on a canvas at 3–4× scale, so it shows exactly what the screen shows.

## Order of work

1. Dry-fit: pin order (hanging up: LED at the antenna end), pad alignment, clearance to the main board and below.
2. Hardware:
   - **Drawing and notes:** add the edge-mounted module, its 6 links and the GND and VCC wires to the drawing and its parts list, and update `wiring.md`.
   - **Pin map:** move the frequency socket to GPIO47/21 in `bridge_config.h`.
3. Firmware: driver and a test pattern, then the dashboard view and the PA-emergency overlay.
4. HTTP settings and the frame endpoint; then the web card and preview.
5. The remaining views: spectrum, levels, system, network, TX.

## Open questions

- Whether the dithered waterfall is readable at 84 × 40 pixels, or the spectrum view keeps only the line.
- That the module, hanging up, clears the main board 20 mm above and anything else in the stack.
