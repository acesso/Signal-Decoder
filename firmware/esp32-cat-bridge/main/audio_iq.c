#include "audio_iq.h"

#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"

#include "bridge_config.h"

static const char *TAG = "audio_iq";

// Deliberately small — same reasoning as audio_sniff.c's identical
// constant: a debug/instrument tap, not a feature meant for many
// simultaneous viewers the way /cat's WS_MAX_CLIENTS is. Kept separate from
// AUDIO_WS_MAX_CLIENTS/AUDIO_SNIFF_MAX_CLIENTS so this endpoint's own
// buffer-pool memory cost (see s_client_bufs) is sized independently.
#define AUDIO_IQ_MAX_CLIENTS 2

// Per-client ring depth — see s_client_bufs's comment for the real-hardware
// investigation this replaced a single-slot (depth-1) design over: with
// only one buffer per client, ANY WiFi-layer stall (confirmed via
// firmware/esp32-iq-minimal, a stripped-down single-purpose build used to
// rule out every other bridge task first) meant the very next
// audio_iq_broadcast() call found the slot still "pending" and dropped
// that frame outright — even a brief, recoverable stall turned into an
// audible gap immediately, with zero tolerance. A small ring absorbs that
// same class of stall as pure added latency instead: a frame only gets
// dropped once ALL ring slots for a client are backed up, i.e. the client
// has fallen behind by more than IQ_RING_DEPTH frames, not just one.
#define IQ_RING_DEPTH 10

static httpd_handle_t s_server = NULL;
static int s_client_fds[AUDIO_IQ_MAX_CLIENTS];
// Same reasoning as audio_ws.c's identical field — a client whose TCP
// receive window is stuck full fails httpd_ws_send_frame_async() forever
// otherwise; see that file's comment for the full real-hardware history.
static int s_send_fail_count[AUDIO_IQ_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;

#define MAX_CONSECUTIVE_SEND_FAILURES 8

// Per-client ring of preallocated buffers (PSRAM — this board has 8MB, see
// audio_iq_start()'s comment) instead of a single reused slot. s_free_bufs
// holds indices into s_client_bufs[client] not currently in use;
// s_send_queue holds indices ready for async_send_frame() to drain. A
// client whose ring is fully backed up (s_free_bufs empty) just misses the
// newest frame — see audio_iq_broadcast() — same "don't let a slow client
// build an unbounded backlog" principle as the old single-slot design, just
// with IQ_RING_DEPTH frames of slack instead of 1.
static uint8_t *s_client_bufs[AUDIO_IQ_MAX_CLIENTS][IQ_RING_DEPTH];
static QueueHandle_t s_free_bufs[AUDIO_IQ_MAX_CLIENTS];
static QueueHandle_t s_send_queue[AUDIO_IQ_MAX_CLIENTS];
static size_t s_client_buf_cap = 0;

static bool add_client_locked(int fd) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) return true;
    }
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) {
            s_client_fds[i] = fd;
            s_send_fail_count[i] = 0;
            // Fresh ring state for this slot — drop anything left over from
            // a previous client that used this same slot index, and start
            // this client with every buffer free.
            xQueueReset(s_free_bufs[i]);
            xQueueReset(s_send_queue[i]);
            for (int b = 0; b < IQ_RING_DEPTH; b++) xQueueSend(s_free_bufs[i], &b, 0);
            return true;
        }
    }
    return false;
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; s_send_fail_count[i] = 0; return; }
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

// slot/buf_idx identify which s_client_bufs[slot][buf_idx] this send owns —
// samples is intentionally NOT owned/freed by async_send_frame() itself,
// only returned to s_free_bufs[slot] once the send completes.
typedef struct {
    int slot;
    int buf_idx;
    size_t bytes;
    int fd;
} async_send_ctx_t;

static void async_send_frame(void *arg) {
    async_send_ctx_t *ctx = (async_send_ctx_t *)arg;
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = s_client_bufs[ctx->slot][ctx->buf_idx],
        .len = ctx->bytes,
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, ctx->fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "send_frame_async failed (fd=%d): %s", ctx->fd, esp_err_to_name(err));
    }

    xQueueSend(s_free_bufs[ctx->slot], &ctx->buf_idx, portMAX_DELAY); // buffer free for reuse

    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    int fail_count = record_send_result_locked(ctx->fd, err == ESP_OK);
    xSemaphoreGive(s_client_mutex);
    if (fail_count >= MAX_CONSECUTIVE_SEND_FAILURES) {
        ESP_LOGW(TAG, "I/Q client (fd=%d) failed %d consecutive sends — forcing close (likely a stuck/dead connection)",
                 ctx->fd, fail_count);
        httpd_sess_trigger_close(s_server, ctx->fd);
    }

    free(ctx);
}

