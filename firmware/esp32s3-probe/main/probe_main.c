// Bring-up probe for the ESP32-S3-N16R8 bridge board (S3_PORT_PLAN.md, phase 1).
//
// Runs on the bare dev board, with no converter wired:
//   1. Chip, flash and PSRAM report, plus a full PSRAM write/read check.
//   2. RGB LED pin search: GPIO48 (DevKitC-1 v1.0) blinks RED, GPIO38 (v1.1) blinks GREEN.
//   3. External-clock I2S check (the audio port: PCM1808 + PCM5102 at 48 kHz):
//      I2S0 is a normal master on the 160 MHz PLL and outputs its MCLK on GPIO4.
//      I2S1 takes that same pad as its EXTERNAL clock, told it is 24.576 MHz, and
//      makes 48 kHz from it with whole-number dividers. The pulse counter then
//      measures I2S1's word clock. I2S0's MCLK is set to a different frequency on
//      purpose (20.48 MHz), so the word clock tells which clock I2S1 really used:
//        external → 20.48 MHz / 512 = 40000 Hz
//        internal → 48000 Hz
//      I2S1 also loops its data out (GPIO18) straight back in, so the same run
//      proves full-duplex 24-bit transfer on the external clock.
//   4. Slave check (the I/Q port: WM8782 as clock master): I2S0 drives bit clock,
//      word clock and data like the module would, and I2S1 receives them as a slave
//      at 48, 96 and 192 kHz.
//
//   5. Wired board (PROBE_WIRED_BOARD = 1, the default): passive checks only. Every
//      converter pin is an input here, so nothing on the S3 fights a module output:
//      the 24.576 MHz master clock on GPIO7 (through the 74LVC1G157 buffer), and the
//      WM8782's bit clock, word clock and data on GPIO4/5/6, read as an I2S slave at
//      96 kHz. It repeats every few seconds so pins can be probed while it runs.
//      Two spare pins, GPIO21 and GPIO47, also count whatever a test wire brings them.
//
// Tests 3 and 4 drive GPIO4, 15, 16, 18, 40 and 41 as outputs. On the wired board GPIO4 is
// the WM8782's bit-clock output, so they only run with PROBE_WIRED_BOARD = 0 on a bare board.
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "driver/pulse_cnt.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_random.h"
#include "sdkconfig.h"
#include "esp_heap_caps.h"
#include "esp_psram.h"
#include "esp_rom_gpio.h"
#include "esp_timer.h"
#include "hal/gpio_ll.h"
#include "soc/gpio_sig_map.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"


// 1 = the S3 sits on the wired bridge board: passive board checks only (test 5).
// 0 = bare dev board: the self-tests that drive the pads (tests 3 and 4).
#ifndef PROBE_WIRED_BOARD
#define PROBE_WIRED_BOARD 1
#endif

// Wired board pins (bridge_config.h, S3 map)
#define PIN_BRD_MCLK     GPIO_NUM_7   // 24.576 MHz from the buffer, branch A (47 Ω)
#define PIN_BRD_IQ_BCLK  GPIO_NUM_4   // WM8782 B
#define PIN_BRD_IQ_WS    GPIO_NUM_5   // WM8782 LR
#define PIN_BRD_IQ_DATA  GPIO_NUM_6   // WM8782 D
#define PIN_AUX_A        GPIO_NUM_21  // spare: test wire, e.g. the WM8782 CLK pin (through 220 Ω to 1 kΩ)
#define PIN_AUX_B        GPIO_NUM_47  // spare: test wire, e.g. the buffer's Y pin
#define PIN_AUD_DOUT     GPIO_NUM_15  // S3 -> PCM5102A DIN
#define PIN_AUD_BCLK     GPIO_NUM_16  // to PCM1808 BCK, then PCM5102A BCK
#define PIN_AUD_DIN      GPIO_NUM_17  // PCM1808 OUT -> S3
#define PIN_AUD_WS       GPIO_NUM_18  // to PCM1808 LRC, then PCM5102A LCK
#define PIN_DAC_XSMT     GPIO_NUM_8   // PCM5102A soft mute: high = play
#define AUD_RATE_HZ      48000u
#define BRD_MCLK_HZ      24576000u
#define BRD_IQ_RATE_HZ   96000u

#define PIN_EXT_MCLK   GPIO_NUM_4    // I2S0 MCLK out == I2S1 external clock in (same pad)
#define PIN_I2S0_BCLK  GPIO_NUM_40
#define PIN_I2S0_WS    GPIO_NUM_41
#define PIN_I2S1_BCLK  GPIO_NUM_15
#define PIN_I2S1_WS    GPIO_NUM_16
#define PIN_I2S1_DATA  GPIO_NUM_18   // DOUT == DIN → internal loopback

#define EXT_CLK_CLAIMED_HZ 24576000u  // what I2S1 is told the external clock is
#define I2S0_MCLK_HZ       20480000u  // what I2S0 really drives on the pad (80 kHz × 256)
// The audio port's real setting: 48 kHz from the 24.576 MHz crystal at 256 × fs. The S3's MCLK
// divider can't divide by 1, so this runs it at 2 (internal MCLK 12.288 MHz) and the bit clock at
// MCLK/4. Measured on a 20.48 MHz pad clock it must come out at 20.48 MHz / 512 = 40 kHz.
// (96 kHz this way needs the bit clock at MCLK/2, where loopback data came back shifted by one
// bit, so the I/Q port uses the WM8782 as clock master instead: see test_slave_rx.)
#define I2S1_RATE_HZ       48000u
#define I2S1_MCLK_MULTIPLE I2S_MCLK_MULTIPLE_256
#define I2S1_EXPECT_WS_HZ  (I2S0_MCLK_HZ / 512)

