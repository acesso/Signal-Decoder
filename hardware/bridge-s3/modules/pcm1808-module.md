---
component: PCM1808 ADC module (purple, "TENSTAR ROBOT" listing)
image: pcm1808-module.png
role: audio port ADC — radio RX audio (L) and the audio-loop tap (R), slave to the S3 at 48 kHz
status: validated by the user 2026-10-12 (Q2 confirmed, label read; Q1 function still to check)
---

# PCM1808 module

## Read from the image
- **Left header, top to bottom:** `PMT`, `MD1`, `MD0`, `GND`, `3.3V`, `+5V`.
- **Right header, top to bottom:** `BCK`, `OUT`, `LRC`, `SCK`, `GND`, `3.3V`.
- **Top edge, 3 pads:** `RIN`, (unlabelled middle), `LIN`.
- **Parts:**
  - Five 10 µF 100 V electrolytics.
  - A small part marked `101` next to `SCK`, probably a 100 Ω series resistor.
  - No voltage regulator visible on either side.

## Inferred — needs your confirmation
- **Q1 (label confirmed, function still assumed):** the board really prints `PMT`, not `FMT`. It is almost certainly the PCM1808's FMT pin (low = I2S, 24-bit), mislabelled. To confirm, check continuity from the `PMT` pad to PCM1808 pin 12 (FMT).
- **Q2, confirmed:** the board has **no regulator**. `+5V` feeds the analog supply (VCC) and `3.3V` the digital supply (VDD), so both must be supplied. The two `3.3V` pins are the same net.
- **Q3:** the unlabelled middle pad on the top edge is analog ground for the inputs.
- **Q4:** `SCK` is the master-clock input (SCKI), not the bit clock.

## Settings for this project
- **Pins:** `PMT` (FMT), `MD1` and `MD0` bridged to the neighbouring `GND` pin: I2S 24-bit, slave.
- **Clocks:**
  - `SCK` ← buffered 24.576 MHz, which is 512 × 48 kHz.
  - `BCK`/`LRC` ← S3 I2S1 (GPIO16/18).
  - `OUT` → S3 GPIO17.
- **Power:**
  - `+5V` from the 5 V lane.
  - `3.3V` from a separate small LDO (LP5907, which you have), not the S3's 3V3 pin. That keeps the S3's digital noise off the ADC.
- **Input level:** full scale is about 0.6 × VCC peak-to-peak, roughly 3 Vpp or 1.06 Vrms at 5 V. Set your RX trimpot below that.
