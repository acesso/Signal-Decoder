#include "pa_watchdog.h"

#include <stdatomic.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "bridge_state.h"
#include "led_status.h"

static const char *TAG = "pa_watchdog";

// Polled, not interrupt-driven — this task's whole job is a slow (seconds-
// scale) timeout, so there's no latency reason to react to PA_SENSE_PIN
// faster than this, and polling keeps the debounce logic below trivially
// easy to reason about (a safety-critical input is not where cleverness
// pays off).
#define POLL_INTERVAL_MS 100

// Requires PA_SENSE_PIN to read the SAME level for this many consecutive
// polls before believing it — a raw digital input from an external board
// crossing a relay/PA switching event is exactly the kind of line that can
// glitch for a poll or two; debouncing here means a single noise edge
// can't either falsely start the timeout clock or falsely reset it right
// before it would have tripped.
#define DEBOUNCE_POLLS 3

// ── Signal polarity ──────────────────────────────────────────────────────
// Both PA lines are ACTIVE LOW / ACTIVE HIGH in the non-obvious direction,
// because the interface board switches them with an NPN (2N2222) low-side
// transistor behind forward-biased isolation diodes. Every level<->meaning
// conversion goes through the two helpers below rather than being open-
// coded, so there is exactly one place to get the polarity right — an
// earlier version of this file used the raw pin level as if it WERE the
// energized flag, which is precisely the conflation that made inverting it
// error-prone.
//
// SENSE (GPIO19, input) — reads the 2N2222 collector through an isolation
// diode. PA idle: collector floats, the level shifter's pull-up holds the
// pin HIGH. PA energized: the collector grounds and pulls the pin LOW.
#define PA_SENSE_LEVEL_ENERGIZED 0
#define PA_SENSE_LEVEL_IDLE      1

// EMERGENCY (GPIO5, output) — drives the 2N2222 base through an isolation
// diode. HIGH biases the base on, grounding the PA keying loop and clamping
// the PA off. LOW leaves the diode unbiased so the uSDX's own command path
// operates without interference (the permissive/idle state).
#define PA_EMERGENCY_LEVEL_CLAMPED   1
#define PA_EMERGENCY_LEVEL_PERMISSIVE 0

// True when the raw pin level means "the PA is drawing power right now".
static inline bool pa_level_is_energized(int level) {
    return level == PA_SENSE_LEVEL_ENERGIZED;
}

static _Atomic bool s_pa_sense = false;
static _Atomic bool s_emergency_tripped = false;

static void mutate_pa_state(bridge_state_t *state, void *ctx) {
    (void)ctx;
    state->pa_sense = atomic_load(&s_pa_sense);
    state->pa_emergency_tripped = atomic_load(&s_emergency_tripped);
}

static void publish_pa_state(void) {
    bridge_state_update(mutate_pa_state, NULL);
}

// The permissive state is HIGH-Z (input mode), NOT a driven LOW.
//
// REAL HARDWARE FINDING (2026-08-31): the clamp diode's cathode sits on the
// 2N2222's BASE junction — the same node the uSDX's PTT drives through its
// 1k resistor. A driven LOW on this line is therefore NOT inert: with the
// anode held near 0V, base current arriving from Ring 2 flows straight out
// through the diode into the level shifter's low-impedance pull-down, so
// the base never reaches the ~0.7V needed to turn the transistor on. The
// symptom is unmistakable — plugging the brown wire in stops real PTT from
// keying the PA at all, while never producing a short of its own.
//
// Releasing the pin to an input instead leaves the diode with no low-
// impedance path in either direction, so the radio's own PTT drive is
// untouched. Asserting the clamp means switching back to an output driven
// HIGH.
//
// NOTE the clamp direction is still WRONG for this wiring, and this change
// does not fix that: HIGH feeds current INTO the base, which turns the
// transistor on and KEYS the PA rather than shutting it off. This node can
// only ever assert, never interrupt. Until the hardware gains a real
// shutdown path (a base-steal NPN across base-emitter, or a series
// interrupt in the collector/key line), a trip here is actively harmful —
// see pa_watchdog.h's KNOWN LIMITATION block.
static void set_emergency(bool tripped) {
    atomic_store(&s_emergency_tripped, tripped);
    if (tripped) {
        gpio_set_direction(PA_EMERGENCY_PIN, GPIO_MODE_OUTPUT);
        gpio_set_level(PA_EMERGENCY_PIN, PA_EMERGENCY_LEVEL_CLAMPED);
    } else {
        // High-Z: stop sinking the radio's base current.
        gpio_set_direction(PA_EMERGENCY_PIN, GPIO_MODE_INPUT);
    }
    led_status_set_pa_emergency(tripped);
    publish_pa_state();
}

void pa_watchdog_clear(void) {
    if (!atomic_load(&s_emergency_tripped)) return; // nothing to clear
    ESP_LOGW(TAG, "emergency cleared by operator — PA_EMERGENCY_PIN restored LOW (permissive)");
    set_emergency(false);
}

bool pa_watchdog_pa_sensed(void) {
    return atomic_load(&s_pa_sense);
}

bool pa_watchdog_emergency_tripped(void) {
    return atomic_load(&s_emergency_tripped);
}