// ── 1. Chip / flash / PSRAM ─────────────────────────────────────────────────

static void report_chip(void)
{
    esp_chip_info_t ci;
    esp_chip_info(&ci);
    uint32_t flash = 0;
    esp_flash_get_size(NULL, &flash);
    printf("\n=== S3 probe ===\n");
    printf("chip: model %d, rev v%d.%d, %d cores, features 0x%" PRIx32 "\n",
           ci.model, ci.revision / 100, ci.revision % 100, ci.cores, ci.features);
    printf("flash: %" PRIu32 " MB\n", flash >> 20);
    printf("psram: %s, %u KB, free internal %u KB, free psram %u KB\n",
           esp_psram_is_initialized() ? "ok" : "MISSING", (unsigned)(esp_psram_get_size() >> 10),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) >> 10),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) >> 10));
}

static void test_psram(void)
{
    size_t len = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM) & ~(size_t)3;
    uint32_t *buf = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
    if (!buf) { printf("psram test: alloc of %u bytes FAILED\n", (unsigned)len); return; }
    size_t n = len / 4;
    int64_t t0 = esp_timer_get_time();
    for (size_t i = 0; i < n; i++) buf[i] = (uint32_t)i * 2654435761u;
    int64_t t1 = esp_timer_get_time();
    size_t bad = 0;
    for (size_t i = 0; i < n; i++) if (buf[i] != (uint32_t)i * 2654435761u) bad++;
    int64_t t2 = esp_timer_get_time();
    printf("psram test: %u KB, %u bad words, write %.1f MB/s, read %.1f MB/s -> %s\n",
           (unsigned)(len >> 10), (unsigned)bad, len / (double)(t1 - t0), len / (double)(t2 - t1),
           bad ? "FAIL" : "PASS");
    heap_caps_free(buf);
}

// Memory speed, for comparing PSRAM/cache settings: copies between PSRAM and internal RAM,
// random reads across PSRAM (cache-miss cost), and how long the other core stalls while flash is
// erased and written (the audio-glitch risk during OTA, NVS or CAT-log writes).
static volatile int64_t s_stall_max_us;
static volatile bool s_stall_run;

static void stall_task(void *arg)
{
    uint32_t *buf = arg;
    int64_t last = esp_timer_get_time();
    uint32_t acc = 0;
    while (s_stall_run) {
        for (int i = 0; i < 256; i++) acc += buf[(i * 67) & 16383];  // keeps touching PSRAM through the cache
        int64_t now = esp_timer_get_time();
        if (now - last > s_stall_max_us) s_stall_max_us = now - last;
        last = now;
    }
    buf[0] = acc;
    vTaskDelete(NULL);
}

static double mbps(size_t bytes, int64_t us) { return bytes / (double)us; }

static void bench_memory(void)
{
    const size_t big = 1 << 20;
    uint8_t *p1 = heap_caps_malloc(big, MALLOC_CAP_SPIRAM), *p2 = heap_caps_malloc(big, MALLOC_CAP_SPIRAM);
    uint8_t *in = heap_caps_malloc(64 * 1024, MALLOC_CAP_INTERNAL);
    if (!p1 || !p2 || !in) { printf("bench: alloc failed\n"); return; }
    memset(p1, 0x5A, big); memset(p2, 0, big);

    int64_t t = esp_timer_get_time();
    for (int k = 0; k < 8; k++) memcpy(p2, p1, big);
    double pp = mbps(8 * big, esp_timer_get_time() - t);
    t = esp_timer_get_time();
    for (int k = 0; k < 128; k++) memcpy(in, p1 + (k & 15) * 65536, 65536);
    double pi = mbps(128 * 65536, esp_timer_get_time() - t);
    t = esp_timer_get_time();
    for (int k = 0; k < 128; k++) memcpy(p2 + (k & 15) * 65536, in, 65536);
    double ip = mbps(128 * 65536, esp_timer_get_time() - t);

    uint32_t *w = (uint32_t *)p1, acc = 0, seed = esp_random();
    const int reads = 200000;
    t = esp_timer_get_time();
    for (int k = 0; k < reads; k++) { seed = seed * 1664525u + 1013904223u; acc += w[(seed >> 8) & ((big / 4) - 1)]; }
    double ns = (esp_timer_get_time() - t) * 1000.0 / reads;
    p2[0] = (uint8_t)acc;

    // Flash erase+write while the other core keeps reading PSRAM.
    const uint32_t scratch = 0x800000;  // 8 MB in: far past this probe's app, nothing lives there
    s_stall_max_us = 0; s_stall_run = true;
    xTaskCreatePinnedToCore(stall_task, "stall", 3072, p1, 5, NULL, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
    int64_t base = s_stall_max_us;
    s_stall_max_us = 0;
    t = esp_timer_get_time();
    esp_err_t e = esp_flash_erase_region(NULL, scratch, 4096);
    if (e == ESP_OK) e = esp_flash_write(NULL, in, scratch, 4096);
    int64_t fl = esp_timer_get_time() - t;
    vTaskDelay(pdMS_TO_TICKS(20));
    s_stall_run = false;
    vTaskDelay(pdMS_TO_TICKS(20));

    printf("bench: PSRAM->PSRAM %.1f MB/s, PSRAM->internal %.1f MB/s, internal->PSRAM %.1f MB/s\n", pp, pi, ip);
    printf("bench: random PSRAM read %.0f ns\n", ns);
    printf("bench: flash sector erase+write %" PRId64 " ms (%s); other core longest stall %" PRId64 " us (idle %" PRId64 " us)\n",
           fl / 1000, esp_err_to_name(e), s_stall_max_us, base);
    printf("bench: free internal %u KB, code from %s\n", (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) >> 10),
#if CONFIG_SPIRAM_FETCH_INSTRUCTIONS
           "PSRAM"
#else
           "flash"
#endif
    );
    heap_caps_free(p1); heap_caps_free(p2); heap_caps_free(in);
}

