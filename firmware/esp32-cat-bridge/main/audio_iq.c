#include "audio_iq.h"

#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "bridge_config.h"

static const char *TAG = "audio_iq";

// Deliberately small — same reasoning as audio_sniff.c's identical
// constant: a debug/instrument tap, not a feature meant for many
// simultaneous viewers the way /cat's WS_MAX_CLIENTS is. Kept separate from
// AUDIO_WS_MAX_CLIENTS/AUDIO_SNIFF_MAX_CLIENTS so this endpoint's own
// buffer-pool memory cost (see s_client_bufs) is sized independently.
#define AUDIO_IQ_MAX_CLIENTS 2

static httpd_handle_t s_server = NULL;
static int s_client_fds[AUDIO_IQ_MAX_CLIENTS];
// Same reasoning as audio_ws.c's identical field — a client whose TCP
// receive window is stuck full fails httpd_ws_send_frame_async() forever
// otherwise; see that file's comment for the full real-hardware history.
static int s_send_fail_count[AUDIO_IQ_MAX_CLIENTS];
// True while a previously-queued frame for this client hasn't finished
// sending yet — see audio_ws.c's identical field for the full real-hardware
// lockup this fixes. I/Q's byte rate (up to ~19.2KB/50ms at 96kHz stereo,
// vs /audio's mono ~4.8KB/50ms at 48kHz) makes this shared-httpd-worker
// backlog risk WORSE than the paths that risk was first found on, so this
// endpoint needed it from day one rather than retrofitted after a lockup.
static bool s_send_pending[AUDIO_IQ_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;

#define MAX_CONSECUTIVE_SEND_FAILURES 8

// One preallocated buffer per client slot, reused for every broadcast to
// that slot — NOT a fresh malloc/free per frame like audio_ws.c/
// audio_sniff.c. I/Q's per-frame byte count can be several times larger
// than either of those paths' (see audio_iq.h's comment), and this device
// has a documented heap-fragmentation history (GET /system-stats has shown
// a large nominal free heap with only a much smaller largest-contiguous-
// block available) with no PSRAM to fall back on — a malloc/free churn at
// this size, every 50ms, per client, was judged too much added
// fragmentation risk to accept before any hardware data exists to say
// otherwise (see the I/Q design discussion). s_client_buf_cap is the size
// each s_client_bufs[i] was allocated at (audio_iq_start()'s
// max_bytes_per_frame) — every broadcast must fit within it; one prior
// broadcast still "pending" for a slot (see s_send_pending) is exactly what
// guarantees a second broadcast never overwrites a buffer the httpd worker
// task might still be reading out of.
static uint8_t *s_client_bufs[AUDIO_IQ_MAX_CLIENTS];
static size_t s_client_buf_cap = 0;

static bool add_client_locked(int fd) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) return true;
    }
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) { s_client_fds[i] = fd; s_send_fail_count[i] = 0; s_send_pending[i] = false; return true; }
    }
    return false;
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; s_send_fail_count[i] = 0; s_send_pending[i] = false; return; }
    }
}

static bool try_mark_pending_locked(int fd, int *slot_out) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) {
            if (s_send_pending[i]) return false;
            s_send_pending[i] = true;
            *slot_out = i;
            return true;
        }
    }
    return false;
}

static void clear_pending_locked(int fd) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_send_pending[i] = false; return; }
    }
}

static int record_send_result_locked(int fd, bool ok) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) {
            s_send_fail_count[i] = ok ? 0 : s_send_fail_count[i] + 1;
            return s_send_fail_count[i];
        }
    }
    return 0;
}

// Points at one of s_client_bufs[] (no per-call malloc — see that field's
// comment) — samples is intentionally NOT owned/freed by async_send_frame().
typedef struct {
    uint8_t *samples;
    size_t bytes;
    int fd;
} async_send_ctx_t;

static void async_send_frame(void *arg) {
    async_send_ctx_t *ctx = (async_send_ctx_t *)arg;
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = ctx->samples,
        .len = ctx->bytes,
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, ctx->fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "send_frame_async failed (fd=%d): %s", ctx->fd, esp_err_to_name(err));
    }

    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    int fail_count = record_send_result_locked(ctx->fd, err == ESP_OK);
    clear_pending_locked(ctx->fd); // buffer is free for the NEXT broadcast to reuse from this point on
    xSemaphoreGive(s_client_mutex);
    if (fail_count >= MAX_CONSECUTIVE_SEND_FAILURES) {
        ESP_LOGW(TAG, "I/Q client (fd=%d) failed %d consecutive sends — forcing close (likely a stuck/dead connection)",
                 ctx->fd, fail_count);
        httpd_sess_trigger_close(s_server, ctx->fd);
    }

    // Only ctx itself is freed here — ctx->samples is a slot buffer owned
    // by s_client_bufs[], not this call's to free.
    free(ctx);
}

