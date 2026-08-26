#include "http_control.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "audio_monitor.h"
#include "bridge_config.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "cat_bridge.h"
#include "cat_log.h"
#include "cpu_monitor.h"
#include "led_status.h"
#include "pa_watchdog.h"
#include "ws_server.h"
#include "wifi_net.h"

static const char *TAG = "http_control";

// Additive-only capability list — see the versioning note in bridge_config.h.
// "audio" means: /audio WebSocket exists, carrying raw 16-bit PCM mono at
// ES8388_SAMPLE_RATE_HZ in both directions (see audio_ws.h/audio_monitor.h)
// — the web app should gate its audio UI on this rather than assuming it.
// "cat_baud" means: POST /cat-baud exists (see cat_baud_handler below).
// "pa_watchdog" means: GET /status reports pa_sense/pa_emergency_tripped
// and POST /pa-emergency-clear exists (see pa_watchdog.h for the full
// safety design this backs).
// "audio_input_select" means: GET /status reports adc_input and
// POST /audio-input exists — lets the browser live-switch the ES8388's ADC
// input mux between its 5 real supported modes (see the ADCCONTROL2
// comment in audio_monitor.c for why this needs to be switchable rather
// than a single hardcoded choice).
// "mic_gain" means: POST /mic-gain exists — lets the browser live-adjust
// the ES8388's MIC preamp gain (see audio_monitor_set_mic_gain_db()), for
// attenuating the onboard MIC1 preamp's bleed-through into other input modes.
// "rx_slot_select" means: GET /status reports rx_slot_right and
// POST /rx-slot exists — lets the browser live-switch which I2S slot
// (left/right) the ADC capture reads, independent of the ADCCONTROL2 mux
// selection (see audio_monitor_set_rx_slot() for why this is a separate axis).
// "led_enable" means: GET /status reports led_enabled and POST /led-enable
// exists — a reversible kill-switch for the status LEDs, to test whether
// their own PWM switching injects noise into the analog audio path.
// "alc_control" means: GET /status reports alc_enabled and POST /alc
// exists — live-toggles the ES8388's Automatic Level Control (see
// audio_monitor_set_alc_enabled()). Confirmed off by the chip's own
// power-on-reset default, exposed as a checkable diagnostic.
// "noise_gate_control" means: GET /status reports noise_gate_enabled and
// POST /noise-gate exists — same reasoning as alc_control, for the ALC's
// Noise Gate sub-feature.
// "cpu_monitor" means: GET /system-stats exists (heap + per-task CPU%/
// core/stack usage) and POST /cpu-freq exists to live-repin the CPU
// frequency between 80/160/240 MHz via esp_pm_configure() — see
// cpu_monitor.h. Diagnostic tooling only, not persisted across reboots.
// "wifi_tx_power_control" means: GET /status reports wifi_tx_power_quarter_dbm
// and POST /wifi-tx-power exists — live-sets the WiFi radio's max TX power
// via esp_wifi_set_max_tx_power() (see wifi_net.h). Applied immediately AND
// persisted to NVS, same pattern as mic_gain.
// "adc_hpf_control" means: GET /status reports adc_hpf_enabled and
// POST /adc-hpf exists — live-toggles the ES8388's ADC digital high-pass
// filter (see audio_monitor_set_adc_hpf_enabled()). UNLIKE alc_control/
// noise_gate_control, this one is ON by the chip's own power-on-reset
// default, so this toggle's diagnostic direction is disabling it, not
// enabling it.
// "sample_rate_select" means: GET /status reports sample_rate_hz and
// POST /sample-rate exists — the /audio WebSocket's wire rate, which IS
// the codec/I2S hardware's actual sample rate too (see
// bridge_config.h/bridge_settings.h — an earlier fixed-4x-oversample
// design was tried and dropped after A/B testing showed no benefit).
// Changing it persists to NVS and REBOOTS the bridge to apply — not a
// live reconfig, same pattern as POST /wifi-config.
// "speaker_amp_control" means: GET /status reports speaker_amp_enabled and
// POST /speaker-amp exists — live-forces the onboard NS4150 speaker amp's
// enable/shutdown GPIO (see audio_monitor_set_speaker_amp_enabled()). A
// class-D amp has its own free-running switching oscillator; exposed as a
// live toggle since the enable-pin's polarity was only ever a guess
// (ES8388_PA_REVERTED), never confirmed on real hardware.
// "cat_log" means: GET /cat-log and POST /cat-log/clear exist — a
// flash-persisted ring buffer of the most recent CAT_LOG_CAPACITY CAT
// frames (see cat_log.h), surviving reboots unlike the control page's own
// browser-only live log, specifically to help diagnose "what was the radio
// doing right before a restart". GET /status reports cat_log_enabled and
// POST /cat-log-enable exists to turn it on/off — defaults OFF (a debug
// feature whose boot-time recovery scan grows with the log's own record
// count; see bridge_settings.c's DEFAULT_CAT_LOG_ENABLED comment for why
// that made it worth defaulting off rather than always-on).
// "audio_mic_sniff" means: ws://<device>/audio-mic-sniff exists — a
// read-only WebSocket broadcasting a copy of every sample block just
// written to the radio's mic input (see audio_sniff.h). Exists because
// the browser -> radio mic path otherwise has no return signal at all;
// this lets an operator actually verify what got sent, separate from
// (and never interfering with) /audio's own real traffic.
// "input_mode_select" means: GET /status reports input_mode and
// POST /input-mode exists — selects whether the line-in jack is captured
// as demodulated mono audio ("audio", broadcast on /audio, the original
// and default mode) or raw wideband I/Q ("iq", stereo capture — I on the
// ADC's left channel, Q on the right — broadcast on the separate
// ws://<device>/iq-data instead, see audio_iq.h). Reboot-to-apply, same
// as sample_rate_select above; POST /sample-rate's own valid-rate list
// depends on which mode is currently selected (audio: 8-48kHz; iq: also
// allows 96kHz, this feature's own default — see http_control.c's
// SUPPORTED_IQ_SAMPLE_RATES_HZ for why that's unverified-but-selectable
// rather than assumed to just work).
// "tx_buffer_playback" means: POST /tx-audio, /tx-play, /tx-stop and
// GET /tx-status exist — lets the browser upload a whole pre-encoded TX
// message once (raw Int16 PCM, mono, 16000Hz — see
// TX_BUFFER_SAMPLE_RATE_HZ in audio_monitor.h) and play it back from an
// in-PSRAM buffer instead of streaming it live over /audio, avoiding the
// Wi-Fi-jitter-causes-audible-glitch problem that streaming has on real
// hardware (see audio_monitor.h's TX buffer playback pool comment for the
// full reasoning). Browser code should check for this feature before using
// those endpoints, same pattern as input_mode_select above — an older
// bridge without this feature simply doesn't register those routes at all.
// NOTE: as of BRIDGE_FIRMWARE_VERSION 0.6.0 this is a 4-slot POOL (see
// audio_monitor.h's TX_SLOT_COUNT), not the single global buffer this
// feature originally shipped with — /tx-audio and /tx-play now REQUIRE a
// ?slot=N query param and GET /tx-status's response shape changed to
// report all slots. The feature string is left unchanged (still the same
// underlying capability, additive per this file's versioning policy) —
// gate on BRIDGE_FIRMWARE_VERSION >= 0.6.0 (GET /info) if a browser client
// needs to distinguish the single-buffer wire shape from the pooled one.
static const char *const BRIDGE_FEATURES[] = {
    "cat", "wifi_config", "wifi_scan", "reset", "audio", "cat_baud", "pa_watchdog",
    "audio_input_select", "mic_gain", "rx_slot_select", "led_enable",
    "alc_control", "noise_gate_control", "cpu_monitor", "wifi_tx_power_control",
    "adc_hpf_control", "sample_rate_select", "speaker_amp_control", "cat_log",
    "audio_mic_sniff", "input_mode_select", "tx_buffer_playback",
};

