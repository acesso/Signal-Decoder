// Bridge self-description and routing — see io_routing.h.
#include "io_routing.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "audio_monitor.h"
#include "bridge_config.h"
#include "bridge_settings.h"
#include "http_control.h"
#if CONFIG_BRIDGE_BOARD_S3
#include "iq_dsp.h"
#endif

static const char *TAG = "io_routing";

// ── Tiny JSON helpers (bodies are short and flat enough for this) ──────────

// The {...} object that follows "key": in json, as [start, end). NULL if absent.
static const char *object_of(const char *json, const char *key, const char **end) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p || !(p = strchr(p + strlen(pat), '{'))) return NULL;
    const char *q = strchr(p, '}');
    if (!q) return NULL;
    *end = q;
    return p;
}

// The string value of "key" inside [start, end); false if absent or not a string.
static bool string_in(const char *start, const char *end, const char *key, char *out, size_t out_sz) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(start, pat);
    if (!p || p >= end || !(p = strchr(p + strlen(pat), ':')) || p >= end) return false;
    while (*++p == ' ') {}
    if (*p != '"') return false;
    const char *q = strchr(++p, '"');
    if (!q || q >= end || (size_t)(q - p) >= out_sz) return false;
    memcpy(out, p, q - p);
    out[q - p] = 0;
    return true;
}

static const char *tx_channel_name(audio_tx_slot_t s) {
    return s == AUDIO_TX_SLOT_LEFT ? "left" : s == AUDIO_TX_SLOT_RIGHT ? "right" : "both";
}

static bool parse_tx_channel(const char *name, audio_tx_slot_t *out) {
    if (strcmp(name, "left") == 0) { *out = AUDIO_TX_SLOT_LEFT; return true; }
    if (strcmp(name, "right") == 0) { *out = AUDIO_TX_SLOT_RIGHT; return true; }
    if (strcmp(name, "both") == 0) { *out = AUDIO_TX_SLOT_BOTH; return true; }
    return false;
}

static esp_err_t send_json(httpd_req_t *req, const char *body, int len) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, len);
}

static esp_err_t send_err(httpd_req_t *req, const char *msg) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, msg);
}

// ── Board descriptions ─────────────────────────────────────────────────────

#if CONFIG_BRIDGE_BOARD_S3

static int capabilities_json(char *b, size_t n) {
    return snprintf(b, n,
        "{\"version\":1,\"board\":\"%s\",\"model\":\"ESP32-S3-N16R8\",\"firmware_version\":\"%s\","
        "\"pa\":{\"sense\":true,\"emergency\":true},"
        "\"concurrent_inputs\":true,"
        "\"inputs\":["
          "{\"id\":\"wm8782\",\"chip\":\"WM8782\",\"jack\":\"I/Q\",\"kinds\":[\"iq\",\"audio\"],\"rate_hz\":%d,\"bits\":24,"
           "\"channels\":[{\"id\":\"left\",\"label\":\"I\"},{\"id\":\"right\",\"label\":\"Q\"}]},"
          "{\"id\":\"pcm1808\",\"chip\":\"PCM1808\",\"jack\":\"RX/loop\",\"kinds\":[\"audio\",\"iq\"],\"rate_hz\":48000,\"bits\":24,"
           "\"channels\":[{\"id\":\"left\",\"label\":\"RX\"},{\"id\":\"right\",\"label\":\"loop\"}]}],"
        "\"outputs\":["
          "{\"id\":\"pcm5102a\",\"chip\":\"PCM5102A\",\"jack\":\"TX\",\"kinds\":[\"audio\"],\"rate_hz\":48000,"
           "\"channels\":[\"left\",\"right\",\"both\"],\"delivery\":[\"slots\",\"stream\"],\"slots\":%d,\"slot_rate_hz\":%d}],"
        "\"streams\":{\"audio\":{\"ws\":\"/audio\",\"rate_hz\":48000,\"format\":\"s16le_mono\"},"
          "\"iq\":{\"ws_spectrum\":\"/iq-spectrum\",\"ws_passband\":\"/iq-passband\",\"config\":\"/iq-config\"}},"
        "\"dsp\":{\"iq_spectrum\":{\"fft_sizes\":[1024,2048,4096],\"rows_per_s_max\":30},"
          "\"iq_passband\":{\"rates_hz\":[6000,12000,24000]},"
          "\"iq_corrections\":[\"none\",\"swap\",\"negateI\",\"negateQ\"],\"dc_removal\":true,\"imbalance_correction\":false}}",
        BRIDGE_BOARD_NAME, BRIDGE_FIRMWARE_VERSION, iq_dsp_source_rate_hz(IQ_DSP_SRC_WM8782),  // the module's DIP switch sets it
        TX_SLOT_COUNT, TX_BUFFER_SAMPLE_RATE_HZ);
}