void audio_iq_broadcast(const int16_t *samples, size_t count) {
    if (!s_server || count == 0) return;
    size_t bytes = count * sizeof(int16_t);
    if (bytes > s_client_buf_cap) {
        // Caller bug (or audio_iq_start() sized the pool for the wrong
        // rate) — drop rather than overflow a fixed-size slot buffer.
        // Logged with a rate-limited flavor isn't needed here: this can
        // only happen on every call if it happens at all (the frame size
        // is fixed once the sample rate is set at boot), so one loud
        // warning per occurrence is fine, not a flood risk.
        ESP_LOGE(TAG, "I/Q frame (%u bytes) exceeds preallocated buffer capacity (%u) — dropped, check audio_iq_start() sizing",
                 (unsigned)bytes, (unsigned)s_client_buf_cap);
        return;
    }

    // Only fds whose prior frame already finished sending — see
    // s_send_pending's comment. A client that's fallen behind just misses
    // this frame instead of adding to a backlog that starves the shared
    // httpd worker task.
    int fds[AUDIO_IQ_MAX_CLIENTS];
    int slots[AUDIO_IQ_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) continue;
        int slot = -1;
        if (try_mark_pending_locked(s_client_fds[i], &slot)) {
            fds[n] = s_client_fds[i];
            slots[n] = slot;
            n++;
        }
    }
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no one watching, or all still draining a prior frame

    // PSRAM — same reasoning as audio_ws.c/audio_sniff.c's identical
    // per-broadcast ctx structs: tiny, transient, no codec/DMA involvement.
    for (int i = 0; i < n; i++) {
        async_send_ctx_t *ctx = heap_caps_malloc(sizeof(async_send_ctx_t), MALLOC_CAP_SPIRAM);
        if (!ctx) { xSemaphoreTake(s_client_mutex, portMAX_DELAY); clear_pending_locked(fds[i]); xSemaphoreGive(s_client_mutex); continue; }
        // Copy into THIS client's own preallocated buffer — see
        // s_client_bufs's comment. Safe to write here (off the httpd
        // worker task) because try_mark_pending_locked() above guarantees
        // no in-flight async_send_frame() is still reading from this same
        // slot's buffer.
        memcpy(s_client_bufs[slots[i]], samples, bytes);
        ctx->samples = s_client_bufs[slots[i]];
        ctx->bytes = bytes;
        ctx->fd = fds[i];

        if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed, dropping %d bytes for fd=%d", (int)bytes, fds[i]);
            free(ctx);
            xSemaphoreTake(s_client_mutex, portMAX_DELAY);
            clear_pending_locked(fds[i]);
            xSemaphoreGive(s_client_mutex);
        }
    }
}

static esp_err_t audio_iq_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        // Only track a genuinely completed WebSocket handshake — see
        // ws_server.c's cat_ws_handler for the full reasoning (a plain
        // HTTP GET here would otherwise permanently occupy a client slot).
        int fd = httpd_req_to_sockfd(req);
        if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
            ESP_LOGW(TAG, "GET /iq-data from fd=%d without a completed WebSocket handshake — not tracking as a client", fd);
            return ESP_OK;
        }

        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        bool added = add_client_locked(fd);
        xSemaphoreGive(s_client_mutex);
        if (!added) {
            ESP_LOGW(TAG, "I/Q client (fd=%d) connected but AUDIO_IQ_MAX_CLIENTS (%d) already tracked "
                           "— serving it anyway, but it won't receive broadcasts", fd, AUDIO_IQ_MAX_CLIENTS);
        } else {
            ESP_LOGI(TAG, "I/Q client connected (fd=%d)", fd);
        }
        return ESP_OK;
    }

    // Read-only endpoint — drain and discard anything a client sends
    // (there's nothing to do with it) rather than leaving unread bytes on
    // the socket, same "probe the header, read the payload, move on"
    // shape as audio_ws.c/audio_sniff.c even though the payload itself is
    // unused here.
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
        ESP_LOGI(TAG, "I/Q client disconnected (fd=%d)", fd);
    }
    free(buf);
    return err;
}

void audio_iq_on_client_close(int fd) {
    if (!s_client_mutex) return;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    bool was_tracked = false;
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { was_tracked = true; break; }
    }
    remove_client_locked(fd);
    xSemaphoreGive(s_client_mutex);
    if (was_tracked) ESP_LOGI(TAG, "I/Q client socket closed (fd=%d)", fd);
}

void audio_iq_start(httpd_handle_t server, size_t max_bytes_per_frame) {
    s_server = server;
    s_client_mutex = xSemaphoreCreateMutex();
    s_client_buf_cap = max_bytes_per_frame;
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        s_client_fds[i] = -1;
        // PSRAM — this buffer only ever feeds httpd_ws_send_frame_async()
        // (a plain WebSocket send), never esp_codec_dev/I2S; the earlier
        // "keep it internal since it's written from audio_task" caution
        // was about task-timing proximity, not an actual memory-capability
        // requirement — see audio_monitor.c's audio_task read-buffer fix
        // for the real-hardware bug that same over-caution caused
        // elsewhere. Large (up to ~19.2KB per client at 96kHz stereo) and
        // permanently resident, so moving it off internal RAM meaningfully
        // reduces the exact fragmentation pressure that bug traced back to.
        s_client_bufs[i] = heap_caps_malloc(max_bytes_per_frame, MALLOC_CAP_SPIRAM);
        if (!s_client_bufs[i]) {
            // Preallocation failing at startup (rather than mid-stream,
            // which malloc-per-frame designs risk) is the whole point of
            // this approach — fail loud and early instead of silently
            // falling back to a pattern this endpoint deliberately avoided.
            ESP_LOGE(TAG, "failed to preallocate I/Q client buffer %d (%u bytes) — /iq-data disabled",
                     i, (unsigned)max_bytes_per_frame);
            s_server = NULL;
            return;
        }
    }

    httpd_uri_t iq_uri = {
        .uri = "/iq-data",
        .method = HTTP_GET,
        .handler = audio_iq_handler,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &iq_uri));

    ESP_LOGI(TAG, "WebSocket I/Q endpoint listening on ws://<device>/iq-data (up to %d clients, %u bytes/frame buffer each)",
             AUDIO_IQ_MAX_CLIENTS, (unsigned)max_bytes_per_frame);
}
