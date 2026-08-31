// PA safety watchdog — guards against the uSDX hanging with the external
// miniPA70 amplifier still keyed. See main/doc/PA_WATCHDOG_DESIGN.md for
// the full design, the research (miniPA70 has no feedback of its own) it's
// based on, and the pin-choice revision history (now GPIO19/GPIO5, both on
// the real header — see bridge_config.h's PA_SENSE_PIN/PA_EMERGENCY_PIN).
//
// Both lines are switched by an NPN (2N2222) low-side transistor on the
// interface board, behind forward-biased isolation diodes, so BOTH have
// non-obvious polarity — see pa_watchdog.c's polarity block, which is the
// single source of truth for every level<->meaning conversion.
//
// PA_SENSE_PIN (input, ACTIVE LOW) reads the amp's own energized-state
// feedback, from the user's interface board — ground truth, independent of
// the radio's PA-send command or the interface board's own level-shifting.
// The transistor collector floats (level-shifter pull-up holds the pin
// HIGH) while the PA is idle, and grounds the pin LOW once the PA is
// energized. The moment it reads continuously LOW/energized for
// PA_MAX_ON_SECONDS, PA_EMERGENCY_PIN (ACTIVE HIGH clamp line driving the
// transistor base) is driven HIGH, grounding the PA keying loop and forcing
// the PA off regardless of what the radio is doing.
//
// The trip LATCHES: once tripped, PA_EMERGENCY_PIN stays HIGH even after
// PA_SENSE_PIN returns to its idle level on its own. Only pa_watchdog_clear() un-
// trips it. This is deliberate — see the design doc's reasoning — a real
// hardware fault should require a human to notice and clear it, not
// silently flap the PA back on the moment the sense signal looks okay again.
#pragma once

#include <stdbool.h>

// Configures PA_SENSE_PIN as input (internal pull-UP, matching the
// interface board's own, so an unwired header reads as idle rather than a
// false "energized") and PA_EMERGENCY_PIN as a HIGH-Z input — the
// permissive default. High-Z rather than a driven LOW because the clamp
// diode lands on the transistor's BASE junction, where a driven LOW sinks
// the radio's own PTT base current and silently prevents the PA from
// keying at all (confirmed on hardware 2026-08-31). Then starts the polling
// task that watches for a stuck-on condition. Call once from app_main.
//
// KNOWN LIMITATION 1: because idle and "sense wire severed" both read HIGH,
// this watchdog cannot detect loss of its own sense line — it would simply
// never trip. Closing that needs a second signal the bridge does not
// currently have. See pa_watchdog.c's pull-up comment for the full
// tradeoff.
//
// KNOWN LIMITATION 2 — THE CLAMP CANNOT SHUT THE PA OFF, AND A TRIP IS
// HARMFUL. PA_EMERGENCY_PIN's diode lands on the same base junction the
// uSDX's PTT drives, so asserting it HIGH turns the switching transistor ON
// — grounding the PA key line, which is what KEYS the amplifier. The
// watchdog's remedy therefore asserts the exact condition it detects. This
// is a wiring-topology limit; no firmware change can work around it. A real
// shutdown path needs either a base-steal NPN across base-emitter or a
// series interrupt in the collector/key line. Until then, treat a trip as
// something to avoid rather than rely on.
void pa_watchdog_start(void);

// True if PA_SENSE_PIN currently reads its ENERGIZED level (LOW; debounced
// — see pa_watchdog.c's poll interval) — i.e. the PA hardware is confirmed
// energized right now, independent of the latched emergency state below.
bool pa_watchdog_pa_sensed(void);

// True once PA_MAX_ON_SECONDS of continuous pa_watchdog_pa_sensed() has
// driven PA_EMERGENCY_PIN HIGH (clamped). Latched — stays true until
// pa_watchdog_clear() is called, regardless of what pa_watchdog_pa_sensed()
// does in the meantime.
bool pa_watchdog_emergency_tripped(void);

// Manually clears a latched emergency trip and restores PA_EMERGENCY_PIN
// to LOW (the permissive default) — called from POST /pa-emergency-clear.
// Does NOT check whether pa_watchdog_pa_sensed() is currently false first:
// if the PA is still genuinely on when this is called, the timeout timer
// simply starts counting again from zero rather than tripping immediately,
// same as any other case of pa_sense transitioning to true. Deliberately
// simple — the operator calling this is expected to have already confirmed
// (by eye/ear) that it's actually safe to re-enable, same as clearing any
// other physical safety interlock.
void pa_watchdog_clear(void);
