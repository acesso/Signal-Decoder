# Station hardware: current setup and the v2 bridge plan

Adapted from the user's notes (`~/ham/current hardware setup.md`, 2026-10-12). The module details and the decisions taken since live beside this file: `README.md` and `modules/*.md`.

## The radio

- **Model:** uSDX+ Plus v2 (Boluti) running custom firmware.
  - Features were removed and added.
  - CAT commands were added, and settings can be changed live over CAT.
  - No audio over CAT.
- **Receiver chain:** FST3253 (SSOP-16) Tayloe mixer, then an NE5532 (SOP-8) op-amp.
- **I/Q tap:** NE5532 pins 1 and 7, brought out on a P2 cable.

## The bridge today (v1)

A double-sided perfboard with an ESP32-A1S dev board on top.

### Power zone
- **LM2596 step-down board:** 12 V or 13.8 V in, set to 7.5 V out.
- **LM7805:** fed from the LM2596, filtered with a 104 ceramic, a 330 µF SMD capacitor and a 100 µH choke.
- **Output:** a power-only USB port.

### Audio zone
- **Transformers:** 1:1 600 Ω, galvanically isolating the radio's K1 plug, which carries TX and RX audio over a 3-pin P2 plug.
  - There is one transformer for TX and one for RX.
  - Each has its own 10 kΩ multi-turn trimpot to set the level.

### I/Q coupler (manual)
- **Connections:** a P2 in and a P2 out carry the I/Q signal from the NE5532.
- **Per channel:** a 10 µF electrolytic in series with 4.7 kΩ, in parallel with a 2N2222 collector. The base goes to a 10 kΩ multi-turn trimpot, and the emitter to 330 Ω to ground.
- **Bias trimpot:** both transistors share it; its other end gets 5 V.
- **Mode switching:** the cable is replugged by hand to swap between I/Q mode and audio mode at the bridge.

### Data zone
- **Radio cable:** a P2 cable from the radio carries CAT (serial TX/RX) and PA_SEND.
- **CAT:** goes through a level shifter to the ESP32 (today the A1S, to be replaced by the S3).
- **PA_SEND:** goes through a 1 kΩ resistor (possibly 10 kΩ, unconfirmed) to a can-type 2N2222. That transistor keys an external 70 W PA.
  - The bridge's PA sense and PA emergency lines connect here. Nothing changes in this part.

### The bridge itself
- **ESP32-A1S dev board (ES8388 codec),** powered from the power zone's USB output.
- **Audio mode:** receives RX audio from the audio zone and sends and receives it over WebSocket to the web app.
- **I/Q mode:** sends the stereo I/Q signal over WebSocket.
- **TX:** goes over the bridge too, as audio on its own WebSocket. It comes either from the bridge's PSRAM slots or straight from the web app.
- **The web app** decodes and encodes FT8 in both modes. I/Q mode gives up to a 48 kHz-wide waterfall, against about 3 kHz in audio mode.

### Physical layout
- **Power zone:** two floors. The LM2596 board is on top; the power input, filtering and USB port are below.
- **Audio zone:** single floor (the bottom one, like the power zone). Transformers, trimpots, the K1 P2 jack on the left side, and two P2 output jacks on the right side.
- **Data zone:** same floor as the audio zone. CAT P2 input on the left, the level shifter and the PA circuit.
  - The A1S sits on the top floor, covering the data zone and the I/Q coupler.
- **I/Q coupler:** same floor as the data zone, on the right side of the board. Two P2 jacks: in from the radio, out to the A1S input.

## Known issues

1. **Large DC spike at the centre of the I/Q band.** Most of the time the web app is set to decode away from the VFO centre to avoid it, which costs signal strength.
   - **Design note:** much of this is inherent to direct conversion: LO leakage and 1/f noise at 0 Hz. The S3 path removes DC in firmware, and its 96 kHz span leaves plenty of room away from the centre. The new coupler should simply avoid adding offset or hum of its own.
2. **LPF band selection is manual.** The goal is to automate it without a microcontroller and without tapping the uSDX's internal LPF relay lines.
   - The idea is plain RF sensing on the uSDX's coax (RG316) before it goes to the PA/LPF; the power there is under 3 W.

## v2 goals

1. Read the low TX power passively with a toroid probe, outside this board project, to:
   - feed an AliExpress OLED frequency counter (low priority);
   - set the LPF band automatically from sensing alone, no microcontroller in between (low priority).
2. A wider, better RX: the ES8388 is the limit, and a better ADC gives more visibility.
3. No WebSocket lag or dropouts, which come mostly from the ESP32-A1S's limits.
4. Automatic and manual LPF switching. A 4-position rotary switch is available. Low priority, not part of v2.

