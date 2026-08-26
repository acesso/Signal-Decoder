#include "audio_sniff.h"

#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"

#include "bridge_config.h"

static const char *TAG = "audio_sniff";

// Deliberately small — this is a debug tap, not a feature meant for
// several simultaneous viewers the way /cat's WS_MAX_CLIENTS is.
#define AUDIO_SNIFF_MAX_CLIENTS 2

// Per-client in-flight depth — was a single pending flag (depth 1) until
// 2026-08-25: real-hardware reports of the sniffer visibly cutting out
// during TX buffer uploads/playback (concurrent core-0 PSRAM/WiFi activity
// stalling this endpoint's own httpd_queue_work() dispatch) pointed at the
// exact same zero-slack failure mode audio_iq.c's IQ_RING_DEPTH already
// exists to fix for /iq-data — ANY brief stall meant the very next
// audio_sniff_broadcast() call found the single slot still busy and
// dropped that frame outright. Unlike audio_iq.c's fixed-size ring (that
// endpoint's frame size is knowable at boot from the codec's configured
// rate), this endpoint's frame size varies with whatever chunk size
// produced it (a live /audio mic-send frame vs. tx_play_task's fixed
// TX_PLAY_CHUNK_SAMPLES), so this keeps per-frame heap_caps_malloc()
// (PSRAM, same as before) rather than a fixed-capacity preallocated ring —
// only the DEPTH of how many frames can be in flight at once changed, from
// 1 to SNIFF_MAX_IN_FLIGHT.
#define SNIFF_MAX_IN_FLIGHT 20

static httpd_handle_t s_server = NULL;
static int s_client_fds[AUDIO_SNIFF_MAX_CLIENTS];
// Same reasoning as audio_ws.c's identical field — a client whose TCP
// receive window is stuck full fails httpd_ws_send_frame_async() forever
// otherwise; see that file's comment for the full real-hardware history.
static int s_send_fail_count[AUDIO_SNIFF_MAX_CLIENTS];
// Counting semaphore, not a bool — see SNIFF_MAX_IN_FLIGHT's comment.
// Starts full (SNIFF_MAX_IN_FLIGHT tokens available); audio_sniff_broadcast()
// takes a token before dispatching a frame for this client, async_send_frame()
// gives it back once that send completes — so up to SNIFF_MAX_IN_FLIGHT
// frames can be queued/in-flight per client before a new one is dropped,
// same "don't let one slow client build an unbounded backlog, just give it
// real slack instead of none" principle as audio_iq.c's ring.
static SemaphoreHandle_t s_in_flight[AUDIO_SNIFF_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;

#define MAX_CONSECUTIVE_SEND_FAILURES 8

static bool add_client_locked(int fd) {
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) return true;
    }
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) {
            s_client_fds[i] = fd;
            s_send_fail_count[i] = 0;
            // Fresh in-flight budget for this slot — drop anything left
            // over from a previous client that used this same slot index.
            while (xSemaphoreTake(s_in_flight[i], 0) == pdTRUE) { /* drain */ }
            for (int t = 0; t < SNIFF_MAX_IN_FLIGHT; t++) xSemaphoreGive(s_in_flight[i]);
            return true;
        }
    }
    return false;
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; s_send_fail_count[i] = 0; return; }
    }
}

static int record_send_result_locked(int fd, bool ok) {
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) {
            s_send_fail_count[i] = ok ? 0 : s_send_fail_count[i] + 1;
            return s_send_fail_count[i];
        }
    }
    return 0;
}

typedef struct {
    int16_t *samples;
    size_t count;
    int fd;
    int slot; // which s_in_flight[] token to return once this send completes
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

    xSemaphoreGive(s_in_flight[ctx->slot]); // return this frame's in-flight token

    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    int fail_count = record_send_result_locked(ctx->fd, err == ESP_OK);
    xSemaphoreGive(s_client_mutex);
    if (fail_count >= MAX_CONSECUTIVE_SEND_FAILURES) {
        ESP_LOGW(TAG, "sniff client (fd=%d) failed %d consecutive sends — forcing close (likely a stuck/dead connection)",
                 ctx->fd, fail_count);
        httpd_sess_trigger_close(s_server, ctx->fd);
    }

    free(ctx->samples);
    free(ctx);
}