// ── 2. RGB LED pin search ───────────────────────────────────────────────────

static led_strip_handle_t new_led(int gpio)
{
    led_strip_config_t sc = { .strip_gpio_num = gpio, .max_leds = 1,
                              .led_pixel_format = LED_PIXEL_FORMAT_GRB, .led_model = LED_MODEL_WS2812 };
    led_strip_rmt_config_t rc = { .clk_src = RMT_CLK_SRC_DEFAULT, .resolution_hz = 10 * 1000 * 1000 };
    led_strip_handle_t h = NULL;
    if (led_strip_new_rmt_device(&sc, &rc, &h) != ESP_OK) return NULL;
    led_strip_clear(h);
    return h;
}

static void led_task(void *arg)
{
    led_strip_handle_t l48 = new_led(48), l38 = new_led(38);
    printf("led: GPIO48 blinks RED, GPIO38 blinks GREEN (whichever lights is the onboard RGB pin)\n");
    for (;;) {
        if (l48) { led_strip_set_pixel(l48, 0, 40, 0, 0); led_strip_refresh(l48); }
        vTaskDelay(pdMS_TO_TICKS(700));
        if (l48) led_strip_clear(l48);
        if (l38) { led_strip_set_pixel(l38, 0, 0, 40, 0); led_strip_refresh(l38); }
        vTaskDelay(pdMS_TO_TICKS(700));
        if (l38) led_strip_clear(l38);
    }
}

// ── 3. External-clock I2S ───────────────────────────────────────────────────

// Turns on a pad's input path without touching its output routing. The GPIO driver's own
// gpio_set_direction()/gpio_config() reset the output to a plain GPIO, which would cut a
// peripheral's clock off the pad.
static void pad_input_on(gpio_num_t pin)
{
    gpio_ll_input_enable(GPIO_LL_GET_HW(GPIO_PORT_0), pin);
}

// Edge rate on a pad that a peripheral is driving. The pulse counter is created with no GPIO
// (so its driver leaves the pad alone) and wired to the pad by hand; it is the only counter
// in use, so its input is unit 0 / channel 0.
static int64_t count_edges(gpio_num_t pin, int ms)
{
    pcnt_unit_config_t uc = { .low_limit = -1, .high_limit = 30000, .flags.accum_count = 1 };
    pcnt_unit_handle_t u = NULL;
    ESP_ERROR_CHECK(pcnt_new_unit(&uc, &u));
    pcnt_chan_config_t cc = { .edge_gpio_num = -1, .level_gpio_num = -1 };
    pcnt_channel_handle_t c = NULL;
    ESP_ERROR_CHECK(pcnt_new_channel(u, &cc, &c));
    pad_input_on(pin);
    esp_rom_gpio_connect_in_signal(pin, PCNT_SIG_CH0_IN0_IDX, false);
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(c, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_HOLD));
    ESP_ERROR_CHECK(pcnt_unit_add_watch_point(u, 30000));
    ESP_ERROR_CHECK(pcnt_unit_enable(u));
    ESP_ERROR_CHECK(pcnt_unit_clear_count(u));
    int64_t t0 = esp_timer_get_time();
    ESP_ERROR_CHECK(pcnt_unit_start(u));
    vTaskDelay(pdMS_TO_TICKS(ms));
    int v = 0;
    pcnt_unit_get_count(u, &v);
    int64_t t1 = esp_timer_get_time();
    pcnt_unit_stop(u);
    pcnt_unit_disable(u);
    pcnt_del_channel(c);
    pcnt_del_unit(u);
    return (int64_t)v * 1000000 / (t1 - t0);  // Hz
}