### Better RX
1. **Inside the uSDX board, drop-in replacements:** NE5532 → OPA1612, and FST3253 → SN74CBT3253CDR.
2. **ESP32-A1S → ESP32-S3.** This needs external converters: an ADC for I/Q, an ADC for RX audio, both running at once, and a DAC for TX audio.

## v2 plan

- **Build in steps,** but settle a first design that fits every component.
- **Keep and reuse the existing board.** All its inputs and outputs are P2, plus USB for power; more lanes can be added, such as 7.5 V.
- **Build a new board at floor −1,** attached under the current stack, and connect everything to it with cables (modular).
- **Mount every module on 2.54 mm round-pin headers,** so modules can be swapped or modified (`parts/round-pin-headers-2.54mm.md`).

### Signal paths

**uSDX K1 audio (TX and RX)**
- **RX:** uSDX → main board transformer and filters → P2 cable → new board → PCM1808 → S3.
- **TX:** S3 → PCM5102A → P2 cable → main board filters and transformer → uSDX.

**I/Q**
- uSDX I/Q P2 (from the NE5532, an OPA1612 later) → new coupler → WM8782 → S3.
- The new coupler uses WIMA capacitors and an op-amp stage.
  - **Design note:** the WM8782 has single-ended inputs, so the plan is a low-noise dual op-amp (OPA1612 or LM4562). The THS4552 (fully differential) is kept for the PCM1804 upgrade, which has differential inputs.
- **Power for the I/Q chain:** a clean dedicated rail through the TPS7A4701 board.
  - **Design note:** the TPS7A4701 needs about 0.3 V of headroom, so it is fed from the 7.5 V lane (through an LC pre-filter), not from the 7805's 5 V.

## Components on hand

### Power supplies (220 V AC to DC)
- 12 V 7 A, server grade
- 9–15 V 120 A, automotive, switched
- 13.8 V 2 A, wall-plug type

### Pre-built equipment
- ATU-100 automatic antenna tuner
- uSDX+ (Boluti) with custom firmware, NE5532 op-amp, FST3253, ATmega328P
- MiniPA-70 with heatsink and fans, internal RX/TX switch (jumper activated), internal SMA connectors for LPF in/out; its IRF530N is shorted/burned
- XF-LPF-HF 4-band low-pass filter (10–15 m, 17–20 m, 40 m, 80 m), switched by 12 V jumpers or a rotary switch, internal relays
- M4430 mini digital voltmeter/ammeter (220 V, 10 A)
- PLJ-096OLED-L1 RF frequency counter with OLED display

### Modules
- PCM1808 (`modules/pcm1808-module.md`)
- PCM5102A (`modules/pcm5102a-module.md`)
- LM2596 with input/output voltage display
- TPS7A4701 (`modules/tps7a4701-module-swirfe.md`)
- ULN2803A board
- WM8782 with its own 22.579 MHz and 24.576 MHz crystals (`modules/wm8782-module.md`)
- ESP32-S3 dev board, N16R8 (`modules/esp32-s3-devkitc-1-n16r8-pinout.md`)

### ICs
- 74LVC1G157GW: tiny 6-pin SOT package (SOT-363); the marking is too small to read and the bag label lists every variant of the listing
- THS4552 (TSSOP-16)
- SN74CBT3253CDR (SOP-16)
- OPA1612 (SOP-8)
- PCM1804 (SSOP-28)
- LM4562MA (SOIC-8)
- LM331 (DIP-8)
- SN74HC4040 (DIP-16)
- LM2917 (DIP-8)
- LM3914 (DIP-18)

### Active crystal oscillators
- 24.576 MHz
- 36.864 MHz

### Regulators
- LM7805 (TO-220)
- AMS1117 variants (SOT-223)
- LP5907MFX (SOT-23-5)

### Capacitors
- Multilayer/monolithic: 102, 103, 473
- Ceramic: 10, 102, 104
- WIMA: 4.7 µF 50 V, 1 µF
- C0G/NP0: 2.2 nF
- Electrolytic: 1 µF 50 V, 10 µF 50 V
- Silver mica: 10 pF 60 V

### Resistors
- 10 kΩ multi-turn trimpots
- 1/4 W metal-film resistors (common values, 5 bands)

### Diodes
- 1N5711
- 1N4148

### Transistors
- 2N2222, metal can
- BS170 (TO-92)
- FQP13N10 (TO-220)
- RD16HHF1 (TO-220)

### Toroids and inductors
- FT37-43, FT50-43, FT140-43
- 100 µH chokes

### Miscellaneous
- 0.35 mm enamelled wire
- P2 male 4-pin plugs; P2 female 3- and 4-pin THT jacks
- 2.54 mm round-pin headers, male and female (`parts/round-pin-headers-2.54mm.md`)
- SMA female/male plugs and connectors
- RG316 coax
- SOP-to-DIP adapter boards (several)
- DIP sockets (plenty)
- 8 × 12 cm double-sided perfboard
