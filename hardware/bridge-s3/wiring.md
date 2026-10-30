# S3 bridge board: wiring (draft 1, 2026-10-12)

The new board sits at floor −1 under the existing bridge (main) board, on 2 cm metal spacers, and is cabled to it. Every module plugs into 2.54 mm round-pin sockets.

- Pin map: `firmware/esp32-cat-bridge/main/bridge_config.h`.
- Module facts: `modules/*.md`.
- Items marked **[check]** need a quick confirmation before soldering.
- **Sections 1–9 are the design history.** Where they disagree with section 10, section 10 wins. The tables in sections 1, 3 and 4 have been corrected to the final pins and straps. The soldering checklist is `pre-solder-review.md`.

## 1. Power

| Rail | Source | Feeds | Notes |
|---|---|---|---|
| **+7.5 V** | Main board, tapped at the LM7805's input (new lane on the power cable) | TPS7A4701 `Vin`, directly | The LC pre-filter was dropped in draft 5: the TPS7A47 rejects the LM2596 ripple on its own. |
| **+5 V quiet** | TPS7A4701 `Vo`, pads `3.2` + `.4` bridged = 5.0 V; `EN` tied to `Vin` | WM8782 module `+5V` | Nothing digital on this rail. |
| **+5 V** | Main board, LM7805 (the lane that feeds the A1S today) | S3 `5Vin`, PCM5102A `VIN`, PCM1808 `+5V`, LP5907 input | |
| **+3.3 V audio** | LP5907 from +5 V (`IN`, `GND`, `EN`→`IN`, `OUT`; 1 µF ceramic on IN and OUT, at the pins) | PCM1808 `3.3V` (digital), the 74LVC1G157 clock buffer | Kept separate from the S3's own 3V3, so the S3's switching stays off the ADC. **Pending, the user will confirm:** LP5907MFX pinout against its datasheet before fitting. |
| **GND** | Main board power entry (the stack's single star point) | Everything | See section 6. |

**Budget:** the S3 takes 250–350 mA with Wi-Fi; the converters, buffer and LP5907 add about 60 mA. The 7805 drops 2.5 V at about 0.4 A, so roughly 1 W: fine, a little warm.

**S3 power while flashing:** with external 5 V on `5Vin` and the USB cable plugged in, the board's `IN-OUT` pads must stay **open**. The diode then stops the USB port and the external 5 V from feeding each other. **Confirmed open on the user's board (2026-10-12).**

## 2. Cables between the main board and the new board

| Cable | Conductors | From (main board) | To (new board) |
|---|---|---|---|
| Power | +7.5 V, +5 V, GND (3 wires; add a second GND if the connector allows) | Power zone | Power entry |
| Data (the existing Dupont bundle, moved) | 3V3, GND, CAT TX, CAT RX, PA sense, PA emergency | Data zone (level shifter, PA circuit) | 6-pin socket next to the S3 |
| RX audio (P2) | signal, GND | RX transformer output | PCM1808 `LIN` |
| TX audio (P2) | signal, GND | TX trimpot and transformer input | PCM5102A `LROUT` / `AGND` |
| I/Q (P2) | I, Q, GND | Straight from the radio's I/Q P2 (the old manual coupler is retired) | I/Q jack → WM8782 `J4` |
| Audio loop (P2, optional) | signal, GND | Radio mic line after the TX transformer | PCM1808 `RIN` |

**Data bundle mapping:** the same functions, moved from the A1S pins to the S3:

| Function | A1S pin today | S3 pin |
|---|---|---|
| CAT TX (bridge → radio, level shifter LV1) | IO18 | **GPIO9** |
| CAT RX (radio → bridge, level shifter LV2) | IO23 | **GPIO10** |
| PA sense (active low, pull-up in firmware; LV4) | IO19 | **GPIO14** |
| PA emergency (clamp, high-Z when idle; LV3) | IO5 | **GPIO11** |
| Level shifter low side | 3V3 | **3V3** (S3 header) |
| Ground | GND | **GND** |

**The level shifter** (on the power board, left as it is):
- Top view: `HV1 HV2 HV GND HV3 HV4` over `LV1 LV2 LV GND LV3 LV4`.
- HV1 and HV2: 220 Ω each to the CAT P2 tip and middle. HV: the board's 5 V (LM7805). HV3: diode and 1 kΩ to PA_SEND (PA emergency). HV4: the 2N2222 and choke to the PA (PA sense).
- **The new cable** runs straight from the LV row to the data header, in the same order: orange LV1 (CAT TX), yellow LV2 (CAT RX), green LV (3.3 V), blue GND, violet LV3 (PA emergency), gray LV4 (PA sense).
- **LV1 is taken as CAT TX.** If CAT stays silent, swap `CAT_UART_TX_PIN` and `CAT_UART_RX_PIN` in `bridge_config.h`; no rewiring.
- **The old cable's resistor** (across LV and GND, mid-cable) is a bleeder that held the LV rail at 0 V while the A1S was off. It isn't needed with the S3, whose 3V3 is a stiff regulator: the LV pin only feeds the shifter's own 10 kΩ pull-ups. Left out of the new cable.

## 3. Module connections

### ESP32-S3 dev board

All signal pins are on the left header, except the frequency-module serial line.

| S3 pin | Net | Goes to |
|---|---|---|
| 5Vin | +5 V | power |
| GND (both headers) | GND | ground grid |
| 3V3 | 3V3 | data cable (level shifter low side) only |
| GPIO4 | IQ_BCLK | WM8782 `B` |
| GPIO5 | IQ_LRCK | WM8782 `LR` |
| GPIO6 | IQ_DATA | WM8782 `D` |
| GPIO7 | MCLK_S3 | clock buffer branch A (33 Ω) |
| GPIO15 | AUD_DAC | PCM5102A `DIN` |
| GPIO16 | AUD_BCLK | PCM1808 `BCK`, then on to PCM5102A `BCK` |
| GPIO17 | AUD_ADC | from PCM1808 `OUT` |
| GPIO18 | AUD_LRCK | PCM1808 `LRC`, then on to PCM5102A `LCK` |
| GPIO8 | DAC_MUTE | PCM5102A pad `3` (XSMT) |
| GPIO9 | CAT_TX | data cable (LV1) |
| GPIO10 | CAT_RX | data cable (LV2) |
| GPIO11 | PA_EMERG | data cable (LV3) |
| GPIO14 | PA_SENSE | data cable (LV4) |
| GPIO12 | TUNER_TX | tuner socket (future) |
| GPIO13 | TUNER_RX | tuner socket (future) |
| GPIO47 (J3) | FREQ_TX | frequency-module socket (future; was GPIO1 before the LCD) |
| GPIO21 (J3) | FREQ_RX | frequency-module socket (future; was GPIO2) |
| GPIO43 (J3) | LCD_LED | status LCD backlight (section 11) |
| GPIO44 (J3) | LCD_CLK | status LCD |
| GPIO1 (J3) | LCD_DIN | status LCD |
| GPIO2 (J3) | LCD_DC | status LCD |
| GPIO42 (J3) | LCD_RST | status LCD |
| GPIO41 (J3) | LCD_CE | status LCD |

**Leave unconnected:** GPIO0/3/45/46 (strapping), 19/20 (USB), 35/36/37 (PSRAM).

### WM8782 module (I/Q ADC, clock master)

- **Switches:** DIP S1 = `+ 0 + 0` (master, I2S, 96 kHz, 24-bit). Jumpers `J1` = 24, `J2` open, `J6` = M.

| Module pin | Net |
|---|---|
| J5 `+5V` | +5 V quiet |
| J5 `GND` | GND (analog area) |
| J4 `Lin` | I/Q jack, I channel (direct, see section 5) |
| J4 `Rin` | I/Q jack, Q channel |
| J4 middle | GND (analog area) |
| `B` | IQ_BCLK → GPIO4 |
| `LR` | IQ_LRCK → GPIO5 |
| `D` | IQ_DATA → GPIO6 |
| `CLK` | MCLK_SRC → clock buffer input |
| `G` | GND |

### PCM1808 module (audio ADC, slave at 48 kHz)

| Module pin | Net |
|---|---|
| `+5V` | +5 V |
| `3.3V` (both) | +3.3 V audio (LP5907) |
| `GND` (both) | GND |
| `PMT` (FMT), `MD1`, `MD0` | one solder bridge to the neighbouring `GND` (I2S 24-bit, slave) |
| `SCK` | MCLK_ADC ← clock buffer branch B (33 Ω) |
| `BCK` | AUD_BCLK ← GPIO16 |
| `LRC` | AUD_LRCK ← GPIO18 |
| `OUT` | AUD_ADC → GPIO17 |
| `LIN` | RX audio P2 |
| `RIN` | audio-loop P2 (or GND if unused) |
| top middle pad | GND (input ground) |

### PCM5102A module (TX DAC)

| Module pin | Net |
|---|---|
| `VIN` | +5 V |
| `GND` | GND |
| `SCK` | GND through the module's own solder bridge beside `SCK`; the chip then makes its own clock |
| `BCK` | AUD_BCLK, from PCM1808 `BCK` (GPIO16) |
| `LCK` | AUD_LRCK, from PCM1808 `LRC` (GPIO18) |
| `DIN` | AUD_DAC ← GPIO15 |
| pad `1` FLT | H1L soldered to L |
| pad `2` DEMP | H2L soldered to L |
| pad `3` XSMT | DAC_MUTE ← GPIO8 (H3L stays open) |
| pad `4` FMT | H4L soldered to L |
| `LROUT` + `AGND` | TX audio P2 |
| `ROUT` | unused |

### TPS7A4701 module (quiet 5 V)

- **Before connecting any load:** bridge pads `3.2` and `.4`. With them open it outputs 1.4 V.

| Module pin | Net |
|---|---|
| `Vin` | +7.5 V from the power header |
| `EN` | `Vin` (solder bridge) |
| `GND` (all four) | GND (analog area) |
| `Vo` | +5 V quiet |
| `NC` | — |

## 4. Master clock (24.576 MHz)

```
WM8782 CLK ──► 74LVC1G157 I1 (as a buffer) Y ─┬─ 33 Ω ──► S3 GPIO7    (branch A)
                                               └─ 33 Ω ──► PCM1808 SCK (branch B)
```

- **74LVC1G157GW** is a 6-pin SOT-363 part on an adapter. Wired as a buffer:
  - Final straps (section 10): pin 6 S bridged to pin 5 VCC (selects I1), pin 1 I1 = WM8782 `CLK`, pin 3 I0 bridged to pin 2 GND.
  - pin 4 Y = output, pin 5 VCC = +3.3 V audio (LP5907), pin 2 GND.
  - 100 nF from VCC to GND at the pins.
  - **Pending, the user will confirm:** this pinout against the Nexperia datasheet and the pin-1 dot. The marking is unreadable, so confirm under magnification which way round it sits on the adapter.
- **Routing:**
  - The shortest runs on the board.
  - Each branch has a ground wire laid alongside.
  - The two 33 Ω resistors sit right at the buffer output.
  - Keep the clock away from the I/Q inputs.
- **Before fitting the PCM1808,** the probe firmware measures this clock on GPIO7 (its probe pin moves with the map).

## 5. I/Q input: direct, no op-amp (decided 2026-10-12)

The radio's NE5532 drives the WM8782 module directly:
- **DC:** the NE5532 output sits at about 2.5 V. The module's own 47 µF input capacitors (`C6`/`C7`) block it, so no re-biasing is needed.
- **Level:** the WM8782's full scale is about 1 Vrms. A quieter uSDX signal only costs headroom, and the converter has 100 dB to spare. The bridge's spectrum shows the real level in dBFS once wired.
- **Reserved:** keep a few free holes next to `J4`, in case the measurement calls for a buffer. The op-amp comes back with the PCM1804 upgrade, which needs a differential driver (THS4552).
- **WIMA film capacitors, optional upgrade:**
  - In series with the module's electrolytics they add nothing: both just block DC.
  - Their use is to *replace* `C6`/`C7`. Desolder the electrolytics, fit the film capacitors in their place or on our board in the I/Q lines, and bridge the module's pads.
  - Film coupling has lower distortion than electrolytics. The difference is small at these levels, but it costs nothing.
  - Which value: 1 µF puts the high-pass corner around 15 Hz with a ~10 kΩ input; 6.8 µF (the mislabelled "4.7 µF" parts) around 2 Hz. Both are far below anything useful. 1 µF settles faster after a DC step.
  - Use one value for both I and Q, so the two channels match.

## 6. Ground and placement

- **Ground:**
  - One face of the perfboard is a ground grid of tinned wire. Perfboard pads aren't connected to each other, so lay wire runs.
  - The analog area's ground (I/Q stage, WM8782, TPS7A4701, PCM inputs) joins the rest at one point, near the power entry.
  - The power cable's GND lands at that same point.
- **Zones on the 8 × 12 cm board:**
  - **Quiet analog corner:** I/Q P2, TPS7A4701 with its LC filter, and the WM8782 module.
  - **Converters in the middle:** PCM1808, PCM5102A, clock buffer, LP5907.
  - **Digital edge:** the S3 board, with its USB-C ports and IPEX connector at the board edge. The data socket goes beside it.
  - **P2 jacks** go on the edge facing the main board's audio zone, so the cables stay short.
- **Height with 2 cm spacers:**

  | Item | Height |
  |---|---|
  | Round socket plus pin | ~4 mm |
  | Module board | 1.6 mm |
  | Tallest part (PCM1808 electrolytic) | ~7 mm |
  | **Total** | **~13 mm** |
  | Main board underside (solder joints, resistors on the solder face) | ~3 mm |
  | **Clearance left** | **~4 mm** |

  It fits. Keep anything taller (big electrolytics) out of the area under the main board's resistor clusters.

## 7. Placement, draft 2 (from the user's mock-up; the op-amp parts are dropped in draft 3, section 8)

`layout/placement-mockup-1.jpg` is the user's first arrangement. Sizes measured against the ruler:

| Module | Size |
|---|---|
| ESP32-S3 | ~6.7 × 2.9 cm |
| WM8782 | 5.3 × 3.6 cm |
| PCM1808 | 3.4 × 3.0 cm |
| PCM5102A | 1.7 × 3.2 cm |
| TPS7A4701 | 1.8 × 2.9 cm |

All the S3's signal pins are on its **bottom** header (`3V3 3V3 RST 4 5 6 7 15 16 17 18 8 3 46 9 10 11 12 13 14 5Vin GND`), which faces the WM8782. Four changes to the mock-up:

1. **Rotate the WM8782 180° and move it to the left edge.**
   - Its `B LR D CLK` header then sits about 1 cm under S3 GPIO4–7, the shortest possible run for the 6.1 MHz I/Q bit clock and the 24.576 MHz clock.
   - As placed in the mock-up, that header is on the module's far edge, about 4.5 cm from GPIO4–7.
   - After rotating, `J4` (I/Q inputs) is at the module's bottom-right and `J5` (+5 V) at its bottom-left.
2. **Use the right-hand column freed below the S3** (about 2 × 3.6 cm):
   - the I/Q op-amp (OPA1612 on a SOP-8 adapter) right next to `J4`;
   - the I/Q P2 jack on the right board edge;
   - the 6-pin data socket at the top of the column, just under S3 pins 9–14.
3. **Put the small parts under the S3.** On round sockets, the S3 sits several millimetres above a free 2.5 × 5.6 cm patch of perfboard between its headers. Mounted flat (adapter boards soldered flush, no pins), these fit there:
   - the 74LVC1G157 clock buffer and its two 33 Ω resistors;
   - the LP5907 and its capacitors.

   Then every clock run is short:
   - WM8782 `CLK` (just below) → buffer;
   - branch A → GPIO4;
   - branch B → PCM1808 `SCK`, directly above the S3's top edge.
4. **Keep the TPS7A4701 top-right,** next to the power entry, so 7.5 V and the LC filter sit together there.
   - Its quiet 5 V goes to the op-amp column and to `J5` as a **twisted pair** (5 V with its own ground return), down the right edge and along the bottom.
   - Put 10 µF + 100 nF at each end.

**The rest stays as in the mock-up:**
- **PCM5102A** top-left. Its own 3.5 mm jack hangs over the left edge, so the TX cable plugs straight into it and no P2 jack is needed for TX.
- **PCM1808** top-middle:
  - its inputs (`RIN`/`LIN`) are on its right edge, with no room for a P2 jack beside them;
  - bring RX audio and the audio loop in through a 3-pin round socket and a short cable, with the P2 at the main board end.
- **The SSOP-16 adapter** (THS4552) isn't needed for this build. It belongs to the PCM1804 upgrade, which replaces the WM8782 module.

```
 x: 0 cm      2         4         6        8
 ┌───────────────────────────────────────────┐ 0
◄┤PCM5102A│   PCM1808  RX/loop   │TPS7A + LC │   power entry: 7.5 V, 5 V, GND
 │(TX jack)│  (SCK below)  socket │ filter    │
 ├─────────────────────────────────────────────┤ ~3.8
◄┤ant/IPEX  ESP32-S3 on sockets                ├► USB-C
 │   under it: clock buffer + 33 Ω, LP5907     │
 │  bottom header: 4 5 6 7 15 16 17 18 8 … 14  │
 ├──────────────────────────────┬──────────────┤ ~7.0
 │ WM8782 (rotated 180°)        │ data socket  │
 │ B LR D CLK header on top     │ OPA1612      │
 │ J5 +5 V bottom-left    J4 ──►│ I/Q P2 jack ►├►
 └──────────────────────────────┴──────────────┘ ~11.2
 quiet 5 V twisted pair: TPS7A → right edge → op-amp → along the bottom → J5
```

**Next:** a second mock-up photo with the WM8782 rotated and moved left, to check that it clears the S3's header and the spacer holes. Then the hole-by-hole drawing.

## 8. Placement, draft 3 (the user's second mock-up, 2026-10-12)

**As mounted:**
- PCM5102A top-left, rotated so its 3.5 mm jack faces the left edge.
- PCM1808 top-middle; TPS7A4701 top-right.
- S3 across the middle, antenna at the left edge.
- WM8782 rotated 180° on the left, its header under S3 pins 4–7.
- Two P2 jacks on the left edge; WIMA capacitors.

**Decided:**
- **I/Q wiring, now straight:** the module header reads `CLK D LR B` under S3 pins `4 5 6 7`, so the firmware now uses GPIO5 = data and GPIO7 = bit clock, and no wires cross.
  - `CLK` goes to the clock buffer under the S3, and from there to GPIO4 and the PCM1808.
- **S3 on square female headers:** square into square is fine. The board sits about 8.5 mm above the perfboard, roughly 14 mm total with the USB-C ports. That fits the 2 cm spacers with ~3 mm of solder joints below the main board.
- **LP5907, and the clock buffer, under the S3:** each on its adapter (SOT-23-5 and the 6-pin), soldered flat to the perfboard, under 3 mm tall. That clears the ~8.5 mm gap under the S3.
  - Keep the 1 µF capacitors at the LP5907's pins.
- **The TPS7A4701 is mounted component side up.** The second mock-up shows it flipped to read the back labels; flipped, the pin order mirrors. Its load is tiny (~30 mA), so heat is not a concern either way.

**To change:**
1. **The P2 jack beside the antenna:** move it at least 1 cm away. Metal next to the S3's antenna, or its IPEX lead, costs Wi-Fi range, and range is already weak under the stack.
2. **The I/Q jack** (bottom-left, with the WIMA capacitors) belongs in the **free right column**, next to the module's `J4` (`Lin`/`Rin`, on the module's right edge in this orientation). That keeps the I/Q analog run to a couple of centimetres, instead of crossing under the module.
   - The right column also takes the data socket, under S3 pins 9–14.
