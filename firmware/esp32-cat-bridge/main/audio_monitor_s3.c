// audio_monitor.h for the ESP32-S3 board (CONFIG_BRIDGE_BOARD_S3).
//
// Three converters, two I2S ports (S3_PORT_PLAN.md "Clocking"):
//   I2S0  slave to the WM8782 (I/Q ADC), 96 kHz, 24-bit in 32-bit slots.
//   I2S1  master at 48 kHz from the board's 24.576 MHz oscillator on GPIO7
//         (I2S_CLK_SRC_EXTERNAL), full duplex: PCM1808 (audio ADC) in, PCM5102A
//         (TX DAC) out.
//
// Both ADCs run all the time; a source switch only picks which one feeds which
// stream, so the two can be compared on the same signal:
//   I/Q streams (iq_dsp.h)  WM8782 (default) or PCM1808 — /iq-config "source"
//   /audio (mono, 48 kHz)   PCM1808 (default) or WM8782 decimated 96 -> 48 kHz
//                           — POST /audio-source {"source":"pcm1808"|"wm8782"}
// Which channel of the chosen ADC /audio carries is the existing rx_slot
// setting (left = RX audio, right = audio loop on the PCM1808).
//
// TX: the browser's 16 kHz mic stream, the TX slot pool and the test tone all
// go through audio_monitor_report_out_samples(): upsampled x3 to 48 kHz and
// queued for the DAC task, which writes silence whenever the queue is empty —
// so playback never needs a trailing silence flush (the A1S's ES8388 path did).
//
// The ES8388-only controls (input mux, mic PGA, ALC, noise gate, HPF, speaker
// amp/volume) have no equivalent on this board and report "not applied".
#include "audio_monitor.h"

#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "audio_sniff.h"
#include "audio_ws.h"
#include "bridge_config.h"
#include "bridge_settings.h"
#include "iq_dsp.h"
#include "ws_server.h"

static const char *TAG = "audio_s3";

#define AUDIO_RATE_HZ        48000
#define MIC_SEND_RATE_HZ     TX_BUFFER_SAMPLE_RATE_HZ        // 16 kHz, the /audio mic-send and TX-slot wire rate
#define AUDIO_WINDOW_SAMPLES (AUDIO_RATE_HZ * 50 / 1000)    // one /audio frame: 50 ms
#define WM_BLOCK_FRAMES      480                             // 5 ms at 96 kHz, 2.5 ms at 192 kHz
#define PORT_BLOCK_FRAMES    240                             // 5 ms at 48 kHz
#define DMA_DESC_NUM         4
#define DMA_FRAME_NUM        240
#define TX_QUEUE_SAMPLES     (AUDIO_RATE_HZ / 10)            // 100 ms of 48 kHz mono ahead of the DAC
#define TX_CHUNK_SAMPLES     (MIC_SEND_RATE_HZ * 50 / 1000)  // 800 = 50 ms at 16 kHz
#define TASK_CORE            1
#define TASK_PRIO            6

static const char *const AUDIO_SRC_NAMES[] = { "pcm1808", "wm8782" };

static _Atomic int s_audio_src = AUDIO_SRC_PCM1808;
static _Atomic bool s_rx_right = false;
static _Atomic int s_tx_slot = AUDIO_TX_SLOT_BOTH;
static bool s_started;

static i2s_chan_handle_t s_wm_rx, s_port_rx, s_port_tx;
static StreamBufferHandle_t s_tx_q;  // int16 mono 48 kHz, filled by report_out_samples()

static _Atomic int64_t s_max_loop_us, s_max_read_us, s_max_bcast_us;
static _Atomic uint32_t s_loop_count;

// Peak meters (audio_monitor_take_peaks): each writer raises its own channel,
// the display reads and clears. A raise racing the clear only loses one block.
static _Atomic uint32_t s_peak[AUDIO_PEAK_COUNT];  // |sample| in 16-bit units
static inline void peak_raise(int ch, uint32_t v) { if (v > atomic_load(&s_peak[ch])) atomic_store(&s_peak[ch], v); }
static inline uint32_t abs16(int32_t v) { return (uint32_t)(v < 0 ? -(v >> 16) : v >> 16); }

void audio_monitor_take_peaks(float out[AUDIO_PEAK_COUNT]) {
    for (int c = 0; c < AUDIO_PEAK_COUNT; c++) out[c] = atomic_exchange(&s_peak[c], 0) / 32768.0f;
}

// ── /audio framing ─────────────────────────────────────────────────────────

static int16_t s_win[AUDIO_WINDOW_SAMPLES];
static int s_win_fill;

// Collects mono 48 kHz samples into 50 ms /audio frames. Called from exactly
// one task at a time (whichever ADC is the audio source).
static void audio_out_push(const int16_t *x, int n) {
    for (int i = 0; i < n; i++) {
        s_win[s_win_fill++] = x[i];
        if (s_win_fill == AUDIO_WINDOW_SAMPLES) {
            int64_t t0 = esp_timer_get_time();
            audio_ws_send_to_clients(s_win, AUDIO_WINDOW_SAMPLES);
            int64_t d = esp_timer_get_time() - t0;
            if (d > atomic_load(&s_max_bcast_us)) atomic_store(&s_max_bcast_us, d);
            s_win_fill = 0;
        }
    }
}

