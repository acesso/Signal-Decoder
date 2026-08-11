#include "audio_ws.h"

#include <string.h>
#include <unistd.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "bridge_config.h"

static const char *TAG = "audio_ws";

static httpd_handle_t s_server = NULL;
static int s_client_fds[AUDIO_WS_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;
static void (*s_rx_callback)(const int16_t *samples, size_t count) = NULL;

static bool add_client_locked(int fd) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) return true;
    }
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) { s_client_fds[i] = fd; return true; }
    }
    return false;
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; return; }
    }
}

// Same async-send trampoline pattern as ws_server.c's CAT broadcast —
// httpd_ws_send_frame_async() may be called from any task, unlike the
// synchronous send API which requires the handler task that owns the
// socket. One of these per (buffer x connected client).
typedef struct {
    int16_t *samples;
    size_t count;
    int fd;
} async_send_ctx_t;

static void async_send_frame(void *arg) {
    async_send_ctx_t *ctx = (async_send_ctx_t *)arg;
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = (uint8_t *)ctx->samples,
        .len = ctx->count * sizeof(int16_t),
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, ctx->fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "send_frame_async failed (fd=%d): %s", ctx->fd, esp_err_to_name(err));
    }
    free(ctx->samples);
    free(ctx);
}

void audio_ws_send_to_clients(const int16_t *samples, size_t count) {
    if (!s_server || count == 0) return;

    int fds[AUDIO_WS_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) if (s_client_fds[i] >= 0) fds[n++] = s_client_fds[i];
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no client listening — drop silently, same as /cat with no browser open

    size_t bytes = count * sizeof(int16_t);
    for (int i = 0; i < n; i++) {
        async_send_ctx_t *ctx = malloc(sizeof(async_send_ctx_t));
        if (!ctx) continue;
        ctx->samples = malloc(bytes);
        if (!ctx->samples) { free(ctx); continue; }
        memcpy(ctx->samples, samples, bytes);
        ctx->count = count;
        ctx->fd = fds[i];

        if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed, dropping %d samples for fd=%d", (int)count, fds[i]);
            free(ctx->samples);
            free(ctx);
        }
    }
}

void audio_ws_set_rx_callback(void (*cb)(const int16_t *samples, size_t count)) {
    s_rx_callback = cb;
}

static esp_err_t audio_ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        int fd = httpd_req_to_sockfd(req);
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        bool added = add_client_locked(fd);
        xSemaphoreGive(s_client_mutex);
        if (!added) {
            ESP_LOGW(TAG, "audio client (fd=%d) connected but AUDIO_WS_MAX_CLIENTS (%d) already tracked "
                           "— serving it anyway, but it won't receive broadcasts", fd, AUDIO_WS_MAX_CLIENTS);
        } else {
            ESP_LOGI(TAG, "audio client connected (fd=%d)", fd);
        }
        return ESP_OK;
    }

    httpd_ws_frame_t frame = { 0 };
    frame.type = HTTPD_WS_TYPE_BINARY;
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ws recv (len probe) failed: %s", esp_err_to_name(err));
        return err;
    }
    if (frame.len == 0) return ESP_OK;

    uint8_t *buf = malloc(frame.len);
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
        xSemaphoreGive(s_client_mutex);
        ESP_LOGI(TAG, "audio client disconnected (fd=%d)", fd);
    } else if (frame.type == HTTPD_WS_TYPE_BINARY && s_rx_callback) {
        // Odd trailing byte (shouldn't happen — the browser always sends
        // whole Int16 frames) is silently dropped rather than read out of
        // bounds; one lost sample is inaudible.
        s_rx_callback((const int16_t *)frame.payload, frame.len / sizeof(int16_t));
    }

    free(buf);
    return ESP_OK;
}

void audio_ws_on_client_close(int fd) {
    if (!s_client_mutex) return; // audio_ws_start() hasn't run yet — nothing to untrack
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    bool was_tracked = false;
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { was_tracked = true; break; }
    }
    remove_client_locked(fd);
    xSemaphoreGive(s_client_mutex);
    if (was_tracked) ESP_LOGI(TAG, "audio client socket closed (fd=%d)", fd);
}

void audio_ws_start(httpd_handle_t server) {
    s_server = server;
    s_client_mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) s_client_fds[i] = -1;

    httpd_uri_t audio_ws_uri = {
        .uri = "/audio",
        .method = HTTP_GET,
        .handler = audio_ws_handler,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &audio_ws_uri));

    ESP_LOGI(TAG, "WebSocket audio endpoint listening on ws://<device>/audio (up to %d clients)",
             AUDIO_WS_MAX_CLIENTS);
}