3. **RX audio and the audio loop** come in through a 3-pin socket next to the PCM1808's `RIN`/`LIN` edge, rather than a P2 jack on the left. A P2 jack there only works if it stays clear of the antenna.

**Not needed: AMS1117s.**
- They drop about 1.1 V, and their supply noise rejection at high frequencies is poor: fine for digital rails, wrong for anything analog.
- Every rail here is covered: the S3 board already has its own AMS1117, the LP5907 does the converters' 3.3 V, and the TPS7A4701 the quiet 5 V.
- Keep them in the drawer.

## 9. Placement, draft 4 (the user's third mock-up, 2026-10-12): current

This supersedes drafts 2 and 3 where they differ. The board is portrait.

```
 ┌─────────────────────────────────────────────┐
 │  ant/IPEX   ESP32-S3 (square female headers)   ├► USB-C
 │  bottom header: 3V3 3V3 RST 4 5 6 7 15 16 17 18 8 … 14 5Vin GND
 ├───────────────────────────────────┬─────────┤ data socket (pins 9–14 side)
◄┤I/Q P2 → J4  WM8782 (original orientation)  J5 ◄┤ TPS7A4701, upside down
 │  under it: LP5907, 74LVC1G157 + 33 Ω         │ (heatsink up), 7.5 V in at
 │  header B LR D CLK on its bottom edge        │ its bottom, power entry here
 ├──────────────┬──────────────────────────────┤
◄┤PCM5102A (TX  │ PCM1808 (top row: BCK OUT LRC │
 │ jack, left)  │ SCK GND 3.3V; LIN/RIN left)    │
◄┤RX/loop P2    │                                │
 └──────────────┴──────────────────────────────┘
```