// The uSDX firmware's own CAT_BAUD menu setting (usdxBLACKBRICK.ino) only
// offers these four — validated against on POST /cat-baud so a typo/garbage
// value can't wedge the UART into a rate the radio could never actually be
// running at.
static const int SUPPORTED_CAT_BAUDS[] = { 9600, 19200, 38400, 57600 };
#define SUPPORTED_CAT_BAUDS_COUNT (sizeof(SUPPORTED_CAT_BAUDS) / sizeof(SUPPORTED_CAT_BAUDS[0]))

static bool is_supported_cat_baud(int baud) {
    for (size_t i = 0; i < SUPPORTED_CAT_BAUDS_COUNT; i++) {
        if (SUPPORTED_CAT_BAUDS[i] == baud) return true;
    }
    return false;
}
#define BRIDGE_FEATURES_COUNT (sizeof(BRIDGE_FEATURES) / sizeof(BRIDGE_FEATURES[0]))

static const char *wifi_state_str(bridge_wifi_state_t s) {
    switch (s) {
        case BRIDGE_WIFI_CONNECTED:    return "connected";
        case BRIDGE_WIFI_CONNECTING:   return "connecting";
        case BRIDGE_WIFI_AP_FALLBACK:  return "ap_fallback";
        case BRIDGE_WIFI_DISCONNECTED:
        default:                      return "disconnected";
    }
}

// Minimal JSON-string escaping — Wi-Fi SSIDs/passwords are normally plain
// ASCII, but nothing stops a network from being named with a `"` or `\` in
// it, and these fields land straight in a JSON response, so they're escaped
// rather than assumed safe. Truncates silently if `out` is too small (a
// garbled tail is preferable to a buffer overflow; these are display-only
// round-trips, not something the caller reconstructs bit-for-bit).
static void json_escape(char *out, size_t out_sz, const char *in) {
    size_t o = 0;
    for (const char *p = in; *p && o + 2 < out_sz; p++) {
        if (*p == '"' || *p == '\\') {
            if (o + 3 >= out_sz) break;
            out[o++] = '\\';
        }
        out[o++] = *p;
    }
    out[o] = '\0';
}

static void set_cors(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
}

static esp_err_t status_handler(httpd_req_t *req) {
    bridge_state_t st;
    bridge_state_get(&st);

    int8_t live_rssi = st.wifi_rssi;
    wifi_net_get_live_rssi(&live_rssi); // best-effort refresh; keeps the cached value if it fails

    char ssid[33], password[65];
    bridge_settings_get_wifi(ssid, sizeof(ssid), password, sizeof(password));
    char ssid_escaped[64];
    json_escape(ssid_escaped, sizeof(ssid_escaped), ssid);
    char bssid[18];
    bridge_settings_get_wifi_bssid(bssid, sizeof(bssid));

    int64_t uptime_s = esp_timer_get_time() / 1000000;

    int8_t tx_power_quarter_dbm = 0;
    wifi_net_get_tx_power_quarter_dbm(&tx_power_quarter_dbm); // best-effort; 0 if WiFi hasn't started yet

    char body[850];
    int n = snprintf(body, sizeof(body),
        "{\"wifi_state\":\"%s\",\"ssid\":\"%s\",\"bssid\":\"%s\",\"rssi\":%d,\"ip\":\"%s\","
        "\"ws_clients\":%u,\"ws_max_clients\":%d,\"radio_linked\":%s,"
        "\"cat_baud\":%d,\"pa_sense\":%s,\"pa_emergency_tripped\":%s,"
        "\"adc_input\":\"%s\",\"rx_slot_right\":%s,\"led_enabled\":%s,"
        "\"alc_enabled\":%s,\"noise_gate_enabled\":%s,\"cpu_freq_mhz\":%d,"
        "\"wifi_tx_power_quarter_dbm\":%d,\"adc_hpf_enabled\":%s,"
        "\"sample_rate_hz\":%u,\"speaker_amp_enabled\":%s,"
        "\"mic_gain_db\":%.1f,\"cat_log_enabled\":%s,"
        "\"input_mode\":\"%s\","
        "\"uptime_s\":%lld}",
        wifi_state_str(st.wifi_state), ssid_escaped, bssid, (int)live_rssi,
        st.ip_addr[0] ? st.ip_addr : "",
        (unsigned)st.ws_client_count, WS_MAX_CLIENTS,
        (esp_timer_get_time() - st.last_radio_rx_us) <= 3000000 ? "true" : "false",
        bridge_settings_get_cat_baud(),
        st.pa_sense ? "true" : "false",
        st.pa_emergency_tripped ? "true" : "false",
        audio_monitor_get_adc_input_name(),
        audio_monitor_get_rx_slot_is_right() ? "true" : "false",
        led_status_get_enabled() ? "true" : "false",
        audio_monitor_get_alc_enabled() ? "true" : "false",
        audio_monitor_get_noise_gate_enabled() ? "true" : "false",
        cpu_monitor_get_freq_mhz(),
        (int)tx_power_quarter_dbm,
        audio_monitor_get_adc_hpf_enabled() ? "true" : "false",
        (unsigned)bridge_settings_get_sample_rate_hz(),
        audio_monitor_get_speaker_amp_enabled() ? "true" : "false",
        (double)audio_monitor_get_mic_gain_db(),
        bridge_settings_get_cat_log_enabled() ? "true" : "false",
        audio_monitor_input_mode_name(audio_monitor_get_input_mode()),
        (long long)uptime_s);
    if (n < 0 || (size_t)n >= sizeof(body)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "status body truncated");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    // Same-origin browser fetches (the web app itself, served from
    // elsewhere) need CORS to read this cross-origin — the bridge has no
    // sensitive control surface behind a missing Origin check, it's a
    // read-only status blob on a LAN-only device.
    set_cors(req);
    return httpd_resp_send(req, body, n);
}

// GET /info — firmware version + capability list, so the web app can gate
// UI on "does this bridge support X" instead of comparing version numbers.
// Queried once when the bridge panel opens, same as /status.
static esp_err_t info_handler(httpd_req_t *req) {
    // 256 was enough when this handler was first written, but
    // BRIDGE_FEATURES[] is additive-only (see its own versioning comment)
    // and had grown to 17 entries by the time this was first bumped to
    // 512 — 256 bytes wasn't enough by then (needed ~288) and this
    // handler was silently returning "info body truncated" on every
    // single call, which broke the control page's entire
    // refreshStatus() (it Promise.all()s /status and /info together and
    // awaits both .json() calls — a non-JSON error body here throws, and
    // since the periodic auto-refresh always calls refreshStatus(true)
    // [silent], that exception had been killing every subsequent status
    // update with no visible error at all). Sized with real headroom
    // (22 entries -> ~380 bytes as of tx_buffer_playback landing) so the
    // next several feature additions don't repeat this exact bug a
    // second time.
    char body[512];
    size_t o = (size_t)snprintf(body, sizeof(body),
        "{\"firmware_version\":\"%s\",\"features\":[", BRIDGE_FIRMWARE_VERSION);
    for (size_t i = 0; i < BRIDGE_FEATURES_COUNT && o < sizeof(body); i++) {
        int n = snprintf(body + o, sizeof(body) - o, "%s\"%s\"", i ? "," : "", BRIDGE_FEATURES[i]);
        if (n < 0 || (size_t)n >= sizeof(body) - o) {
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "info body truncated");
            return ESP_FAIL;
        }
        o += (size_t)n;
    }
    int tail = snprintf(body + o, sizeof(body) - o, "]}");
    if (tail < 0 || (size_t)tail >= sizeof(body) - o) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "info body truncated");
        return ESP_FAIL;
    }
    o += (size_t)tail;

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    return httpd_resp_send(req, body, o);
}

