---
component: TPS7A4701 low-noise LDO module (green; listing photo marked "(C)SWIRFE", the user's board marked "(C)DykbRadio" on the back)
image: tps7a4701-module-swirfe.png (seller's photo, component side), tps7a4701-module-back.png (the user's board, back side)
role: quiet 5.0 V rail for the I/Q chain (WM8782 module + I/Q op-amp), fed from the 7.5 V lane
status: validated by the user 2026-10-12 (pads all open; pin labels from the back of the user's board)
---

# TPS7A4701 module

## Read from the image
- **Output-setting pads:** a row of 8 pad pairs marked `.1`, `.2`, `.4`, `.8`, `1.6`, `3.2`, `6.4`, `6.4`. These are the chip's ANY-OUT pins.
- **Other marks:** `P V7.4` with a small pad.
- **Connectors:** 4 through-holes on each of two edges, and 4 mounting holes.
- **Back of the user's board** (`tps7a4701-module-back.png`, viewed from the back):
  - Output edge: `GND`, `NC`, `Vo`, `GND`.
  - Input edge: `GND`, `EN`, `(3-36V)Vin`, `GND`.
  - Seen from the component side, the input edge is the one next to the protection diode.
- **Parts:** the TPS7A47 chip (QFN), a tantalum capacitor, ceramics, and a diode on the left.

## Inferred — needs your confirmation
- **Q1, pads confirmed all open:** output voltage = 1.4 V + the sum of the bridged pads. **For 5.0 V:** bridge `3.2` and `.4` (1.4 + 3.2 + 0.4 = 5.0). With nothing bridged the output is 1.4 V, so bridge the pads before connecting a load.
- **Q2, answered by the back-side photo:** see the pin list above.
- **Q4:** `EN` has no visible pull-up. The TPS7A47's enable must be driven high (it tolerates up to Vin), so tie `EN` to `Vin` on our board.
- **Q3:** `P V7.4` is probably a board revision ("PV 7.4") or a power-good pad, not a setting.

## Settings for this project
- **Input:** the 7.5 V lane, tapped at the main board's LM7805 input. No LC pre-filter (dropped in draft 5).
  - Dropout is about 0.3 V, so 7.5 V leaves plenty of margin.
  - It can't run from the 7805's 5 V.
- **Enable:** `EN` bridged to `Vin`.
- **Output:** 5.0 V from `Vo` to the WM8782 module's `+5V` only (no op-amp in this build). `NC` stays unconnected.
