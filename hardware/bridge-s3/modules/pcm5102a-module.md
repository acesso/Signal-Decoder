---
component: PCM5102A DAC module (purple, "EstarDyn" listing; footprint also fits PCM5100/5101)
image: pcm5102a-module.png
role: TX audio DAC — S3 → radio mic path through the main board's isolation transformer
status: validated by the user 2026-10-12 (Q2, Q3)
---

# PCM5102A module

## Read from the image
- **Front, 6-pin header:** `SCK`, `BCK`, `DIN`, `LCK`, `GND`, `VIN`.
- **Front, top row:** pads `1`, `2`, `3`, `4`, then `G`, `R`, `G`, `L` (marked LINE OUT), and a 3.5 mm jack.
- **Back, same row:** `FLT`, `DEMP`, `XSMT`, `FMT`, `A3V3`, `AGND`, `ROUT`, `AGND`, `LROUT`. So `1`=FLT, `2`=DEMP, `3`=XSMT, `4`=FMT.
- **Back, solder jumpers:** `H1L`, `H2L`, `H3L`, `H4L`, each 3 pads, choosing high or low for FLT, DEMP, XSMT and FMT.
- **Back, variant marks:** `PCM5102` / `PCM5101` / `PCM5100`.
- **Parts:** a PCM5102A chip and two small regulators.

## Inferred — needs your confirmation
- **Q1:** `VIN` takes 3.3–5 V; the two onboard regulators make the chip's supplies.
- **Q2, confirmed:** all four jumpers H1L–H4L are **open** on this board. FLT, DEMP, XSMT and FMT therefore float unless set, either by soldering the jumper or by driving the numbered pad. Our board must set every one.
- **Q3, confirmed:** `SCK` is **not** grounded on the board. With `SCK` tied to GND, the chip makes its own clock from `BCK`, so our board must ground `SCK`.
- **Q4:** `LROUT` is the left output.

## Settings for this project
- **Clocks and data:**
  - `SCK` = GND through the module's own solder bridge beside `SCK`: internal PLL from BCK; no master clock needed.
  - `BCK`/`LCK` ← S3 I2S1 (GPIO16/18), shared with the PCM1808.
  - `DIN` ← S3 GPIO15.
- **Pins** (the jumpers ship open, so each must be set):
  - `FMT` = L: I2S. Solder H4L to L.
  - `FLT` = L: normal-latency filter. Solder H1L to L.
  - `DEMP` = L: de-emphasis off. Solder H2L to L.
  - `XSMT` ← S3 GPIO8 through pad `3`, so the firmware can mute. High = playing. Leave H3L open.
- **Power:** `VIN` from the 5 V lane.
- **Output:** use `LROUT` and `AGND` to the TX P2 cable. Full scale is 2.1 Vrms, far above mic level, so the main board's TX trimpot stays.
