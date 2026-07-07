# uSDX BLACK_BRICK firmware — lineage and changes

Customized firmware for the Chinese "black brick" uSDX clone (ATmega328P @ 20 MHz, HD44780 16×2 LCD, class-E PA, SI5351 @ 25 MHz TCXO), operated as a **CAT-controlled digital-modes transceiver**: RX with basic signal controls, TX always SSB fed by external audio (the Signal-Decoder web app or any other encoder) into the mic input, PTT via CAT. It deliberately does **no** decoding of its own.

## Lineage

```
threeme3/QCX-SSB R1.02w (PE1NNZ, 2021-08-23)      ← original open-source baseline
  └─ GW8RDI/uSDXOpen fork (1.02wA2 … 4.00d, 2022-2023)   ← multi-hardware fork
       └─ this file (PU7FTW, 4.00e … 4.01a, 2026)       ← BLACK_BRICK-only, digital-modes profile
```

This build was not forked directly from R1.02w — it descends through GW8RDI's
uSDXOpen fork — so the tables below describe the *cumulative* difference between
stock R1.02w and the current source.

Stock R1.02w reference: [threeme3/QCX-SSB @ R1.02w](https://github.com/threeme3/QCX-SSB/blob/R1.02w/README.md) ·
Fork lineage: [GW8RDI/uSDXOpen](https://github.com/GW8RDI/uSDXOpen)

## What stock R1.02w shipped (baseline)

Enabled by default: startup diagnostics (DIAG), CW keyer (straight/iambic-A/B + practice mode), TS-480-subset CAT, CW decoder, key-click envelope shaping, semi-QSK, RIT, VOX, CW messages with CQ auto-repeat, 8-band latching-relay LPF switching. Runtime features: LSB/USB/CW/AM/FM (RX **and** TX), VFO A/B + Split, AGC on/off, NR 0–8, analog + digital attenuators, S-meter (OFF/dBm/S/S-bar), TX drive, noise gate, PA bias min/max, CW tone 600/700 Hz, ref-freq + IQ calibration, battery-voltage indicator, CAT RX-audio streaming. Compiled out but present: FAST_AGC, SWR meter, MOX, TX delay, clock, OLED/LCD-I2C variants, multi-hardware (QCX legacy) support.

## Added (vs. R1.02w)

| Feature | Origin | Notes |
|---|---|---|
| Per-band freq/mode memory (KEEP_BAND_DATA) | GW8RDI 1.02wA-era | last frequency + mode restored per band |
| Directional band change, menu wrap-around, error codes | GW8RDI 1.02wA-era | |
| CAT enable menu item (no reboot needed), CAT baud menu (9600–57600) | GW8RDI 4.00a / PU7FTW | |
| CAT frequency error handling | GW8RDI 2.00d | rejects corrupted `FA` payloads (1.5–60 MHz window) |
| CAT mode change incl. AM/FM with IQ-flip tracking | GW8RDI 4.00b | since 2026-07-06 AM/FM are RX-only (see below) |
| **PU7FTW extension commands**: `VO AT A2 NR BL AG0 AL FW SM DR PM PX XF FD SR/SR2` | PU7FTW 4.00e–h | full table in the [project README](../../README.md#custom-cat-commands-pu7ftw-extensions); all SETs echo the effective value, rejects echo the old value |
| Batched multi-command CAT queries | PU7FTW | one write → concatenated replies in order; the web app polls 12 commands per round-trip |
| `SM` live S-meter over CAT | PU7FTW | dBm computed every cycle regardless of the LCD display mode |
| `PM`/`PX` PA-bias live-apply (`build_lut()` on SET) | PU7FTW | same hardware-reapply pattern as the ATT1 fix |
| `XF` ref-frequency calibration over CAT | PU7FTW | drives the web app's receive-only calibration wizard |
| `SR`/`SR2` soft restart / factory reset over CAT | PU7FTW | SR2 realigns EEPROM after param-layout changes |
| **AGC level (`AL`, menu 1.8)** | PU7FTW 2026-07-06 | target window for the M0PUB AGC, 1–14 (default 4 = the algorithm's original 1024…1536 window) |
| **TX gate: only LSB/USB can key the PA** | PU7FTW 2026-07-06 | `switch_rxtx()` refuses TX in CW/AM/FM from PTT and CAT alike — can't transmit over a station you're listening to |
| Baud-rate correction for the 20 MHz crystal | fork/PU7FTW | `Serial.begin(16000000ULL * baud / F_MCU)` |
| Backlight on correct pin (PD3) + CAT `BL` control | PU7FTW 2026-07-04 | stock/fork drove the wrong pin on this hardware |

## Removed (vs. R1.02w)

All removals follow the same pattern: feature flag commented out (or code deleted) with a dated note in the source.

| Feature | Why |
|---|---|
| CW decoder, CW messages/CQ-repeat, CW keyer (iambic + practice mode) | no self-decoding; no key attached |
| **CW transmit** (dsp_tx_cw, sidetone, key-click ramp, semi-QSK, CW tone volume) | TX is always SSB from external audio; CW **RX** kept (narrow filters, `cw_offset` tuning, CW Tone menu) |
| **AM/FM transmit** (dsp_tx_am/dsp_tx_fm) | AM/FM kept as RX-only listening modes |
| **VOX + noise gate** | PTT is CAT-controlled |
| **RIT** (+ `RTS` CAT command) | the PC tunes via CAT |
| **VFO B / Split** (`FREQB`/`MODEB`, VFO menu, A/B swap) | single-VFO; CAT always tuned VFO A anyway |
| **TX offset (`XO` CAT command)** | unused by the web app and by hamlib's TS-480 driver |
| **Fast AGC variant** (`process_agc_fast`) | single algorithm now: M0PUB fast-attack/slow-decay (~60 dB range) as plain AGC ON, plus the `AL` level |
| SWR meter (fork addition), practice mode, MOX, TX delay, CAT audio streaming, QUAD, multi-hardware configs | earlier removals for flash space; BLACK_BRICK is the only supported hardware |
| Startup diagnostics (DIAG), debug/testbench, clock, VSS meter | compiled out |

## Reimplemented / major changes (vs. R1.02w)

| Area | Change |
|---|---|
| **S-meter dBm math** | float + `log10()` → pure integer (MSB position + 4-bit mantissa LUT, 0.376 dB steps). Validated against the float formula: 60 % identical, rest ±1 dB. Removed the only libm-log user. |
| **SI5351 divider math** | `(float)num/denom` → integer `(128*num)/denom` — the datasheet-exact floor; the float could round one step off |
| **AM demod DC blocker** | per-sample float multiply → Q15 integer (~100 cycles/sample saved in AM RX) |
| **Float support library** | fully eliminated (the three sites above were the only live float users) |
| **AGC** | dbm/peak-decay decoupled from LCD display mode (CAT `SM` stays live); `centiGain` backup/restore across TX; target window parameterized (`AL`) |
| **EEPROM layout** | param table shrank with each removal — the layout is positional, so a flash across these changes **requires `SR2;` (factory reset)** unless the version string was bumped (boot then auto-resets) |
| **Menu labels** | fitted to the 16×2 LCD budget: Volume, Noise Reduce, Analog Att, Digital Att, PA bias min/max, AGC (1.7) + AGC level (1.8) |
| ATT1 hardware apply | extracted `apply_att1()`, called from both menu and CAT SET (stock only re-applied from the menu dial) |
| Encoder boot glitch | pull-ups settle + `PCIFR` clear before enabling pin-change interrupts (stock stepped the VFO once at power-on) |

## Known hardware quirk

The LCD shares its data pins with the UART (PD0/PD1); every LCD write briefly
disables the serial port (`pre()`/`post()` in the source, "NOISE LEAK INTO
RX!!!"). Occasional CAT replies carry a stray trailing byte or get dropped —
the web app and the hardware test bed both tolerate/retry this by design. It
is a board-level design constraint, not a firmware bug.

## Flash budget history (2026-07-06 session)

| Build | Flash | Free RAM |
|---|---|---|
| 4.00h baseline | 31 338 (97 %) | 540 |
| − VOX | 30 968 | 544 |
| AGC single-algorithm + `AL` | 30 604 | 536 |
| − RIT, menu renames | 30 300 | 544 |
| − XO | 30 460→30 116 (− CW TX) | 543 |
| − VFO B/Split | 29 404 | 560 |
| − float library (integer dBm) | **28 018 (86 %)** | **560** |

4.01a (same day) additionally sets the PA bias max default to 130 (was 160) for this unit's PA.

A later same-day fix replaced a 1-Hz throttled LCD S-meter redraw (still an
audible periodic tick over the shared LCD/UART pins) with full suppression of
the LCD S-meter/dBm field while a CAT session is active — CAT already delivers
a live reading via `SM;`, so nothing is lost functionally, and `smode` itself
is left untouched so the LCD resumes updating immediately if `cat_active`
is ever cleared.

## Build / flash / test

See the [project README](../../README.md#usdx-black_brick-firmware) for the
full compile/flash/validation workflow. Every flash must pass
`npm run test:cat-hardware` (46 checks against the live radio, RX-only — TX is
never keyed by automated tests).