static int routing_json(char *b, size_t n, bool reboot_required) {
    iq_dsp_source_t iq = iq_dsp_get_source();
    bool iq_adc = iq == IQ_DSP_SRC_WM8782 || iq == IQ_DSP_SRC_PCM1808;
    return snprintf(b, n,
        "{\"iq\":{\"input\":%s%s%s,\"rate_hz\":%d},"
        "\"audio\":{\"input\":\"%s\",\"channel\":\"%s\",\"rate_hz\":48000},"
        "\"tx\":{\"output\":\"pcm5102a\",\"channel\":\"%s\"},\"reboot_required\":%s}",
        iq_adc ? "\"" : "", iq_adc ? iq_dsp_source_name(iq) : "null", iq_adc ? "\"" : "", iq_dsp_source_rate_hz(iq),
        audio_monitor_audio_source_name(audio_monitor_get_audio_source()),
        audio_monitor_get_rx_slot_is_right() ? "right" : "left",
        tx_channel_name(audio_monitor_get_tx_slot()), reboot_required ? "true" : "false");
}

// Validates everything first, then applies; returns an error message or NULL.
static const char *routing_apply(const char *body, bool *reboot_required) {
    *reboot_required = false;
    const char *e, *o;
    char v[16];
    iq_dsp_source_t iq_src;
    audio_source_t audio_src;
    audio_tx_slot_t tx_slot;
    bool set_iq = false, set_audio = false, set_rx = false, set_tx = false, rx_right = false;
    if ((o = object_of(body, "iq", &e)) && string_in(o, e, "input", v, sizeof(v))) {
        if (!iq_dsp_parse_source(v, &iq_src) || iq_src == IQ_DSP_SRC_NONE || iq_src == IQ_DSP_SRC_TEST)
            return "iq.input must be wm8782 or pcm1808";
        set_iq = true;
    }
    if ((o = object_of(body, "audio", &e))) {
        if (string_in(o, e, "input", v, sizeof(v))) {
            if (!audio_monitor_parse_audio_source(v, &audio_src)) return "audio.input must be pcm1808 or wm8782";
            set_audio = true;
        }
        if (string_in(o, e, "channel", v, sizeof(v))) {
            if (strcmp(v, "left") && strcmp(v, "right")) return "audio.channel must be left or right";
            rx_right = strcmp(v, "right") == 0;
            set_rx = true;
        }
    }
    if ((o = object_of(body, "tx", &e))) {
        if (string_in(o, e, "output", v, sizeof(v)) && strcmp(v, "pcm5102a")) return "tx.output must be pcm5102a";
        if (string_in(o, e, "channel", v, sizeof(v))) {
            if (!parse_tx_channel(v, &tx_slot)) return "tx.channel must be left, right or both";
            set_tx = true;
        }
    }
    if (set_iq) iq_dsp_set_source(iq_src);
    if (set_audio) audio_monitor_set_audio_source(audio_src);
    if (set_rx && audio_monitor_set_rx_slot(rx_right)) bridge_settings_set_rx_slot_is_right(rx_right);
    if (set_tx && audio_monitor_set_tx_slot(tx_slot)) bridge_settings_set_tx_slot((int8_t)tx_slot);
    return NULL;
}

