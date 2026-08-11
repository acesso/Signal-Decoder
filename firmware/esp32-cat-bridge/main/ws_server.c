#include "ws_server.h"

#include <string.h>
#include <unistd.h>

#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "audio_ws.h"
#include "bridge_config.h"
#include "bridge_state.h"
#include "cat_bridge.h"

static const char *TAG = "ws_server";

static httpd_handle_t s_server = NULL;
// Up to WS_MAX_CLIENTS browser tabs can watch/drive the same CAT session at
// once — the radio is a single shared resource either way (last command on
// the wire wins, same as two people at one physical knob), but there's no
// reason to boot an existing viewer just because a second one showed up.
// -1 marks an empty slot. Guarded by a mutex: written from the HTTP handler
// task on connect/disconnect, read from cat_bridge's UART reader task (via
// ws_server_send_to_client) to broadcast radio->browser bytes.
static int s_client_fds[WS_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;

static void mutate_client_count(bridge_state_t *state, void *ctx) {
    state->ws_client_count = *(uint8_t *)ctx;
}

// Recomputes and publishes the live client count. Call with s_client_mutex
// already held (it only reads s_client_fds, doesn't touch the mutex itself).
static void publish_client_count_locked(void) {
    uint8_t count = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) if (s_client_fds[i] >= 0) count++;
    bridge_state_update(mutate_client_count, &count);
}

static bool add_client_locked(int fd) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) return true; // already tracked (shouldn't happen, but idempotent)
    }
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) { s_client_fds[i] = fd; return true; }
    }
    return false; // full — caller logs and lets the connection through anyway;
                  // httpd's own max_open_sockets is the real backstop
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; return; }
    }
}

// Async-send trampoline: httpd_ws_send_frame() may only be called from the
// handler task that owns the connection's socket; calling it from another
// task (cat_bridge's UART reader) requires httpd_queue_work(), which runs
// this function on the httpd task with the work_arg we pass through. One of
// these is queued per (byte chunk x connected client) — each owns its own
// copy of the data so they can complete independently.
typedef struct {
    uint8_t *data;
    size_t len;
    int fd;
} async_send_ctx_t;

static void async_send_frame(void *arg) {
    async_send_ctx_t *ctx = (async_send_ctx_t *)arg;
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = ctx->data,
        .len = ctx->len,
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, ctx->fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "send_frame_async failed (fd=%d): %s", ctx->fd, esp_err_to_name(err));
    }
    free(ctx->data);
    free(ctx);
}

void ws_server_send_to_client(const uint8_t *data, size_t len) {
    if (!s_server || len == 0) return;

    int fds[WS_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < WS_MAX_CLIENTS; i++) if (s_client_fds[i] >= 0) fds[n++] = s_client_fds[i];
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no client connected — drop silently, radio keeps running

    for (int i = 0; i < n; i++) {
        async_send_ctx_t *ctx = malloc(sizeof(async_send_ctx_t));
        if (!ctx) continue;
        ctx->data = malloc(len);
        if (!ctx->data) { free(ctx); continue; }
        memcpy(ctx->data, data, len);
        ctx->len = len;
        ctx->fd = fds[i];

        if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed, dropping %d bytes for fd=%d", (int)len, fds[i]);
            free(ctx->data);
            free(ctx);
        }
    }
}

