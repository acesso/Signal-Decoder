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

| Name         | Direction | GPIO (current) | Idle state | Meaning |
|--------------|-----------|------------------|------------|---------|
| PA Sense     | input     | GPIO19           | n/a        | **ACTIVE LOW** — LOW = PA hardware confirmed energized (2N2222 collector grounds the line); HIGH = idle (collector floats, level-shifter pull-up holds it up). Already level-shifted to safe logic by the user's board — plain digital read, no ADC |
| PA Emergency | output    | GPIO5            | LOW        | **ACTIVE HIGH** clamp line driving the 2N2222 base — LOW leaves the isolation diode unbiased so the radio's own signal controls the PA normally; HIGH biases the base on, grounding the PA keying loop and forcibly cutting it regardless of what the radio is doing. LOW-when-idle also suits GPIO5 being an ESP32 strapping pin |

### Pin choice — revision history

**v1 (GPIO2/GPIO4, SD-card DATA0/DATA1):** the original choice, reasoning
being that these were wired to a peripheral this firmware never uses,
rather than sharing a live button/LED/codec function. Abandoned after
confirming ON REAL HARDWARE (nothing wired to the header, software
pull-down enabled) that GPIO2 reads a steady, non-flickering HIGH — the
A1S board has a fixed, always-populated pull-up on that line for SD-bus
compliance (per Espressif's own SD pull-up guidance) that trivially
overpowers the ESP32's weak internal pull-down. Every PA-emergency trip
seen with this wiring was almost certainly a false 300s timeout against a
permanently-"energized"-reading pin, not a real stuck PA.

**v2 (GPIO13/GPIO4, SD-card DATA3/DATA1):** GPIO13 was substituted for
GPIO2 as the next SD-pad fallback — still not a real header pin, and still
DIP-switch-shared with KEY2 on this board, carrying the same "which
physical mode is actually active" ambiguity v1 was trying to avoid in the
first place.

**v3, current (GPIO19/GPIO5, both real header pins):** moved off the
SD-card pads entirely. GPIO19 was freed by dropping the second status LED
(LED_AUDIO_OUT_PIN — see led_status.c/bridge_config.h; audio-level display
was removed rather than trying to fold two independent levels onto the
remaining single LED). GPIO5 was the one header GPIO left genuinely
unclaimed by anything else in this firmware. Both are on the actual pin
header — no soldering to the SD card slot required, and neither should
carry an SD-bus pull-up the way GPIO2 did (they aren't SD-bus pins at all
on this board), though this hasn't been bench-verified yet — same
continuity/multimeter check GPIO2 needed applies here before trusting a
reading from GPIO19 with nothing wired to the header.

Explicitly avoided (all versions):

- **GPIO12** — SD DATA2, but also an ESP32 strapping pin (MTDI, selects
  flash voltage at boot). Driving this from external circuitry risks
  interfering with boot if it's held in the wrong state during reset.
- **GPIO34/36/39** — not broken out to the header at all on this board
  (used internally for SD-card-detect and KEY1), so not reachable
  regardless of their input-only/ADC1 nature.

Needs hardware confirmation before wiring: verify GPIO19/GPIO5 read/drive
as expected with the real interface board connected — the same caution
already applied to the ES8388 PA-enable polarity elsewhere in this
firmware, and the exact check that caught GPIO2's false-HIGH pull-up in v1.

## Behavior

**Trigger**: fixed maximum continuous PA-on duration. The moment PA Sense
reads LOW (energized), start a timer. If PA Sense is *still* energized after
`PA_MAX_ON_SECONDS` (proposed default: 300s / 5 minutes — comfortably past
any real SSB/CW transmission, far short of "left keyed for hours"), pull PA
Emergency HIGH (clamped). The timer resets the instant PA Sense returns to idle — a
normal TX-then-RX cycle never comes close to tripping it.

Deliberately *not* cross-checked against the CAT line's TX0;/RX0; state
(the existing `CAT_TX_CMD` sniffing in `cat_bridge.c`): coupling a hardware
safety watchdog to CAT parsing correctness would make it only as reliable
as CAT parsing, and it wouldn't catch a hang that happens to occur while
the radio still legitimately believes it's transmitting. PA Sense is
ground truth about the hardware; the timeout should depend on nothing else.

**Polarity (2026-08-31 revision):** both lines were originally specified
active-HIGH-sense / active-LOW-clamp. The real interface board switches them
with an NPN (2N2222) low-side transistor behind forward-biased isolation
diodes, which inverts BOTH relative to that original assumption — sense is
now active LOW, clamp is now active HIGH. `pa_watchdog.c` holds the only
level<->meaning conversion (`PA_SENSE_LEVEL_ENERGIZED` /
`PA_EMERGENCY_LEVEL_CLAMPED` and the `pa_level_is_energized()` helper);
nothing else in the firmware should compare these pins to a raw 0/1.

**Known limitation — the watchdog cannot detect loss of its own sense line.**
The internal pull is UP (matching the board's level-shifter pull-up), so an
unplugged or severed sense wire reads HIGH = "PA idle" — indistinguishable
from a genuinely idle PA on this pin alone, and the watchdog would simply
never trip. The alternative (pull-down) would make a severed wire read as
energized and trip after the full 300s, but that trades silent blindness for
a guaranteed-but-late trip that misreports its cause, and it fights the
board's own pull-up. Closing this properly needs a second signal — the
bridge currently tracks no PTT/TX state of its own to cross-check against.

**Recovery**: latched, not auto-clearing. Once PA Emergency goes HIGH, it
**stays** HIGH — even after PA Sense returns to idle on its own — until an
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
