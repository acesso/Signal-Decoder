# Bridge v2 hardware (ESP32-S3 board)

Hardware notes for the S3 bridge: a new board mounted at floor −1 of the existing bridge stack, cabled to the current main board (power, audio, data zones). The firmware side and the pin map are in `firmware/esp32-cat-bridge/main/doc/S3_PORT_PLAN.md` and `main/bridge_config.h`.

## Modules

Each image has a description file beside it, with the same name and a `.md` extension. A file separates what is read off the photo, what is inferred (numbered questions, waiting for the user's confirmation), and the settings chosen for this project. `status` in the front matter says whether the user has validated it.

| Module | Image | Description | Status |
|---|---|---|---|
| ESP32-S3 dev board (N16R8) | `modules/esp32-s3-devkitc-1-n16r8-pinout.png`, `modules/esp32-s3-devkitc-1-n16r8-board.png` | `modules/esp32-s3-devkitc-1-n16r8-pinout.md` | partly validated |
| WM8782 ADC (I/Q) | `modules/wm8782-module.png`, `modules/wm8782-module-settings.png` | `modules/wm8782-module.md` | partly validated |
| PCM1808 ADC (audio) | `modules/pcm1808-module.png` | `modules/pcm1808-module.md` | validated (FMT function to check) |
| PCM5102A DAC (TX audio) | `modules/pcm5102a-module.png` | `modules/pcm5102a-module.md` | validated |
| TPS7A4701 LDO (quiet I/Q rail) | `modules/tps7a4701-module-swirfe.png`, `modules/tps7a4701-module-back.png` | `modules/tps7a4701-module-swirfe.md` | validated |

## Parts

| Part | Image | Description |
|---|---|---|
| 2.54 mm round-pin (machined) headers, male and female | `parts/round-pin-headers-2.54mm.png` | `parts/round-pin-headers-2.54mm.md` |

## Wiring

`wiring.md`: power rails, cables to the main board, every module's pin connections, the clock buffer, the I/Q input stage, ground and placement (draft).

`pre-solder-review.md`: the final check before soldering: findings by severity, the parts list with what to buy, every solder jumper, and the bring-up order.

## Board drawing

`layout/board-render.html`: top and bottom views of the board as built (bottom face checked against the build photo, wires in their real colours) and the complete as-built parts list. The `layout/placement-mockup-*.jpg` photos are the user's mock-ups it was drawn from.

## The rest of the station

`current-hardware-setup.md`: the radio, the existing bridge board this one plugs into, the v2 plan and the parts on hand.
