# PA safety watchdog — design (not yet implemented)

## Problem

The uSDX drives an external miniPA70 (generic ~70W HF linear, IRF530
push-pull, no onboard MCU) through the user's own interface board, which
level-shifts the uSDX's PA-send signal up to the amp's 12V PTT/key input.
If the uSDX hangs while that signal is still asserted, the PA stays keyed
indefinitely — the failure mode this feature exists to guard against.

Research on the miniPA70 (a bare-bones, undocumented Chinese kit — see
sources at the bottom) confirms it has **no feedback path of its own**: a
two-pin contact closure keys a relay via a PNP transistor, nothing reports
back. Any "is the PA really on" signal has to come from the user's own
interface board, not the amp.

The user's interface board already derives two useful signals:
- The uSDX's own PA-send line (before level-shifting) — proves the *radio*
  commanded PA-on, nothing more.
- 12V feedback from the amp's own switched leg (after level-shifting) —
  proves the *PA hardware* is actually energized, independent of whether
  the uSDX's PA-send line or the level-shifter itself are behaving
  correctly.

Decision: use the 12V feedback. Sensing only the command signal can't catch
a relay welded shut or a fault in the interface board itself — exactly the
kind of independent failure a watchdog exists to catch. The extra sensing
circuitry (already built by the user, just needs a GPIO) is worth it.

## Signals

| Name         | Direction | GPIO (proposed) | Idle state | Meaning |
|--------------|-----------|------------------|------------|---------|
| PA Sense     | input     | GPIO2            | n/a        | HIGH = PA hardware confirmed energized (already level-shifted to safe logic by the user's board — plain digital read, no ADC) |
| PA Emergency | output    | GPIO4            | HIGH       | Permissive line, in series with the uSDX's own PA-send path — HIGH lets the radio's own signal control the PA normally; LOW forcibly cuts it regardless of what the radio is doing |

### Pin choice

Every one of the "7 free" A1S header GPIOs (0, 5, 18, 19, 21, 22, 23) is
already claimed by this firmware (CAT UART, status LEDs, codec PA-enable).
GPIO2 and GPIO4 are the SD-card slot's DATA0/DATA1 lines — wired to a
peripheral this firmware never uses, rather than sharing a live
button/LED/codec function. Confirmed via cross-checked A1S board
documentation (NuttX board file, community ESP-ADF board definitions).

Explicitly avoided:
- **GPIO12** — SD DATA2, but also an ESP32 strapping pin (MTDI, selects
  flash voltage at boot). Driving this from external circuitry risks
  interfering with boot if it's held in the wrong state during reset.
- **GPIO13** — SD DATA3, DIP-switch-shared with KEY2 on this board;
  avoiding it sidesteps any ambiguity about which physical mode is active.
- **GPIO34/36/39** — not broken out to the header at all on this board
  (used internally for SD-card-detect and KEY1), so not reachable
  regardless of their input-only/ADC1 nature.

Needs hardware confirmation before wiring: verify GPIO2/GPIO4 don't have
pull resistors from the (unpopulated) SD card circuit that would fight the
external sense/drive signals — a quick continuity/multimeter check against
the actual board, same caution already applied to the ES8388 PA-enable
polarity elsewhere in this firmware.

## Behavior

**Trigger**: fixed maximum continuous PA-on duration. The moment PA Sense
reads HIGH, start a timer. If PA Sense is *still* HIGH after
`PA_MAX_ON_SECONDS` (proposed default: 300s / 5 minutes — comfortably past
any real SSB/CW transmission, far short of "left keyed for hours"), pull PA
Emergency LOW. The timer resets the instant PA Sense reads LOW again — a
normal TX-then-RX cycle never comes close to tripping it.

Deliberately *not* cross-checked against the CAT line's TX0;/RX0; state
(the existing `CAT_TX_CMD` sniffing in `cat_bridge.c`): coupling a hardware
safety watchdog to CAT parsing correctness would make it only as reliable
as CAT parsing, and it wouldn't catch a hang that happens to occur while
the radio still legitimately believes it's transmitting. PA Sense is
ground truth about the hardware; the timeout should depend on nothing else.

**Recovery**: latched, not auto-clearing. Once PA Emergency goes LOW, it
**stays** LOW — even after PA Sense drops back to LOW on its own — until an
explicit operator action clears it (a control-page/web-app button, or a
bridge reboot). Auto-recovery risks a flapping fault (PA re-enables,
immediately re-trips, disables again) with nobody ever notified that a real
hardware problem occurred. Given the stakes already established for PTT
safety in this project ("we should never trust the radio fallback
mechanism... if it hangs... that means hardware burning kind of thing"),
requiring a human to notice and clear the fault is the correct default.

**LED**: highest priority in `led_status.c`'s existing tier system — above
AP fallback (currently the top tier). A fast synchronized strobe on both
LEDs (~100ms on/off, visibly faster/more urgent than AP fallback's 300ms
blink or Wi-Fi-connecting's 400ms alternation) so it reads unambiguously as
"hardware fault," not "network issue," at a glance.

## Open questions before implementation

- Exact `PA_MAX_ON_SECONDS` default — 300s is a placeholder; should reflect
  the longest realistic legitimate transmission for this station's actual
  use (a long FT8 sequence, a ragchew on SSB, etc.) with real margin.
- Whether `POST /pa-emergency-clear` (or similar) needs auth/confirmation
  beyond a browser button click, given it re-enables a safety-critical path.
- Whether PA Sense should also appear in `GET /status` (almost certainly
  yes, same pattern as `radio_linked`/`cat_baud`) and whether the latched
  fault state itself needs its own field there too, so the control page and
  web app can both surface "PA EMERGENCY TRIPPED — clear before
  transmitting" prominently rather than only via the LED.
- GPIO2/GPIO4 electrical verification against the real board (pull
  resistors, actual logic thresholds coming from the user's level-shifter)
  before any code touches these pins.

## Sources (miniPA70 research)

- https://www.ebay.com/itm/183383705781
- https://ralph-ab1op.blogspot.com/2018/05/minipa-70-watt-hf-amplifier-unboxed.html
- https://ea8arx.blogspot.com/2018/06/minipa-70-step-by-step.html
- https://vk8rhradioprojects.com/hf-linear-amplifiers/
- https://awsh.org/mosfet-amplifier/

## Sources (A1S GPIO research)

- https://nuttx.apache.org/docs/latest/platforms/xtensa/esp32/boards/esp32-audio-kit/index.html
- https://diyelectromusic.com/2025/04/07/esp32-a1s-audio-kit/
- https://github.com/Ai-Thinker-Open/ESP32-A1S-AudioKit
- https://github.com/trombik/esp-adf-component-ai-thinker-esp32-a1s
