---
component: WM8782 ADC module (green, two crystals 24.576 / 22.579 MHz)
image: wm8782-module.png, wm8782-module-settings.png (seller's settings table)
role: I/Q ADC — clock master at 96 kHz, feeds the S3's I2S0 and the 24.576 MHz master clock for the whole board
status: partly validated (settings table read with the user, 2026-10-11)
---

# WM8782 module

## Read from the images
- **Inputs:** `J4` with `Rin` / (middle) / `Lin`, through the 47 µF 16 V coupling capacitors `C6`/`C7`.
- **Power:** `J5`, `+5V` / `GND`, into regulator `VR1` (a 3-pin regulator package) and the 47 µF capacitor `C10`.
- **Output header:** `B`, `LR`, `D`, `CLK`, plus a `G` test pad.
- **Jumpers:**
  - `J1` picks the crystal: 22 or 24.
  - `J2` halves the clock (½clk), through the small chip `U1`, likely a flip-flop.
  - `J6` sets the clock role: S or M.
- **DIP switch `S1`, four levers, each + / 0 / −:**

  | Lever | Function | + | 0 | − |
  |---|---|---|---|---|
  | 1 | Master/slave | master | — | slave |
  | 2 | Format | left-justified | I2S | right-justified |
  | 3 | Rate | 96 / 88.2 kHz | 192 / 176.4 kHz | 48 / 44.1 kHz |
  | 4 | Word length | 20-bit | 24-bit | 16-bit |

## Inferred — needs your confirmation
- **Q1:** `VR1` makes the 3.3 V digital supply, while analog (AVDD) runs at 5 V. With 5 V AVDD, full-scale input is about 1 Vrms.
- **Q2, answered by measurement (2026-10-21): no.** `J6` selects the chip's master-clock source; the seller's picture calls it "Master-slave M/S clock source selection".
  - **S:** the chip takes its clock from the `CLK` header, through R1.
  - **M:** it takes the on-board crystal, and the `CLK` header is left unconnected.
  - **Measured:** with J6 = M the WM8782 ran at 96 kHz, while the buffer saw a floating `CLK` (Y stuck high, 0 Hz on GPIO7).
  - **Fix:** tie all three J6 pins together (the shunt on M + middle, plus a wire from S to the middle). The crystal then also drives the `CLK` header, through R1. First check by continuity that `CLK` reaches the S pin.
- **Q3, confirmed by the user 2026-10-12:** the middle pin of `J4` is analog ground.

## Settings for this project
- **DIP S1:** lever 1 = + (master), lever 2 = 0 (I2S), lever 3 = + (96 kHz), lever 4 = 0 (24-bit).
- **Jumpers:** `J1` = 24, `J2` open, `J6` = M **with S also tied to the middle pin**, so `CLK` carries the crystal out (see Q2).
- **Output header** (final map, draft 4 on):
  - `B`/`LR`/`D` → S3 GPIO4/5/6.
  - `CLK` → clock buffer → S3 GPIO7 and PCM1808 `SCK`.
- **Power:** `+5V` from the TPS7A4701 board (quiet rail), not the shared 5 V lane.