**What this layout gets right:**
- **I/Q analog:** the jack is right beside `J4`.
- **Quiet 5 V:** the TPS7A `Vo` is right beside `J5`.
- **Clock buffer:** next to `CLK`. Branch B to the PCM1808's `SCK` is about 1.5 cm.
- **Antenna:** nothing metal near it.

**Pin map changed again:** the module header now reads `B LR D CLK` under S3 pins `4 5 6 7`. The firmware now uses GPIO4 = I/Q bit clock, 5 = word clock, 6 = data, and 7 = master clock in (through the buffer), so the four wires run straight.

**Runs under the WM8782 (about 4 cm):**
- `B`/`LR`/`D` go to GPIO4/5/6.
- Branch A of the clock goes from the buffer to GPIO7.
- The audio I2S goes from GPIO15/16/17/18 down to the PCM1808, with `BCK`/`LRC`/`DIN` on to the PCM5102A (6–7 cm).
- XSMT goes from GPIO8 to the PCM5102A's pad 3.

All of this is fine at these frequencies (6.1 MHz bit clock and 24.576 MHz master clock at most), with three rules:
- **A ground wire alongside each clock run** (`B` and both clock branches), and ground on both sides of the audio bit clock where it runs long.
- **Straight runs on the solder side.** Don't bundle the I/Q `D`/`B` wires with the audio wires.
- **The 33 Ω resistors sit at the buffer output,** not at the far ends.

