// Bridge-side I/Q processing — see iq_dsp.h.
#include "iq_dsp.h"

#include <inttypes.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include "dsps_fft2r.h"
#include "dsps_fir.h"
#include "dsps_wind_hann.h"
#include "esp_heap_caps.h"
#include "esp_memory_utils.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "bridge_settings.h"
#include "ws_fanout.h"

static const char *TAG = "iq_dsp";

#define BLOCK_FRAMES     960                     // 10 ms at 96 kHz, 20 ms at 48 kHz
#define IN_BUFFER_FRAMES (IQ_DSP_FS_MAX_HZ / 5)  // 200 ms of input slack at 192 kHz
#define FFT_MAX          4096
#define PB_FRAME_MS      50
#define IQ_DSP_TASK_CORE 1
#define IQ_DSP_TASK_PRIO 3

// Which ADC (or the synthetic test signal) feeds the streams; sets the input rate too.
typedef iq_dsp_source_t iq_source_t;
static const char *const SRC_NAMES[] = { "none", "test", "wm8782", "pcm1808" };
static _Atomic int s_wm_fs = IQ_DSP_FS_HZ;  // measured by the WM8782 reader
static int fs_for(iq_source_t s) { return s == IQ_DSP_SRC_PCM1808 ? 48000 : s == IQ_DSP_SRC_WM8782 ? atomic_load(&s_wm_fs) : IQ_DSP_FS_HZ; }
// Corrections applied to the wideband I/Q before the spectrum and the passband
// shift, same meaning as the web app's (useIQBridge.ts IQCorrection).
typedef enum { CORR_NONE = 0, CORR_SWAP, CORR_NEGATE_I, CORR_NEGATE_Q } iq_corr_t;
static const char *const CORR_NAMES[] = { "none", "swap", "negateI", "negateQ" };
// DC removal: one-pole tracker per channel, corner ~7.6 Hz at 96 kHz (the web
// app uses 0.001 at 48 kHz, the same corner).
#define DC_ALPHA 0.0005f

typedef struct {
    iq_source_t source;
    int32_t center_hz;
    int pb_rate;
    int fft_size;
    int rows_per_s;
    int db_floor;
    int db_span;
    iq_corr_t correction;
    bool dc_removal;
} iq_cfg_t;

static iq_cfg_t s_cfg = {
    .source = IQ_DSP_SRC_WM8782, .center_hz = 0, .pb_rate = 12000, .fft_size = 4096,
    .rows_per_s = 10, .db_floor = -130, .db_span = 120, .correction = CORR_NONE, .dc_removal = false,
};
static SemaphoreHandle_t s_cfg_mutex;
static _Atomic bool s_cfg_changed = true;

static StreamBufferHandle_t s_in;
static ws_fanout_t s_spec_out, s_pb_out;
static _Atomic uint32_t s_in_dropped, s_rows, s_pb_frames;
static _Atomic uint32_t s_load_permille;  // DSP time per second of input, x1000

// ── Working state (DSP task only) ───────────────────────────────────────────

static float *s_fft;      // complex interleaved, FFT_MAX*2
static float *s_win;      // FFT_MAX
static float *s_pow;      // FFT_MAX accumulated power
static uint8_t *s_row;    // FFT_MAX
static int s_fft_fill, s_avg_done, s_avg_count;
static float s_win_gain2;  // (sum of window)^2 — a full-scale tone reads 0 dBFS

static fir_f32_t s_fir_i, s_fir_q;
static float *s_fir_coeffs, *s_fir_delay_i, *s_fir_delay_q;
static int s_fir_taps, s_decim;
static const char *volatile s_fir_mem = "none";  // where the FIR landed: "internal", "psram" or "none"
static float *s_mix_i, *s_mix_q, *s_dec_i, *s_dec_q;
static int16_t *s_pb_buf;
static int s_pb_fill, s_pb_frame_len;
static float s_dc_i, s_dc_q;
static float s_nco_re = 1.0f, s_nco_im = 0.0f, s_step_re = 1.0f, s_step_im = 0.0f;
static iq_cfg_t s_live;  // the config the working state was built for
static int s_fs = IQ_DSP_FS_HZ;  // input rate of s_live.source
static _Atomic int s_cfg_source = IQ_DSP_SRC_WM8782;  // read lock-free by the producers

