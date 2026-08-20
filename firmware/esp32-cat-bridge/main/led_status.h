// Drives the board's single status LED (see LED_STATUS_PIN in
// bridge_config.h) via LEDC PWM. Used to show per-direction audio levels on
// two separate LEDs — GPIO19 (the second LED) was reclaimed for the PA
// safety watchdog's header wiring (see bridge_config.h), so audio-level
// display was dropped rather than trying to fold two independent levels
// onto one LED. This one LED now shows only bridge-wide states.
//
// Priority order (highest wins, checked every tick by the internal timer):
//   1. PA emergency     — very fast strobe (hardware safety fault — see
//                         pa_watchdog.h — takes priority over EVERYTHING
//                         else; this is the one state that must never be
//                         visually confused with a mere network issue)
//   2. AP fallback     — fast sync blink (network needs fixing)
//   3. Wi-Fi connecting — alternating blink (joining, not stuck yet)
//   4. Normal           — slow pulse as a base "still alive" layer
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Starts the LEDC timer/channel and the internal update task. Call once
// from app_main, any time after gpio/ledc are available.
void led_status_start(void);

// Wi-Fi connecting/AP-fallback are mutually exclusive states in wifi_net.c's
// own state machine (see bridge_wifi_state_t) — mirrored here as plain
// booleans rather than routing through bridge_state, since wifi_net.c's
// event_handler already has a natural call site at every transition and a
// push is simpler than adding a third field to poll every tick.
void led_status_set_wifi_connecting(bool connecting);
void led_status_set_ap_fallback(bool active);

// Highest-priority state — see pa_watchdog.c, which calls this the moment
// PA_MAX_ON_SECONDS of continuous PA sense trips (or clears) the latched
// emergency cutoff.
void led_status_set_pa_emergency(bool tripped);

// Live kill-switch for the status LED (forces duty to 0, bypassing every
// display state above) — a reversible, one-time test for whether the LEDC
// PWM switching on GPIO22 (right next to the audio codec on this board) is
// itself injecting noise into the analog audio path. Defaults to true (on);
// see POST /led-enable. NOT persisted to NVS — this is a live probe, not a
// permanent setting, and should default back to on after a reboot unless
// the test actually confirms it matters.
void led_status_set_enabled(bool enabled);
bool led_status_get_enabled(void);