// GET /wifi-scan — blocking active scan for the control page's network
// select box. Deduped/sorted-by-nothing-in-particular list straight from
// wifi_net_scan(); the browser doesn't need anything smarter than "here are
// the networks currently in range."
static esp_err_t wifi_scan_handler(httpd_req_t *req) {
    wifi_net_scan_result_t results[WIFI_NET_SCAN_MAX_RESULTS];
    int count = wifi_net_scan(results, WIFI_NET_SCAN_MAX_RESULTS);
    if (count < 0) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "scan failed");
        return ESP_FAIL;
    }

    char body[WIFI_NET_SCAN_MAX_RESULTS * 48 + 32];
    size_t o = (size_t)snprintf(body, sizeof(body), "{\"networks\":[");
    for (int i = 0; i < count && o < sizeof(body); i++) {
        char ssid_escaped[64];
        json_escape(ssid_escaped, sizeof(ssid_escaped), results[i].ssid);
        int n = snprintf(body + o, sizeof(body) - o, "%s{\"ssid\":\"%s\",\"rssi\":%d}",
                          i ? "," : "", ssid_escaped, (int)results[i].rssi);
        if (n < 0 || (size_t)n >= sizeof(body) - o) {
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "scan body truncated");
            return ESP_FAIL;
        }
        o += (size_t)n;
    }
    int tail = snprintf(body + o, sizeof(body) - o, "]}");
    if (tail < 0 || (size_t)tail >= sizeof(body) - o) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "scan body truncated");
        return ESP_FAIL;
    }
    o += (size_t)tail;

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    return httpd_resp_send(req, body, o);
}

static void restart_task(void *arg) {
    // Give the HTTP response time to actually leave the socket before the
    // reboot tears everything down under it.
    vTaskDelay(pdMS_TO_TICKS(300));
    ESP_LOGW(TAG, "restarting now");
    esp_restart();
}

static esp_err_t reset_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/plain");
    set_cors(req);
    httpd_resp_sendstr(req, "restarting");
    xTaskCreate(restart_task, "bridge_restart", 2048, NULL, tskIDLE_PRIORITY + 1, NULL);
    return ESP_OK;
}

// POST /pa-emergency-clear — un-trips a latched PA safety cutoff (see
// pa_watchdog.h). Deliberately does not require a request body or check
// pa_sense first — the operator calling this is expected to have already
// confirmed by eye/ear that it's actually safe to re-enable the PA, same
// as clearing any other physical safety interlock. Always returns the
// resulting state so the caller can confirm the clear actually took.
static esp_err_t pa_emergency_clear_handler(httpd_req_t *req) {
    pa_watchdog_clear();

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char body[64];
    int n = snprintf(body, sizeof(body), "{\"pa_emergency_tripped\":%s}",
                      pa_watchdog_emergency_tripped() ? "true" : "false");
    return httpd_resp_send(req, body, n);
}

// Shared small-body reader for the POST handlers below — bodies are tiny
// (a couple of short strings), so a single bounded recv into a stack
// buffer is enough; anything larger than the buffer is rejected rather
// than looped/accumulated.
static esp_err_t read_request_body(httpd_req_t *req, char *buf, size_t buf_sz) {
    if (req->content_len >= buf_sz) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body too large");
        return ESP_FAIL;
    }
    int received = httpd_req_recv(req, buf, req->content_len);
    if (received <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "failed to read body");
        return ESP_FAIL;
    }
    buf[received] = '\0';
    return ESP_OK;
}

// Extracts the string value of a top-level "key":"value" pair from a small,
// flat JSON object. Not a general JSON parser — just enough for the fixed,
// known shape of this endpoint's own request body ({"ssid":"...","password":"..."}).
// Returns false if the key isn't found or the value doesn't fit in out_sz.
static bool extract_json_string(const char *json, const char *key, char *out, size_t out_sz) {
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ') p++;
    if (*p != '"') return false;
    p++;
    size_t o = 0;
    while (*p && *p != '"' && o + 1 < out_sz) {
        if (*p == '\\' && *(p + 1)) p++; // skip the escape char, take the next literally (good enough for this endpoint's own inputs)
        out[o++] = *p++;
    }
    if (*p != '"') return false; // ran out of buffer or string before the closing quote
    out[o] = '\0';
    return true;
}

// Extracts the integer value of a top-level "key":123 pair — same "just
// enough for this endpoint's own fixed shape" scope as extract_json_string
// above, not a general JSON parser. Returns false if the key isn't found or
// its value isn't a plain (optionally signed) integer.
static bool extract_json_int(const char *json, const char *key, int *out) {
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ') p++;
    char *end;
    long v = strtol(p, &end, 10);
    if (end == p) return false; // no digits consumed — not a number
    *out = (int)v;
    return true;
}

// Same minimal "just enough for this endpoint's own fixed shape" approach
// as extract_json_int above, for a plain (optionally signed, optionally
// fractional) "key":12.5 pair.
static bool extract_json_float(const char *json, const char *key, float *out) {
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ') p++;
    char *end;
    float v = strtof(p, &end);
    if (end == p) return false; // no digits consumed — not a number
    *out = v;
    return true;
}

// Same minimal-scope approach as extract_json_int/extract_json_float
// above, for a plain "key":true / "key":false literal.
static bool extract_json_bool(const char *json, const char *key, bool *out) {
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ') p++;
    if (strncmp(p, "true", 4) == 0) { *out = true; return true; }
    if (strncmp(p, "false", 5) == 0) { *out = false; return true; }
    return false;
}

// POST /wifi-config — body: {"ssid":"...","password":"...","bssid":"..."}.
// bssid is OPTIONAL — omit it (or send "") to clear any existing pin and
// let esp_wifi pick any AP for the SSID, today's long-standing default.
// See bridge_settings_get_wifi_bssid()'s comment for why this pin exists
// at all: a real fix for intermittent multi-second WiFi-layer stalls on a
// network broadcasting one SSID from multiple same-channel APs. Persists
// to NVS and reboots to apply (same pattern as most consumer Wi-Fi
// devices — there's no clean way to tear down and rejoin a different AP
// without disrupting every open CAT WebSocket anyway, so a full restart is
// no worse than a live reconnect would be from the client's point of view).
static esp_err_t wifi_config_handler(httpd_req_t *req) {
    char body[200];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    char ssid[33] = {0}, password[65] = {0}, bssid[18] = {0};
    if (!extract_json_string(body, "ssid", ssid, sizeof(ssid)) || ssid[0] == '\0') {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or empty \"ssid\"");
        return ESP_FAIL;
    }
    // Password CAN legitimately be empty (open networks) — only ssid is required.
    extract_json_string(body, "password", password, sizeof(password));
    extract_json_string(body, "bssid", bssid, sizeof(bssid));
    if (!wifi_net_is_valid_bssid(bssid)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "\"bssid\" must be \"aa:bb:cc:dd:ee:ff\" format, or omitted/empty to clear");
        return ESP_FAIL;
    }

    if (!bridge_settings_set_wifi(ssid, password) || !bridge_settings_set_wifi_bssid(bssid)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to save to NVS");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/plain");
    set_cors(req);
    httpd_resp_sendstr(req, "saved, restarting");
    xTaskCreate(restart_task, "bridge_restart", 2048, NULL, tskIDLE_PRIORITY + 1, NULL);
    return ESP_OK;
}

// POST /cat-baud — body: {"baud":38400}. Applied immediately (no reboot —
// see the doc comment in http_control.h for why this differs from
// /wifi-config) AND persisted to NVS.
static esp_err_t cat_baud_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    int baud = 0;
    if (!extract_json_int(body, "baud", &baud)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"baud\"");
        return ESP_FAIL;
    }
    if (!is_supported_cat_baud(baud)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "unsupported baud — must be 9600/19200/38400/57600");
        return ESP_FAIL;
    }

    cat_bridge_set_baud(baud);
    bool saved = bridge_settings_set_cat_baud(baud);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[64];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"baud\":%d,\"saved\":%s}", baud, saved ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /audio-input — body: {"input":"lin1"|"lin2"|"mic1"|"mic2"|"diff"}.
// Applied immediately (a live I2C register write — see
// audio_monitor_set_adc_input()) AND persisted to NVS, same pattern as
// /cat-baud. Exists to sweep every ADC input mode the ES8388 actually
// supports, not just a single onboard-mic-vs-P2-jack guess — that guess was
// tried on real hardware and had no audible effect either way, so the
// correct value (if any) needs to be found by testing each option.
static esp_err_t audio_input_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    char input[8];
    if (!extract_json_string(body, "input", input, sizeof(input))) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing \"input\"");
        return ESP_FAIL;
    }
    int idx = audio_monitor_find_adc_input(input);
    if (idx < 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "unsupported input — must be lin1/lin2/mic1/mic2/diff");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_adc_input(idx);
    bool saved = applied && bridge_settings_set_adc_input_name(input);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[96];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"input\":\"%s\",\"applied\":%s,\"saved\":%s}",
        audio_monitor_get_adc_input_name(),
        applied ? "true" : "false", saved ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /mic-gain — body: {"db":0}. Live-adjusts the ES8388's MIC preamp
