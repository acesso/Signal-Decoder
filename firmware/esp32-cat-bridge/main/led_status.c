#include "led_status.h"

#include <stdatomic.h>

#include "driver/ledc.h"
#include "esp_log.h"
#include "sdkconfig.h"
#if CONFIG_BRIDGE_BOARD_S3
#include "led_strip.h"
#endif
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
//
// The S3 board has an RGB LED (WS2812) instead, so each pattern also gets a
// colour there: green = alive, blue = Wi-Fi connecting, amber = AP fallback,
// red = PA emergency. The A1S's single LED ignores the colour.
typedef enum { LED_GREEN, LED_BLUE, LED_AMBER, LED_RED } led_color_t;

#if CONFIG_BRIDGE_BOARD_S3
static led_strip_handle_t s_strip;
// A WS2812 at full drive is glaring on a desk; this caps each channel.
#define LED_RGB_MAX 48

static void set_led(uint8_t level, led_color_t color) {
    if (!s_strip) return;
    static const uint8_t rgb[][3] = {
        [LED_GREEN] = {0, 255, 0}, [LED_BLUE] = {0, 0, 255},
        [LED_AMBER] = {255, 110, 0}, [LED_RED] = {255, 0, 0},
    };
    uint32_t k = (uint32_t)level * LED_RGB_MAX;
    led_strip_set_pixel(s_strip, 0, rgb[color][0] * k / (255u * 255u),
                        rgb[color][1] * k / (255u * 255u), rgb[color][2] * k / (255u * 255u));
    led_strip_refresh(s_strip);
}
#else
static void set_led(uint8_t level, led_color_t color) {
    (void)color;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LED_CHANNEL, level);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LED_CHANNEL);
}
#endif

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
            set_led(0, LED_GREEN);
            vTaskDelay(pdMS_TO_TICKS(LED_TICK_MS));
            continue;
        }

        if (atomic_load(&s_pa_emergency)) {
            // Very fast strobe — a hardware safety fault, the single most
            // urgent thing this device can report. Deliberately faster
            // than every other pattern below so it can never be mistaken
            // for a mere network issue at a glance.
            bool on = (tick % 2) < 1; // 100ms on/off at 50ms ticks
            set_led(on ? LED_DUTY_MAX : 0, LED_RED);
        } else if (atomic_load(&s_ap_fallback)) {
            // Fast sync blink — network needs attention now.
            bool on = (tick % 6) < 3; // 300ms on/off at 50ms ticks
            set_led(on ? LED_DUTY_MAX : 0, LED_AMBER);
        } else if (atomic_load(&s_wifi_connecting)) {
            // Fast-ish blink — distinct from AP fallback's slower blink,
            // distinct from the slow pulse below.
            bool on = (tick % 8) < 4; // ~400ms per phase
            set_led(on ? LED_DUTY_MAX : 0, LED_BLUE);
        } else {
            // Slow pulse as a permanent base layer, "still alive" —
            // floors at PULSE_MIN_DUTY rather than 0, since a full
            // dim-to-off pulse reads as "flickering/off" at a glance
            // rather than "gently breathing."
            #define PULSE_MIN_DUTY (LED_DUTY_MAX / 6)
            uint32_t phase = tick % 40; // 2s period at 50ms ticks
            uint32_t pulse = phase < 20 ? phase : (40 - phase); // 0..20..0 triangle
            uint8_t pulse_level = (uint8_t)(PULSE_MIN_DUTY + (pulse * (LED_DUTY_MAX - PULSE_MIN_DUTY)) / 20);
            set_led(pulse_level, LED_GREEN);
        }

        vTaskDelay(pdMS_TO_TICKS(LED_TICK_MS));
    }
}

void led_status_start(void) {
#if CONFIG_BRIDGE_BOARD_S3
    led_strip_config_t strip_cfg = {
        .strip_gpio_num = LED_STATUS_PIN, .max_leds = 1,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB, .led_model = LED_MODEL_WS2812,
    };
    led_strip_rmt_config_t rmt_cfg = { .clk_src = RMT_CLK_SRC_DEFAULT, .resolution_hz = 10 * 1000 * 1000 };
    if (led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip) != ESP_OK) {
        ESP_LOGW(TAG, "RGB LED init failed — running without a status LED");
        s_strip = NULL;
    } else {
        led_strip_clear(s_strip);
    }
#else
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
#endif

    // Cosmetic only (visual feedback, not radio timing) — default core
    // affinity is fine, no need to reserve core 1 for this the way the CAT
    // UART reader does.
    xTaskCreate(led_task, "led_status", 3072, NULL, tskIDLE_PRIORITY + 2, NULL);
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
