// PA safety watchdog — guards against the uSDX hanging with the external
// miniPA70 amplifier still keyed. See main/doc/PA_WATCHDOG_DESIGN.md for
// the full design, the research (miniPA70 has no feedback of its own) it's
// based on, and the pin-choice revision history (now GPIO19/GPIO5, both on
// the real header — see bridge_config.h's PA_SENSE_PIN/PA_EMERGENCY_PIN).
//
// PA_SENSE_PIN (input) reads the amp's own energized-state feedback, from
// the user's interface board — ground truth, independent of the radio's
// PA-send command or the interface board's own level-shifting. The moment
// it reads continuously HIGH for PA_MAX_ON_SECONDS, PA_EMERGENCY_PIN
// (normally-HIGH permissive line in series with the radio's PA-send path
// on the interface board) is pulled LOW, forcing the PA off regardless of
// what the radio is doing.
//
// The trip LATCHES: once tripped, PA_EMERGENCY_PIN stays LOW even after
// PA_SENSE_PIN drops back to LOW on its own. Only pa_watchdog_clear() un-
// trips it. This is deliberate — see the design doc's reasoning — a real
// hardware fault should require a human to notice and clear it, not
// silently flap the PA back on the moment the sense signal looks okay again.
#pragma once

#include <stdbool.h>

// Configures PA_SENSE_PIN as input and PA_EMERGENCY_PIN as output (driven
// HIGH immediately — the permissive default, letting the radio's own
// PA-send signal control the amp normally), then starts the polling task
// that watches for a stuck-on condition. Call once from app_main.
void pa_watchdog_start(void);

// True if PA_SENSE_PIN currently reads HIGH (debounced — see
// pa_watchdog.c's poll interval) — i.e. the PA hardware is confirmed
// energized right now, independent of the latched emergency state below.
bool pa_watchdog_pa_sensed(void);

// True once PA_MAX_ON_SECONDS of continuous pa_watchdog_pa_sensed() has
// forced PA_EMERGENCY_PIN low. Latched — stays true until
// pa_watchdog_clear() is called, regardless of what pa_watchdog_pa_sensed()
// does in the meantime.
bool pa_watchdog_emergency_tripped(void);

// Manually clears a latched emergency trip and restores PA_EMERGENCY_PIN
// to HIGH (the permissive default) — called from POST /pa-emergency-clear.
// Does NOT check whether pa_watchdog_pa_sensed() is currently false first:
// if the PA is still genuinely on when this is called, the timeout timer
// simply starts counting again from zero rather than tripping immediately,
// same as any other case of pa_sense transitioning to true. Deliberately
// simple — the operator calling this is expected to have already confirmed
// (by eye/ear) that it's actually safe to re-enable, same as clearing any
// other physical safety interlock.
void pa_watchdog_clear(void);