// (PGA) gain — see audio_monitor_set_mic_gain_db() for why this exists: the
// onboard MIC1 preamp was found bleeding into every ADCCONTROL2 input
// mode, including modes that shouldn't route it at all, and this is the
// one documented (not guessed-bit) way to attenuate it. Applied
// immediately AND persisted to NVS — 21dB was confirmed on real hardware
// to produce a clean, strong signal (see bridge_settings.c's default).
static esp_err_t mic_gain_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    float db = 0;
    if (!extract_json_float(body, "db", &db)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"db\"");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_mic_gain_db(db);
    bool saved = applied && bridge_settings_set_mic_gain_db(db);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[80];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"db\":%.1f,\"applied\":%s,\"saved\":%s}",
        db, applied ? "true" : "false", saved ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /wifi-tx-power — body: {"quarter_dbm":84}. Live-sets the WiFi
// radio's max TX power via wifi_net_set_tx_power_quarter_dbm() — units are
// quarter-dBm (84 == 21.0dBm, the driver's own maximum), valid range [8,84]
// (2..21dBm), snapped internally to the driver's own nearest supported
// step. A low-confidence experiment for whether the WiFi radio's own
// transmit activity couples noise into the analog audio path. Applied
// immediately AND persisted to NVS.
static esp_err_t wifi_tx_power_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    int quarter_dbm = 0;
    if (!extract_json_int(body, "quarter_dbm", &quarter_dbm)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"quarter_dbm\"");
        return ESP_FAIL;
    }

    bool applied = wifi_net_set_tx_power_quarter_dbm((int8_t)quarter_dbm);

    int8_t live_value = (int8_t)quarter_dbm;
    wifi_net_get_tx_power_quarter_dbm(&live_value); // best-effort — falls back to the requested value on failure

    // Persist the driver's own SNAPPED value, not the raw request — the
    // driver only supports discrete steps (see wifi_net_set_tx_power_quarter_dbm()),
    // so persisting the unsnapped request meant GET /status showed a
    // different number right after this POST than it would after a
    // reboot re-applied the persisted value (both eventually converge to
    // the same snapped result, but only after a re-snap on the NEXT boot
    // — in between, /status looked like the setting had drifted/not
    // taken effect).
    bool saved = applied && bridge_settings_set_wifi_tx_power_quarter_dbm(live_value);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[96];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"quarter_dbm\":%d,\"applied\":%s,\"saved\":%s}",
        (int)live_value, applied ? "true" : "false", saved ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /rx-slot — body: {"right":true|false}. Live-switches which I2S slot
// the ADC capture side reads — see audio_monitor_set_rx_slot() for why
// this is a SEPARATE axis from /audio-input's ADCCONTROL2 mux selection: a
// jack's tip signal can land on either ADC channel depending on board
// wiring. Applied immediately (disables/reconfigures/re-enables the RX I2S
// channel, with a brief capture pause) AND persisted to NVS — right was
// confirmed on real hardware to be where this board's P2 jack tip signal
// actually lands.
//
// Rejected outright in AUDIO_INPUT_MODE_IQ: audio_monitor_set_rx_slot()
// unconditionally reconfigures to I2S_SLOT_MODE_MONO, which would silently
// break I/Q's stereo capture. This axis doesn't apply in I/Q mode at all
// (both channels are always kept — see audio_monitor_start()'s iq_mode
// branch); switching back to audio mode (POST /input-mode, reboot) is the
// only way to change it once I/Q is selected. The control page's own
// Left/Right buttons are disabled client-side too, but that's a UX
// nicety, not the real guard — this check is.
static esp_err_t rx_slot_handler(httpd_req_t *req) {
    if (audio_monitor_get_input_mode() == AUDIO_INPUT_MODE_IQ) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "RX slot doesn't apply in I/Q input mode — both channels are always captured");
        return ESP_FAIL;
    }

    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool use_right = false;
    if (!extract_json_bool(body, "right", &use_right)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"right\"");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_rx_slot(use_right);
    bool saved = applied && bridge_settings_set_rx_slot_is_right(use_right);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[80];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"right\":%s,\"applied\":%s,\"saved\":%s}",
        audio_monitor_get_rx_slot_is_right() ? "true" : "false", applied ? "true" : "false", saved ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /led-enable — body: {"enabled":true|false}. One-time reversible test
// for whether the status LEDs' own PWM switching (GPIO22/19, right next to
// the audio codec on this board) is injecting noise into the analog audio
// path — see led_status_set_enabled()'s comment. Applied immediately; NOT
// persisted to NVS (defaults back to on after a reboot unless confirmed to
// actually matter and made permanent later).
static esp_err_t led_enable_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool enabled = true;
    if (!extract_json_bool(body, "enabled", &enabled)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"enabled\"");
        return ESP_FAIL;
    }

    led_status_set_enabled(enabled);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[48];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"enabled\":%s}", led_status_get_enabled() ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /alc — body: {"enabled":true|false}. Live-toggles the ES8388's ALC
// (Automatic Level Control) — see audio_monitor_set_alc_enabled() for why
// this exists: confirmed OFF by the chip's own power-on-reset default, but
// exposed here as a checkable diagnostic (the operator suspected ALC/noise
// gate might be contributing to the already-confirmed audio-noise
// investigation) rather than left as an untested assumption. NOT persisted
// to NVS (a live experiment, not a permanent setting yet).
static esp_err_t alc_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool enabled = false;
    if (!extract_json_bool(body, "enabled", &enabled)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"enabled\"");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_alc_enabled(enabled);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[64];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"enabled\":%s,\"applied\":%s}",
        audio_monitor_get_alc_enabled() ? "true" : "false", applied ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /noise-gate — body: {"enabled":true|false}. Live-toggles the ALC's
// Noise Gate sub-feature — same reasoning as /alc above. Only has an
// audible effect while ALC itself is also enabled. NOT persisted to NVS.
static esp_err_t noise_gate_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool enabled = false;
    if (!extract_json_bool(body, "enabled", &enabled)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"enabled\"");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_noise_gate_enabled(enabled);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[64];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"enabled\":%s,\"applied\":%s}",
        audio_monitor_get_noise_gate_enabled() ? "true" : "false", applied ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /adc-hpf — body: {"enabled":true|false}. Live-toggles the ES8388's
// ADC digital high-pass filter — see audio_monitor_set_adc_hpf_enabled()
// for why this exists: UNLIKE /alc and /noise-gate above, this one is
// confirmed ON by the chip's own power-on-reset default and was never
// touched by the vendored driver either, so "disabling" is the actual
// diagnostic direction — exposed so the operator can compare with/without
// while chasing a reported broadband noise floor that showed up even
// feeding a clean sine wave from a known-clean source. NOT persisted to
// NVS (a live experiment, not a permanent setting yet).
static esp_err_t adc_hpf_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool enabled = true;
    if (!extract_json_bool(body, "enabled", &enabled)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"enabled\"");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_adc_hpf_enabled(enabled);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[64];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"enabled\":%s,\"applied\":%s}",
        audio_monitor_get_adc_hpf_enabled() ? "true" : "false", applied ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// POST /speaker-amp — body: {"enabled":true|false}. Live-forces the onboard
// NS4150 speaker amplifier's own enable/shutdown GPIO — see
// audio_monitor_set_speaker_amp_enabled() for why: it's a class-D
// (free-running switching) amp on the same board as the analog ADC input,
// and its enable-pin polarity (ES8388_PA_REVERTED) was only ever a guess,
// never confirmed. Exposed so the operator can test/compare both real GPIO
// states live while chasing a reported noise floor. NOT persisted to NVS
// (a live experiment, not a permanent setting yet).
static esp_err_t speaker_amp_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool enabled = true;
    if (!extract_json_bool(body, "enabled", &enabled)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"enabled\"");
        return ESP_FAIL;
    }

    bool applied = audio_monitor_set_speaker_amp_enabled(enabled);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[64];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"enabled\":%s,\"applied\":%s}",
        audio_monitor_get_speaker_amp_enabled() ? "true" : "false", applied ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// GET /cat-log — the persisted CAT-frame ring buffer (see cat_log.h),