static bool test_ext_clock(void)
{
    // I2S1 first: its MCLK pin becomes an input from the external clock.
    i2s_chan_handle_t tx1, rx1;
    i2s_chan_config_t cc1 = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&cc1, &tx1, &rx1));
    i2s_std_config_t sc1 = {
        .clk_cfg = { .sample_rate_hz = I2S1_RATE_HZ, .clk_src = I2S_CLK_SRC_EXTERNAL,
                     .ext_clk_freq_hz = EXT_CLK_CLAIMED_HZ, .mclk_multiple = I2S1_MCLK_MULTIPLE },
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = PIN_EXT_MCLK, .bclk = PIN_I2S1_BCLK, .ws = PIN_I2S1_WS,
                      .dout = PIN_I2S1_DATA, .din = PIN_I2S1_DATA },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx1, &sc1));
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx1, &sc1));

    // I2S0: an ordinary PLL master whose MCLK output drives the same pad.
    i2s_chan_handle_t tx0;
    i2s_chan_config_t cc0 = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&cc0, &tx0, NULL));
    i2s_std_config_t sc0 = {
        .clk_cfg = { .sample_rate_hz = I2S0_MCLK_HZ / 256, .clk_src = I2S_CLK_SRC_DEFAULT,
                     .mclk_multiple = I2S_MCLK_MULTIPLE_256 },
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = PIN_EXT_MCLK, .bclk = PIN_I2S0_BCLK, .ws = PIN_I2S0_WS,
                      .dout = I2S_GPIO_UNUSED, .din = I2S_GPIO_UNUSED },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx0, &sc0));
    // I2S0 set the pad to output-only; turn the input path back on so I2S1 still sees it.
    pad_input_on(PIN_EXT_MCLK);
    ESP_ERROR_CHECK(i2s_channel_enable(tx0));

    // Loopback payload: 24-bit samples left-justified in 32-bit slots, as the WM8782 sends them.
    enum { FRAMES = 240 };
    static int32_t out[FRAMES * 2], in[FRAMES * 2 * 4];
    for (int i = 0; i < FRAMES * 2; i++) out[i] = (int32_t)(((uint32_t)(0x123400 + i) & 0xFFFFFF) << 8);
    size_t w = 0;
    i2s_channel_preload_data(tx1, out, sizeof(out), &w);
    // The pad must carry I2S0's clock before I2S1 starts: enabling an I2S channel waits for its
    // clock, and with no external clock that wait never ends.
    printf("ext clock: I2S0 alone: word clock %" PRId64 " Hz, bit clock %" PRId64 " Hz\n",
           count_edges(PIN_I2S0_WS, 200), count_edges(PIN_I2S0_BCLK, 20));
    int64_t mclk = count_edges(PIN_EXT_MCLK, 20);
    printf("ext clock: pad GPIO%d carries %" PRId64 " Hz (expect %u)\n", PIN_EXT_MCLK, mclk, (unsigned)I2S0_MCLK_HZ);
    if (mclk < 1000000) {
        printf("ext clock: no clock on the pad -> FAIL\n");
        return false;
    }
    printf("ext clock: enabling I2S1 TX...\n");
    ESP_ERROR_CHECK(i2s_channel_enable(tx1));
    printf("ext clock: enabling I2S1 RX...\n");
    ESP_ERROR_CHECK(i2s_channel_enable(rx1));

    int64_t ws0 = count_edges(PIN_I2S0_WS, 500);
    int64_t ws1 = count_edges(PIN_I2S1_WS, 500);
    int64_t bck1 = count_edges(PIN_I2S1_BCLK, 50);
    printf("ext clock: I2S0 word clock %" PRId64 " Hz (expect %u)\n", ws0, (unsigned)(I2S0_MCLK_HZ / 256));
    printf("ext clock: I2S1 word clock %" PRId64 " Hz, bit clock %" PRId64 " Hz\n", ws1, bck1);
    bool ext = ws1 > I2S1_EXPECT_WS_HZ * 99 / 100 && ws1 < I2S1_EXPECT_WS_HZ * 101 / 100;
    bool internal = ws1 > I2S1_RATE_HZ * 99 / 100 && ws1 < I2S1_RATE_HZ * 101 / 100;
    printf("ext clock: I2S1 follows the %s clock (expect %u Hz) -> %s\n",
           ext ? "EXTERNAL" : internal ? "INTERNAL" : "UNKNOWN", (unsigned)I2S1_EXPECT_WS_HZ, ext ? "PASS" : "FAIL");

    // Keep TX fed and look for the payload in what came back.
    size_t r = 0;
    bool found = false;
    for (int round = 0; round < 20 && !found; round++) {
        i2s_channel_write(tx1, out, sizeof(out), &w, pdMS_TO_TICKS(100));
        r = 0;
        i2s_channel_read(rx1, in, sizeof(in), &r, pdMS_TO_TICKS(100));  // a timeout still returns what arrived
        // The stream may start anywhere in the pattern: accept any 8 consecutive samples that match
        // the pattern at the matching position.
        int n = r / 4;
        for (int s = 0; s + 8 < n && !found; s++) {
            uint32_t k0 = ((uint32_t)in[s] >> 8) - 0x123400u;
            if (k0 + 8 > FRAMES * 2) continue;
            bool all = true;
            for (int k = 0; k < 8; k++) if (in[s + k] != out[k0 + k]) { all = false; break; }
            found = all;
        }
    }
    if (!found && r >= 64) {
        printf("loopback: sent   %08" PRIx32 " %08" PRIx32 " %08" PRIx32 " %08" PRIx32 "\n", out[0], out[1], out[2], out[3]);
        for (int k = 0; k < 16; k += 4)
            printf("loopback: got[%2d] %08" PRIx32 " %08" PRIx32 " %08" PRIx32 " %08" PRIx32 "\n", k, in[k], in[k + 1], in[k + 2], in[k + 3]);
    }
    printf("loopback: 24-bit data %s -> %s\n", found ? "came back intact" : "NOT seen", found ? "PASS" : "FAIL");

    i2s_channel_disable(tx1); i2s_channel_disable(rx1); i2s_channel_disable(tx0);
    i2s_del_channel(tx1); i2s_del_channel(rx1); i2s_del_channel(tx0);
    return ext && found;
}