static esp_err_t cat_ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        // Initial handshake — add this fd to the active-client set.
        int fd = httpd_req_to_sockfd(req);
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        bool added = add_client_locked(fd);
        publish_client_count_locked();
        xSemaphoreGive(s_client_mutex);
        if (!added) {
            ESP_LOGW(TAG, "CAT client (fd=%d) connected but WS_MAX_CLIENTS (%d) already tracked "
                           "— serving it anyway, but it won't receive broadcasts", fd, WS_MAX_CLIENTS);
        } else {
            ESP_LOGI(TAG, "CAT client connected (fd=%d)", fd);
        }
        return ESP_OK;
    }

    httpd_ws_frame_t frame = { 0 };
    // Length-probe call (payload=NULL, max_len=0): httpd_ws_recv_frame reads
    // the frame header off the wire and fills in the real frame.type/len
    // regardless of what we set beforehand — the BINARY default here is
    // just a harmless placeholder, not something the check below relies on.
    frame.type = HTTPD_WS_TYPE_BINARY;
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ws recv (len probe) failed: %s", esp_err_to_name(err));
        return err;
    }
    if (frame.len == 0) return ESP_OK; // ping/control frame with no payload

    uint8_t *buf = malloc(frame.len + 1);
    if (!buf) return ESP_ERR_NO_MEM;
    frame.payload = buf;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ws recv (payload) failed: %s", esp_err_to_name(err));
        free(buf);
        return err;
    }

    if (frame.type == HTTPD_WS_TYPE_CLOSE) {
        int fd = httpd_req_to_sockfd(req);
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        remove_client_locked(fd);
        publish_client_count_locked();
        xSemaphoreGive(s_client_mutex);
        ESP_LOGI(TAG, "CAT client disconnected (fd=%d)", fd);
    } else if (frame.type == HTTPD_WS_TYPE_BINARY || frame.type == HTTPD_WS_TYPE_TEXT) {
        // Browser -> radio: forward verbatim, from whichever client sent it.
        // The web app's existing CAT layer (useRadioCAT.ts) already writes/
        // reads plain ASCII Kenwood frames over Web Serial; this transport
        // is byte-transparent so that logic doesn't need to change, only
        // the underlying I/O call.
        cat_bridge_write(frame.payload, frame.len);
    }

    free(buf);
    return ESP_OK;
}

// httpd_close_func_t returns void — httpd itself always closes the socket
// after calling this hook, so we only need to clear our own bookkeeping.
// This is the ONLY close_fn httpd supports per server instance — since
// /audio shares this httpd instance with /cat, this hook also untracks the
// closed fd from audio_ws's client set (a no-op if it was never one).
static void on_client_close(httpd_handle_t hd, int sockfd) {
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    remove_client_locked(sockfd);
    publish_client_count_locked();
    xSemaphoreGive(s_client_mutex);
    audio_ws_on_client_close(sockfd);
    ESP_LOGI(TAG, "CAT client socket closed (fd=%d)", sockfd);
    close(sockfd);
}

void ws_server_start(void) {
    s_client_mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < WS_MAX_CLIENTS; i++) s_client_fds[i] = -1;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = WS_SERVER_PORT;
    // Default is 4096 — too tight once /wifi-scan's handler chain
    // (wifi_scan_handler's on-stack result/body buffers calling into
    // wifi_net_scan's own wifi_ap_record_t[32] buffer, ~3.2KB alone) is
    // layered on top of esp_http_server's own per-request stack usage —
    // discovered as a LoadStoreAlignment panic (stack overflow corrupting
    // the call frame) on real hardware when /wifi-scan was first added.
    config.stack_size = 6144;
    // +2 headroom for a short-lived /status/etc request landing alongside
    // every already-open CAT AND audio socket at once (both routes share
    // this one httpd instance/socket pool).
    config.max_open_sockets = WS_MAX_CLIENTS + AUDIO_WS_MAX_CLIENTS + 2;
    config.close_fn = on_client_close;
    // Default is 8 — this server now registers 10 URI handlers (/cat, /audio,
    // /status, /info, /wifi-scan, /reset, /wifi-config, /* OPTIONS, plus
    // control_page's /, /style.css, /app.js), so the default silently
    // overflows (ESP_ERR_HTTPD_HANDLERS_FULL, discovered as a boot-loop on
    // real hardware once control_page.c was added). Rounded up well past
    // the current count for headroom before this needs revisiting again.
    config.max_uri_handlers = 16;
    // Wildcard matching so http_control.c can register a single "/*" OPTIONS
    // handler for CORS preflight instead of one per concrete route — exact
    // routes (/cat, /status, /reset) still match themselves first under this
    // mode, wildcard is only a fallback for anything not otherwise registered.
    config.uri_match_fn = httpd_uri_match_wildcard;

    ESP_ERROR_CHECK(httpd_start(&s_server, &config));

    httpd_uri_t cat_ws_uri = {
        .uri = "/cat",
        .method = HTTP_GET,
        .handler = cat_ws_handler,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &cat_ws_uri));

    ESP_LOGI(TAG, "WebSocket CAT endpoint listening on ws://<device>:%d/cat (up to %d clients)",
             WS_SERVER_PORT, WS_MAX_CLIENTS);
}

httpd_handle_t ws_server_get_httpd(void) {
    return s_server;
}