// oldest-first. Each entry is small (direction + uptime_ms + up-to-40-char
// frame), so CAT_LOG_CAPACITY of them comfortably fits one response;
// no pagination. Reads straight from the in-RAM shadow (never touches
// flash), so this is cheap enough to call on demand from a diagnostics panel.
static esp_err_t cat_log_handler(httpd_req_t *req) {
    // Heap-allocated, not stack — CAT_LOG_CAPACITY entries would blow the
    // httpd worker task's stack if declared locally. PSRAM (MALLOC_CAP_SPIRAM):
    // this is a per-request scratch buffer on the httpd worker task, never
    // touched by the time-critical CAT/audio/PA-watchdog path — see
    // sdkconfig.defaults' CONFIG_SPIRAM comment. Directly relieves the
    // documented history below (this used to collide with the internal
    // heap's fragmentation at the OLD CAT_LOG_CAPACITY of 1000).
    cat_log_entry_t *entries = heap_caps_malloc(sizeof(cat_log_entry_t) * CAT_LOG_CAPACITY, MALLOC_CAP_SPIRAM);
    if (!entries) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
        return ESP_FAIL;
    }
    size_t count = cat_log_read_recent(entries, CAT_LOG_CAPACITY);

    // Streamed as HTTP chunks (httpd_resp_send_chunk), one small buffer
    // reused per entry, rather than building the whole JSON body in one
    // contiguous malloc() first — at the ORIGINAL CAT_LOG_CAPACITY of
    // 1000 (since reduced — see cat_log.h), a full response was ~150KB+
    // of JSON, which reliably failed to allocate as a single
    // block on real hardware (WiFi/TLS/audio buffers fragment this
    // device's ~300KB heap enough that a 96KB largest-free-block was all
    // that remained even with 135KB nominally free) — this was a real,
    // reproduced bug: GET /cat-log returned "out of memory" on every call
    // once the ring buffer filled up, i.e. almost always in practice.
    httpd_resp_set_type(req, "application/json");
    set_cors(req);

    esp_err_t err = httpd_resp_send_chunk(req, "{\"entries\":[", HTTPD_RESP_USE_STRLEN);
    for (size_t i = 0; err == ESP_OK && i < count; i++) {
        char frame_escaped[96];
        json_escape(frame_escaped, sizeof(frame_escaped), entries[i].frame);
        char chunk[192];
        int n = snprintf(chunk, sizeof(chunk),
            "%s{\"from_radio\":%s,\"uptime_ms\":%u,\"frame\":\"%s\"}",
            i ? "," : "", entries[i].from_radio ? "true" : "false",
            (unsigned)entries[i].uptime_ms_at_log, frame_escaped);
        if (n < 0 || (size_t)n >= sizeof(chunk)) {
            err = ESP_FAIL; // frame_escaped is bounded to 96 bytes, so this should never actually trip
            break;
        }
        err = httpd_resp_send_chunk(req, chunk, (size_t)n);
    }
    free(entries);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, "]}", 2);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, NULL, 0); // terminates the chunked response
    return err;
}

// POST /cat-log/clear — erases the persisted CAT log (flash + RAM shadow).
// No body needed. Distinct from the control page's own browser-side "Clear"
// button, which only clears the live DOM view.
static esp_err_t cat_log_clear_handler(httpd_req_t *req) {
    bool cleared = cat_log_clear();

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[32];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"cleared\":%s}", cleared ? "true" : "false");
    return httpd_resp_send(req, resp_body, n);
}

// The bridge's own supported wire/hardware sample rates in
// AUDIO_INPUT_MODE_AUDIO — common steps from the original 8kHz up through
// a typical laptop sound card/browser AudioContext's own native rate
// (48kHz), so a same-rate A/B comparison against a direct sound-card
// capture is possible at the top of the range, with several intermediate
// steps for narrowing down where any audible/measurable difference
// actually starts. Validated against on POST /sample-rate so a
// typo/garbage value can't wedge the codec into an unsupported rate.
static const uint32_t SUPPORTED_SAMPLE_RATES_HZ[] = { 8000, 16000, 22050, 32000, 44100, 48000 };
#define SUPPORTED_SAMPLE_RATES_COUNT (sizeof(SUPPORTED_SAMPLE_RATES_HZ) / sizeof(SUPPORTED_SAMPLE_RATES_HZ[0]))

// AUDIO_INPUT_MODE_IQ's own supported rates — DELIBERATELY a separate,
// smaller list from SUPPORTED_SAMPLE_RATES_HZ above, not a superset: the
// ES8388's vendored driver hardcodes single-speed mode (see
// audio_monitor.c's DLL-disable comment) and its own known-good range is
// 8-32kHz, with 48kHz already flagged as untested and everything above
// that requiring undocumented double-speed register work this firmware
// doesn't attempt yet. 96000 is included as the FEATURE's chosen default
// (selectable, not forced — see bridge_settings.h's input_mode_name
// comment) specifically so it can be bench-tested for real, with 48000
// kept as a known-safe fallback if it doesn't pan out. 22050/44100 were
// removed after real-hardware waterfall captures showed unique, reliably
// reproducible spectral artifacts at exactly those two rates in I/Q mode
// (not present at any other supported rate) — not chasing the root cause
// since these fractional-of-44.1kHz rates have no real use for this
// project's I/Q consumers anyway.
static const uint32_t SUPPORTED_IQ_SAMPLE_RATES_HZ[] = { 8000, 16000, 32000, 48000, 96000 };
#define SUPPORTED_IQ_SAMPLE_RATES_COUNT (sizeof(SUPPORTED_IQ_SAMPLE_RATES_HZ) / sizeof(SUPPORTED_IQ_SAMPLE_RATES_HZ[0]))

static bool is_supported_sample_rate_for_mode(int hz, audio_input_mode_t mode) {
    const uint32_t *rates = mode == AUDIO_INPUT_MODE_IQ ? SUPPORTED_IQ_SAMPLE_RATES_HZ : SUPPORTED_SAMPLE_RATES_HZ;
    size_t count = mode == AUDIO_INPUT_MODE_IQ ? SUPPORTED_IQ_SAMPLE_RATES_COUNT : SUPPORTED_SAMPLE_RATES_COUNT;
    for (size_t i = 0; i < count; i++) {
        if (rates[i] == (uint32_t)hz) return true;
    }
    return false;
}

// POST /sample-rate — body: {"hz":48000}; one of SUPPORTED_SAMPLE_RATES_HZ
// (or SUPPORTED_IQ_SAMPLE_RATES_HZ if the bridge is currently in
// AUDIO_INPUT_MODE_IQ — see audio_monitor_get_input_mode()). Persists to
// NVS and REBOOTS to apply — the wire rate IS the codec/I2S hardware's own
// rate (see bridge_config.h), and live-reconfiguring that exact hardware
// path has already caused one subtle bug in this codebase (see
// audio_monitor.c's RX-slot re-apply comment); rebooting sidesteps
// repeating that class of bug, same pattern as POST /wifi-config.
static esp_err_t sample_rate_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    int hz = 0;
    if (!extract_json_int(body, "hz", &hz)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"hz\"");
        return ESP_FAIL;
    }

    if (!is_supported_sample_rate_for_mode(hz, audio_monitor_get_input_mode())) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
            audio_monitor_get_input_mode() == AUDIO_INPUT_MODE_IQ
                ? "unsupported rate — must be one of 8000/16000/32000/48000/96000"
                : "unsupported rate — must be one of 8000/16000/22050/32000/44100/48000");
        return ESP_FAIL;
    }

    if (!bridge_settings_set_sample_rate_hz((uint32_t)hz)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to save to NVS");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/plain");
    set_cors(req);
    httpd_resp_sendstr(req, "saved, restarting");
    xTaskCreate(restart_task, "bridge_restart", 2048, NULL, tskIDLE_PRIORITY + 1, NULL);
    return ESP_OK;
}