// Drains one already-enqueued frame for one client slot, dispatching it to
// httpd's worker task via httpd_queue_work() — called once per
// (slot, queued frame) from audio_iq_broadcast() below. Kept as its own
// function since audio_iq_broadcast() calls it in a loop, once per client,
// each time a new frame arrives (it doesn't block: httpd_queue_work()
// itself is the async boundary, same as the original design).
static void dispatch_next_locked_free(int slot, int fd) {
    int buf_idx;
    if (xQueueReceive(s_send_queue[slot], &buf_idx, 0) != pdTRUE) return; // nothing queued right now

    async_send_ctx_t *ctx = heap_caps_malloc(sizeof(async_send_ctx_t), MALLOC_CAP_SPIRAM);
    if (!ctx) {
        ESP_LOGW(TAG, "async_send_ctx_t alloc failed, dropping frame for fd=%d", fd);
        xQueueSend(s_free_bufs[slot], &buf_idx, portMAX_DELAY);
        return;
    }
    ctx->slot = slot;
    ctx->buf_idx = buf_idx;
    ctx->bytes = s_client_buf_cap; // every buffer in the ring is filled to the same fixed frame size — see audio_iq_broadcast()
    ctx->fd = fd;
    if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
        ESP_LOGW(TAG, "httpd_queue_work failed, dropping frame for fd=%d", fd);
        free(ctx);
        xQueueSend(s_free_bufs[slot], &buf_idx, portMAX_DELAY);
    }
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

    int fds[AUDIO_IQ_MAX_CLIENTS];
    int slots[AUDIO_IQ_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < AUDIO_IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] >= 0) { fds[n] = s_client_fds[i]; slots[n] = i; n++; }
    }
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no one watching

    for (int i = 0; i < n; i++) {
        int slot = slots[i];
        int buf_idx;
        if (xQueueReceive(s_free_bufs[slot], &buf_idx, 0) != pdTRUE) {
            // This client's entire ring is backed up (IQ_RING_DEPTH frames
            // already queued/in-flight) — same "don't let one slow client
            // build an unbounded backlog" principle as the original design,
            // just with real slack instead of none. Drop this newest frame
            // for this client only; other clients are unaffected.
            continue;
        }
        memcpy(s_client_bufs[slot][buf_idx], samples, bytes);
        xQueueSend(s_send_queue[slot], &buf_idx, 0); // always succeeds — s_send_queue and s_free_bufs are the same total depth
        dispatch_next_locked_free(slot, fds[i]);
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
        s_free_bufs[i] = xQueueCreate(IQ_RING_DEPTH, sizeof(int));
        s_send_queue[i] = xQueueCreate(IQ_RING_DEPTH, sizeof(int));
        if (!s_free_bufs[i] || !s_send_queue[i]) {
            ESP_LOGE(TAG, "failed to create free/send queues for client slot %d — /iq-data disabled", i);
            s_server = NULL;
            return;
        }
        for (int b = 0; b < IQ_RING_DEPTH; b++) {
            // PSRAM — this buffer only ever feeds httpd_ws_send_frame_async()
            // (a plain WebSocket send), never esp_codec_dev/I2S; the earlier
            // "keep it internal since it's written from audio_task" caution
            // was about task-timing proximity, not an actual memory-capability
            // requirement — see audio_monitor.c's audio_task read-buffer fix
            // for the real-hardware bug that same over-caution caused
            // elsewhere. Large (up to ~19.2KB per client at 96kHz stereo,
            // times IQ_RING_DEPTH per client now) and permanently resident,
            // so moving it off internal RAM meaningfully reduces the exact
            // fragmentation pressure that bug traced back to — this board's
            // 8MB PSRAM has ample headroom for the ring's added cost.
            s_client_bufs[i][b] = heap_caps_malloc(max_bytes_per_frame, MALLOC_CAP_SPIRAM);
            if (!s_client_bufs[i][b]) {
                // Preallocation failing at startup (rather than mid-stream,
                // which malloc-per-frame designs risk) is the whole point of
                // this approach — fail loud and early instead of silently
                // falling back to a pattern this endpoint deliberately avoided.
                ESP_LOGE(TAG, "failed to preallocate I/Q ring buffer %d/%d for client slot %d (%u bytes) — /iq-data disabled",
                         b, IQ_RING_DEPTH, i, (unsigned)max_bytes_per_frame);
                s_server = NULL;
                return;
            }
            xQueueSend(s_free_bufs[i], &b, 0);
        }
    }

    httpd_uri_t iq_uri = {
        .uri = "/iq-data",
        .method = HTTP_GET,
        .handler = audio_iq_handler,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &iq_uri));

    ESP_LOGI(TAG, "WebSocket I/Q endpoint listening on ws://<device>/iq-data (up to %d clients, %d x %u bytes/frame ring buffer each)",
             AUDIO_IQ_MAX_CLIENTS, IQ_RING_DEPTH, (unsigned)max_bytes_per_frame);
}
