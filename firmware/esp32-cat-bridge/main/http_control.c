#include "http_control.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "ws_server.h"
#include "wifi_net.h"

static const char *TAG = "http_control";

// Additive-only capability list — see the versioning note in bridge_config.h.
// "audio" is deliberately NOT listed yet: no WebRTC/audio firmware exists,
// and the web app treats an absent flag as "not supported", so there is
// nothing to reserve here beyond this comment. Add the string literally
// once real audio support ships.
static const char *const BRIDGE_FEATURES[] = {
    "cat", "wifi_config", "wifi_scan", "reset",
};
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

    int64_t uptime_s = esp_timer_get_time() / 1000000;

    char body[320];
    int n = snprintf(body, sizeof(body),
        "{\"wifi_state\":\"%s\",\"ssid\":\"%s\",\"rssi\":%d,\"ip\":\"%s\","
        "\"ws_clients\":%u,\"ws_max_clients\":%d,\"radio_linked\":%s,"
        "\"uptime_s\":%lld}",
        wifi_state_str(st.wifi_state), ssid_escaped, (int)live_rssi,
        st.ip_addr[0] ? st.ip_addr : "",
        (unsigned)st.ws_client_count, WS_MAX_CLIENTS,
        (esp_timer_get_time() - st.last_radio_rx_us) <= 3000000 ? "true" : "false",
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
    char body[256];
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

// POST /wifi-config — body: {"ssid":"...","password":"..."}. Persists to
// NVS and reboots to apply (same pattern as most consumer Wi-Fi devices —
// there's no clean way to tear down and rejoin a different AP without
// disrupting every open CAT WebSocket anyway, so a full restart is no
// worse than a live reconnect would be from the client's point of view).
static esp_err_t wifi_config_handler(httpd_req_t *req) {
    char body[160];
    if (read_request_body(req, body, sizeof(body)) != ESP_OK) return ESP_FAIL;

    char ssid[33] = {0}, password[65] = {0};
    if (!extract_json_string(body, "ssid", ssid, sizeof(ssid)) || ssid[0] == '\0') {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing or empty \"ssid\"");
        return ESP_FAIL;
    }
    // Password CAN legitimately be empty (open networks) — only ssid is required.
    extract_json_string(body, "password", password, sizeof(password));

    if (!bridge_settings_set_wifi(ssid, password)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "failed to save to NVS");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/plain");
    set_cors(req);
    httpd_resp_sendstr(req, "saved, restarting");
    xTaskCreate(restart_task, "bridge_restart", 2048, NULL, tskIDLE_PRIORITY + 1, NULL);
    return ESP_OK;
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
    httpd_uri_t options_uri      = { .uri = "/*",           .method = HTTP_OPTIONS, .handler = options_handler };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &info_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_scan_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &reset_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_config_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &options_uri));

    ESP_LOGI(TAG, "control endpoints ready: GET /status, GET /info, GET /wifi-scan, POST /reset, POST /wifi-config");
}