// Windowed-sinc (Blackman) low-pass for decimation by `decim`: flat to
// 0.4 x the output rate, -74 dB from 0.6 x, so nothing folds back into the
// 0..0.4 x band. Taps = 5.5 x fs / transition, rounded up to a multiple of 4
// (the S3-optimized FIR needs that).
// Internal RAM is tight on this board (the I2S DMA rings live there), so a
// filter that doesn't fit takes PSRAM: slower per tap, but it runs.
static float *fir_alloc(int taps) {
    float *p = heap_caps_aligned_calloc(16, taps, sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    return p ? p : heap_caps_aligned_calloc(16, taps, sizeof(float), MALLOC_CAP_SPIRAM);
}

static void design_fir(int decim) {
    float fs_out = (float)s_fs / decim;
    float transition = 0.2f * fs_out;
    int taps = (int)ceilf(5.5f * s_fs / transition);
    taps = (taps + 3) & ~3;
    heap_caps_free(s_fir_coeffs); heap_caps_free(s_fir_delay_i); heap_caps_free(s_fir_delay_q);
    s_fir_coeffs = fir_alloc(taps);
    s_fir_delay_i = fir_alloc(taps);
    s_fir_delay_q = fir_alloc(taps);
    if (!s_fir_coeffs || !s_fir_delay_i || !s_fir_delay_q) {
        // Not even PSRAM: the passband stays off until the next redesign.
        ESP_LOGE(TAG, "FIR (%d taps): out of memory — passband off", taps);
        heap_caps_free(s_fir_coeffs); heap_caps_free(s_fir_delay_i); heap_caps_free(s_fir_delay_q);
        s_fir_coeffs = s_fir_delay_i = s_fir_delay_q = NULL;
        s_fir_taps = 0;
        s_decim = decim;
        s_fir_mem = "none";
        return;
    }
    float fc = 0.5f * fs_out / s_fs;  // cutoff, cycles/sample
    float sum = 0;
    for (int n = 0; n < taps; n++) {
        float m = n - (taps - 1) / 2.0f;
        float sinc = m == 0 ? 2 * fc : sinf(2 * (float)M_PI * fc * m) / ((float)M_PI * m);
        float w = 0.42f - 0.5f * cosf(2 * (float)M_PI * n / (taps - 1)) + 0.08f * cosf(4 * (float)M_PI * n / (taps - 1));
        s_fir_coeffs[n] = sinc * w;
        sum += s_fir_coeffs[n];
    }
    for (int n = 0; n < taps; n++) s_fir_coeffs[n] /= sum;  // unity gain at DC
    s_fir_mem = esp_ptr_internal(s_fir_coeffs) && esp_ptr_internal(s_fir_delay_i) && esp_ptr_internal(s_fir_delay_q) ? "internal" : "psram";
    if (s_fir_mem[0] == 'p') ESP_LOGW(TAG, "FIR (%d taps) in PSRAM: internal RAM is short", taps);
    dsps_fird_init_f32(&s_fir_i, s_fir_coeffs, s_fir_delay_i, taps, decim);
    dsps_fird_init_f32(&s_fir_q, s_fir_coeffs, s_fir_delay_q, taps, decim);
    s_fir_taps = taps;
    s_decim = decim;
}

static void apply_config(void) {
    xSemaphoreTake(s_cfg_mutex, portMAX_DELAY);
    iq_cfg_t c = s_cfg;
    xSemaphoreGive(s_cfg_mutex);

    if (c.fft_size != s_live.fft_size || !s_win) {
        dsps_wind_hann_f32(s_win, c.fft_size);
        float sum = 0;
        for (int i = 0; i < c.fft_size; i++) sum += s_win[i];
        s_win_gain2 = sum * sum;
    }
    bool new_source = c.source != s_live.source || !s_win || fs_for(c.source) != s_fs;  // or a new WM8782 rate
    if (new_source) {
        // A different ADC, possibly at a different rate: start from clean state.
        s_fs = fs_for(c.source);
        xStreamBufferReset(s_in);
        s_dc_i = s_dc_q = 0;
        s_nco_re = 1.0f; s_nco_im = 0.0f;
        s_decim = 0;  // force the FIR redesign for the new rate
    }
    if (c.center_hz > s_fs / 2) c.center_hz = s_fs / 2;
    if (c.center_hz < -s_fs / 2) c.center_hz = -s_fs / 2;
    float ffts_per_s = (float)s_fs / c.fft_size;
    s_avg_count = MAX(1, (int)lroundf(ffts_per_s / c.rows_per_s));
    s_fft_fill = s_avg_done = 0;
    memset(s_pow, 0, FFT_MAX * sizeof(float));

    int decim = s_fs / c.pb_rate;
    if (decim != s_decim) design_fir(decim);
    s_pb_frame_len = c.pb_rate * PB_FRAME_MS / 1000;
    s_pb_fill = 0;
    double w = -2.0 * M_PI * c.center_hz / s_fs;  // shift center_hz down to 0 Hz
    s_step_re = (float)cos(w);
    s_step_im = (float)sin(w);
    s_live = c;
    ESP_LOGI(TAG, "source=%s (%d Hz) center=%" PRId32 " Hz passband %d Hz (decim %d, %d taps), FFT %d x avg %d = %.1f rows/s",
             SRC_NAMES[c.source], s_fs, c.center_hz, c.pb_rate, s_decim, s_fir_taps,
             c.fft_size, s_avg_count, ffts_per_s / s_avg_count);
}

typedef struct __attribute__((packed)) {
    char magic[4];
    uint32_t seq, fs;
    uint16_t bins;
    int16_t db_floor;
    uint16_t db_span, reserved;
} spec_hdr_t;

typedef struct __attribute__((packed)) {
    char magic[4];
    uint32_t seq, fs;
    int32_t center_hz;
} pb_hdr_t;

static void emit_row(void) {
    const int n = s_live.fft_size;
    const float norm = 1.0f / (s_avg_count * s_win_gain2);
    const float scale = 255.0f / s_live.db_span;
    for (int k = 0; k < n; k++) {
        int src = (k + n / 2) & (n - 1);  // lowest frequency first
        float db = 10.0f * log10f(s_pow[src] * norm + 1e-20f);
        float v = (db - s_live.db_floor) * scale;
        s_row[k] = v <= 0 ? 0 : v >= 255 ? 255 : (uint8_t)v;
    }
    spec_hdr_t h = { .magic = {'I', 'Q', 'S', '1'}, .seq = atomic_fetch_add(&s_rows, 1), .fs = (uint32_t)s_fs,
                     .bins = (uint16_t)n, .db_floor = (int16_t)s_live.db_floor, .db_span = (uint16_t)s_live.db_span };
    ws_fanout_send(&s_spec_out, &h, sizeof(h), s_row, n);
}

// The status display's overview (iq_dsp_overview): a few columns of maxima,
// kept under a spinlock (written on core 1, read on core 0).
#define OVERVIEW_COLS 96
static float s_ov[OVERVIEW_COLS];
static int s_ov_fs;
static int64_t s_ov_at;
static portMUX_TYPE s_ov_lock = portMUX_INITIALIZER_UNLOCKED;

static void update_overview(void) {
    const int n = s_live.fft_size;
    const float norm = 1.0f / (s_avg_count * s_win_gain2);
    float col[OVERVIEW_COLS];
    for (int c = 0; c < OVERVIEW_COLS; c++) {
        int k0 = c * n / OVERVIEW_COLS, k1 = (c + 1) * n / OVERVIEW_COLS;
        float m = 0;
        for (int k = k0; k < k1; k++) {
            float p = s_pow[(k + n / 2) & (n - 1)];
            if (p > m) m = p;
        }
        col[c] = 10.0f * log10f(m * norm + 1e-20f);
    }
    portENTER_CRITICAL(&s_ov_lock);
    memcpy(s_ov, col, sizeof(col));
    s_ov_fs = s_fs;
    s_ov_at = esp_timer_get_time();
    portEXIT_CRITICAL(&s_ov_lock);
}

int iq_dsp_overview(float *db, int cols, int32_t *center_hz) {
    float col[OVERVIEW_COLS];
    portENTER_CRITICAL(&s_ov_lock);
    memcpy(col, s_ov, sizeof(col));
    int fs = s_ov_fs;
    int64_t at = s_ov_at;
    portEXIT_CRITICAL(&s_ov_lock);
    if (center_hz) *center_hz = s_live.center_hz;
    if (!fs || esp_timer_get_time() - at > 2000000) return 0;
    for (int c = 0; c < cols; c++) {  // resample to the caller's width, keeping maxima
        int a = c * OVERVIEW_COLS / cols, b = (c + 1) * OVERVIEW_COLS / cols;
        if (b <= a) b = a + 1;
        float m = -200;
        for (int k = a; k < b && k < OVERVIEW_COLS; k++) if (col[k] > m) m = col[k];
        db[c] = m;
    }
    return fs;
}

static void spectrum_feed(const float *i_in, const float *q_in, int len) {
    const int n = s_live.fft_size;
    for (int k = 0; k < len; k++) {
        s_fft[2 * s_fft_fill] = i_in[k] * s_win[s_fft_fill];
        s_fft[2 * s_fft_fill + 1] = q_in[k] * s_win[s_fft_fill];
        if (++s_fft_fill < n) continue;
        s_fft_fill = 0;
        dsps_fft2r_fc32(s_fft, n);
        dsps_bit_rev_fc32(s_fft, n);
        for (int b = 0; b < n; b++) s_pow[b] += s_fft[2 * b] * s_fft[2 * b] + s_fft[2 * b + 1] * s_fft[2 * b + 1];
        if (++s_avg_done < s_avg_count) continue;
        if (ws_fanout_count(&s_spec_out) > 0) emit_row();
        update_overview();
        s_avg_done = 0;
        memset(s_pow, 0, n * sizeof(float));
    }
}

static void passband_feed(const float *i_in, const float *q_in, int len) {
    // Mix down: (i + jq) * nco, nco advancing by e^(j w) per sample.
    float re = s_nco_re, im = s_nco_im;
    for (int k = 0; k < len; k++) {
        s_mix_i[k] = i_in[k] * re - q_in[k] * im;
        s_mix_q[k] = i_in[k] * im + q_in[k] * re;
        float nr = re * s_step_re - im * s_step_im;
        im = re * s_step_im + im * s_step_re;
        re = nr;
    }
    float mag = sqrtf(re * re + im * im);  // keep the oscillator on the unit circle
    s_nco_re = re / mag;
    s_nco_im = im / mag;

    if (!s_fir_coeffs) return;  // the FIR didn't fit (design_fir)
    int outs = dsps_fird_f32(&s_fir_i, s_mix_i, s_dec_i, len / s_decim);
    dsps_fird_f32(&s_fir_q, s_mix_q, s_dec_q, len / s_decim);
    for (int k = 0; k < outs; k++) {
        float vi = s_dec_i[k] * 32767.0f, vq = s_dec_q[k] * 32767.0f;
        s_pb_buf[2 * s_pb_fill] = (int16_t)(vi > 32767 ? 32767 : vi < -32768 ? -32768 : vi);
        s_pb_buf[2 * s_pb_fill + 1] = (int16_t)(vq > 32767 ? 32767 : vq < -32768 ? -32768 : vq);
        if (++s_pb_fill < s_pb_frame_len) continue;
        s_pb_fill = 0;
        uint32_t seq = atomic_fetch_add(&s_pb_frames, 1);
        if (ws_fanout_count(&s_pb_out) == 0) continue;
        pb_hdr_t h = { .magic = {'I', 'Q', 'P', '1'}, .seq = seq, .fs = (uint32_t)s_live.pb_rate, .center_hz = s_live.center_hz };
        ws_fanout_send(&s_pb_out, &h, sizeof(h), s_pb_buf, s_pb_frame_len * 2 * sizeof(int16_t));
    }
}

static void dsp_task(void *arg) {
    int32_t *raw = heap_caps_malloc(BLOCK_FRAMES * 2 * sizeof(int32_t), MALLOC_CAP_SPIRAM);
    float *fi = heap_caps_malloc(BLOCK_FRAMES * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    float *fq = heap_caps_malloc(BLOCK_FRAMES * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!raw || !fi || !fq) {
        ESP_LOGE(TAG, "DSP task: out of memory");
        vTaskDelete(NULL);
    }
    int64_t busy_us = 0, window_start = esp_timer_get_time();
    for (;;) {
        // A receive returns early with whatever is already buffered (the
        // WM8782 writes 5 ms chunks), so gather a whole block; only a timeout
        // with nothing more arriving means an idle source.
        const size_t block_bytes = BLOCK_FRAMES * 2 * sizeof(int32_t);
        size_t got = 0;
        while (got < block_bytes) {
            size_t n = xStreamBufferReceive(s_in, (uint8_t *)raw + got, block_bytes - got, pdMS_TO_TICKS(200));
            if (n == 0) break;
            got += n;
        }
        if (atomic_exchange(&s_cfg_changed, false)) apply_config();
        if (got < block_bytes) continue;  // idle source
        int64_t t0 = esp_timer_get_time();
        const float k = 1.0f / 2147483648.0f;
        for (int n = 0; n < BLOCK_FRAMES; n++) { fi[n] = raw[2 * n] * k; fq[n] = raw[2 * n + 1] * k; }
        if (s_live.dc_removal) {
            for (int n = 0; n < BLOCK_FRAMES; n++) {
                s_dc_i += DC_ALPHA * (fi[n] - s_dc_i);
                s_dc_q += DC_ALPHA * (fq[n] - s_dc_q);
                fi[n] -= s_dc_i;
                fq[n] -= s_dc_q;
            }
        }
        float *ci = fi, *cq = fq;  // after the swap correction, I and Q trade places
        switch (s_live.correction) {
            case CORR_SWAP: ci = fq; cq = fi; break;
            case CORR_NEGATE_I: for (int n = 0; n < BLOCK_FRAMES; n++) fi[n] = -fi[n]; break;
            case CORR_NEGATE_Q: for (int n = 0; n < BLOCK_FRAMES; n++) fq[n] = -fq[n]; break;
            default: break;
        }
        spectrum_feed(ci, cq, BLOCK_FRAMES);
        passband_feed(ci, cq, BLOCK_FRAMES);
        int64_t t1 = esp_timer_get_time();
        busy_us += t1 - t0;
        if (t1 - window_start >= 1000000) {
            atomic_store(&s_load_permille, (uint32_t)(busy_us * 1000 / (t1 - window_start)));
            busy_us = 0;
            window_start = t1;
        }
    }
}

// ── Input ───────────────────────────────────────────────────────────────────

void iq_dsp_feed(iq_dsp_source_t src, const int32_t *iq, size_t frames) {
    if (!s_in || src != (iq_dsp_source_t)atomic_load(&s_cfg_source)) return;
    size_t bytes = frames * 2 * sizeof(int32_t);
    if (xStreamBufferSend(s_in, iq, bytes, 0) != bytes) atomic_fetch_add(&s_in_dropped, (uint32_t)frames);
}

// Synthetic 96 kHz I/Q in 10 ms blocks: three complex tones plus noise.
static void test_source_task(void *arg) {
    static const struct { float hz, dbfs; } tones[] = { { 5000, -20 }, { -12000, -40 }, { 20300, -60 } };
    enum { NT = sizeof(tones) / sizeof(tones[0]) };
    float re[NT], im[NT], sre[NT], sim[NT], amp[NT];
    for (int t = 0; t < NT; t++) {
        re[t] = 1; im[t] = 0;
        sre[t] = cosf(2 * (float)M_PI * tones[t].hz / IQ_DSP_FS_HZ);
        sim[t] = sinf(2 * (float)M_PI * tones[t].hz / IQ_DSP_FS_HZ);
        amp[t] = powf(10, tones[t].dbfs / 20);
    }
    const float noise = powf(10, -100 / 20.0f) * 1.7f;  // uniform ±a has rms a/√3; I and Q each
    int32_t *blk = heap_caps_malloc(BLOCK_FRAMES * 2 * sizeof(int32_t), MALLOC_CAP_SPIRAM);
    if (!blk) {
        ESP_LOGE(TAG, "test source: out of memory");
        vTaskDelete(NULL);
    }
    // Noise from xorshift32: esp_random() waits on the hardware RNG and, called
    // twice per sample, made this task slower than real time (it then never
    // slept and the task watchdog fired).
    uint32_t rng = esp_random() | 1;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(10));
        if (xTaskGetTickCount() - wake > pdMS_TO_TICKS(50)) wake = xTaskGetTickCount();  // fell behind: skip, never spin
        if (atomic_load(&s_cfg_source) != IQ_DSP_SRC_TEST) continue;
        for (int n = 0; n < BLOCK_FRAMES; n++) {
            float i = 0, q = 0;
            for (int t = 0; t < NT; t++) {
                i += amp[t] * re[t];
                q += amp[t] * im[t];
                float nr = re[t] * sre[t] - im[t] * sim[t];
                im[t] = re[t] * sim[t] + im[t] * sre[t];
                re[t] = nr;
            }
            rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
            i += noise * ((int32_t)rng / 2147483648.0f);
            rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
            q += noise * ((int32_t)rng / 2147483648.0f);
            blk[2 * n] = (int32_t)(i * 2147483392.0f) & (int32_t)0xFFFFFF00;      // 24-bit, left-justified
            blk[2 * n + 1] = (int32_t)(q * 2147483392.0f) & (int32_t)0xFFFFFF00;
        }
        for (int t = 0; t < NT; t++) { float m = sqrtf(re[t] * re[t] + im[t] * im[t]); re[t] /= m; im[t] /= m; }
        iq_dsp_feed(IQ_DSP_SRC_TEST, blk, BLOCK_FRAMES);
    }
}

