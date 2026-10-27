# Pre-solder review (2026-10-12)

A full pass over the selected parts and the draft 5 wiring (`wiring.md` section 10, `layout/board-render.html`) before the first joint. Items marked **must** block soldering or power-up; **should** are cheap insurance; **watch** are things to measure once it runs.

## 1. Findings

| # | Level | Finding | Action |
|---|---|---|---|
| 1 | done | **LP5907 capacitors.** Harvested from the fan headers of an old motherboard: two 0805 MLCCs of ~10 µF (rated for the 12 V rail; TI allows 1–10 µF ceramic on the output). | C1 10 µF across holes 1–2 (IN–GND), C2 10 µF across holes 6–5 (OUT–spare pad, grounded). See section 6. |
| 2 | done | **LP5907 voltage:** marked `LLVB`, TI's code for the LP5907MFX-3.3. | Still measure 3.3 V at OUT before plugging anything in. |
| 3 | **must** | **The power header can be plugged in backwards.** The order 7V5, GND, 5V is symmetric, so a flipped plug puts 7.5 V on the 5 V lane. The LP5907 (6 V max) and the PCM1808 `+5V` (6.5 V max) would not survive. | Use a polarised or keyed housing, or at least mark pin 1 on the board and on the plug. Check the lanes with a meter before the first plug-in. |
| 4 | **must** | **The data header can also be flipped.** Its order follows the level shifter's LV row (TX, RX, 3V3, GND, EMG, SNS), and reversed, the S3's `3V3` lands on the cable's GND and shorts the S3's regulator. | Mark pin 1 (LV1, CAT TX, the orange wire) on the board and on the cable housing. The new cable runs straight: orange, yellow, green, blue, violet, gray = LV1, LV2, LV, GND, LV3, LV4. |
| 5 | **must** | **TPS7A4701 output pads.** Out of the box it makes 1.4 V. | Bridge `3.2` and `.4`, bridge `EN` to `Vin`, then measure 5.0 V at `Vo` before plugging in the WM8782. |
| 6 | done | **74LVC1G157 orientation:** pin 1 found and checked by continuity (2026-10-15). | See section 6. |
| 7 | **must** | **Fit both adapters before the WM8782.** They sit under it, and the WM8782 hides them once it is plugged in. The WM8782 is socketed, so it can come out again for probing. | Solder and test the adapters (items 2 and 6) first. |
| 8 | **should** | **No bulk capacitance where the 5 V enters.** The S3's Wi-Fi bursts (up to ~500 mA peaks) pull on the cable's resistance and inductance. | 10 µF/50 V electrolytic plus a 104 across 5 V and GND at the power header. Lay the electrolytic flat. Both are in stock. |
| 9 | done | **Buffer decoupling:** a 1 µF 0603 MLCC across VCC and GND, on the adapter's empty footprint. | See section 6. |
| 10 | **should** | **XSMT floats until the firmware drives GPIO8.** H3L is open, so between power-up and the audio code starting, the DAC may unmute on noise. There is no audio then, so the only effect is a possible click. | Optional: 10 kΩ from PCM5102A pad `3` to GND, so the DAC boots muted. The firmware drives GPIO8 high to play. |
| 11 | **should** | **PCM1808 `PMT` = FMT is still assumed.** | Continuity from `PMT` to PCM1808 pin 12 before bridging the four pins. |
| 12 | **should** | **The IPEX antenna path.** The XH-S3E module chooses between its PCB antenna and the IPEX socket with a 0 Ω resistor. | Check which pads are fitted before relying on the IPEX cable. |
| 13 | watch | **WM8782 logic level.** The chip's DVDD is limited to 3.6 V, so its `B`/`LR`/`D`/`CLK` outputs can't be 5 V. Still confirm it, because they go straight into the S3. | With the module powered alone, measure `LR` with a meter: about 1.65 V average means 3.3 V logic. |
| 14 | watch | **`CLK` as a crystal output in master mode** is still inferred. Everything on the audio port depends on it. | The probe firmware must listen on GPIO7 (it still uses the old pin, see section 4). Measure it before fitting the PCM1808. |
| 15 | watch | **Ground loop on the I/Q cable.** The I/Q comes straight from the radio's NE5532 with the radio's ground, while the bridge's ground also returns through the power supply. That loop can pick up hum, which shows near 0 Hz in the spectrum. RX and TX audio are transformer-isolated, so they're clear. | Keep the I/Q cable short and routed along the power cable. If hum appears, try a ground-lift (I/Q ground through ~10 Ω) as the first fix. |
| 16 | watch | **PCM1808 `RIN` floats with no audio-loop plug in the jack.** It only adds noise to the loop channel, which can be switched off. | Nothing now. Ground `RIN` if the loop is never used. |
| 17 | watch | **Firmware internal RAM** is ~44 KB free, and the I2S DMA buffers need internal RAM. | Phase 4/5: move the FFT buffers to PSRAM first (`S3_PORT_PLAN.md`). |