**Parts under the WM8782:**
- The LP5907 adapter (feeds the PCM1808 `3.3V`, nearest on its top row, and the buffer's VCC) and the 74LVC1G157 adapter.
- **Clearance: fine.** The user confirmed the module is single-sided with a clear underside.
- **Once the WM8782 is fitted they can't be probed.** Test them first: check the LP5907 output with a meter, and run the probe with the module unplugged.

**Decided by the user (2026-10-12):**
- **Wiring:** the double-sided perfboard is soldered on both faces. The adapters go on top under the WM8782; the long runs go on the bottom face, in AWG22.
- **PCM5102A I2S:** one ground wire laid next to `BCK` (its fastest line, 3 MHz) is enough, for example in the order `LCK`, `BCK`, `GND`, `DIN`. That wire is the module's own ground return.
- **Power entry:** a 3-pin header at the TPS7A4701's input side (7.5 V, 5 V, GND).
  - The 7.5 V goes through the LC filter into the TPS7A `Vin`.
  - The 5 V lane goes to the S3 `5Vin`, PCM5102A `VIN`, PCM1808 `+5V` and LP5907.
  - That GND pin is the board's single ground meeting point.
- **Level-shifter / PA header:** 6 pins (3V3, GND, CAT TX, CAT RX, PA sense, PA emergency) in the gap between the TPS7A output and the S3, next to S3 pins 9–14.
  - Its 3V3 comes from the S3's `3V3` pin at the far left of the same header, by a wire under the S3.
  - Keep the CAT and PA wires a little clear of the TPS7A `Vo` and the WM8782's `+5V` pin.

## 10. Draft 5 (the user's routing review, 2026-10-12): current

This supersedes earlier drafts where they differ. The drawing is `layout/board-render.html`: open it locally (hover a wire for its two ends; filter by part). It is not to be republished.

**Solder jumpers** (bridges between neighbouring pins or pads, no wire; their own colour in the drawing):
- **PCM1808:** one bridge across `PMT`, `MD1`, `MD0` and `GND` (four neighbouring pins on the bottom row).
- **TPS7A4701:** `EN` to `Vin` (neighbouring pins).
- **74LVC1G157:** both straps are bridges between neighbouring pins.
  - Pins 6–5 (S to VCC), which selects input I1.
  - Pins 3–2 (I0 to GND).
  - The clock goes in on pin 1 and out on pin 4.
  - The 3.3 V supply is a short wire from the LP5907 into the S/VCC pair.
  - Pinout checked against a KiCad library entry for the GW (SOT-363) part: 1 I1, 2 GND, 3 I0, 4 Y, 5 VCC, 6 S.
- **PCM5102A** (on the module itself):
  - **SCK:** use the board's own solder bridge beside `SCK`, which ties it to ground on the module. No wire.
  - **Control jumpers:** H1L, H2L and H4L go to L; H3L stays open, because XSMT is driven by GPIO8 through pad 3.

**PCM1808 inputs:** `LIN`, `GND` and `RIN` are three neighbouring pads. The RX jack's ground goes to the middle one: LIN = RX audio, RIN = audio loop.

**Power:**
- **Power header:** turned vertical, pin order 7.5 V, GND (the ground star), 5 V.
- **7.5 V source:** tapped on the main board at the LM7805's input, after the input capacitors already there. The local LC filter is dropped. The TPS7A4701 rejects the LM2596's ~150 kHz ripple by roughly 55 dB, and its module has its own input capacitor.
- **5 V to the S3:** runs up the right edge and under the S3 into `5Vin` from above. It crosses no other wire.
- **5 V and GND to the PCM5102A:** two straight lanes under the PCM1808. The PCM1808's `+5V` and `GND` tap off them.

**Data header:** to the right of the WM8782, two holes lower than draft 5 (columns 23–28), in the level shifter's LV order: TX, RX, 3V3, GND, EMG, SNS (pin 1 by S3 pin 9).
- TX, RX and SNS go straight across to S3 pins 9, 10 and 14; EMG jogs one row to pin 11.
- 3V3 is a red wire on the top face, between the WM8782 and the S3, from the S3's `3V3` pin to header pin 3.
- GND (a black wire, bottom face) goes two holes over to the WM8782 ground hole by the TPS7A4701, which is bridged to the TPS7A's GND. (The bottom edge row already carries the S3-to-TPS7A ground wire, so the header doesn't use it.)
- Nothing crosses, and the cable needs no reordering.
- **CAT RX pull-up: 1 kΩ from header pin 2 (RX) to pin 3 (3.3 V)**, soldered across the two neighbouring pins on the bottom face. Without it the radio's replies rise too slowly through the shifter and arrive as bytes of mostly zeros. 470 Ω (what the A1S cable had) lifts the lows too far against the 220 Ω, and 2.2 kΩ is too slow again.
- **CAT runs at 19200 baud** (radio menu and bridge). At 38400 the edges were still marginal: replies lost their first byte, and short ones came back garbled. At 19200, 39 of 40 test queries came back clean (2026-10-26). CAT auto-reply is off on the radio.

