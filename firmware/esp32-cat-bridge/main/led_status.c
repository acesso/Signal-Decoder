#include "led_status.h"

#include <stdatomic.h>

#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "bridge_state.h"

static const char *TAG = "led_status";

#define LED_TICK_MS 50

// LEDC channel assignment — arbitrary, just needs to be unique per pin and
// consistent between config and duty-set calls.
#define LED_IN_CHANNEL  LEDC_CHANNEL_0
#define LED_OUT_CHANNEL LEDC_CHANNEL_1
#define LED_TIMER       LEDC_TIMER_0
#define LED_DUTY_MAX    ((1 << LED_PWM_RESOLUTION) - 1)

// Plain atomics, not a mutex: every field here is written by exactly one
// producer (audio_monitor for levels, wifi_net/cat_bridge for the state
// flags) and read only by led_status's own tick task — no read-modify-write
// race is possible, so a lock would just add overhead for nothing.
static _Atomic uint8_t s_level_in = 0;
static _Atomic uint8_t s_level_out = 0;
static _Atomic bool s_wifi_connecting = false;
static _Atomic bool s_ap_fallback = false;
static _Atomic bool s_pa_emergency = false;

// Same "traffic within the last 3s" threshold GET /status uses (see
// status_handler in http_control.c) — kept as one named constant so the two
// don't silently drift apart if either is tuned later.
#define CAT_LINK_TIMEOUT_US 3000000

static bool cat_currently_linked(void) {
    bridge_state_t st;
    bridge_state_get(&st);
    return (esp_timer_get_time() - st.last_radio_rx_us) <= CAT_LINK_TIMEOUT_US;
}

// ledc_set_duty()/ledc_update_duty() are documented as not thread-safe, but
// led_task is the LEDC peripheral's only writer (no other task ever touches
// these channels), so that caveat doesn't apply here — the thread-safe
// ledc_set_duty_and_update() alternative requires ledc_fade_func_install()
// first (a fade-service dependency this driver has no other use for) and
// errored on every call without it, discovered as a silent-LED bug (no
// crash, just ESP_ERR logged and the duty never actually changing) on real
// hardware.
static void set_duty(ledc_channel_t channel, uint8_t level) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, channel, level);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, channel);
}

// Runs forever at LED_TICK_MS resolution, picking whichever display mode
// currently has priority and rendering one frame of it. A tick-based
// approach (vs. e.g. separate blink timers per mode) keeps the priority
// order trivial to read top-to-bottom and avoids two blink patterns ever
// fighting over the same LEDC channel.
static void led_task(void *arg) {
    uint32_t tick = 0;
    for (;;) {
        tick++;

        if (atomic_load(&s_pa_emergency)) {
            // Very fast strobe — a hardware safety fault, the single most
            // urgent thing this device can report. Deliberately faster
            // than every other pattern below so it can never be mistaken
            // for a mere network issue at a glance.
            bool on = (tick % 2) < 1; // 100ms on/off at 50ms ticks
            set_duty(LED_IN_CHANNEL, on ? LED_DUTY_MAX : 0);
            set_duty(LED_OUT_CHANNEL, on ? LED_DUTY_MAX : 0);
        } else if (atomic_load(&s_ap_fallback)) {
            // Fast sync blink — network needs attention now.
            bool on = (tick % 6) < 3; // 300ms on/off at 50ms ticks
            set_duty(LED_IN_CHANNEL, on ? LED_DUTY_MAX : 0);
            set_duty(LED_OUT_CHANNEL, on ? LED_DUTY_MAX : 0);
        } else if (atomic_load(&s_wifi_connecting)) {
            // Alternating blink — distinct from AP fallback's synced blink,
            // distinct from the slow pulse below.
            bool phase = (tick % 8) < 4; // ~400ms per phase
            set_duty(LED_IN_CHANNEL, phase ? LED_DUTY_MAX : 0);
            set_duty(LED_OUT_CHANNEL, phase ? 0 : LED_DUTY_MAX);
        } else if (!cat_currently_linked()) {
            // Slow synced pulse as a base layer — audio levels (if any)
            // still ride on top as brightness, so a live audio signal
            // during a CAT dropout is still visible, not hidden.
            uint32_t phase = tick % 40; // 2s period at 50ms ticks
            uint32_t pulse = phase < 20 ? phase : (40 - phase); // 0..20..0 triangle
            uint8_t pulse_level = (uint8_t)((pulse * LED_DUTY_MAX) / 20);
            uint8_t in_level = atomic_load(&s_level_in);
            uint8_t out_level = atomic_load(&s_level_out);
            set_duty(LED_IN_CHANNEL, pulse_level > in_level ? pulse_level : in_level);
            set_duty(LED_OUT_CHANNEL, pulse_level > out_level ? pulse_level : out_level);
        } else {
            set_duty(LED_IN_CHANNEL, atomic_load(&s_level_in));
            set_duty(LED_OUT_CHANNEL, atomic_load(&s_level_out));
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

    ledc_channel_config_t in_cfg = {
        .gpio_num = LED_AUDIO_IN_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LED_IN_CHANNEL,
        .timer_sel = LED_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&in_cfg));

    ledc_channel_config_t out_cfg = {
        .gpio_num = LED_AUDIO_OUT_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LED_OUT_CHANNEL,
        .timer_sel = LED_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&out_cfg));

    // Cosmetic only (visual feedback, not radio timing) — default core
    // affinity is fine, no need to reserve core 1 for this the way the CAT
    // UART reader does.
    xTaskCreate(led_task, "led_status", 2048, NULL, tskIDLE_PRIORITY + 2, NULL);
    ESP_LOGI(TAG, "status LEDs ready (in=GPIO%d, out=GPIO%d)", LED_AUDIO_IN_PIN, LED_AUDIO_OUT_PIN);
}

void led_status_set_audio_levels(uint8_t in_level, uint8_t out_level) {
    atomic_store(&s_level_in, in_level);
    atomic_store(&s_level_out, out_level);
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