// ── HTTP / WebSocket ────────────────────────────────────────────────────────

static esp_err_t ws_join(httpd_req_t *req, ws_fanout_t *f) {
    if (req->method != HTTP_GET) {
        httpd_ws_frame_t frame = { 0 };  // clients only listen; drain whatever they send
        esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
        if (err == ESP_OK && frame.len > 0 && frame.len <= 256) {
            uint8_t buf[256];
            frame.payload = buf;
            err = httpd_ws_recv_frame(req, &frame, frame.len);
        }
        return err;
    }
    int fd = httpd_req_to_sockfd(req);
    if (!ws_fanout_add(f, fd)) {
        ESP_LOGW(TAG, "%s: client limit reached — refusing fd=%d", f->name, fd);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "%s: client connected (fd=%d)", f->name, fd);
    return ESP_OK;
}
static esp_err_t spectrum_ws(httpd_req_t *req) { return ws_join(req, &s_spec_out); }
static esp_err_t passband_ws(httpd_req_t *req) { return ws_join(req, &s_pb_out); }

void iq_dsp_on_client_close(int sockfd) {
    ws_fanout_remove(&s_spec_out, sockfd);
    ws_fanout_remove(&s_pb_out, sockfd);
}

static esp_err_t config_get(httpd_req_t *req) {
    xSemaphoreTake(s_cfg_mutex, portMAX_DELAY);
    iq_cfg_t c = s_cfg;
    xSemaphoreGive(s_cfg_mutex);
    char body[448];
    int n = snprintf(body, sizeof(body),
        "{\"fs\":%d,\"source\":\"%s\",\"center_hz\":%" PRId32 ",\"pb_rate\":%d,\"fft_size\":%d,\"rows_per_s\":%d,"
        "\"db_floor\":%d,\"db_span\":%d,\"iq_correction\":\"%s\",\"dc_removal\":%s,\"dsp_load_pct\":%.1f,\"input_dropped\":%" PRIu32 ",\"rows\":%" PRIu32 ","
        "\"pb_frames\":%" PRIu32 ",\"spectrum_clients\":%d,\"passband_clients\":%d,\"client_frames_dropped\":%" PRIu32 ",\"fir_memory\":\"%s\"}",
        fs_for(c.source), SRC_NAMES[c.source], c.center_hz, c.pb_rate, c.fft_size, c.rows_per_s,
        c.db_floor, c.db_span, CORR_NAMES[c.correction], c.dc_removal ? "true" : "false", atomic_load(&s_load_permille) / 10.0, atomic_load(&s_in_dropped), atomic_load(&s_rows),
        atomic_load(&s_pb_frames), ws_fanout_count(&s_spec_out), ws_fanout_count(&s_pb_out),
        s_spec_out.dropped + s_pb_out.dropped, s_fir_mem);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, n);
}