**Checked against the build photo (2026-10-26):** the real perfboard is 30 × 42 holes, not 31 × 44. As built:
- The WM8782's I2S pins sit one column nearer the S3 than drafted. The PCM5102A is one row down and one column nearer, and the PCM1808 two of each.
- The PCM5102A's BCK, LCK and GND run straight down to the PCM1808's pins. The oscillator's ground is a black wire to the PCM5102A's GND.
- The S3's ground is a black wire along the edge row to the TPS7A4701's GND.
- 5 V is all red wire: the AMS1117's pins are IN, OUT, GND in one column (top to bottom, seen from the bottom); OUT leaves by a solder bridge one hole right, then a red wire runs straight up to the PCM1808's `+5V` (a solder bar), and another on to the LP5907's EN (tied to IN on the adapter). Checked: no short. The PCM5102A takes 5 V by a wire on the top face.
- The LP5907 sits two columns further left than drafted (seen from the bottom): its OUT is right beside the PCM1808's `3.3V`.
- The old clock buffer's ground is unwired (its pins are only soldered in); the top-face ground run from it to the WM8782 is gone.
- GPIO8 (mute) goes through a hole beside the S3 to the top face: under the S3, behind the I/Q jack, then under the PCM5102A to its pad 3.
- The drawing follows the build there, in the real wire colours. The AMS1117 and LP5907 pin positions, the clock area and the rest of the top face are still as planned, not yet compared.

