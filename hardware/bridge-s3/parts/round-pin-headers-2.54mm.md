---
part: 2.54 mm round-pin (machined) single-row headers, male and female, gold-plated ("YU NA SHENG" listing, 1×2 to 1×40)
image: round-pin-headers-2.54mm.png
role: every module on the new board plugs in, so modules can be swapped or modified
status: chosen by the user 2026-10-12
---

# Round-pin headers

## Read from the image
- **Variants:** male and female single rows, 2.54 mm pitch, gold-plated, 2 to 40 positions.
- **Female:** machined round sockets.
- **Male:** round pins, thinner than standard square header pins.

## How to use them on this board
- **Round into round only.** The modules ship with standard square header pins, about 0.64 mm square, nearly 0.9 mm across the corners.
  - Pushed into machined round sockets, square pins stretch the inner contact and loosen it for every later insertion, and give poor contact meanwhile.
  - So:
    - **Fit round male pins on each module,** in place of the square ones (or alongside, where the module isn't populated yet).
    - **Fit round female sockets on the perfboard.**
- **Height:** a socket plus pin adds roughly 7–9 mm under each module. Allow for that in the space under the stack, together with the tallest module (the PCM1808's electrolytics).
- **Signal quality:** machined contacts have low, stable resistance, and they're fine at the 24.576 MHz master clock and the I2S bit clocks.
  - Keep the clock path to one socket per hop; don't chain adapters.
- **Ground pins:** put every module's ground pins in sockets too, and use all of them. Several ground contacts in parallel keep the return path solid.