**Checked and fine:**
- **Levels:** every logic input into the S3 is 3.3 V. The PCM1808's `VDD` comes from the LP5907, the PCM5102A's from its own regulator, and the buffer's from the LP5907. The buffer's inputs are 5 V tolerant.
- **Clock ratios:**
  - WM8782 at 96 kHz × 256 = 24.576 MHz.
  - PCM1808 `SCKI` at 512 × 48 kHz.
  - PCM5102A PLL from a 64 fs bit clock (needs `SCK` grounded: the module's bridge).
  - The external clock into I2S1 was proven on the probe.
- **Strapping pins:** GPIO0, 3, 45 and 46 are unused. Nothing drives a strap at reset: the WM8782 drives GPIO4/5/6 and 7, which aren't straps.
- **Regulator headroom:**
  - TPS7A4701: 7.5 → 5.0 V at ~30 mA, 75 mW.
  - LM7805 on the main board: 7.5 → 5 V at about 0.4 A, ~1 W, inside its dropout of ~2 V. Warm, so a small heatsink is worth it if it runs hot.
  - LP5907: 5 → 3.3 V at ~15 mA.
- **S3 powered from both ends:** the `IN-OUT` pads are confirmed open, so USB and the external 5 V can't fight.
- **TX output:** the PCM5102A's output is ground-centred (no DC) and drives the 600 Ω transformer through the 10 kΩ trimpot. Its 2.1 Vrms full scale is far above mic level, so the trimpot stays.
- **I/Q input:** the module's 47 µF capacitors block the NE5532's 2.5 V DC.
- **Hole grid:** every socket pin sits on a real hole of the 8 × 12 board. The data header's six pins fit in one row right of the WM8782 (columns 25–30). The TPS7A4701 module overhangs the right board edge by ~4 mm, as in the mock-up; its pins are inside.

## 2. Parts list for this board

| Part | Qty | Where | In stock |
|---|---|---|---|
| Round female sockets, 1×4 | 4 | WM8782 `B LR D CLK` (1×5 if you also take its `G` pad), PCM5102A pads `1–4` (only `3` is wired; the rest hold the module level), TPS7A4701 both edges | yes |
| Round female sockets, 1×3 | 2 | WM8782 `J4`, PCM1808 `LIN GND RIN` | yes |
| Round female sockets, 1×2 | 1 | WM8782 `J5` | yes |
| Round female sockets, 1×6 | 3 | PCM5102A header, PCM1808 both rows | yes |
| Round male pins | to match | on each module, in place of its square pins | yes |
| Square female header, 1×22 | 2 | ESP32-S3 (both headers, for support even where unwired) | yes |
| Pin header for the cables, 1×6 and 1×3 | 1 each | data and power. Male pins if the cable ends are Dupont female housings | yes |
| P2 (3.5 mm) female stereo THT jack | 2 | I/Q in, RX / audio loop (TX uses the PCM5102A's own jack) | yes |
| SOT-363 adapter + 74LVC1G157GW | 1 | under the WM8782 | yes |
| SOT-23-5 adapter + LP5907MFX (3.3 V, item 2) | 1 | under the WM8782 | yes |
| 47 Ω 1/4 W metal film (no 33 Ω in stock; 22 Ω also fine, same on both branches) | 2 | buffer output, branches A and B | yes (E12 kit) |
| **1 µF MLCC, X7R/X5R** | **2** | LP5907 IN and OUT | **no: buy** |
| 104 ceramic | 2 | buffer VCC, power header 5 V | yes |
| 10 µF/50 V electrolytic | 1 | power header 5 V, laid flat | yes |
| 10 kΩ 1/4 W (optional) | 1 | PCM5102A pad `3` to GND | yes |
| AWG22 wire, solid | — | bottom-face lanes and top-face links | yes |
| 2 cm metal spacers | 4 | stack mounting | yes |

## 3. Solder jumpers (all of them)

| Part | Bridge | Purpose |
|---|---|---|
| PCM1808 | `PMT`–`MD1`–`MD0`–`GND` | I2S 24-bit, slave |
| PCM5102A (module) | `SCK` bridge to ground | internal PLL from `BCK` |
| PCM5102A (module) | `H1L`, `H2L`, `H4L` to L; `H3L` open | normal filter, no de-emphasis, I2S; XSMT from GPIO8 |
| TPS7A4701 (module) | pads `3.2` and `.4` | 5.0 V output |
| TPS7A4701 | `EN`–`Vin` | always on |
| 74LVC1G157 | pin 6 S – pin 5 VCC | selects I1 |
| 74LVC1G157 | pin 3 I0 – pin 2 GND | unused input tied |

Module settings, not jumpers on our board:
- **WM8782:** DIP `+ 0 + 0`, `J1` = 24, `J2` open, `J6` = M.
- **S3:** `IN-OUT` pads open.

## 4. Bring-up order

Each step is checked before the next part goes in.

1. **Bare board:** continuity on every lane; no short between 7.5 V, 5 V, 3V3 and GND.
2. **Adapters** (item 7): LP5907 with its capacitors, measure 3.3 V (item 2). Then the buffer, with its strap continuity checked.
3. **Power header only, no modules:** 7.5 V and 5 V at every socket they should reach, and nowhere else.
4. **TPS7A4701** (pads bridged): 5.0 V at the WM8782's `J5` socket.
5. **S3:** boots, joins Wi-Fi, `/info` answers.
6. **Probe firmware update:** listen for the external clock on GPIO7 (it still has the earlier pin from the draft maps). This is a firmware task before step 7.
7. **WM8782** (switches set): the probe reads the clock on GPIO7 and 96 kHz I2S on GPIO4/5/6 (items 13 and 14).
8. **PCM1808**, then **PCM5102A** (jumpers soldered first).
9. **Data cable** (pin 1 marked), then a CAT test with the radio on GPIO9/10 (if it stays silent, swap TX and RX in `bridge_config.h`).

## 5. Still open (the user's to confirm)

- Which of LV1/LV2 is CAT TX (taken as LV1; the old cable's violet wire went to the A1S's IO18 if so).
- The resistor across LV and GND in the old cable (a bleeder): not carried over to the new cable; see `wiring.md`.
- The 74LVC1G157 and LP5907 pinouts against their datasheets (items 2 and 6).
- `PMT` = FMT on the PCM1808 (item 11).
- The IPEX resistor (item 12).

## 6. The adapters as built (2026-10-15)

Both adapters are the same double-sided board: a SOT-23-6 footprint on side A and a SOT-363 footprint on side B. **Each side numbers the holes differently:** side-A hole *n* is side-B hole *7 − n* (the square hole is A1 = B6). Each chip's pins follow the numbers on the side it is soldered to. The unused footprint's pads are live, wired to the same holes, so they take the bypass capacitors and the straps.

### 74LVC1G157 (chip on side B, done and checked)

| Side-A hole | Side-B hole | Chip pin | Connection |
|---|---|---|---|
| 6 | 1 | I1 | clock in from WM8782 `CLK` |
| 5 | 2 | GND | ground |
| 4 | 3 | I0 | bridged to GND (side-A pads 4–5) |
| 3 | 4 | Y | clock out to the two 47 Ω resistors. Keep solder off it: the mask is scraped between pads 2 and 3 |
| 2 | 5 | VCC | 3.3 V from the LP5907 |
| 1 | 6 | S | bridged to VCC (side-A pads 1–2), selects I1 |

- **C3:** 1 µF 0603, across side-A pads 5–2 (GND–VCC).
- **Continuity checked:**
  - 1–2 and 4–5 beep;
  - 3 is free;
  - 6 is free;
  - 2–5 shows only the capacitor charging.

### LP5907 (chip on side A, side-A numbers)

**Built and tested (2026-10-15):** continuity passed. On 5 V from USB, OUT read 3.30–3.31 V with no load and 3.33–3.34 V driving a red LED through 150 Ω (~9 mA). The adapter has pin headers on side B and plugs in like a DIP-6 (rows 7.62 mm apart).

| Hole | Chip pin | Connection |
|---|---|---|
| 1 | IN | 5 V; bridged to EN |
| 2 | GND | ground |
| 3 | EN | to IN, by a short insulated wire around hole 2 (or the perfboard wire in the drawing) |
| 4 | NC | — |
| 5 | (no lead) | spare pad, tied to GND: bridged on side B, pads B2–B5, with a wire strand. B1 is OUT, 0.65 mm from B2: keep solder off it |
| 6 | OUT | 3.3 V |

- **C1:** 10 µF, holes 1–2.
- **C2:** 10 µF, holes 6–5.
- **Optional:** a 1N5711 from hole 6 (anode) to hole 1 (cathode), to drain the output at switch-off.

### Placement on the perfboard (drawing updated 2026-10-15)

- **Mounting:** both adapters stand on short pin headers, soldered through the board like a DIP-6, with the pins trimmed.
  - **LP5907:** side A (chip and caps) up.
  - **74LVC1G157:** side B (the chip) up, with side A (pins, C3 and both bridges) facing the perfboard (user, 2026-10-20).
  - Seen from above, the buffer's pins read as in the side-B photo: I1, GND, I0 down the left and S, VCC, Y down the right. The drawing labels them by chip pin.
  - That changes three runs:
    - CLK reaches I1 with a short L on the bottom.
    - Branch A leaves Y under the adapter and goes straight up to GPIO7.
    - The 3.3 V enters at VCC, and the old crossing with branch B is gone.
  - The pin labels in the drawing are side-A hole numbers.
  - The drawing has a close-up section for both faces of each adapter.
- **The buffer stays at its draft-5 spot.** Its trimmed pins sit over the bottom-face lanes LR and GPIO15. The user judged the insulated wires safe against the cut pins.
- **The S3 and the TPS7A4701 sit one column right of draft 5.** The S3's USB end hangs about 4.5 mm past the right edge, and the TPS7A4701 about 6.7 mm.
- **User's moves (2026-10-16):**
  - **I/Q jack** down four rows. Its three wires climb to the WM8782's `J4`.
  - **WM8782** two columns left of draft 5, which leaves plenty of room for the 1×6 data header.
    - B, LR and D each jog three columns on the way up to GPIO4/5/6. The jogs are staggered so they never cross.
  - **74LVC1G157** down two rows. Its I1 now sits in the hole next to the WM8782's `CLK`, so the clock input is a one-hole jumper on the bottom. The old via is gone.
  - **LP5907** turned 90° clockwise and placed by the PCM1808's top pin row: OUT, spare and NC on row 31, with one free hole between OUT and the PCM1808's `3.3V`; IN, GND and EN on row 34.
    - IN drops straight onto the 5 V lane and GND onto the ground lane, both short stubs.
    - OUT reaches the PCM1808's `3.3V` two holes away.
    - The buffer's 3.3 V runs on the top face, crossing branch B once.
    - **Check the height:** the adapter sits partly under the PCM1808 module's edge, so seat the module over it before soldering.
  - **Buffer ground:** it now takes the top face round to a hole beside the WM8782's `J5` and joins the J5 ground wire.
- **Power in: one 2-pin JST XH** (7.5 V, GND), in place of the 3-pin header. It is keyed, so it can't go in backwards, and with one connector there's nothing to swap.
  - **Source:** the 7.5 V comes from the main board's 7805 input rail, after the 100 µH choke, with GND taken at the 330 µF capacitor's negative. Twist the pair.
  - **Choke rating:** check it. Everything on that rail now flows through it: the 7805 (the S3 included), the TPS7A and the AMS1117.
- **TPS7A4701 bench test (2026-10-16):** fed from that 7.5 V tap, driving a red LED through 330 Ω, Vo read 5.04–5.05 V. That's inside its ±1.5% (4.93–5.08 V).
- **The 5 V lane now comes from an AMS1117-5.0** on a SOT-223 adapter in the free bottom-right corner (pins GND, OUT, IN at columns 26–28, row 42).
  - **Budget:** about 250–300 mA continuous, limited by heat at a 2.5 V drop. The board takes about 60 mA, which leaves about 200 mA for add-ons. Solder the tab (OUT) well; it is the heatsink.
  - **Output capacitors:** a harvested 10 µF MLCC across adapter holes 2–1, plus a 10 µF electrolytic on the board.
    - The datasheets want 10 µF tantalum, or 50 µF aluminium with ESR under 0.5 Ω, for stability.
    - The 10 µF 50 V electrolytics alone have several ohms of ESR, so they don't meet that. The MLCC does.
  - **Input capacitor:** a 10 µF electrolytic on the board.
  - **Wiring:**
    - The 7.5 V reaches IN through a top-face hop over the 5 V and ground lanes.
    - The 5 V leaves OUT straight up into the lane.
    - The ground goes to the right-edge ground run.
    - The TPS7A4701's ground now uses its right-hand GND pin, into the same run.
  - **Built and tested (2026-10-20):**
    - The part is marked `1117 5.0`.
    - The adapter's pads read 3, 2, 1 (IN, OUT, GND) left to right, and the drawing follows that order.
    - The MLCC is fitted between OUT and GND.
    - 7.5 V in gave 4.99 V out driving a red LED through 330 Ω, with the MLCC only, before the electrolytics went on.
  - **If the MLCC is really 8 µF rather than 10 µF:** the regulator has slightly less stability margin. The worst case would be a little ringing after a load step, not a wrong voltage. The 10 µF electrolytic in parallel more than covers the gap, and its ESR damps the loop.
  - **Choke:** its rating is unknown. It already carried the A1S bridge through the 7805, and the new board adds only about 90 mA (TPS7A plus the AMS1117 loads). Check it after an hour's run: warm is fine, too hot to hold means it's undersized.
- **The S3 takes its 5 V over its USB-C from the main board's LM7805** (user, 2026-10-15), so the 5 V lane on this board no longer goes to `5Vin`.
  - The LM7805 load is unchanged.
  - A ground wire runs from the power header's GND (the star) up the right edge, outside hole column 30, to the S3's GND pin. It keeps the S3–converter return currents local instead of going round through the two cables.
- **Data header 1×6:** TX, RX, 3V3, GND, EMG, SNS (the level shifter's LV order), in columns 23–28, straight across from S3 pins 9–14.
- **LP5907 5 V feed:** it leaves the 5 V lane through a hole beside the power header and runs on the top face up column 26 to the LP5907's IN.
- **EN to IN is made on the LP5907 adapter**, so the perfboard wire for it is gone.
- **Height check:** each adapter stands about 5–6 mm. Seat the WM8782 on its sockets over them before soldering them in.

## 7. Master clock, as built (2026-10-21)

**Why it changed:** the WM8782 module's `CLK` header turned out to be a weak tap on its own clock line. A buffer couldn't switch on it, and the S3 couldn't read it directly. The 24.576 MHz master clock now comes from a separate oscillator.

- **Oscillator:** half-size DIP-8 metal can, marked `GP08-5 24.576MHz`; the vendor says it runs at 3.3 V or 5 V, and here it runs at 3.3 V.
  - **Pins:** 1 NC (the sharp corner), 4 GND, 5 OUT, 8 VCC.
  - **Location:** left of the buffer, under the WM8782's left half, pins at columns 8 and 11, rows 19 and 22.
  - **Supply:** VCC from the LP5907's 3.3 V (user, 2026-10-21), with a 104 on the bottom across pins 8–4 (optional for a first test).
    - **Route:** a top-face wire up from buffer pad 6, along row 17, and down a hole to pin 8.
    - **Crossings:** it crosses branch A and the buffer's ground run once each, insulated and at 90°. These are the board's only two crossings.
  - **Ground:** through a hole below the can into the buffer's ground run.
- **OUT:** goes on the bottom along row 22, then up a hole to buffer pad 1. Pads 1–2 are bridged on the bottom, so the clock reaches input A (pad 2) and, through the existing L-jumper on pad 1, the WM8782's `CLK`.
  - **J6 on the module is open,** so the module takes our clock.
  - No series resistor at the oscillator for now. Add 22–47 Ω at pin 5 if the probe shows extra edges.
- **Buffer:** a C14-marked '1G14-type inverter clone on the 74LVC1G157 adapter, chip side up, side A bare.
  - **Pads:** 1 NC, 2 A, 3 GND, 4 Y, 5 NC, 6 VCC.
  - **On the perfboard:** pads 5–6 bridged (3.3 V), the ground on pad 3, and a 104 from pad 6 to pad 3 on the bottom.
  - **Output:** Y drives both 47 Ω branches, to GPIO7 and to the PCM1808's SCK. The clock is inverted, which is fine for both.
- **Removed:** the wire that tied pad 1 to Y.
- **Expected on the probe:** GPIO7 = 24,576,000 Hz, with the WM8782's B = 6,144,000 Hz and LR = 96,000 Hz, now clocked from the same oscillator.

### Final state (2026-10-21, tested)

- **Buffer bypassed.** The clone chip is out of the circuit: the adapter's pins are cut above the spacers, and its holes stay as junctions.
  - The oscillator's OUT reaches the pad 1 hole (and, through the L-jumper, the WM8782's `CLK`).
  - A short wire joins pad 1 to the pad 4 (Y) hole, where both 47 Ω branches start.
  - One oscillator output now drives the WM8782, the S3's GPIO7 and the PCM1808's SCK.
- **Supply:** the oscillator keeps its LP5907 3.3 V through holes 5 and 6. The buffer's 104 is no longer needed.
- **Probe result:**
  - GPIO7 = 24,574,260 Hz (−71 ppm), 50% duty.
  - WM8782 B = 6,143,739 Hz (MCLK ÷ 4), LR = 95,999 Hz, D toggling.
  - I/Q noise −92 dBFS on both channels with open inputs.
  - Input current 49 mA, down from the 60–71 mA measured with the clone chip in place.
- **If the PCM1808's clock is ever marginal** with all three loads on one output, put a known-good LVC buffer (74LVC1G34, '1G125 or '1G157, bought by exact part number) back in the old spot.


### Board bring-up, all converters (2026-10-26)

| Path | Reading |
|---|---|
| Master clock, GPIO7 | 24,574,494 Hz, 50% duty |
| WM8782 B / LR / D | 6,143,679 Hz / 95,995 Hz / toggling; open-input noise −91 / −93 dBFS |
| Audio BCK / LRC | 3,070,611 Hz / 47,995 Hz |
| PCM1808, open inputs | −88.9 / −90.5 dBFS |
| Loopback, TX jack → RX/loop jack, 1 kHz at −20 dBFS | both channels −32.9 dBFS RMS, peak −29.9 (a clean sine: 3.0 dB crest) |

**Loopback level:** about 16 dB below the estimate from the datasheets (0.21 Vrms out, about −17 dBFS in). Not a fault: the path is clean and identical on both channels. Measure AC volts at the TX jack sometime (expect ~0.21 V) to see which side accounts for it.

Input current was 52 mA with the S3 on USB.

**Channel mapping, loopback with the right DAC channel 12 dB below the left (2026-10-26):**
- **RX/loop jack:** the tip feeds PCM1808 L (RX audio) and the ring feeds R (loop). Readings −32.9 / −44.8 dBFS.
- **I/Q jack:** the tip feeds WM8782 L (I) and the ring feeds R (Q). Readings −19.8 / −31.8 dBFS, 12 dB apart as sent.
- **Levels:** the WM8782 sits within about 3 dB of the datasheet estimate, so the DAC output is about right. The PCM1808 module reads about 13 dB lower than the WM8782 for the same signal, so its input is the side that attenuates.
- **I/Q sample glitches: none.** The spikes seen at first were all on frame 0 of each capture: the probe restarts its I2S slave for every reading and picks up a partial first frame. From frame 64 on, every window peaks exactly 3.0 dB above its RMS (I −16.8 / −19.8, Q −28.8 / −31.8 dBFS), which is a clean sine on both channels. The USB-powered S3 sharing ground with the board causes no errors.