**Audio pins, remapped again** so nothing crosses:

| S3 pin | Signal | Goes to |
|---|---|---|
| GPIO15 | DAC data | PCM5102A DIN |
| GPIO16 | Bit clock | PCM1808 BCK |
| GPIO17 | ADC data | from PCM1808 OUT |
| GPIO18 | Word clock | PCM1808 LRC |

The bit clock and word clock continue from the PCM1808's pins, under the PCM1808, to the PCM5102A's BCK and LCK.

**Guard ground wires: dropped.**
- A guard needs ground at both ends to carry the return current. The S3's ground pins are at the far ends of its headers, nowhere near GPIO4–7 or 15–18, so those wires would have been tied at one end only and done little.
- The returns go through the ground system instead: each module's ground goes to the star, and the S3's ground goes to the star through the data header's GND.
- **If the probe later shows clock or data errors,** add one direct wire from the WM8782's `G` pad to the S3's nearest GND pin.

**Faces:** the adapters and their short wires are on the top face, under the WM8782. Where a wire changes face it uses a free hole (a ring in the drawing). The ground link from the star to the S3 also takes the top face, past the LP5907's 5 V feed.

**Adapters rotated** (user, 2026-10-12): the 74LVC1G157 is turned 90° clockwise and the LP5907 90° counter-clockwise.
- **Buffer:** Y (pin 4) now faces the LP5907. Both 33 Ω branches leave it short and straight:
  - branch A goes up to the hole for GPIO7;
  - branch B goes straight down to the hole by the PCM1808's `SCK`.