static const char *json_val(const char *j, const char *key) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(j, pat);
    if (!p || !(p = strchr(p + strlen(pat), ':'))) return NULL;
    while (*++p == ' ') {}
    return p;
}

static esp_err_t config_post(httpd_req_t *req) {
    char body[256] = { 0 };
    int len = httpd_req_recv(req, body, MIN(req->content_len, sizeof(body) - 1));
    // The CORS header is set once, by whichever response goes out: a second
    // copy makes browsers reject the response (config_get() sets its own).
    if (len <= 0) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
    }
    xSemaphoreTake(s_cfg_mutex, portMAX_DELAY);
    iq_cfg_t c = s_cfg;
    xSemaphoreGive(s_cfg_mutex);
    const char *v;
    const char *err = NULL;
    bool source_given = false;
    if ((v = json_val(body, "source"))) {
        int found = -1;
        for (int i = 0; i < 4; i++) {
            size_t l = strlen(SRC_NAMES[i]);
            if (v[0] == '"' && strncmp(v + 1, SRC_NAMES[i], l) == 0 && v[1 + l] == '"') found = i;
        }
        if (found < 0) err = "source must be wm8782, pcm1808, test or none";
        else { c.source = (iq_source_t)found; source_given = true; }
    }
    if ((v = json_val(body, "center_hz"))) {
        int x = atoi(v), half = fs_for(c.source) / 2;
        if (x < -half || x > half) err = "center_hz must be within ±fs/2";
        else c.center_hz = x;
    }
    if ((v = json_val(body, "pb_rate"))) {
        int x = atoi(v);
        if (x != 6000 && x != 12000 && x != 24000) err = "pb_rate must be 6000, 12000 or 24000";
        else c.pb_rate = x;
    }
    if ((v = json_val(body, "fft_size"))) {
        int x = atoi(v);
        if (x != 1024 && x != 2048 && x != 4096) err = "fft_size must be 1024, 2048 or 4096";
        else c.fft_size = x;
    }
    if ((v = json_val(body, "rows_per_s"))) {
        int x = atoi(v);
        if (x < 1 || x > 30) err = "rows_per_s must be 1..30";
        else c.rows_per_s = x;
    }
    if ((v = json_val(body, "db_floor"))) {
        int x = atoi(v);
        if (x < -160 || x > 0) err = "db_floor must be -160..0";
        else c.db_floor = x;
    }
    if ((v = json_val(body, "db_span"))) {
        int x = atoi(v);
        if (x < 20 || x > 160) err = "db_span must be 20..160";
        else c.db_span = x;
    }
    if ((v = json_val(body, "iq_correction"))) {
        int found = -1;
        for (int i = 0; i < 4; i++) {
            size_t l = strlen(CORR_NAMES[i]);
            if (v[0] == '"' && strncmp(v + 1, CORR_NAMES[i], l) == 0 && v[1 + l] == '"') found = i;
        }
        if (found < 0) err = "iq_correction must be none, swap, negateI or negateQ";
        else c.correction = (iq_corr_t)found;
    }
    if ((v = json_val(body, "dc_removal"))) c.dc_removal = strncmp(v, "true", 4) == 0;
    if (err) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, err);
    }
    xSemaphoreTake(s_cfg_mutex, portMAX_DELAY);
    s_cfg = c;
    xSemaphoreGive(s_cfg_mutex);
    atomic_store(&s_cfg_source, (int)c.source);
    atomic_store(&s_cfg_changed, true);
    if (source_given) bridge_settings_set_str("iq_src", SRC_NAMES[c.source]);
    return config_get(req);
}