// debounced_energized tracks what the debounce logic currently believes
// about the PA's real state; pending_energized/pending_count track a
// candidate change in progress. on_high_since is the timestamp the
// debounced state last transitioned to ENERGIZED — 0 when it is idle.
static void watchdog_task(void *arg) {
    // Tracked as ENERGIZED/not, never as a raw pin level — see the polarity
    // block above for why that distinction is load-bearing here.
    bool debounced_energized = pa_level_is_energized(gpio_get_level(PA_SENSE_PIN));
    bool pending_energized = debounced_energized;
    int pending_count = 0;
    int64_t on_high_since = debounced_energized ? esp_timer_get_time() : 0;

    atomic_store(&s_pa_sense, debounced_energized);
    publish_pa_state();

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));

        bool raw = pa_level_is_energized(gpio_get_level(PA_SENSE_PIN));
        if (raw == pending_energized) {
            pending_count++;
        } else {
            pending_energized = raw;
            pending_count = 1;
        }

        if (pending_count >= DEBOUNCE_POLLS && pending_energized != debounced_energized) {
            debounced_energized = pending_energized;
            atomic_store(&s_pa_sense, debounced_energized);
            if (debounced_energized) {
                on_high_since = esp_timer_get_time();
                ESP_LOGI(TAG, "PA sense: energized");
            } else {
                on_high_since = 0;
                ESP_LOGI(TAG, "PA sense: off");
            }
            publish_pa_state();
        }

        if (debounced_energized && !atomic_load(&s_emergency_tripped) && on_high_since != 0) {
            int64_t on_seconds = (esp_timer_get_time() - on_high_since) / 1000000;
            if (on_seconds >= PA_MAX_ON_SECONDS) {
#if PA_WATCHDOG_TRIP_ENABLED
                ESP_LOGE(TAG, "PA has been continuously energized for %lld s (limit %d s) — "
                               "tripping emergency cutoff", (long long)on_seconds, PA_MAX_ON_SECONDS);
                set_emergency(true);
#else
                // Trip disabled: with the clamp diode on the base junction,
                // asserting it would KEY the PA rather than shut it off (see
                // set_emergency()'s block). Log once per overrun so the
                // condition is still visible, but never assert. Reset the
                // clock so this doesn't spam every poll.
                ESP_LOGE(TAG, "PA continuously energized for %lld s (limit %d s) — trip is "
                               "DISABLED for this wiring (asserting the clamp would key the PA, "
                               "not stop it); NOT tripping", (long long)on_seconds, PA_MAX_ON_SECONDS);
                on_high_since = esp_timer_get_time();
#endif
            }
        }
    }
}

void pa_watchdog_start(void) {
    // Pulled UP internally, matching the interface board's own level-shifter
    // pull-up: with the new active-LOW sense polarity, HIGH means "PA idle",
    // so an unplugged or severed header line settles at the SAFE reading
    // rather than a false "energized". A pull-DOWN here would fight the
    // board's pull-up (an indeterminate divider if that pull-up is weak) and
    // would make a severed wire masquerade as a genuine 300-second
    // transmission — the watchdog would still eventually trip, but five
    // minutes late and logging the wrong cause.
    //
    // The tradeoff this accepts, stated plainly: with the pull-up, a severed
    // sense line reads HIGH = "PA idle", which is indistinguishable from a
    // genuinely idle PA on this pin alone. The watchdog therefore cannot
    // detect its own blindness — it would simply never trip. Distinguishing
    // the two needs a second signal the bridge does not currently have (it
    // tracks no PTT/TX state of its own), so this is a known limitation to
    // close with a hardware or plumbing change, NOT something the debounce
    // logic below can infer. The alternative (pull-down) trades this silent
    // blindness for a guaranteed-but-late trip that misreports its cause;
    // per the operator's decision, an unwired header reading "safe" is
    // preferred over one that manufactures a fake 300-second transmission.
    //
    // NOTE: a software pull-up cannot override a real resistor on the PCB.
    // If PA_SENSE_PIN ever reads a steady, non-flickering LOW with nothing
    // wired to the header, that is the signature of a board-populated
    // pull-down on whatever pin is in use (the mirror image of the
    // GPIO2/SD-DATA0 pull-up problem that drove this signal off the SD pads
    // — see bridge_config.h), not a genuine PA fault.
    gpio_config_t sense_cfg = {
        .pin_bit_mask = 1ULL << PA_SENSE_PIN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&sense_cfg));

    // INPUT (high-Z) is the permissive boot state — see set_emergency()'s
    // block for why a driven LOW here silently blocks the radio's own PTT.
    // No internal pull in either direction: a pull would reintroduce exactly
    // the current path being avoided. Also the safest state for GPIO5 as an
    // ESP32 strapping pin, since nothing here drives it at all during boot.
    gpio_config_t emergency_cfg = {
        .pin_bit_mask = 1ULL << PA_EMERGENCY_PIN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&emergency_cfg));
    // Nothing to drive — gpio_config() above already left the pin high-Z,
    // which IS the permissive state.

    // Pinned to RELAY_TASK_CORE — safety-critical timing belongs with the
    // other real-time relay work, never contended by Wi-Fi/network
    // activity. Below CAT UART's priority (protocol correctness always
    // wins) but above audio (this task's own polling is far lighter than
    // audio's I2S I/O, so it should never be starved by it) — see
    // bridge_config.h's Task placement notes.
    xTaskCreatePinnedToCore(watchdog_task, "pa_watchdog", 3072, NULL,
                             PA_WATCHDOG_TASK_PRIO, NULL, PA_WATCHDOG_TASK_CORE);
    ESP_LOGI(TAG, "PA watchdog ready (sense=GPIO%d, emergency=GPIO%d, limit=%ds)",
             PA_SENSE_PIN, PA_EMERGENCY_PIN, PA_MAX_ON_SECONDS);
}