// ── 4. I2S1 as slave to an outside clock master (the WM8782-as-master option) ───
//
// I2S0 plays the WM8782: a PLL master driving bit clock, word clock and 24-bit data out.
// I2S1 is a slave receiving them on the same pads, as it would from the module.

static bool test_slave_rx(uint32_t rate)
{
    i2s_chan_handle_t rx1, tx0;
    i2s_chan_config_t cc1 = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_SLAVE);
    ESP_ERROR_CHECK(i2s_new_channel(&cc1, NULL, &rx1));
    i2s_std_config_t sc1 = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(rate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = I2S_GPIO_UNUSED, .bclk = PIN_I2S0_BCLK, .ws = PIN_I2S0_WS,
                      .dout = I2S_GPIO_UNUSED, .din = PIN_I2S1_DATA },
    };
    esp_err_t e = i2s_channel_init_std_mode(rx1, &sc1);
    if (e != ESP_OK) {
        printf("slave %6" PRIu32 " Hz: I2S1 slave init refused (%s) -> FAIL\n", rate, esp_err_to_name(e));
        i2s_del_channel(rx1);
        return false;
    }

    i2s_chan_config_t cc0 = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&cc0, &tx0, NULL));
    i2s_std_config_t sc0 = {
        .clk_cfg = { .sample_rate_hz = rate, .clk_src = I2S_CLK_SRC_DEFAULT, .mclk_multiple = I2S_MCLK_MULTIPLE_128 },
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = I2S_GPIO_UNUSED, .bclk = PIN_I2S0_BCLK, .ws = PIN_I2S0_WS,
                      .dout = PIN_I2S1_DATA, .din = I2S_GPIO_UNUSED },
    };
    e = i2s_channel_init_std_mode(tx0, &sc0);
    if (e != ESP_OK) {
        printf("slave %6" PRIu32 " Hz: I2S0 master init refused (%s) -> FAIL\n", rate, esp_err_to_name(e));
        i2s_del_channel(tx0); i2s_del_channel(rx1);
        return false;
    }
    // I2S0 made the pads output-only; give I2S1 its inputs back.
    pad_input_on(PIN_I2S0_BCLK); pad_input_on(PIN_I2S0_WS); pad_input_on(PIN_I2S1_DATA);

    enum { FRAMES = 240 };
    static int32_t out[FRAMES * 2], in[FRAMES * 2 * 4];
    for (int i = 0; i < FRAMES * 2; i++) out[i] = (int32_t)(((uint32_t)(0x5A0000 + i * 3) & 0xFFFFFF) << 8);
    size_t w = 0, r = 0;
    i2s_channel_preload_data(tx0, out, sizeof(out), &w);
    ESP_ERROR_CHECK(i2s_channel_enable(rx1));
    ESP_ERROR_CHECK(i2s_channel_enable(tx0));
    int64_t ws = count_edges(PIN_I2S0_WS, 200);

    bool found = false;
    int shift = 99;
    for (int round = 0; round < 20 && !found; round++) {
        i2s_channel_write(tx0, out, sizeof(out), &w, pdMS_TO_TICKS(100));
        if (i2s_channel_read(rx1, in, sizeof(in), &r, pdMS_TO_TICKS(100)) != ESP_OK) continue;
        int n = r / 4;
        for (int s = 0; s + 8 < n && !found; s++) {
            for (int sh = -2; sh <= 2 && !found; sh++) {
                bool all = true;
                for (int k = 0; k < 8 && all; k++) {
                    uint32_t want = (uint32_t)out[k];
                    want = sh >= 0 ? want << sh : want >> -sh;
                    all = ((uint32_t)in[s + k] & 0xFFFFFF00u) == (want & 0xFFFFFF00u);
                }
                if (all) { found = true; shift = sh; }
            }
        }
    }
    bool ok = found && shift == 0;
    printf("slave %6" PRIu32 " Hz: word clock %" PRId64 " Hz, data %s -> %s\n", rate, ws,
           !found ? "NOT seen" : shift == 0 ? "intact" : shift > 0 ? "shifted left" : "shifted right",
           ok ? "PASS" : "FAIL");
    i2s_channel_disable(tx0); i2s_channel_disable(rx1);
    i2s_del_channel(tx0); i2s_del_channel(rx1);
    return ok;
}

// ── 5. Wired board: passive clock and I/Q checks ────────────────────────────

static void brd_input(gpio_num_t pin)
{
    gpio_reset_pin(pin);
    gpio_set_direction(pin, GPIO_MODE_INPUT);
    gpio_set_pull_mode(pin, GPIO_FLOATING);  // every one of these lines is driven by a module
}