// POST /input-mode — body: {"mode":"audio"|"iq"}. Persists to NVS and
// REBOOTS to apply, same reasoning as /sample-rate above — switching input
// mode means reconfiguring the I2S RX channel's slot mode (mono vs
// stereo) and esp_codec_dev_open()'s channel count, both boot-time-only
// operations in this codebase (see audio_monitor_start()'s iq_mode
// branches), not something with an established live-reconfig path the way
// e.g. ADC input selection has.
//
// Switching modes while the currently-saved sample rate isn't valid in
// the TARGET mode would leave the bridge about to boot into an
// unsupported combination — rather than silently clamping the rate here
// (surprising, and this handler doesn't know what the operator actually
// wants it clamped TO), reject the mode switch and ask them to change the
// rate first. This used to only matter for "audio" (e.g. a saved 96000,
// which is IQ-only) since SUPPORTED_IQ_SAMPLE_RATES_HZ used to be a
// strict superset of SUPPORTED_SAMPLE_RATES_HZ — no longer true now that
// 22050/44100 were removed from the IQ list (see that array's comment),
// so both directions need the check.
static esp_err_t input_mode_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    char mode_name[8];
    if (!extract_json_string(body, "mode", mode_name, sizeof(mode_name))) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing \"mode\"");
        return ESP_FAIL;
    }
    audio_input_mode_t mode;
    if (!audio_monitor_parse_input_mode(mode_name, &mode)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "unsupported mode — must be \"audio\" or \"iq\"");
        return ESP_FAIL;
    }

    uint32_t current_rate = bridge_settings_get_sample_rate_hz();
    if (!is_supported_sample_rate_for_mode((int)current_rate, mode)) {
        char err_msg[128];
        snprintf(err_msg, sizeof(err_msg),
            "current sample rate (%u Hz) isn't valid in %s mode — change POST /sample-rate first",
            (unsigned)current_rate, mode_name);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, err_msg);
        return ESP_FAIL;
    }

    if (!bridge_settings_set_input_mode_name(mode_name)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to save to NVS");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/plain");
    set_cors(req);
    httpd_resp_sendstr(req, "saved, restarting");
    xTaskCreate(restart_task, "bridge_restart", 2048, NULL, tskIDLE_PRIORITY + 1, NULL);
    return ESP_OK;
}

// POST /cat-log-enable — body: {"enabled":true|false}. Turns the
// persistent CAT-frame log (see cat_log.h/GET /cat-log) on or off.
// Defaults OFF — this is a debug feature, and its boot-time flash-
// recovery scan grows with the log's own accumulated record count; left
// running indefinitely on real hardware, that scan grew close enough to
// the 5s task-watchdog timeout to cause a genuine crash-loop (see
// cat_log.c's recover_from_flash() yield fix for the immediate
// mitigation, and bridge_settings.c's DEFAULT_CAT_LOG_ENABLED comment for
// the full story). cat_log_init() only reads this once at boot, so
// (like /sample-rate) this reboots to apply rather than trying to
// live-start/stop the background task and its flash-recovery scan.
static esp_err_t cat_log_enable_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    bool enabled = false;
    if (!extract_json_bool(body, "enabled", &enabled)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"enabled\"");
        return ESP_FAIL;
    }

    if (!bridge_settings_set_cat_log_enabled(enabled)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to save to NVS");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/plain");
    set_cors(req);
    httpd_resp_sendstr(req, "saved, restarting");
    xTaskCreate(restart_task, "bridge_restart", 2048, NULL, tskIDLE_PRIORITY + 1, NULL);
    return ESP_OK;
}

// POST /cpu-freq — body: {"mhz":80|160|240}. Live-repins the ESP32's CPU
// frequency via esp_pm_configure() (min==max, no dynamic scaling — see
// cpu_monitor.c) — a cheap, low-confidence experiment for whether digital
// switching activity is coupling into the analog audio path, separate
// from the already-confirmed onboard-mic-bleed investigation. NOT
// persisted to NVS (defaults back to CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ, 160,
// after every reboot).
static esp_err_t cpu_freq_handler(httpd_req_t *req) {
    char body[64];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    int mhz = 0;
    if (!extract_json_int(body, "mhz", &mhz)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or invalid \"mhz\"");
        return ESP_FAIL;
    }

    bool applied = cpu_monitor_set_freq_mhz(mhz);
    if (!applied) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "unsupported frequency — must be 80/160/240");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[48];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"mhz\":%d,\"applied\":true}", cpu_monitor_get_freq_mhz());
    return httpd_resp_send(req, resp_body, n);
}

// Shared by all four /tx-* handlers below — parses the mandatory ?slot=N
// query param via httpd_query_key_value() (ESP-IDF's plain query-string
// parser; no wildcard URI registration needed since the path itself never
// varies, only the query string does). Sends its own 400 and returns false
// on anything wrong (missing param, non-numeric, out of [0, TX_SLOT_COUNT))
// so every caller can just do `if (!tx_parse_slot_param(req, &slot)) return
// ESP_FAIL;` without duplicating the error response.
static bool tx_parse_slot_param(httpd_req_t *req, int *slot_out) {
    char query[32];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing ?slot=N query parameter");
        return false;
    }
    char slot_str[8];
    if (httpd_query_key_value(query, "slot", slot_str, sizeof(slot_str)) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing ?slot=N query parameter");
        return false;
    }
    char *end;
    long v = strtol(slot_str, &end, 10);
    if (end == slot_str || v < 0 || v >= TX_SLOT_COUNT) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "slot must be an integer in [0, 4)");
        return false;
    }
    *slot_out = (int)v;
    return true;
}