iq_dsp_source_t iq_dsp_get_source(void) { return (iq_dsp_source_t)atomic_load(&s_cfg_source); }
const char *iq_dsp_source_name(iq_dsp_source_t src) { return (unsigned)src < 4 ? SRC_NAMES[src] : "none"; }
int iq_dsp_source_rate_hz(iq_dsp_source_t src) { return fs_for(src); }

void iq_dsp_set_wm8782_rate(int hz) {
    if (atomic_exchange(&s_wm_fs, hz) == hz) return;
    ESP_LOGI(TAG, "WM8782 now at %d Hz", hz);
    if (atomic_load(&s_cfg_source) == IQ_DSP_SRC_WM8782) atomic_store(&s_cfg_changed, true);
}

bool iq_dsp_parse_source(const char *name, iq_dsp_source_t *out) {
    for (int i = 0; i < 4; i++) if (strcmp(name, SRC_NAMES[i]) == 0) { *out = (iq_dsp_source_t)i; return true; }
    return false;
}

bool iq_dsp_set_source(iq_dsp_source_t src) {
    if ((unsigned)src >= 4 || !s_cfg_mutex) return false;
    xSemaphoreTake(s_cfg_mutex, portMAX_DELAY);
    s_cfg.source = src;
    xSemaphoreGive(s_cfg_mutex);
    atomic_store(&s_cfg_source, (int)src);
    atomic_store(&s_cfg_changed, true);
    return bridge_settings_set_str("iq_src", SRC_NAMES[src]);
}