static bool near(int64_t hz, uint32_t want, int ppm)
{
    int64_t d = hz - (int64_t)want;
    if (d < 0) d = -d;
    return d * 1000000 <= (int64_t)want * ppm;
}

// What a wrong master clock most likely means on the WM8782 module.
static const char *mclk_hint(int64_t hz)
{
    if (hz < 1000) return "no clock at GPIO7";
    if (near(hz, 22579200, 2000)) return "22.5792 MHz: J1 is on the 22 crystal, move it to 24";
    if (near(hz, BRD_MCLK_HZ / 2, 2000)) return "half rate: J2 (half clock) is closed, open it";
    return "unexpected rate";
}

static void report_iq_samples(void)
{
    i2s_chan_handle_t rx;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    if (i2s_new_channel(&cc, NULL, &rx) != ESP_OK) { printf("iq: no I2S channel\n"); return; }
    i2s_std_config_t sc = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(BRD_IQ_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = I2S_GPIO_UNUSED, .bclk = PIN_BRD_IQ_BCLK, .ws = PIN_BRD_IQ_WS,
                      .dout = I2S_GPIO_UNUSED, .din = PIN_BRD_IQ_DATA },
    };
    if (i2s_channel_init_std_mode(rx, &sc) != ESP_OK) { printf("iq: slave init refused\n"); i2s_del_channel(rx); return; }
    i2s_channel_enable(rx);
    enum { FRAMES = 4800 };                           // 50 ms at 96 kHz
    static int32_t buf[FRAMES * 2];
    size_t got = 0;
    i2s_channel_read(rx, buf, sizeof(buf), &got, pdMS_TO_TICKS(30));  // drop the start-up block
    got = 0;
    esp_err_t e = i2s_channel_read(rx, buf, sizeof(buf), &got, pdMS_TO_TICKS(200));
    i2s_channel_disable(rx);
    i2s_del_channel(rx);
    int n = (int)(got / 8);
    if (e != ESP_OK || n < 100) { printf("iq: no samples (%s, %d frames): the WM8782 isn't clocking the port\n", esp_err_to_name(e), n); return; }
    for (int ch = 0; ch < 2; ch++) {
        double sum = 0, sq = 0;
        int32_t pk = 0, pk_late = 0;
        int pk_at = 0;
        for (int i = 0; i < n; i++) {
            int32_t v = buf[i * 2 + ch] >> 8;          // 24-bit sample, left-justified in the slot
            int32_t a = v < 0 ? -v : v;
            sum += v;
            if (a > pk) { pk = a; pk_at = i; }
            if (i >= 64 && a > pk_late) pk_late = a;   // the same, ignoring the first 64 frames
        }
        double mean = sum / n;
        for (int i = 0; i < n; i++) { double d = (buf[i * 2 + ch] >> 8) - mean; sq += d * d; }
        double rms = sqrt(sq / n);
        const double fs = 8388608.0;                   // 2^23
        // The DAC tone and this ADC share one oscillator, so the tone is exactly 96 samples per cycle at 96 kHz.
        // Fit it (frames 64 on, whole cycles), subtract it, and what is left is noise plus distortion.
        int n0 = 64, nfit = ((n - n0) / 96) * 96;
        double c = 0, sn = 0, m2 = 0;
        for (int i = 0; i < nfit; i++) m2 += buf[(n0 + i) * 2 + ch] >> 8;
        m2 /= nfit;
        for (int i = 0; i < nfit; i++) {
            double v = (buf[(n0 + i) * 2 + ch] >> 8) - m2, ph = 2 * M_PI * i / 96.0;
            c += v * cos(ph); sn += v * sin(ph);
        }
        c *= 2.0 / nfit; sn *= 2.0 / nfit;
        double res = 0;
        for (int i = 0; i < nfit; i++) {
            double ph = 2 * M_PI * i / 96.0, d = (buf[(n0 + i) * 2 + ch] >> 8) - m2 - c * cos(ph) - sn * sin(ph);
            res += d * d;
        }
        res = sqrt(res / nfit);
        double tone = sqrt((c * c + sn * sn) / 2);
        if (nfit > 0 && tone > 1000)
            printf("iq: %s  tone %6.1f dBFS, residual (noise + distortion, 0-48 kHz) %6.1f dBFS -> THD+N %6.1f dB\n", ch ? "R (Q)" : "L (I)",
                   20 * log10(tone / fs), 20 * log10(res / fs), 20 * log10(res / tone));
        printf("iq: %s  DC %+8.0f  RMS %7.1f counts (%6.1f dBFS)  peak %6.1f dBFS at frame %4d of %d, after frame 64: %6.1f dBFS\n",
               ch ? "R (Q)" : "L (I)", mean, rms, rms > 0 ? 20 * log10(rms / fs) : -200.0, pk > 0 ? 20 * log10(pk / fs) : -200.0,
               pk_at, n, pk_late > 0 ? 20 * log10(pk_late / fs) : -200.0);
    }
}

// Audio port (I2S1): master at 48 kHz from the board's 24.576 MHz on GPIO7. The PCM1808 is a slave
// (SCKI = 512 fs from the same oscillator); the PCM5102A locks its PLL to the bit clock. The task
// plays a 1 kHz tone (L -20 dBFS, R 12 dB lower) to the DAC and measures what the ADC delivers, once a second.
static struct {
    volatile bool running;
    volatile int64_t frames;
    volatile double dc[2], rms[2], pk[2];
    volatile int stuck[2];
} aud;