- **LP5907:**
  - OUT faces the buffer.
  - Its IN takes the 5 V straight from the right-edge 5 V wire on the bottom face, and EN is tied to IN there.
  - Its 3.3 V also goes through a hole to the PCM1808's `3.3V`.
- **Ground:** the adapters' ground takes the long way round on the top face: left of the buffer, along the strip between the S3 and the WM8782, then down the WM8782's right edge to the LP5907. From there it goes through a hole into the TPS7A-to-J5 ground wire.
- **One crossing:** the 3.3 V wire from the LP5907 to the buffer crosses branch B once, on the top face. It is a DC wire crossing at 90°, insulated, so the coupling is negligible. It is marked in the drawing.

## 11. Draft 6: status LCD on the board edge

A Nokia 5110/3310 LCD module (PCD8544, 84 × 48) for live status. The plan, the views and the firmware outline are in `doc/plans/s3-status-lcd/PLAN.md`; the drawing shows it in draft 6.

- **Mounting:** the module's 8 pins are soldered onto the top-edge pads beside the S3's free header (J3), at 90° to the board, display facing out, **hanging up**. That puts pin 8 (LED) at the antenna end and pin 1 (VCC) toward USB. Hot glue or a bracket takes the load off the joints.
- **Links (bottom face):** six pads straight across the two hole rows to their J3 pins: LED → GPIO43 (backlight under 20 mA, driven directly), CLK → GPIO44, DIN → GPIO1, D/C → GPIO2, RST → GPIO42, SCE → GPIO41.
- **GND:** the next pad (beside J3's 40, unused) takes a wire along the hole row next to J3, toward the USB end, to J3's GND there.
- **VCC:** the last pad (beside 39, unused) takes a top-face wire along the row by the edge to the hole past J3's antenna end, then on the bottom face under the S3 to its second `3V3` pin (J1). Nothing crosses.
- **Firmware (0.13.0):** `main/status_display.c` draws the views; the frequency-module serial line moved from GPIO1/2 to GPIO47/21 to free the pins.