void iq_dsp_start(httpd_handle_t server) {
    s_cfg_mutex = xSemaphoreCreateMutex();
    char saved[12];
    iq_dsp_source_t src;
    if (bridge_settings_get_str("iq_src", saved, sizeof(saved)) && iq_dsp_parse_source(saved, &src)) {
        s_cfg.source = src;
        atomic_store(&s_cfg_source, (int)src);
    }
    ws_fanout_init(&s_spec_out, "iq-spectrum", server);
    ws_fanout_init(&s_pb_out, "iq-passband", server);

    // The FFT, window, mixer and FIR buffers sit in internal RAM (touched per
    // sample); the power sum, output row, passband frame and the input slack
    // buffer in PSRAM (touched once per row/frame, sequentially).
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    const uint32_t ext = MALLOC_CAP_SPIRAM;
    // FFT and window in PSRAM: 48 KB of internal RAM is worth more as I2S DMA
    // rings for the three converters, and both are walked sequentially.
    s_fft = heap_caps_aligned_calloc(16, FFT_MAX * 2, sizeof(float), ext);
    s_win = heap_caps_aligned_calloc(16, FFT_MAX, sizeof(float), ext);
    s_pow = heap_caps_calloc(FFT_MAX, sizeof(float), ext);
    s_row = heap_caps_malloc(FFT_MAX, ext);
    s_mix_i = heap_caps_aligned_calloc(16, BLOCK_FRAMES, sizeof(float), caps);
    s_mix_q = heap_caps_aligned_calloc(16, BLOCK_FRAMES, sizeof(float), caps);
    s_dec_i = heap_caps_aligned_calloc(16, BLOCK_FRAMES, sizeof(float), caps);
    s_dec_q = heap_caps_aligned_calloc(16, BLOCK_FRAMES, sizeof(float), caps);
    s_pb_buf = heap_caps_malloc(24000 * PB_FRAME_MS / 1000 * 2 * sizeof(int16_t), ext);
    size_t in_bytes = IN_BUFFER_FRAMES * 2 * sizeof(int32_t);
    uint8_t *in_store = heap_caps_malloc(in_bytes + 1, MALLOC_CAP_SPIRAM);
    StaticStreamBuffer_t *in_ctl = heap_caps_malloc(sizeof(StaticStreamBuffer_t), caps);
    if (!s_fft || !s_win || !s_pow || !s_row || !s_mix_i || !s_mix_q || !s_dec_i || !s_dec_q || !s_pb_buf || !in_store || !in_ctl) {
        ESP_LOGE(TAG, "out of memory — I/Q processing disabled");
        return;
    }
    s_in = xStreamBufferCreateStatic(in_bytes, BLOCK_FRAMES * 2 * sizeof(int32_t), in_store, in_ctl);
    if (dsps_fft2r_init_fc32(NULL, FFT_MAX) != ESP_OK) {
        ESP_LOGE(TAG, "FFT init failed — I/Q processing disabled");
        return;
    }
    s_live.fft_size = 0;  // force the window build on the first apply_config()
    s_live.source = IQ_DSP_SRC_NONE;  // and the source setup
    // Build the working state now, before the converters, the status LCD and
    // the rest claim internal RAM: the passband FIR is the DSP's one internal
    // allocation that can grow, and it runs fastest there.
    apply_config();
    atomic_store(&s_cfg_changed, false);
    xTaskCreatePinnedToCore(dsp_task, "iq_dsp", 6144, NULL, IQ_DSP_TASK_PRIO, NULL, IQ_DSP_TASK_CORE);
    xTaskCreatePinnedToCore(test_source_task, "iq_test_src", 4096, NULL, IQ_DSP_TASK_PRIO, NULL, IQ_DSP_TASK_CORE);

    httpd_uri_t uris[] = {
        { .uri = "/iq-spectrum", .method = HTTP_GET, .handler = spectrum_ws, .is_websocket = true },
        { .uri = "/iq-passband", .method = HTTP_GET, .handler = passband_ws, .is_websocket = true },
        { .uri = "/iq-config", .method = HTTP_GET, .handler = config_get },
        { .uri = "/iq-config", .method = HTTP_POST, .handler = config_post },
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++) ESP_ERROR_CHECK(httpd_register_uri_handler(server, &uris[i]));
    ESP_LOGI(TAG, "free internal RAM after start: %u KB", (unsigned)(heap_caps_get_free_size(caps) >> 10));
    ESP_LOGI(TAG, "ready: ws://<bridge>/iq-spectrum, /iq-passband; GET/POST /iq-config (source wm8782 by default; pcm1808, test or none)");
}