static inline int16_t s24_to_s16(int32_t v) { return (int16_t)(v >> 16); }

// ── WM8782 (I2S0, slave) ───────────────────────────────────────────────────
// The module is the clock master, so its DIP switch sets the rate (48, 96 or
// 192 kHz). The reader measures it from the frames arriving and the I/Q
// processing and /audio follow.

#define WM_DMA_DESC_NUM 8    // 8 x 240 frames: 20 ms of slack at 96 kHz, 10 ms at 192 kHz

// Low-pass for /audio from the WM8782, decimating to 48 kHz: windowed sinc,
// cutoff 21 kHz, 47 taps per factor of two; only the kept outputs are computed.
#define AUDIO_LP_TAPS_MAX 95
static float s_hb[AUDIO_LP_TAPS_MAX];
static float s_hb_hist[AUDIO_LP_TAPS_MAX];
static int s_hb_taps = 1, s_hb_decim = 1, s_hb_pos, s_hb_phase;
static int s_wm_rate = IQ_DSP_FS_HZ;

static void hb_design(int rate) {
    s_hb_decim = rate / AUDIO_RATE_HZ;
    s_hb_taps = s_hb_decim <= 1 ? 1 : s_hb_decim == 2 ? 47 : 95;
    float fc = 21000.0f / rate, sum = 0;
    for (int n = 0; n < s_hb_taps; n++) {
        float m = n - (s_hb_taps - 1) / 2.0f;
        float sinc = m == 0 ? 2 * fc : sinf(2 * (float)M_PI * fc * m) / ((float)M_PI * m);
        float w = s_hb_taps == 1 ? 1 : 0.42f - 0.5f * cosf(2 * (float)M_PI * n / (s_hb_taps - 1)) + 0.08f * cosf(4 * (float)M_PI * n / (s_hb_taps - 1));
        s_hb[n] = sinc * w;
        sum += s_hb[n];
    }
    for (int n = 0; n < s_hb_taps; n++) s_hb[n] /= sum;
    memset(s_hb_hist, 0, sizeof(s_hb_hist));
    s_hb_pos = s_hb_phase = 0;
}

// The nearest supported rate to a measurement, or 0 when it matches none.
static int snap_rate(float measured) {
    static const int rates[] = { 48000, 96000, 192000 };
    for (int i = 0; i < 3; i++) if (fabsf(measured - rates[i]) < rates[i] * 0.03f) return rates[i];
    return 0;
}

// Applies a new WM8782 rate: the I2S clock (the driver sizes its timing from
// it even as a slave), the /audio low-pass, and the I/Q processing.
static void wm_apply_rate(int rate) {
    i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG(rate);
    i2s_channel_disable(s_wm_rx);
    i2s_channel_reconfig_std_clock(s_wm_rx, &clk);
    i2s_channel_enable(s_wm_rx);
    s_wm_rate = rate;
    hb_design(rate);
    iq_dsp_set_wm8782_rate(rate);
    ESP_LOGI(TAG, "WM8782 rate: %d Hz", rate);
}