static void audio_task(void *arg)
{
    i2s_chan_handle_t tx, rx;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    if (i2s_new_channel(&cc, &tx, &rx) != ESP_OK) { printf("audio: no I2S1 channel\n"); vTaskDelete(NULL); }
    i2s_std_config_t sc = {
        .clk_cfg = { .sample_rate_hz = AUD_RATE_HZ, .clk_src = I2S_CLK_SRC_EXTERNAL,
                     .ext_clk_freq_hz = BRD_MCLK_HZ, .mclk_multiple = I2S_MCLK_MULTIPLE_256 },
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = PIN_BRD_MCLK, .bclk = PIN_AUD_BCLK, .ws = PIN_AUD_WS,
                      .dout = PIN_AUD_DOUT, .din = PIN_AUD_DIN },
    };
    if (i2s_channel_init_std_mode(tx, &sc) != ESP_OK || i2s_channel_init_std_mode(rx, &sc) != ESP_OK) {
        printf("audio: I2S1 init refused\n"); vTaskDelete(NULL);
    }
    enum { BLK = 480, WIN = 48000 };                  // 10 ms blocks, 1 s windows
    static int32_t out[BLK * 2], in[BLK * 2];
    for (int i = 0; i < BLK; i++) {                   // 1 kHz, exactly 10 cycles per block
        int32_t v = (int32_t)(sinf(2.0f * (float)M_PI * i / 48.0f) * 0.1f * 2147483647.0f);
        out[i * 2] = v; out[i * 2 + 1] = v / 4;      // R is 12 dB quieter, so the channel mapping shows
    }
    size_t w = 0;
    i2s_channel_preload_data(tx, out, sizeof(out), &w);
    i2s_channel_enable(tx);
    i2s_channel_enable(rx);
    gpio_set_level(PIN_DAC_XSMT, 1);                  // unmute once the clocks run
    aud.running = true;
    double sum[2] = {0}, sq[2] = {0}, pk[2] = {0};
    int32_t first[2] = {0}; bool same[2] = {true, true};
    int n = 0;
    for (;;) {
        i2s_channel_write(tx, out, sizeof(out), &w, portMAX_DELAY);
        size_t r = 0;
        if (i2s_channel_read(rx, in, sizeof(in), &r, pdMS_TO_TICKS(100)) != ESP_OK) continue;
        int fr = (int)(r / 8);
        for (int i = 0; i < fr; i++) for (int ch = 0; ch < 2; ch++) {
            int32_t v = in[i * 2 + ch] >> 8;           // 24-bit sample
            if (n == 0 && i == 0) first[ch] = v;
            if (v != first[ch]) same[ch] = false;
            sum[ch] += v; sq[ch] += (double)v * v;
            double a = v < 0 ? -(double)v : v;
            if (a > pk[ch]) pk[ch] = a;
        }
        n += fr;
        aud.frames += fr;
        if (n >= WIN) {
            for (int ch = 0; ch < 2; ch++) {
                double m = sum[ch] / n;
                aud.dc[ch] = m;
                aud.rms[ch] = sqrt(sq[ch] / n - m * m);
                aud.pk[ch] = pk[ch];
                aud.stuck[ch] = same[ch];
                sum[ch] = sq[ch] = pk[ch] = 0; same[ch] = true;
            }
            n = 0;
        }
    }
}

static void report_audio(void)
{
    if (!aud.running) { printf("audio: waiting for the I2S1 clock\n"); return; }
    int64_t bck = count_edges(PIN_AUD_BCLK, 20), ws = count_edges(PIN_AUD_WS, 200);
    printf("audio BCK GPIO16: %8" PRId64 " Hz (expect %u)   LRC GPIO18: %6" PRId64 " Hz (expect %u)   frames read %" PRId64 "\n",
           bck, (unsigned)(AUD_RATE_HZ * 64), ws, (unsigned)AUD_RATE_HZ, aud.frames);
    const double fs = 8388608.0;
    for (int ch = 0; ch < 2; ch++) {
        double rms = aud.rms[ch], pk = aud.pk[ch];
        printf("pcm1808 %s: DC %+9.0f  RMS %9.1f (%6.1f dBFS)  peak %6.1f dBFS%s\n", ch ? "R (loop)" : "L (RX)  ",
               aud.dc[ch], rms, rms > 0 ? 20 * log10(rms / fs) : -200.0, pk > 0 ? 20 * log10(pk / fs) : -200.0,
               aud.stuck[ch] ? "  <- STUCK: one value for 1 s" : "");
    }
    printf("pcm5102a: playing 1 kHz on the TX jack: L at -20 dBFS, R at -32 dBFS (XSMT high)\n");
}