void audio_sniff_broadcast(const int16_t *samples, size_t count) {
    if (!s_server || count == 0) return;

    // Only fds with an available in-flight token — see SNIFF_MAX_IN_FLIGHT's
    // comment. A client that's fallen behind (SNIFF_MAX_IN_FLIGHT frames
    // already queued/in-flight) just misses this newest frame instead of
    // building an unbounded backlog that starves the shared httpd worker
    // task (the real hardware lockup this guards against).
    int fds[AUDIO_SNIFF_MAX_CLIENTS];
    int slots[AUDIO_SNIFF_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        if (s_client_fds[i] >= 0 && xSemaphoreTake(s_in_flight[i], 0) == pdTRUE) {
            fds[n] = s_client_fds[i];
            slots[n] = i;
            n++;
        }
    }
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no one watching, or all clients' in-flight budgets are exhausted

    // PSRAM — see audio_ws.c's identical broadcast path for why: purely
    // transient staging for httpd_ws_send_frame_async(), no codec/DMA
    // involvement, and moving frequent small alloc/free churn like this
    // off internal RAM helps avoid causing the kind of fragmentation that
    // broke audio_task's read buffer on real hardware.
    size_t bytes = count * sizeof(int16_t);
    for (int i = 0; i < n; i++) {
        async_send_ctx_t *ctx = heap_caps_malloc(sizeof(async_send_ctx_t), MALLOC_CAP_SPIRAM);
        if (!ctx) { xSemaphoreGive(s_in_flight[slots[i]]); continue; }
        ctx->samples = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
        if (!ctx->samples) {
            free(ctx);
            xSemaphoreGive(s_in_flight[slots[i]]);
            continue;
        }
        memcpy(ctx->samples, samples, bytes);
        ctx->count = count;
        ctx->fd = fds[i];
        ctx->slot = slots[i];

        if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed, dropping %d samples for fd=%d", (int)count, fds[i]);
            free(ctx->samples);
            free(ctx);
            xSemaphoreGive(s_in_flight[slots[i]]);
        }
    }
}

static esp_err_t audio_sniff_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        // Only track a genuinely completed WebSocket handshake — see
        // ws_server.c's cat_ws_handler for the full reasoning (a plain
        // HTTP GET here would otherwise permanently occupy a client slot).
        int fd = httpd_req_to_sockfd(req);
        if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
            ESP_LOGW(TAG, "GET /audio-mic-sniff from fd=%d without a completed WebSocket handshake — not tracking as a client", fd);
            return ESP_OK;
        }

        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        bool added = add_client_locked(fd);
        xSemaphoreGive(s_client_mutex);
        if (!added) {
            ESP_LOGW(TAG, "sniff client (fd=%d) connected but AUDIO_SNIFF_MAX_CLIENTS (%d) already tracked "
                           "— serving it anyway, but it won't receive broadcasts", fd, AUDIO_SNIFF_MAX_CLIENTS);
        } else {
            ESP_LOGI(TAG, "sniff client connected (fd=%d)", fd);
        }
        return ESP_OK;
    }

    // Read-only endpoint — drain and discard anything a client sends
    // (there's nothing to do with it) rather than leaving unread bytes on
    // the socket, same "probe the header, read the payload, move on"
    // shape as audio_ws.c even though the payload itself is unused here.
    httpd_ws_frame_t frame = { 0 };
    frame.type = HTTPD_WS_TYPE_BINARY;
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ws recv (len probe) failed: %s", esp_err_to_name(err));
        return err;
    }
    if (frame.len == 0) return ESP_OK;

    // PSRAM: genuinely discard-only (see comment above) — the payload is
    // never read for anything, only httpd worker task, no time-critical
    // path involved.
    uint8_t *buf = heap_caps_malloc(frame.len, MALLOC_CAP_SPIRAM);
    if (!buf) return ESP_ERR_NO_MEM;
    frame.payload = buf;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err == ESP_OK && frame.type == HTTPD_WS_TYPE_CLOSE) {
        int fd = httpd_req_to_sockfd(req);
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        remove_client_locked(fd);
        xSemaphoreGive(s_client_mutex);
        ESP_LOGI(TAG, "sniff client disconnected (fd=%d)", fd);
    }
    free(buf);
    return err;
}

void audio_sniff_on_client_close(int fd) {
    if (!s_client_mutex) return;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    bool was_tracked = false;
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { was_tracked = true; break; }
    }
    remove_client_locked(fd);
    xSemaphoreGive(s_client_mutex);
    if (was_tracked) ESP_LOGI(TAG, "sniff client socket closed (fd=%d)", fd);
}

void audio_sniff_start(httpd_handle_t server) {
    s_server = server;
    s_client_mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < AUDIO_SNIFF_MAX_CLIENTS; i++) {
        s_client_fds[i] = -1;
        s_in_flight[i] = xSemaphoreCreateCounting(SNIFF_MAX_IN_FLIGHT, SNIFF_MAX_IN_FLIGHT);
        if (!s_in_flight[i]) {
            ESP_LOGE(TAG, "failed to create in-flight semaphore for client slot %d — /audio-mic-sniff disabled", i);
            s_server = NULL;
            return;
        }
    }

    httpd_uri_t sniff_uri = {
        .uri = "/audio-mic-sniff",
        .method = HTTP_GET,
        .handler = audio_sniff_handler,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &sniff_uri));

    ESP_LOGI(TAG, "WebSocket mic-sniff endpoint listening on ws://<device>/audio-mic-sniff (up to %d clients)",
             AUDIO_SNIFF_MAX_CLIENTS);
}
