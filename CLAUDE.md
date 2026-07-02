# Signal-Decoder — standing instructions

## Node version — always match `.nvmrc`

This repo pins its Node version in `.nvmrc` (currently `v26.3.0`). Before running any `node`/`npm`/`npx` command in this repo, run `nvm use` (or `source ~/.nvm/nvm.sh && nvm use` if `nvm` isn't already loaded in the shell) so the command runs under the pinned version, not whatever Node happens to be active. Don't assume the ambient shell's Node matches — check with `node --version` if unsure. If the pinned version isn't installed via nvm, install it (`nvm install`) rather than falling back to a different version.

## Firmware changes MUST be compiled, flashed, and tested

This repo vendors the uSDX BLACK_BRICK radio firmware at:
`firmware/usdxBLACKBRICK/usdxBLACKBRICK.ino`

**Any edit to this file is not complete until it has been compiled, flashed to the physical radio, and validated.** Do not consider a firmware change "done" just because the source file was edited — treat compile+flash+test as part of the change itself, the same way a code edit isn't done until it typechecks.

### Before compiling/flashing, verify the setup

Do not attempt to flash blind. Before running avrdude, confirm:

1. **Programmer connected** — a USBasp-compatible programmer must be present:
   ```
   lsusb | grep -i "16c0:05dc"
   ```
   If not found, stop and ask the user to connect the USBasp programmer to the target ATmega328P before proceeding.

2. **CAT serial port present** (needed for post-flash CAT validation) — typically `/dev/ttyACM1` at 38400 baud. Check with:
   ```
   ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null
   ```

3. **ALWAYS ask the user for explicit confirmation before flashing — no exceptions.** Flashing overwrites the running firmware on physical hardware and is not easily reversible if something goes wrong mid-write. This applies every single time, even if: the compile step succeeded cleanly, a previous flash in the same session went fine, the change looks trivial, or the user has already approved flashing earlier in the conversation. Approval for one flash does not carry over to the next — ask again each time avrdude is about to run. Do not rationalize skipping this step under time pressure or because the fix seems obviously correct.

### Compile

```bash
cd firmware
arduino-cli compile --fqbn arduino:avr:uno --output-dir ./usdxBLACKBRICK/build ./usdxBLACKBRICK
```
(arduino-cli requires the sketch folder name to match the `.ino` file inside it and must be invoked from its parent directory — running it from inside `usdxBLACKBRICK/` itself fails with "no such file or directory".)

A clean compile is a prerequisite for flashing — do not flash if this errors or warns about overflow.

### Flash

```bash
cd firmware/usdxBLACKBRICK
avrdude -c usbasp -p m328p -B 4 -v \
  -U flash:w:./build/usdxBLACKBRICK.ino.hex:i \
  -U eeprom:w:./build/usdxBLACKBRICK.ino.eep:i
```

### Trigger relevant tests after flashing

- **CAT protocol unit tests** (pure logic, no hardware, run any time): `npm test -- src/lib/cat/__tests__/protocol.test.ts`. If the firmware change touches a CAT command's format, range, or semantics, update this test file to match — it must reflect actual firmware behavior, not the wire-format spec alone (e.g. a command can *accept* a value the running build never meaningfully distinguishes — check the firmware source, not just the inline comment on the command handler).
- **CAT hardware test bed against the physical radio** (run after every flash): `npm run test:cat-hardware -- [/dev/ttyACM1] [baud]`. This is a TypeScript script (`scripts/cat-hardware-test.ts`, run via `tsx`) that talks to the real serial port and validates the IF frame, the full batched multi-command poll, and a SET→GET→restore round-trip. Don't rely on the unit tests alone to sign off a firmware change — they validate the JS-side parsing, not that the flashed `.hex` actually behaves as documented. All test bed tooling in this repo is TypeScript — do not write ad hoc Python (or other language) scripts for hardware validation; extend `scripts/cat-hardware-test.ts` instead.
- **Full app test/build gate** if the change affects `src/hooks/useRadioCAT.ts` or `src/components/RadioCATPanel.tsx` too: `npm test`, `npx tsc --noEmit`, `npm run build`.