static void test_wired_board(void)
{
    brd_input(PIN_BRD_MCLK);
    brd_input(PIN_BRD_IQ_BCLK);
    brd_input(PIN_BRD_IQ_WS);
    brd_input(PIN_BRD_IQ_DATA);
    brd_input(PIN_AUX_A);
    brd_input(PIN_AUX_B);
    gpio_reset_pin(PIN_DAC_XSMT);
    gpio_set_direction(PIN_DAC_XSMT, GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_DAC_XSMT, 0);                  // muted until the audio clocks run
    bool audio_started = false;
    for (int pass = 1;; pass++) {
        int lvl_hi = 0;
        for (int i = 0; i < 1000; i++) lvl_hi += gpio_get_level(PIN_BRD_MCLK);  // ~1 ms of samples
        int64_t mclk = count_edges(PIN_BRD_MCLK, 50);
        int64_t bclk = count_edges(PIN_BRD_IQ_BCLK, 50);
        int64_t ws = count_edges(PIN_BRD_IQ_WS, 200);
        int64_t data = count_edges(PIN_BRD_IQ_DATA, 100);
        bool m_ok = near(mclk, BRD_MCLK_HZ, 1000);
        bool b_ok = near(bclk, BRD_IQ_RATE_HZ * 64, 1000);
        bool w_ok = near(ws, BRD_IQ_RATE_HZ, 1000);
        printf("\n--- board check %d ---\n", pass);
        printf("mclk GPIO7 : %10" PRId64 " Hz (expect %u) -> %s%s%s\n", mclk, (unsigned)BRD_MCLK_HZ,
               m_ok ? "PASS" : "FAIL", m_ok ? "" : ": ", m_ok ? "" : mclk_hint(mclk));
        printf("mclk GPIO7 level: %s (%d of 1000 samples high)\n", lvl_hi > 990 ? "steady HIGH" : lvl_hi < 10 ? "steady LOW" : "changing", lvl_hi);
        printf("iq B GPIO4 : %10" PRId64 " Hz (expect %u, 64 x fs) -> %s\n", bclk, (unsigned)(BRD_IQ_RATE_HZ * 64), b_ok ? "PASS" : "FAIL");
        printf("iq LR GPIO5: %10" PRId64 " Hz (expect %u) -> %s%s\n", ws, (unsigned)BRD_IQ_RATE_HZ, w_ok ? "PASS" : "FAIL",
               w_ok ? "" : near(ws, 88200, 2000) ? ": 88.2 kHz, J1 is on the 22.5792 MHz crystal, move it to 24" :
               near(ws, 48000, 2000) || near(ws, 44100, 2000) ? ": S1 lever 3 is on 48 kHz" :
               near(ws, 192000, 2000) || near(ws, 176400, 2000) ? ": S1 lever 3 is on 192 kHz" : "");
        printf("iq D GPIO6 : %10" PRId64 " edges/s -> %s\n", data, data > 0 ? "toggling (PASS)" : "stuck (FAIL)");
        int64_t ax = count_edges(PIN_AUX_A, 50), bx = count_edges(PIN_AUX_B, 50);
        printf("aux GPIO21 : %10" PRId64 " Hz   aux GPIO47 : %10" PRId64 " Hz   (test wires; 24576000 = the master clock)\n", ax, bx);
        if (b_ok && w_ok) report_iq_samples();
        if (m_ok && !audio_started) { audio_started = true; xTaskCreatePinnedToCore(audio_task, "audio", 6144, NULL, 5, NULL, 1); }
        if (audio_started) report_audio();
        bool wm_runs = bclk > 1000000, clk_seen = mclk > 1000000;
        if (clk_seen && !wm_runs) printf("hint: the clock reaches GPIO7 but the WM8782 isn't mastering: check S1 lever 1 (+) and J6 = M\n");
        if (wm_runs && !clk_seen) printf("hint: the WM8782 runs, so the fault is between its CLK pin and GPIO7. With a DC meter a running\n"
                                         "      clock reads about half its supply (~1.65 V): check WM8782 CLK, buffer pin 1 (I1), pin 4 (Y),\n"
                                         "      then GPIO7. Also pin 5 (VCC) = 3.3 V, pin 6 (S) = 3.3 V, pin 3 (I0) = 0 V\n");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(1500));  // let the host reopen the USB console after reset
    report_chip();
    test_psram();
    bench_memory();
    xTaskCreate(led_task, "led", 4096, NULL, 2, NULL);
#if PROBE_WIRED_BOARD
    printf("=== wired board: passive checks only (PROBE_WIRED_BOARD = 1) ===\n");
    test_wired_board();  // never returns
#endif
    bool ok = test_ext_clock();
    printf("=== external-clock I2S %s ===\n", ok ? "PASS" : "FAIL");
    bool s48 = test_slave_rx(48000), s96 = test_slave_rx(96000), s192 = test_slave_rx(192000);
    printf("=== probe done: slave RX 48k %s, 96k %s, 192k %s ===\n",
           s48 ? "PASS" : "FAIL", s96 ? "PASS" : "FAIL", s192 ? "PASS" : "FAIL");

    // Board LED check: GPIO43 is UART0 TX, wired to the USB-UART chip on the second USB port.
    // If a green LED now blinks once a second, it is that line's TX light.
    printf("led: toggling GPIO43 (UART0 TX) once a second, forever\n");
    gpio_reset_pin(GPIO_NUM_43);
    gpio_set_direction(GPIO_NUM_43, GPIO_MODE_OUTPUT);
    for (int i = 0;; i++) { gpio_set_level(GPIO_NUM_43, i & 1); vTaskDelay(pdMS_TO_TICKS(500)); }
}