static void wm_task(void *arg) {
    int32_t *buf = heap_caps_malloc(WM_BLOCK_FRAMES * 2 * sizeof(int32_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    int16_t *mono = heap_caps_malloc(WM_BLOCK_FRAMES * sizeof(int16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf || !mono) { ESP_LOGE(TAG, "WM8782 task: out of memory"); vTaskDelete(NULL); }
    hb_design(s_wm_rate);
    int64_t last = 0, rate_t0 = 0;
    uint32_t rate_frames = 0;
    int rate_pending = 0;
    for (;;) {
        int64_t t0 = esp_timer_get_time();
        size_t got = 0;
        if (i2s_channel_read(s_wm_rx, buf, WM_BLOCK_FRAMES * 2 * sizeof(int32_t), &got, pdMS_TO_TICKS(100)) != ESP_OK || got == 0) {
            rate_t0 = 0;  // a stall would read as a low rate
            continue;
        }
        int frames = (int)(got / (2 * sizeof(int32_t)));

        // Rate: frames per second over ~1 s windows; a change applies once two
        // windows in a row agree.
        int64_t now = esp_timer_get_time();
        if (!rate_t0) { rate_t0 = now; rate_frames = 0; }
        else {
            rate_frames += frames;
            if (now - rate_t0 >= 1000000) {
                int r = snap_rate(rate_frames * 1e6f / (float)(now - rate_t0));
                if (r && r != s_wm_rate) {
                    if (r == rate_pending) { wm_apply_rate(r); rate_pending = 0; rate_t0 = 0; continue; }
                    rate_pending = r;
                } else rate_pending = 0;
                rate_t0 = now; rate_frames = 0;
            }
        }

        iq_dsp_feed(IQ_DSP_SRC_WM8782, buf, frames);
        uint32_t pi = 0, pq = 0;
        for (int i = 0; i < frames; i++) {
            uint32_t a = abs16(buf[2 * i]), b = abs16(buf[2 * i + 1]);
            if (a > pi) pi = a;
            if (b > pq) pq = b;
        }
        peak_raise(AUDIO_PEAK_WM_I, pi);
        peak_raise(AUDIO_PEAK_WM_Q, pq);
        if (atomic_load(&s_audio_src) != AUDIO_SRC_WM8782) continue;
        int ch = atomic_load(&s_rx_right) ? 1 : 0, out = 0;
        for (int i = 0; i < frames; i++) {
            s_hb_hist[s_hb_pos] = (float)buf[2 * i + ch] * (1.0f / 2147483648.0f);
            s_hb_pos = (s_hb_pos + 1) % s_hb_taps;
            if (++s_hb_phase < s_hb_decim) continue;
            s_hb_phase = 0;
            float acc = 0;
            int p = s_hb_pos;
            for (int k = 0; k < s_hb_taps; k++) { acc += s_hb[k] * s_hb_hist[p]; p = p + 1 == s_hb_taps ? 0 : p + 1; }
            float v = acc * 32767.0f;
            mono[out++] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        }
        audio_out_push(mono, out);
        int64_t t1 = esp_timer_get_time();
        if (t1 - t0 > atomic_load(&s_max_read_us)) atomic_store(&s_max_read_us, t1 - t0);
        if (last && t0 - last > atomic_load(&s_max_loop_us)) atomic_store(&s_max_loop_us, t0 - last);
        last = t0;
        atomic_fetch_add(&s_loop_count, 1);
    }
}

// ── PCM1808 in (I2S1 RX) ───────────────────────────────────────────────────

static void adc_task(void *arg) {
    int32_t *buf = heap_caps_malloc(PORT_BLOCK_FRAMES * 2 * sizeof(int32_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    int16_t *mono = heap_caps_malloc(PORT_BLOCK_FRAMES * sizeof(int16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf || !mono) { ESP_LOGE(TAG, "PCM1808 task: out of memory"); vTaskDelete(NULL); }
    for (;;) {
        size_t got = 0;
        if (i2s_channel_read(s_port_rx, buf, PORT_BLOCK_FRAMES * 2 * sizeof(int32_t), &got, pdMS_TO_TICKS(100)) != ESP_OK || got == 0) continue;
        int frames = (int)(got / (2 * sizeof(int32_t)));
        iq_dsp_feed(IQ_DSP_SRC_PCM1808, buf, frames);
        uint32_t pl = 0, pr = 0;
        for (int i = 0; i < frames; i++) {
            uint32_t a = abs16(buf[2 * i]), b = abs16(buf[2 * i + 1]);
            if (a > pl) pl = a;
            if (b > pr) pr = b;
        }
        peak_raise(AUDIO_PEAK_ADC_L, pl);
        peak_raise(AUDIO_PEAK_ADC_R, pr);
        if (atomic_load(&s_audio_src) != AUDIO_SRC_PCM1808) continue;
        int ch = atomic_load(&s_rx_right) ? 1 : 0;
        for (int i = 0; i < frames; i++) mono[i] = s24_to_s16(buf[2 * i + ch]);
        audio_out_push(mono, frames);
    }
}

// ── PCM5102A out (I2S1 TX) ─────────────────────────────────────────────────

// Writes whatever the queue holds, silence when it's empty; the blocking
// i2s_channel_write() paces it to the DAC's real rate.
static void dac_task(void *arg) {
    int16_t *mono = heap_caps_malloc(PORT_BLOCK_FRAMES * sizeof(int16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    int32_t *out = heap_caps_malloc(PORT_BLOCK_FRAMES * 2 * sizeof(int32_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!mono || !out) { ESP_LOGE(TAG, "PCM5102A task: out of memory"); vTaskDelete(NULL); }
    for (;;) {
        size_t got = xStreamBufferReceive(s_tx_q, mono, PORT_BLOCK_FRAMES * sizeof(int16_t), 0) / sizeof(int16_t);
        if (got < PORT_BLOCK_FRAMES) memset(mono + got, 0, (PORT_BLOCK_FRAMES - got) * sizeof(int16_t));
        int slot = atomic_load(&s_tx_slot);
        uint32_t pk = 0;
        for (int i = 0; i < PORT_BLOCK_FRAMES; i++) {
            uint32_t a = (uint32_t)abs(mono[i]);
            if (a > pk) pk = a;
        }
        peak_raise(AUDIO_PEAK_DAC, pk);
        for (int i = 0; i < PORT_BLOCK_FRAMES; i++) {
            int32_t v = (int32_t)mono[i] << 16;
            out[2 * i] = slot == AUDIO_TX_SLOT_RIGHT ? 0 : v;
            out[2 * i + 1] = slot == AUDIO_TX_SLOT_LEFT ? 0 : v;
        }
        size_t w = 0;
        i2s_channel_write(s_port_tx, out, PORT_BLOCK_FRAMES * 2 * sizeof(int32_t), &w, portMAX_DELAY);
    }
}

// x3 interpolator, 16 -> 48 kHz: windowed-sinc low-pass at 7.2 kHz, 48 taps
// split into 3 phases of 16.
#define UP_PHASE_TAPS 16
static float s_up[3][UP_PHASE_TAPS];
static float s_up_hist[UP_PHASE_TAPS];
static bool s_up_ready;

static void up_design(void) {
    const int taps = 3 * UP_PHASE_TAPS;
    float h[3 * UP_PHASE_TAPS], fc = 7200.0f / 48000.0f, sum = 0;
    for (int n = 0; n < taps; n++) {
        float m = n - (taps - 1) / 2.0f;
        float sinc = m == 0 ? 2 * fc : sinf(2 * (float)M_PI * fc * m) / ((float)M_PI * m);
        float w = 0.42f - 0.5f * cosf(2 * (float)M_PI * n / (taps - 1)) + 0.08f * cosf(4 * (float)M_PI * n / (taps - 1));
        h[n] = sinc * w;
        sum += h[n];
    }
    for (int n = 0; n < taps; n++) s_up[n % 3][n / 3] = h[n] * 3.0f / sum;  // gain 3 restores the level after zero-stuffing
    s_up_ready = true;
}

static void up_reset(void) { memset(s_up_hist, 0, sizeof(s_up_hist)); }

// PCM5102A output: the chip has no volume of its own (hardware mode), so the
// level is a digital gain here, before the sniffer and the DAC queue; XSMT is
// its soft mute.
static _Atomic int s_dac_db = 0;          // -60..0
static _Atomic bool s_dac_muted = false;  // by the operator; not saved

void audio_monitor_report_out_samples(const int16_t *samples, size_t count) {
    if (!s_started || count == 0) return;
    const float dac_gain = powf(10.0f, atomic_load(&s_dac_db) / 20.0f);
    if (!s_up_ready) up_design();
    int16_t out[3 * 64];
    size_t done = 0;
    while (done < count) {
        size_t n = count - done > 64 ? 64 : count - done;
        for (size_t i = 0; i < n; i++) {
            memmove(s_up_hist + 1, s_up_hist, (UP_PHASE_TAPS - 1) * sizeof(float));
            s_up_hist[0] = samples[done + i] * dac_gain;
            for (int p = 0; p < 3; p++) {
                float acc = 0;
                for (int k = 0; k < UP_PHASE_TAPS; k++) acc += s_up[p][k] * s_up_hist[k];
                out[3 * i + p] = (int16_t)(acc > 32767 ? 32767 : acc < -32768 ? -32768 : acc);
            }
        }
        audio_sniff_broadcast(out, 3 * n);
        // Blocks while the queue is full, which paces slot playback and the tone
        // to the DAC; a live mic stream that runs ahead just waits too.
        xStreamBufferSend(s_tx_q, out, 3 * n * sizeof(int16_t), pdMS_TO_TICKS(500));
        done += n;
    }
}

static void audio_rx_callback(const int16_t *samples, size_t count) { audio_monitor_report_out_samples(samples, count); }

// ── Input mode / source selection ──────────────────────────────────────────

bool audio_monitor_parse_input_mode(const char *name, audio_input_mode_t *mode_out) {
    if (strcmp(name, "audio") == 0) { *mode_out = AUDIO_INPUT_MODE_AUDIO; return true; }
    if (strcmp(name, "iq") == 0) { *mode_out = AUDIO_INPUT_MODE_IQ; return true; }
    return false;
}
const char *audio_monitor_input_mode_name(audio_input_mode_t mode) { return mode == AUDIO_INPUT_MODE_IQ ? "iq" : "audio"; }
// Both paths run at once on this board; /audio is always live.
audio_input_mode_t audio_monitor_get_input_mode(void) { return AUDIO_INPUT_MODE_AUDIO; }

audio_source_t audio_monitor_get_audio_source(void) { return (audio_source_t)atomic_load(&s_audio_src); }
const char *audio_monitor_audio_source_name(audio_source_t src) { return AUDIO_SRC_NAMES[src == AUDIO_SRC_WM8782]; }
bool audio_monitor_parse_audio_source(const char *name, audio_source_t *out) {
    if (strcmp(name, "pcm1808") == 0) { *out = AUDIO_SRC_PCM1808; return true; }
    if (strcmp(name, "wm8782") == 0) { *out = AUDIO_SRC_WM8782; return true; }
    return false;
}
bool audio_monitor_set_audio_source(audio_source_t src) {
    atomic_store(&s_audio_src, (int)src);
    ESP_LOGI(TAG, "/audio source: %s", AUDIO_SRC_NAMES[src]);
    return bridge_settings_set_str("audio_src", AUDIO_SRC_NAMES[src]);
}

static esp_err_t audio_source_get(httpd_req_t *req) {
    char body[96];
    int n = snprintf(body, sizeof(body), "{\"source\":\"%s\",\"rate_hz\":%d,\"rx_slot_right\":%s}",
                     AUDIO_SRC_NAMES[atomic_load(&s_audio_src)], AUDIO_RATE_HZ, atomic_load(&s_rx_right) ? "true" : "false");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, n);
}

int audio_monitor_get_dac_level_db(void) { return atomic_load(&s_dac_db); }
bool audio_monitor_get_dac_muted(void) { return atomic_load(&s_dac_muted); }

static esp_err_t dac_level_get(httpd_req_t *req) {
    char body[64];
    int n = snprintf(body, sizeof(body), "{\"db\":%d,\"muted\":%s}", atomic_load(&s_dac_db),
                     atomic_load(&s_dac_muted) ? "true" : "false");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, n);
}

// POST /dac-level — {"db":-12} (saved) and/or {"muted":true} (XSMT, not saved).
static esp_err_t dac_level_post(httpd_req_t *req) {
    char body[96] = { 0 };
    httpd_req_recv(req, body, req->content_len < sizeof(body) - 1 ? req->content_len : sizeof(body) - 1);
    const char *v = strstr(body, "\"db\"");
    if (v && (v = strchr(v, ':'))) {
        int db = atoi(v + 1);
        db = db < -60 ? -60 : db > 0 ? 0 : db;
        atomic_store(&s_dac_db, db);
        bridge_settings_set_dac_level_db((int8_t)db);
    }
    if (strstr(body, "\"muted\":true")) atomic_store(&s_dac_muted, true);
    else if (strstr(body, "\"muted\":false")) atomic_store(&s_dac_muted, false);
    if (s_started) gpio_set_level(S3_DAC_XSMT_PIN, atomic_load(&s_dac_muted) ? 0 : 1);
    return dac_level_get(req);
}

static esp_err_t audio_source_post(httpd_req_t *req) {
    char body[96] = { 0 };
    int len = httpd_req_recv(req, body, req->content_len < sizeof(body) - 1 ? req->content_len : sizeof(body) - 1);
    // One CORS header per response: audio_source_get() sets its own.
    if (strstr(body, "\"wm8782\"")) audio_monitor_set_audio_source(AUDIO_SRC_WM8782);
    else if (len > 0 && strstr(body, "\"pcm1808\"")) audio_monitor_set_audio_source(AUDIO_SRC_PCM1808);
    else {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "source must be pcm1808 or wm8782");
    }
    return audio_source_get(req);
}

// ── Bring-up ───────────────────────────────────────────────────────────────

static bool start_wm8782(void) {
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(S3_IQ_I2S_PORT, I2S_ROLE_SLAVE);
    cc.dma_desc_num = WM_DMA_DESC_NUM;
    cc.dma_frame_num = DMA_FRAME_NUM;
    if (i2s_new_channel(&cc, NULL, &s_wm_rx) != ESP_OK) return false;
    i2s_std_config_t sc = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(IQ_DSP_FS_HZ),  // until the reader measures the module's rate
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = I2S_GPIO_UNUSED, .bclk = S3_IQ_BCLK_PIN, .ws = S3_IQ_WS_PIN,
                      .dout = I2S_GPIO_UNUSED, .din = S3_IQ_DIN_PIN },
    };
    return i2s_channel_init_std_mode(s_wm_rx, &sc) == ESP_OK && i2s_channel_enable(s_wm_rx) == ESP_OK;
}

static bool start_audio_port(void) {
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(S3_AUDIO_I2S_PORT, I2S_ROLE_MASTER);
    cc.dma_desc_num = DMA_DESC_NUM;
    cc.dma_frame_num = DMA_FRAME_NUM;
    cc.auto_clear = true;  // a TX underrun sends silence, never the last buffer again
    if (i2s_new_channel(&cc, &s_port_tx, &s_port_rx) != ESP_OK) return false;
    i2s_std_config_t sc = {
        // The S3 can't divide its MCLK by 1: 256 x 48 kHz from 24.576 MHz runs it
        // at /2 with the bit clock at MCLK/4 (verified by the probe).
        .clk_cfg = { .sample_rate_hz = AUDIO_RATE_HZ, .clk_src = I2S_CLK_SRC_EXTERNAL,
                     .ext_clk_freq_hz = S3_EXT_MCLK_HZ, .mclk_multiple = I2S_MCLK_MULTIPLE_256 },
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = S3_EXT_MCLK_PIN, .bclk = S3_AUDIO_BCLK_PIN, .ws = S3_AUDIO_WS_PIN,
                      .dout = S3_AUDIO_DOUT_PIN, .din = S3_AUDIO_DIN_PIN },
    };
    if (i2s_channel_init_std_mode(s_port_tx, &sc) != ESP_OK || i2s_channel_init_std_mode(s_port_rx, &sc) != ESP_OK) return false;
    static int32_t zeros[PORT_BLOCK_FRAMES * 2];
    size_t w = 0;
    i2s_channel_preload_data(s_port_tx, zeros, sizeof(zeros), &w);
    // Enabling waits for the external clock; it's the board's own oscillator, always running.
    return i2s_channel_enable(s_port_tx) == ESP_OK && i2s_channel_enable(s_port_rx) == ESP_OK;
}

void audio_monitor_start(void) {
    uint8_t *store = heap_caps_malloc(TX_QUEUE_SAMPLES * sizeof(int16_t) + 1, MALLOC_CAP_SPIRAM);
    StaticStreamBuffer_t *ctl = heap_caps_malloc(sizeof(StaticStreamBuffer_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!store || !ctl) { ESP_LOGE(TAG, "out of memory — audio disabled"); return; }
    s_tx_q = xStreamBufferCreateStatic(TX_QUEUE_SAMPLES * sizeof(int16_t), sizeof(int16_t), store, ctl);
    up_reset();

    // Saved routing: the /audio ADC, and the RX and TX channels (POST /rx-slot
    // and /tx-slot have always saved these; this board now reads them back).
    char saved[12];
    audio_source_t src;
    if (bridge_settings_get_str("audio_src", saved, sizeof(saved)) && audio_monitor_parse_audio_source(saved, &src))
        atomic_store(&s_audio_src, (int)src);
    atomic_store(&s_rx_right, bridge_settings_get_rx_slot_is_right());
    int8_t tx = bridge_settings_get_tx_slot();
    if (tx >= AUDIO_TX_SLOT_LEFT && tx <= AUDIO_TX_SLOT_BOTH) atomic_store(&s_tx_slot, tx);
    atomic_store(&s_dac_db, bridge_settings_get_dac_level_db());
    ESP_LOGI(TAG, "routing: /audio from %s (%s channel), TX to %s", AUDIO_SRC_NAMES[atomic_load(&s_audio_src)],
             atomic_load(&s_rx_right) ? "right" : "left",
             atomic_load(&s_tx_slot) == AUDIO_TX_SLOT_LEFT ? "left" : atomic_load(&s_tx_slot) == AUDIO_TX_SLOT_RIGHT ? "right" : "both");

    gpio_reset_pin(S3_DAC_XSMT_PIN);
    gpio_set_direction(S3_DAC_XSMT_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(S3_DAC_XSMT_PIN, 0);  // muted until the clocks run

    bool wm = start_wm8782();
    bool port = start_audio_port();
    ESP_LOGI(TAG, "WM8782 (I2S0 slave, rate from its DIP switch): %s; PCM1808 + PCM5102A (I2S1, 48 kHz, external clock): %s",
             wm ? "running" : "FAILED", port ? "running" : "FAILED");
    if (port) gpio_set_level(S3_DAC_XSMT_PIN, 1);
    s_started = port;

    if (wm) xTaskCreatePinnedToCore(wm_task, "wm8782", 4096, NULL, TASK_PRIO, NULL, TASK_CORE);
    if (port) {
        xTaskCreatePinnedToCore(adc_task, "pcm1808", 4096, NULL, TASK_PRIO, NULL, TASK_CORE);
        xTaskCreatePinnedToCore(dac_task, "pcm5102a", 3072, NULL, TASK_PRIO, NULL, TASK_CORE);
    }
    audio_ws_set_rx_callback(audio_rx_callback);

    httpd_handle_t server = ws_server_get_httpd();
    httpd_uri_t get = { .uri = "/audio-source", .method = HTTP_GET, .handler = audio_source_get };
    httpd_uri_t post = { .uri = "/audio-source", .method = HTTP_POST, .handler = audio_source_post };
    if (httpd_register_uri_handler(server, &get) != ESP_OK || httpd_register_uri_handler(server, &post) != ESP_OK)
        ESP_LOGE(TAG, "could not register /audio-source");
    httpd_uri_t dget = { .uri = "/dac-level", .method = HTTP_GET, .handler = dac_level_get };
    httpd_uri_t dpost = { .uri = "/dac-level", .method = HTTP_POST, .handler = dac_level_post };
    if (httpd_register_uri_handler(server, &dget) != ESP_OK || httpd_register_uri_handler(server, &dpost) != ESP_OK)
        ESP_LOGE(TAG, "could not register /dac-level");
    ESP_LOGI(TAG, "free internal RAM: %u KB", (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) >> 10));
}

// ── Channel routing ────────────────────────────────────────────────────────

bool audio_monitor_set_rx_slot(bool use_right) { atomic_store(&s_rx_right, use_right); return true; }
bool audio_monitor_get_rx_slot_is_right(void) { return atomic_load(&s_rx_right); }
bool audio_monitor_set_tx_slot(audio_tx_slot_t slot) { atomic_store(&s_tx_slot, (int)slot); return true; }
audio_tx_slot_t audio_monitor_get_tx_slot(void) { return (audio_tx_slot_t)atomic_load(&s_tx_slot); }

// ── ES8388-only controls: absent on this board ─────────────────────────────

bool audio_monitor_set_adc_input(int idx) { (void)idx; return false; }
int audio_monitor_find_adc_input(const char *name) { (void)name; return -1; }
const char *audio_monitor_get_adc_input_name(void) { return "none"; }
bool audio_monitor_set_mic_gain_db(float db_value) { (void)db_value; return false; }
float audio_monitor_get_mic_gain_db(void) { return 0.0f; }
bool audio_monitor_set_speaker_vol(int8_t vol_value) { (void)vol_value; return false; }
int8_t audio_monitor_get_speaker_vol(void) { return 0; }
bool audio_monitor_set_alc_enabled(bool enabled) { (void)enabled; return false; }
bool audio_monitor_get_alc_enabled(void) { return false; }
bool audio_monitor_set_noise_gate_enabled(bool enabled) { (void)enabled; return false; }
bool audio_monitor_get_noise_gate_enabled(void) { return false; }
bool audio_monitor_set_adc_hpf_enabled(bool enabled) { (void)enabled; return false; }
bool audio_monitor_get_adc_hpf_enabled(void) { return false; }
bool audio_monitor_set_speaker_amp_enabled(bool enabled) { (void)enabled; return false; }
bool audio_monitor_get_speaker_amp_enabled(void) { return false; }

// ── TX slot pool (POST /tx-audio, /tx-play, GET /tx-status, POST /tx-stop) ─
// Same contract as the A1S implementation (audio_monitor.h); playback walks the
// buffer through audio_monitor_report_out_samples(), which blocks on the DAC
// queue and so paces it to real time.

typedef struct {
    int16_t *buf;
    size_t cap_bytes, len_bytes;
    uint32_t hash, audio_hz;
    char message[TX_SLOT_MESSAGE_MAX];
    char label[TX_SLOT_LABEL_MAX];
} tx_slot_t;

static tx_slot_t s_slots[TX_SLOT_COUNT];
static _Atomic bool s_playing, s_stop_req;
static _Atomic int s_playing_slot = -1, s_play_alive = -1;
static _Atomic uint32_t s_pos_ms;
static int s_play_arg;

static _Atomic uint32_t s_tone_hz = 700;
static _Atomic int s_tone_amp_milli = 250;
static _Atomic bool s_tone_running, s_tone_stop, s_tone_alive;

static bool slot_ok(int slot) { return slot >= 0 && slot < TX_SLOT_COUNT; }

static void copy_meta(char *dst, size_t cap, const char *src) {
    if (!src) { dst[0] = 0; return; }
    strncpy(dst, src, cap - 1);
    dst[cap - 1] = 0;
}

bool audio_monitor_tx_buffer_upload(int slot, const int16_t *data, size_t byte_count,
                                    const char *message, const char *label, uint32_t audio_hz) {
    if (!slot_ok(slot) || atomic_load(&s_playing_slot) == slot || atomic_load(&s_play_alive) == slot) return false;
    tx_slot_t *s = &s_slots[slot];
    if (s->cap_bytes < byte_count) {
        int16_t *grown = heap_caps_realloc(s->buf, byte_count, MALLOC_CAP_SPIRAM);
        if (!grown) return false;
        s->buf = grown;
        s->cap_bytes = byte_count;
    }
    memcpy(s->buf, data, byte_count);
    s->len_bytes = byte_count;
    s->hash = esp_rom_crc32_le(0, (const uint8_t *)data, byte_count);
    s->audio_hz = audio_hz;
    copy_meta(s->message, sizeof(s->message), message);
    copy_meta(s->label, sizeof(s->label), label);
    return true;
}

bool audio_monitor_tx_buffer_ready(int slot) { return slot_ok(slot) && s_slots[slot].len_bytes > 0; }
size_t audio_monitor_tx_buffer_byte_count(int slot) { return slot_ok(slot) ? s_slots[slot].len_bytes : 0; }
uint32_t audio_monitor_tx_buffer_duration_ms(int slot) {
    return slot_ok(slot) ? (uint32_t)((uint64_t)s_slots[slot].len_bytes / sizeof(int16_t) * 1000 / MIC_SEND_RATE_HZ) : 0;
}
uint32_t audio_monitor_tx_slot_hash(int slot) { return slot_ok(slot) ? s_slots[slot].hash : 0; }

bool audio_monitor_tx_buffer_clear(int slot) {
    if (!slot_ok(slot) || atomic_load(&s_playing_slot) == slot) return false;
    s_slots[slot].len_bytes = 0;
    s_slots[slot].hash = 0;
    s_slots[slot].audio_hz = 0;
    s_slots[slot].message[0] = s_slots[slot].label[0] = 0;
    return true;
}

static void tx_play_task(void *arg) {
    int slot = *(int *)arg;
    tx_slot_t *s = &s_slots[slot];
    size_t total = s->len_bytes / sizeof(int16_t), pos = 0;
    atomic_store(&s_pos_ms, 0);
    atomic_store(&s_playing_slot, slot);
    atomic_store(&s_playing, true);
    ESP_LOGI(TAG, "TX playback started (slot %d, %u ms)", slot, (unsigned)audio_monitor_tx_buffer_duration_ms(slot));
    while (pos < total && !atomic_load(&s_stop_req)) {
        size_t n = total - pos > TX_CHUNK_SAMPLES ? TX_CHUNK_SAMPLES : total - pos;
        audio_monitor_report_out_samples(s->buf + pos, n);
        pos += n;
        atomic_store(&s_pos_ms, (uint32_t)((uint64_t)pos * 1000 / MIC_SEND_RATE_HZ));
    }
    if (atomic_load(&s_stop_req)) xStreamBufferReset(s_tx_q);  // drop what's queued: stop means stop now
    up_reset();
    atomic_store(&s_playing, false);
    atomic_store(&s_playing_slot, -1);
    atomic_store(&s_stop_req, false);
    ESP_LOGI(TAG, "TX playback finished (slot %d)", slot);
    atomic_store(&s_play_alive, -1);
    vTaskDelete(NULL);
}

bool audio_monitor_tx_play(int slot) {
    if (!s_started || !audio_monitor_tx_buffer_ready(slot)) return false;
    if (atomic_load(&s_playing) || atomic_load(&s_play_alive) != -1) return false;
    if (atomic_load(&s_tone_running) || atomic_load(&s_tone_alive)) return false;
    atomic_store(&s_play_alive, slot);
    s_play_arg = slot;
    if (xTaskCreatePinnedToCore(tx_play_task, "tx_play", 4096, &s_play_arg, TASK_PRIO - 1, NULL, TASK_CORE) != pdPASS) {
        atomic_store(&s_play_alive, -1);
        return false;
    }
    return true;
}

void audio_monitor_tx_get_status(audio_monitor_tx_status_t *out) {
    out->playing = atomic_load(&s_playing);
    out->playing_slot = atomic_load(&s_playing_slot);
    out->position_ms = atomic_load(&s_pos_ms);
    out->duration_ms = out->playing ? audio_monitor_tx_buffer_duration_ms(out->playing_slot) : 0;
    for (int i = 0; i < TX_SLOT_COUNT; i++) {
        out->slots[i].ready = audio_monitor_tx_buffer_ready(i);
        out->slots[i].byte_count = s_slots[i].len_bytes;
        out->slots[i].duration_ms = audio_monitor_tx_buffer_duration_ms(i);
        out->slots[i].hash = s_slots[i].hash;
        out->slots[i].audio_hz = s_slots[i].audio_hz;
        copy_meta(out->slots[i].message, sizeof(out->slots[i].message), s_slots[i].message);
        copy_meta(out->slots[i].label, sizeof(out->slots[i].label), s_slots[i].label);
    }
}

bool audio_monitor_tx_stop(int *stopped_slot_out) {
    int slot = atomic_load(&s_playing_slot);
    if (stopped_slot_out) *stopped_slot_out = slot;
    if (!atomic_load(&s_playing)) return true;
    atomic_store(&s_stop_req, true);
    for (int waited = 0; atomic_load(&s_playing) && waited < 1000; waited += 20) vTaskDelay(pdMS_TO_TICKS(20));
    return !atomic_load(&s_playing);
}

// ── Continuous test tone (POST /tone) ──────────────────────────────────────

static void tone_task(void *arg) {
    static int16_t chunk[TX_CHUNK_SAMPLES];
    double phase = 0;
    atomic_store(&s_tone_running, true);
    ESP_LOGI(TAG, "test tone started (%u Hz)", (unsigned)atomic_load(&s_tone_hz));
    while (!atomic_load(&s_tone_stop)) {
        double step = (double)atomic_load(&s_tone_hz) / MIC_SEND_RATE_HZ;
        double amp = atomic_load(&s_tone_amp_milli) / 1000.0;
        for (int i = 0; i < TX_CHUNK_SAMPLES; i++) {
            chunk[i] = (int16_t)lrint(amp * 32767.0 * sin(2.0 * M_PI * phase));
            phase += step;
            if (phase >= 1.0) phase -= 1.0;
        }
        audio_monitor_report_out_samples(chunk, TX_CHUNK_SAMPLES);
    }
    xStreamBufferReset(s_tx_q);
    up_reset();
    atomic_store(&s_tone_running, false);
    atomic_store(&s_tone_stop, false);
    ESP_LOGI(TAG, "test tone stopped");
    atomic_store(&s_tone_alive, false);
    vTaskDelete(NULL);
}

bool audio_monitor_tone_start(uint32_t hz, float amplitude) {
    if (hz < TONE_HZ_MIN) hz = TONE_HZ_MIN;
    if (hz > TONE_HZ_MAX) hz = TONE_HZ_MAX;
    if (!(amplitude >= 0.0f)) amplitude = 0.0f;
    if (amplitude > 1.0f) amplitude = 1.0f;
    atomic_store(&s_tone_hz, hz);
    atomic_store(&s_tone_amp_milli, (int)lrintf(amplitude * 1000.0f));
    if (atomic_load(&s_tone_running) || atomic_load(&s_tone_alive)) return true;  // a retune
    if (!s_started || atomic_load(&s_playing) || atomic_load(&s_play_alive) != -1) return false;
    atomic_store(&s_tone_alive, true);
    atomic_store(&s_tone_stop, false);
    if (xTaskCreatePinnedToCore(tone_task, "tone", 4096, NULL, TASK_PRIO - 1, NULL, TASK_CORE) != pdPASS) {
        atomic_store(&s_tone_alive, false);
        return false;
    }
    for (int i = 0; i < 20 && !atomic_load(&s_tone_running); i++) vTaskDelay(pdMS_TO_TICKS(5));
    return true;
}

bool audio_monitor_tone_stop(void) {
    if (!atomic_load(&s_tone_running) && !atomic_load(&s_tone_alive)) return true;
    atomic_store(&s_tone_stop, true);
    for (int i = 0; i < 100 && atomic_load(&s_tone_alive); i++) vTaskDelay(pdMS_TO_TICKS(20));
    return !atomic_load(&s_tone_running);
}

void audio_monitor_tone_get_status(audio_monitor_tone_status_t *out) {
    out->running = atomic_load(&s_tone_running);
    out->hz = atomic_load(&s_tone_hz);
    out->amplitude = atomic_load(&s_tone_amp_milli) / 1000.0f;
}

void audio_monitor_get_rx_timing(audio_monitor_rx_timing_t *out) {
    out->max_loop_interval_us = atomic_exchange(&s_max_loop_us, 0);
    out->max_read_duration_us = atomic_exchange(&s_max_read_us, 0);
    out->max_broadcast_duration_us = atomic_exchange(&s_max_bcast_us, 0);
    out->loop_count = atomic_exchange(&s_loop_count, 0);
}