// POST /tx-audio?slot=N — body: raw Int16 PCM bytes (NOT JSON — a binary
// body), mono, fixed at MIC_SEND_SAMPLE_RATE_HZ (16000 Hz), the exact same
// wire format /audio's live mic-send path already uses (see that constant's
// comment in audio_monitor.c). See audio_monitor.h's TX buffer playback
// pool comment for why this whole feature exists: streaming TX audio live,
// chunk by chunk over /audio, means any single chunk's Wi-Fi jitter is
// instantly audible in the transmitted signal — uploading the WHOLE message
// once up front and playing it back from a local buffer removes the network
// from the timing picture entirely for the rest of the transmission. slot
// (0..TX_SLOT_COUNT-1, see tx_parse_slot_param() above) selects which of the
// TX_SLOT_COUNT independent buffers this upload lands in — see
// audio_monitor.h for why the pool exists (one global buffer meant an
// auto-CQ loop and a queued reply silently clobbered each other).
//
// Reads the body with a plain loop over httpd_req_recv() rather than this
// file's usual read_request_body() helper — that helper's whole design
// (bounded single recv into a small stack buffer) assumes a body of at
// most a couple hundred bytes; this one can be very roughly 500KB (15s of
// 16kHz mono Int16), both too big for any stack buffer this codebase uses
// elsewhere and too big to guarantee arrives in one httpd_req_recv() call
// (esp_http_server hands back whatever's currently in the socket's recv
// buffer per call, which is bounded by the TCP window, not by
// content_len) — the same "loop until you have it all" requirement
// httpd_ws_recv_frame() already handles internally for WebSocket frames,
// done by hand here since httpd_req_recv() is the plain-HTTP-POST
// equivalent and doesn't do that looping itself.
static esp_err_t tx_audio_handler(httpd_req_t *req) {
    int slot;
    if (!tx_parse_slot_param(req, &slot)) return ESP_FAIL;

    audio_monitor_tx_status_t status;
    audio_monitor_tx_get_status(&status);
    if (status.playing && status.playing_slot == slot) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "this slot is currently playing — call POST /tx-stop first");
        return ESP_FAIL;
    }

    size_t content_len = req->content_len;
    if (content_len == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
        return ESP_FAIL;
    }
    // Odd byte counts can't be valid Int16 PCM — reject up front rather
    // than silently truncating the last dangling byte.
    if (content_len % sizeof(int16_t) != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body length must be a multiple of 2 (Int16 PCM)");
        return ESP_FAIL;
    }
    // Loose sanity cap, not a precisely-tuned limit — 5 minutes at 16kHz
    // mono Int16 per slot is already far beyond any realistic FT8/FT4
    // message (both protocols top out well under 20s) and comfortably
    // inside the 8MB PSRAM budget even across all TX_SLOT_COUNT slots (see
    // audio_monitor.h's audio_monitor_tx_buffer_upload() comment for the
    // full worst-case-vs-realistic arithmetic); this exists purely to
    // reject a garbled/misdirected request with a clear 400 instead of a
    // multi-megabyte allocation attempt that either succeeds pointlessly or
    // fails confusingly deep inside audio_monitor_tx_buffer_upload().
    size_t max_bytes = (size_t)TX_BUFFER_SAMPLE_RATE_HZ * sizeof(int16_t) * 300;
    if (content_len > max_bytes) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body too large — must be under 5 minutes of audio");
        return ESP_FAIL;
    }

    // PSRAM (MALLOC_CAP_SPIRAM) — this is a plain socket-recv scratch
    // buffer (httpd_req_recv() -> lwIP recv(), not a peripheral DMA
    // transfer), same reasoning as ws_server.c's identical per-frame
    // receive buffer; freed at the end of this handler regardless of
    // outcome — audio_monitor_tx_buffer_upload() below makes its OWN
    // separate PSRAM copy for long-term storage; this one only needs to
    // live for the duration of this request.
    uint8_t *recv_buf = heap_caps_malloc(content_len, MALLOC_CAP_SPIRAM);
    if (!recv_buf) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to allocate receive buffer");
        return ESP_FAIL;
    }

    size_t received_total = 0;
    while (received_total < content_len) {
        int received = httpd_req_recv(req, (char *)recv_buf + received_total, content_len - received_total);
        if (received <= 0) {
            if (received == HTTPD_SOCK_ERR_TIMEOUT) continue; // recv_wait_timeout hit mid-transfer — retry, same as esp-idf's own upload examples
            ESP_LOGW(TAG, "tx-audio body recv failed at %u/%u bytes (slot %d)", (unsigned)received_total, (unsigned)content_len, slot);
            free(recv_buf);
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "failed to read full body");
            return ESP_FAIL;
        }
        received_total += (size_t)received;
    }

    bool saved = audio_monitor_tx_buffer_upload(slot, (const int16_t *)recv_buf, received_total);
    free(recv_buf);
    if (!saved) {
        // Only real failure path left here is a PSRAM allocation failure
        // inside audio_monitor_tx_buffer_upload() itself (the in-progress
        // check above already ruled out the other false case) — genuinely
        // out of PSRAM, not something retrying immediately would fix.
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to store TX buffer (out of PSRAM?)");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[112];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"slot\":%d,\"bytes\":%u,\"duration_ms\":%u,\"hash\":\"%08x\",\"saved\":true}",
                      slot, (unsigned)audio_monitor_tx_buffer_byte_count(slot),
                      (unsigned)audio_monitor_tx_buffer_duration_ms(slot), (unsigned)audio_monitor_tx_slot_hash(slot));
    return httpd_resp_send(req, resp_body, n);
}

// POST /tx-play?slot=N — no body. Starts the dedicated playback task (see
// audio_monitor_tx_play()'s own comment for why this MUST be a genuinely
// separate FreeRTOS task, not more work stuffed into this httpd worker
// context) reading from slot. Rejects with 400 if slot has no buffer
// uploaded, or ANY slot (not just this one) is already playing/starting —
// this board has exactly one audio output path, so two slots can never
// play "simultaneously" — audio_monitor_tx_play() itself makes both checks
// atomically enough to avoid a double-start race from two back-to-back
// POSTs (see s_tx_play_task_alive_slot's comment in audio_monitor.c).
static esp_err_t tx_play_handler(httpd_req_t *req) {
    int slot;
    if (!tx_parse_slot_param(req, &slot)) return ESP_FAIL;

    if (!audio_monitor_tx_buffer_ready(slot)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "no TX buffer uploaded to this slot — call POST /tx-audio first");
        return ESP_FAIL;
    }
    if (!audio_monitor_tx_play(slot)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "a slot is already playing — only one slot can play at a time");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[64];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"slot\":%d,\"playing\":true,\"duration_ms\":%u}",
                      slot, (unsigned)audio_monitor_tx_buffer_duration_ms(slot));
    return httpd_resp_send(req, resp_body, n);
}

// POST /tx-clear?slot=N — no body. Marks slot empty (as if never uploaded)
// — see audio_monitor_tx_buffer_clear()'s own comment for why this exists
// as a real firmware call rather than something the browser fakes purely
// client-side: a slot-pool UI showing "removed" for a message that's
// actually still sitting in the device's PSRAM, ready to play the moment
// anything hits POST /tx-play against it, would be actively misleading.
// Rejects with 400 if slot is the one currently playing (matching
// POST /tx-audio's identical rule) — clearing a DIFFERENT slot mid-
// playback is always allowed.
static esp_err_t tx_clear_handler(httpd_req_t *req) {
    int slot;
    if (!tx_parse_slot_param(req, &slot)) return ESP_FAIL;

    if (!audio_monitor_tx_buffer_clear(slot)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "this slot is currently playing — call POST /tx-stop first");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[32];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"slot\":%d,\"cleared\":true}", slot);
    return httpd_resp_send(req, resp_body, n);
}

// GET /tx-status — no body, no query params (reports ALL slots at once —
// see audio_monitor_tx_get_status()). Deliberately cheap: that call only
// reads already-computed atomics plus TX_SLOT_COUNT small per-slot structs,
// no I/O, safe for a browser progress bar / queue-lookahead panel to poll
// every few hundred ms continuously.
static esp_err_t tx_status_handler(httpd_req_t *req) {
    audio_monitor_tx_status_t status;
    audio_monitor_tx_get_status(&status);

    // Sized generously above the worst case (all 4 slots at the loose
    // 5-minute/slot sanity cap: "bytes" up to 7 digits, "duration_ms" up to
    // 6 digits) rather than tightly — this is a poll-friendly status
    // endpoint, not a hot path where a few dozen spare stack bytes matter.
    char resp_body[512];
    int n = snprintf(resp_body, sizeof(resp_body),
                      "{\"slots\":[{\"slot\":0,\"ready\":%s,\"bytes\":%u,\"duration_ms\":%u,\"hash\":\"%08x\"},"
                      "{\"slot\":1,\"ready\":%s,\"bytes\":%u,\"duration_ms\":%u,\"hash\":\"%08x\"},"
                      "{\"slot\":2,\"ready\":%s,\"bytes\":%u,\"duration_ms\":%u,\"hash\":\"%08x\"},"
                      "{\"slot\":3,\"ready\":%s,\"bytes\":%u,\"duration_ms\":%u,\"hash\":\"%08x\"}],"
                      "\"playing_slot\":%d,\"playing\":%s,\"position_ms\":%u,\"duration_ms\":%u}",
                      status.slots[0].ready ? "true" : "false", (unsigned)status.slots[0].byte_count, (unsigned)status.slots[0].duration_ms, (unsigned)status.slots[0].hash,
                      status.slots[1].ready ? "true" : "false", (unsigned)status.slots[1].byte_count, (unsigned)status.slots[1].duration_ms, (unsigned)status.slots[1].hash,
                      status.slots[2].ready ? "true" : "false", (unsigned)status.slots[2].byte_count, (unsigned)status.slots[2].duration_ms, (unsigned)status.slots[2].hash,
                      status.slots[3].ready ? "true" : "false", (unsigned)status.slots[3].byte_count, (unsigned)status.slots[3].duration_ms, (unsigned)status.slots[3].hash,
                      status.playing_slot, status.playing ? "true" : "false",
                      (unsigned)status.position_ms, (unsigned)status.duration_ms);
    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    return httpd_resp_send(req, resp_body, n);
}

