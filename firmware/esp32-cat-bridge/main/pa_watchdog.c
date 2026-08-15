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

static void set_emergency(bool tripped) {
    atomic_store(&s_emergency_tripped, tripped);
    // Permissive line: HIGH lets the radio's own PA-send signal work
    // normally, LOW forces the PA off regardless of what the radio is
    // doing. See pa_watchdog.h for why this doesn't also force pa_sense
    // to false here — that's a separate, independently-read signal.
    gpio_set_level(PA_EMERGENCY_PIN, tripped ? 0 : 1);
    led_status_set_pa_emergency(tripped);
    publish_pa_state();
}

void pa_watchdog_clear(void) {
    if (!atomic_load(&s_emergency_tripped)) return; // nothing to clear
    ESP_LOGW(TAG, "emergency cleared by operator — PA_EMERGENCY_PIN restored HIGH");
    set_emergency(false);
}

bool pa_watchdog_pa_sensed(void) {
    return atomic_load(&s_pa_sense);
}

bool pa_watchdog_emergency_tripped(void) {
    return atomic_load(&s_emergency_tripped);
}

// debounced_level tracks what the debounce logic currently believes
// PA_SENSE_PIN reads; pending_level/pending_count track a candidate level
// change in progress. on_high_since is the timestamp the debounced level
// last transitioned to HIGH — 0 when the debounced level is LOW.
static void watchdog_task(void *arg) {
    bool debounced_level = gpio_get_level(PA_SENSE_PIN) != 0;
    bool pending_level = debounced_level;
    int pending_count = 0;
    int64_t on_high_since = debounced_level ? esp_timer_get_time() : 0;

    atomic_store(&s_pa_sense, debounced_level);
    publish_pa_state();

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));

        bool raw = gpio_get_level(PA_SENSE_PIN) != 0;
        if (raw == pending_level) {
            pending_count++;
        } else {
            pending_level = raw;
            pending_count = 1;
        }

        if (pending_count >= DEBOUNCE_POLLS && pending_level != debounced_level) {
            debounced_level = pending_level;
            atomic_store(&s_pa_sense, debounced_level);
            if (debounced_level) {
                on_high_since = esp_timer_get_time();
                ESP_LOGI(TAG, "PA sense: energized");
            } else {
                on_high_since = 0;
                ESP_LOGI(TAG, "PA sense: off");
            }
            publish_pa_state();
        }

        if (debounced_level && !atomic_load(&s_emergency_tripped) && on_high_since != 0) {
            int64_t on_seconds = (esp_timer_get_time() - on_high_since) / 1000000;
            if (on_seconds >= PA_MAX_ON_SECONDS) {
                ESP_LOGE(TAG, "PA has been continuously energized for %lld s (limit %d s) — "
                               "tripping emergency cutoff", (long long)on_seconds, PA_MAX_ON_SECONDS);
                set_emergency(true);
            }
        }
    }
}

void pa_watchdog_start(void) {
    gpio_config_t sense_cfg = {
        .pin_bit_mask = 1ULL << PA_SENSE_PIN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&sense_cfg));

    gpio_config_t emergency_cfg = {
        .pin_bit_mask = 1ULL << PA_EMERGENCY_PIN,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&emergency_cfg));
    gpio_set_level(PA_EMERGENCY_PIN, 1); // permissive default — set before anything can read it as low

    xTaskCreate(watchdog_task, "pa_watchdog", 3072, NULL, tskIDLE_PRIORITY + 4, NULL);
    ESP_LOGI(TAG, "PA watchdog ready (sense=GPIO%d, emergency=GPIO%d, limit=%ds)",
             PA_SENSE_PIN, PA_EMERGENCY_PIN, PA_MAX_ON_SECONDS);
}
