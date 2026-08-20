#include "led_status.h"

#include <stdatomic.h>

#include "driver/ledc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"

static const char *TAG = "led_status";

#define LED_TICK_MS 50

#define LED_CHANNEL LEDC_CHANNEL_0
#define LED_TIMER   LEDC_TIMER_0
#define LED_DUTY_MAX ((1 << LED_PWM_RESOLUTION) - 1)

// Plain atomics, not a mutex: every field here is written by exactly one
// producer (wifi_net/cat_bridge for the state flags) and read only by
// led_status's own tick task — no read-modify-write race is possible, so a
// lock would just add overhead for nothing.
static _Atomic bool s_wifi_connecting = false;
static _Atomic bool s_ap_fallback = false;
static _Atomic bool s_pa_emergency = false;

// Live kill-switch for the status LED — a one-time diagnostic test for
// whether the LEDC PWM switching itself (GPIO22, right next to the audio
// codec on this board) is injecting noise into the analog audio path, on
// top of the already-confirmed onboard-mic bleed-through. Deliberately
// reversible (POST /led-enable, defaults to true/on) rather than ripping
// the LED driver out — if this turns out not to be the culprit, the fix is
// one API call, not a re-flash.
static _Atomic bool s_leds_enabled = true;

// ledc_set_duty()/ledc_update_duty() are documented as not thread-safe, but
// led_task is the LEDC peripheral's only writer (no other task ever touches
// this channel), so that caveat doesn't apply here — the thread-safe
// ledc_set_duty_and_update() alternative requires ledc_fade_func_install()
// first (a fade-service dependency this driver has no other use for) and
// errored on every call without it, discovered as a silent-LED bug (no
// crash, just ESP_ERR logged and the duty never actually changing) on real
// hardware.
static void set_duty(uint8_t level) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LED_CHANNEL, level);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LED_CHANNEL);
}

// Runs forever at LED_TICK_MS resolution, picking whichever display mode
// currently has priority and rendering one frame of it. A tick-based
// approach (vs. e.g. separate blink timers per mode) keeps the priority
// order trivial to read top-to-bottom.
static void led_task(void *arg) {
    uint32_t tick = 0;
    for (;;) {
        tick++;

        if (!atomic_load(&s_leds_enabled)) {
            // Force the channel fully off (not just "skip the update") —
            // otherwise whatever duty was last set before disabling would
            // keep the PWM switching at that duty cycle forever, defeating
            // the whole point of this test.
            set_duty(0);
            vTaskDelay(pdMS_TO_TICKS(LED_TICK_MS));
            continue;
        }

        if (atomic_load(&s_pa_emergency)) {
            // Very fast strobe — a hardware safety fault, the single most
            // urgent thing this device can report. Deliberately faster
            // than every other pattern below so it can never be mistaken
            // for a mere network issue at a glance.
            bool on = (tick % 2) < 1; // 100ms on/off at 50ms ticks
            set_duty(on ? LED_DUTY_MAX : 0);
        } else if (atomic_load(&s_ap_fallback)) {
            // Fast sync blink — network needs attention now.
            bool on = (tick % 6) < 3; // 300ms on/off at 50ms ticks
            set_duty(on ? LED_DUTY_MAX : 0);
        } else if (atomic_load(&s_wifi_connecting)) {
            // Fast-ish blink — distinct from AP fallback's slower blink,
            // distinct from the slow pulse below.
            bool on = (tick % 8) < 4; // ~400ms per phase
            set_duty(on ? LED_DUTY_MAX : 0);
        } else {
            // Slow pulse as a permanent base layer, "still alive" —
            // floors at PULSE_MIN_DUTY rather than 0, since a full
            // dim-to-off pulse reads as "flickering/off" at a glance
            // rather than "gently breathing."
            #define PULSE_MIN_DUTY (LED_DUTY_MAX / 6)
            uint32_t phase = tick % 40; // 2s period at 50ms ticks
            uint32_t pulse = phase < 20 ? phase : (40 - phase); // 0..20..0 triangle
            uint8_t pulse_level = (uint8_t)(PULSE_MIN_DUTY + (pulse * (LED_DUTY_MAX - PULSE_MIN_DUTY)) / 20);
            set_duty(pulse_level);
        }

        vTaskDelay(pdMS_TO_TICKS(LED_TICK_MS));
    }
}

void led_status_start(void) {
    ledc_timer_config_t timer_cfg = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LED_PWM_RESOLUTION,
        .timer_num = LED_TIMER,
        .freq_hz = LED_PWM_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer_cfg));

    ledc_channel_config_t led_cfg = {
        .gpio_num = LED_STATUS_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LED_CHANNEL,
        .timer_sel = LED_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&led_cfg));

    // Cosmetic only (visual feedback, not radio timing) — default core
    // affinity is fine, no need to reserve core 1 for this the way the CAT
    // UART reader does.
    xTaskCreate(led_task, "led_status", 2048, NULL, tskIDLE_PRIORITY + 2, NULL);
    ESP_LOGI(TAG, "status LED ready (GPIO%d)", LED_STATUS_PIN);
}

void led_status_set_wifi_connecting(bool connecting) {
    atomic_store(&s_wifi_connecting, connecting);
}

void led_status_set_ap_fallback(bool active) {
    atomic_store(&s_ap_fallback, active);
}

void led_status_set_pa_emergency(bool tripped) {
    atomic_store(&s_pa_emergency, tripped);
}

void led_status_set_enabled(bool enabled) {
    atomic_store(&s_leds_enabled, enabled);
}

bool led_status_get_enabled(void) {
    return atomic_load(&s_leds_enabled);
}
