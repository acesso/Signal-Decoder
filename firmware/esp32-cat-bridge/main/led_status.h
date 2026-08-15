// Drives the board's two GPIO-controllable LEDs (see LED_AUDIO_IN_PIN/
// LED_AUDIO_OUT_PIN in bridge_config.h) via LEDC PWM. Normal operation shows
// one LED per audio direction, brightness proportional to signal level; a
// handful of bridge-wide states (Wi-Fi connecting, AP fallback, no CAT
// traffic) override that display with a distinct blink pattern since they
// need attention more urgently than "how loud is the audio right now".
//
// Priority order (highest wins, checked every tick by the internal timer):
//   1. PA emergency     — both LEDs strobe very fast (hardware safety fault
//                         — see pa_watchdog.h — takes priority over
//                         EVERYTHING else; this is the one state that must
//                         never be visually confused with a mere network issue)
//   2. AP fallback     — both LEDs blink in sync, fast (network needs fixing)
//   3. Wi-Fi connecting — both LEDs alternate (joining, not stuck yet)
//   4. No CAT traffic   — both LEDs slow-pulse together as a base layer,
//                         audio levels (if any) still show as brightness
//                         riding on top of the pulse
//   5. Normal           — LED_AUDIO_IN = audio-in level, LED_AUDIO_OUT =
//                         audio-out level, plain brightness, no blinking
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Starts the LEDC timers/channels and the internal update task. Call once
// from app_main, any time after gpio/ledc are available. CAT-link status is
// read directly from bridge_state on every tick (same "traffic within the
// last 3s" definition GET /status uses, see http_control.c's
// status_handler) rather than pushed — no ordering dependency on
// bridge_state_init() beyond it having run before the first tick, ~50ms
// away, which app_main.c already guarantees by sequencing.
void led_status_start(void);

// 0-255 brightness for each direction's LED in the "normal" display state —
// called continuously by audio_monitor as new RMS levels are computed.
// Values outside 0-255 are clamped, not asserted, since a caller here is
// far more likely to have a scaling bug than to need a real bounds check.
void led_status_set_audio_levels(uint8_t in_level, uint8_t out_level);

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