// POST /tx-stop — no body, no query params (stops whatever is playing,
// regardless of which slot). Signals the playback task to stop at its next
// chunk boundary and blocks briefly until it actually has (see
// audio_monitor_tx_stop()'s own bounded-wait comment) — always returns 200
// with the resulting state, including the trivial "nothing was playing"
// case (stopped_slot -1), rather than treating that as an error.
static esp_err_t tx_stop_handler(httpd_req_t *req) {
    int stopped_slot = -1;
    bool stopped = audio_monitor_tx_stop(&stopped_slot);

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    char resp_body[48];
    int n = snprintf(resp_body, sizeof(resp_body), "{\"stopped\":%s,\"slot\":%d}", stopped ? "true" : "false", stopped_slot);
    return httpd_resp_send(req, resp_body, n);
}

// GET /system-stats — heap usage + per-task CPU%/core/stack-headroom. Kept
// as its own endpoint (not folded into GET /status) since it's meaningfully
// larger and meant to be polled on its own cadence by a live-refreshing
// diagnostics panel, not fetched every time any other status field is needed.
static esp_err_t system_stats_handler(httpd_req_t *req) {
    cpu_monitor_heap_t heap;
    cpu_monitor_get_heap(&heap);

    // RX-loop timing — see audio_monitor_get_rx_timing()'s own comment;
    // read-and-reset, so each GET reports the max seen since the LAST GET.
    audio_monitor_rx_timing_t rx_timing;
    audio_monitor_get_rx_timing(&rx_timing);

    char tasks_json[1536];
    int tasks_len = cpu_monitor_write_tasks_json(tasks_json, sizeof(tasks_json));
    if (tasks_len < 0) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "task stats buffer too small");
        return ESP_FAIL;
    }

    char body[1850];
    int n = snprintf(body, sizeof(body),
        "{\"cpu_freq_mhz\":%d,\"heap_free\":%u,\"heap_min_free\":%u,\"heap_total\":%u,"
        "\"heap_largest_free_block\":%u,\"dma_free\":%u,\"dma_largest_free_block\":%u,"
        "\"rx_max_loop_interval_us\":%lld,\"rx_max_read_duration_us\":%lld,"
        "\"rx_max_broadcast_duration_us\":%lld,\"rx_loop_count\":%u,"
        "\"tasks\":%s}",
        cpu_monitor_get_freq_mhz(),
        (unsigned)heap.free_bytes, (unsigned)heap.min_free_bytes, (unsigned)heap.total_bytes,
        (unsigned)heap.largest_free_block_bytes,
        (unsigned)heap.dma_free_bytes, (unsigned)heap.dma_largest_free_block_bytes,
        (long long)rx_timing.max_loop_interval_us, (long long)rx_timing.max_read_duration_us,
        (long long)rx_timing.max_broadcast_duration_us, (unsigned)rx_timing.loop_count,
        tasks_json);
    if (n < 0 || (size_t)n >= sizeof(body)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "system-stats body truncated");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    set_cors(req);
    return httpd_resp_send(req, body, n);
}

// Browsers preflight cross-origin POST with OPTIONS — answer it so the web
// app's fetch() to any POST route doesn't fail the preflight before the
// real request.
static esp_err_t options_handler(httpd_req_t *req) {
    set_cors(req);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_send(req, NULL, 0);
}

void http_control_start(void) {
    httpd_handle_t server = ws_server_get_httpd();
    if (!server) {
        ESP_LOGE(TAG, "ws_server_get_httpd() returned NULL — call http_control_start() after ws_server_start()");
        return;
    }

    httpd_uri_t status_uri       = { .uri = "/status",      .method = HTTP_GET,     .handler = status_handler };
    httpd_uri_t info_uri         = { .uri = "/info",        .method = HTTP_GET,     .handler = info_handler };
    httpd_uri_t wifi_scan_uri    = { .uri = "/wifi-scan",   .method = HTTP_GET,     .handler = wifi_scan_handler };
    httpd_uri_t reset_uri        = { .uri = "/reset",       .method = HTTP_POST,    .handler = reset_handler };
    httpd_uri_t wifi_config_uri  = { .uri = "/wifi-config", .method = HTTP_POST,    .handler = wifi_config_handler };
    httpd_uri_t cat_baud_uri     = { .uri = "/cat-baud",    .method = HTTP_POST,    .handler = cat_baud_handler };
    httpd_uri_t pa_clear_uri     = { .uri = "/pa-emergency-clear", .method = HTTP_POST, .handler = pa_emergency_clear_handler };
    httpd_uri_t audio_input_uri = { .uri = "/audio-input", .method = HTTP_POST, .handler = audio_input_handler };
    httpd_uri_t mic_gain_uri    = { .uri = "/mic-gain",    .method = HTTP_POST, .handler = mic_gain_handler };
    httpd_uri_t wifi_tx_power_uri = { .uri = "/wifi-tx-power", .method = HTTP_POST, .handler = wifi_tx_power_handler };
    httpd_uri_t rx_slot_uri     = { .uri = "/rx-slot",     .method = HTTP_POST, .handler = rx_slot_handler };
    httpd_uri_t led_enable_uri = { .uri = "/led-enable", .method = HTTP_POST, .handler = led_enable_handler };
    httpd_uri_t alc_uri         = { .uri = "/alc",         .method = HTTP_POST, .handler = alc_handler };
    httpd_uri_t noise_gate_uri  = { .uri = "/noise-gate",  .method = HTTP_POST, .handler = noise_gate_handler };
    httpd_uri_t cpu_freq_uri    = { .uri = "/cpu-freq",    .method = HTTP_POST, .handler = cpu_freq_handler };
    httpd_uri_t system_stats_uri = { .uri = "/system-stats", .method = HTTP_GET, .handler = system_stats_handler };
    httpd_uri_t adc_hpf_uri      = { .uri = "/adc-hpf",      .method = HTTP_POST, .handler = adc_hpf_handler };
    httpd_uri_t sample_rate_uri  = { .uri = "/sample-rate",  .method = HTTP_POST, .handler = sample_rate_handler };
    httpd_uri_t input_mode_uri  = { .uri = "/input-mode",  .method = HTTP_POST, .handler = input_mode_handler };
    httpd_uri_t cat_log_enable_uri = { .uri = "/cat-log-enable", .method = HTTP_POST, .handler = cat_log_enable_handler };
    httpd_uri_t speaker_amp_uri  = { .uri = "/speaker-amp",  .method = HTTP_POST, .handler = speaker_amp_handler };
    httpd_uri_t cat_log_uri       = { .uri = "/cat-log",       .method = HTTP_GET,  .handler = cat_log_handler };
    httpd_uri_t cat_log_clear_uri = { .uri = "/cat-log/clear", .method = HTTP_POST, .handler = cat_log_clear_handler };
    httpd_uri_t tx_audio_uri     = { .uri = "/tx-audio",   .method = HTTP_POST, .handler = tx_audio_handler };
    httpd_uri_t tx_play_uri      = { .uri = "/tx-play",    .method = HTTP_POST, .handler = tx_play_handler };
    httpd_uri_t tx_status_uri    = { .uri = "/tx-status",  .method = HTTP_GET,  .handler = tx_status_handler };
    httpd_uri_t tx_stop_uri      = { .uri = "/tx-stop",    .method = HTTP_POST, .handler = tx_stop_handler };
    httpd_uri_t tx_clear_uri     = { .uri = "/tx-clear",   .method = HTTP_POST, .handler = tx_clear_handler };
    httpd_uri_t options_uri      = { .uri = "/*",           .method = HTTP_OPTIONS, .handler = options_handler };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &info_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_scan_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &reset_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_config_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cat_baud_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &pa_clear_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &audio_input_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &mic_gain_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_tx_power_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &rx_slot_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &led_enable_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &alc_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &noise_gate_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cpu_freq_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &system_stats_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &adc_hpf_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &sample_rate_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &input_mode_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cat_log_enable_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &speaker_amp_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cat_log_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cat_log_clear_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &tx_audio_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &tx_play_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &tx_status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &tx_stop_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &tx_clear_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &options_uri));

    ESP_LOGI(TAG, "control endpoints ready: GET /status, GET /info, GET /wifi-scan, POST /reset, "
                   "POST /wifi-config, POST /cat-baud, POST /pa-emergency-clear, POST /audio-input, POST /mic-gain, POST /rx-slot, POST /led-enable");
}