#else  // A1S: one ES8388 codec, carrying either demodulated audio or I/Q (boot-time choice)

static int capabilities_json(char *b, size_t n) {
    return snprintf(b, n,
        "{\"version\":1,\"board\":\"%s\",\"model\":\"ESP32-A1S (ES8388)\",\"firmware_version\":\"%s\","
        "\"pa\":{\"sense\":true,\"emergency\":true},"
        "\"concurrent_inputs\":false,\"input_kind_switch\":\"reboot\","
        "\"inputs\":["
          "{\"id\":\"es8388\",\"chip\":\"ES8388\",\"jack\":\"line in\",\"kinds\":[\"audio\",\"iq\"],\"rate_hz\":%u,\"bits\":16,"
           "\"channels\":[{\"id\":\"left\",\"label\":\"left\"},{\"id\":\"right\",\"label\":\"right\"}]}],"
        "\"outputs\":["
          "{\"id\":\"es8388\",\"chip\":\"ES8388\",\"jack\":\"line out\",\"kinds\":[\"audio\"],\"rate_hz\":%u,"
           "\"channels\":[\"left\",\"right\",\"both\"],\"delivery\":[\"slots\",\"stream\"],\"slots\":%d,\"slot_rate_hz\":%d}],"
        "\"streams\":{\"audio\":{\"ws\":\"/audio\",\"rate_hz\":%u,\"format\":\"s16le_mono\"},"
          "\"iq\":{\"ws_raw\":\"/iq-data\",\"rate_hz\":%u,\"format\":\"s16le_stereo\"}},"
        "\"dsp\":null}",
        BRIDGE_BOARD_NAME, BRIDGE_FIRMWARE_VERSION, (unsigned)bridge_settings_get_sample_rate_hz(),
        (unsigned)bridge_settings_get_sample_rate_hz(), TX_SLOT_COUNT, TX_BUFFER_SAMPLE_RATE_HZ,
        (unsigned)bridge_settings_get_sample_rate_hz(), (unsigned)bridge_settings_get_sample_rate_hz());
}

// The kind saved for the next boot, which can differ from the running one.
static audio_input_mode_t saved_mode(void) {
    char name[8];
    audio_input_mode_t m = AUDIO_INPUT_MODE_AUDIO;
    bridge_settings_get_input_mode_name(name, sizeof(name));
    audio_monitor_parse_input_mode(name, &m);
    return m;
}

static int routing_json(char *b, size_t n, bool reboot_required) {
    bool iq = saved_mode() == AUDIO_INPUT_MODE_IQ;
    unsigned rate = (unsigned)bridge_settings_get_sample_rate_hz();
    return snprintf(b, n,
        "{\"iq\":{\"input\":%s,\"rate_hz\":%u},"
        "\"audio\":{\"input\":%s,\"channel\":\"%s\",\"rate_hz\":%u},"
        "\"tx\":{\"output\":\"es8388\",\"channel\":\"%s\"},\"reboot_required\":%s}",
        iq ? "\"es8388\"" : "null", rate, iq ? "null" : "\"es8388\"",
        audio_monitor_get_rx_slot_is_right() ? "right" : "left", rate,
        tx_channel_name(audio_monitor_get_tx_slot()), reboot_required ? "true" : "false");
}

static const char *routing_apply(const char *body, bool *reboot_required) {
    *reboot_required = false;
    const char *e, *o;
    char v[16];
    int want_mode = -1;  // the input kind the request asks the codec to carry
    bool set_rx = false, set_tx = false, rx_right = false;
    audio_tx_slot_t tx_slot;
    if ((o = object_of(body, "iq", &e)) && string_in(o, e, "input", v, sizeof(v))) {
        if (strcmp(v, "es8388")) return "iq.input must be es8388";
        want_mode = AUDIO_INPUT_MODE_IQ;
    }
    if ((o = object_of(body, "audio", &e))) {
        if (string_in(o, e, "input", v, sizeof(v))) {
            if (strcmp(v, "es8388")) return "audio.input must be es8388";
            if (want_mode == AUDIO_INPUT_MODE_IQ) return "this bridge carries audio or I/Q, not both: set only one";
            want_mode = AUDIO_INPUT_MODE_AUDIO;
        }
        if (string_in(o, e, "channel", v, sizeof(v))) {
            if (strcmp(v, "left") && strcmp(v, "right")) return "audio.channel must be left or right";
            rx_right = strcmp(v, "right") == 0;
            set_rx = true;
        }
    }
    if ((o = object_of(body, "tx", &e))) {
        if (string_in(o, e, "output", v, sizeof(v)) && strcmp(v, "es8388")) return "tx.output must be es8388";
        if (string_in(o, e, "channel", v, sizeof(v))) {
            if (!parse_tx_channel(v, &tx_slot)) return "tx.channel must be left, right or both";
            set_tx = true;
        }
    }
    if (want_mode >= 0 && (audio_input_mode_t)want_mode != saved_mode()) {
        if (!http_control_rate_ok_for_mode(bridge_settings_get_sample_rate_hz(), (audio_input_mode_t)want_mode))
            return "the saved sample rate isn't valid for that input kind; change POST /sample-rate first";
        bridge_settings_set_input_mode_name(audio_monitor_input_mode_name((audio_input_mode_t)want_mode));
        *reboot_required = true;
    }
    if (set_rx && audio_monitor_set_rx_slot(rx_right)) bridge_settings_set_rx_slot_is_right(rx_right);
    if (set_tx && audio_monitor_set_tx_slot(tx_slot)) bridge_settings_set_tx_slot((int8_t)tx_slot);
    return NULL;
}

#endif

// ── HTTP ───────────────────────────────────────────────────────────────────

static esp_err_t capabilities_get(httpd_req_t *req) {
    static char body[1600];
    int n = capabilities_json(body, sizeof(body));
    return send_json(req, body, n);
}

static esp_err_t routing_get(httpd_req_t *req) {
    char body[320];
    int n = routing_json(body, sizeof(body), false);
    return send_json(req, body, n);
}

static void restart_task(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(500));  // let the response leave first
    ESP_LOGW(TAG, "restarting to apply the new input kind");
    esp_restart();
}

static esp_err_t routing_post(httpd_req_t *req) {
    char body[256] = { 0 };
    int len = httpd_req_recv(req, body, req->content_len < sizeof(body) - 1 ? req->content_len : sizeof(body) - 1);
    if (len <= 0) return send_err(req, "empty body");
    bool reboot = false;
    const char *err = routing_apply(body, &reboot);
    if (err) return send_err(req, err);
    char out[320];
    int n = routing_json(out, sizeof(out), reboot);
    esp_err_t r = send_json(req, out, n);
    if (reboot) xTaskCreate(restart_task, "routing_restart", 3072, NULL, tskIDLE_PRIORITY + 1, NULL);
    return r;
}

void io_routing_start(httpd_handle_t server) {
    httpd_uri_t uris[] = {
        { .uri = "/capabilities", .method = HTTP_GET, .handler = capabilities_get },
        { .uri = "/routing", .method = HTTP_GET, .handler = routing_get },
        { .uri = "/routing", .method = HTTP_POST, .handler = routing_post },
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++) {
        if (httpd_register_uri_handler(server, &uris[i]) != ESP_OK) ESP_LOGE(TAG, "could not register %s", uris[i].uri);
    }
    ESP_LOGI(TAG, "ready: GET /capabilities, GET/POST /routing");
}
