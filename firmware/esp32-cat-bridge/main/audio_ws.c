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
// Consecutive send-failure count per tracked client (same indexing as
// s_client_fds — s_send_fail_count[i] corresponds to s_client_fds[i]).
// See async_send_frame()'s comment for why this exists: a client whose
// TCP receive window is permanently stuck full (weak/dead WiFi link, or a
// browser tab that stopped reading without a clean WS close) was found on
// real hardware to fail httpd_ws_send_frame_async() forever, once every
// ~6s (the TCP keepalive retry cadence, not the audio frame rate — no
// audio was flowing to anyone at that point, this was the ONLY thing the
// bridge was doing), with nothing ever evicting it. TCP-level keepalive
// (see ws_server.c) does NOT help here: the failure mode is
// EAGAIN/EWOULDBLOCK from a full send buffer (flow control), not a
// connection LWIP itself considers dead, so keepalive's own probe/retry
// logic never fires a close for this case.
static int s_send_fail_count[AUDIO_WS_MAX_CLIENTS];
// True while a previously-queued frame for this client hasn't finished
// sending yet (set right before httpd_queue_work(), cleared at the end of
// async_send_frame()). This is the actual fix for a real hardware lockup:
// audio_ws_send_to_clients() runs unconditionally every ~50ms regardless of
// whether earlier frames have drained, and httpd_queue_work() just posts to
// the ONE shared httpd worker task's control socket — there's no separate
// queue depth, every send_frame_async() call runs serially on that same
// task, which also serves /cat, /status, and every other route on this
// httpd instance. Under a degraded WiFi link, sends stop completing fast
// enough to keep up with the 50ms broadcast cadence (they don't hang
// forever — see MAX_CONSECUTIVE_SEND_FAILURES below — but each one taking
// even a few hundred ms is enough), so new work keeps piling up faster than
// the worker can drain it, eventually starving every other request on that
// task for as long as the backlog persists (observed on real hardware:
// GET /status timing out for 7+ minutes straight while the device stayed
// fully reachable over plain ICMP). Checking this flag before queueing
// sheds load exactly when the worker is falling behind — one client's
// pending-send bit blocks only that client's next frame, not the whole
// broadcast — and self-heals the moment sends start completing again.
static bool s_send_pending[AUDIO_WS_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;
static void (*s_rx_callback)(const int16_t *samples, size_t count) = NULL;

// After this many CONSECUTIVE failed sends to the same fd, force-close it
// via httpd_sess_trigger_close() rather than retrying forever — at one
// frame every ~50ms this is under a second of real audio-streaming
// backpressure (a normal, recoverable WiFi hiccup shouldn't trip it), but
// it's what actually reaps the zombie-client case above, which otherwise
// persists indefinitely (observed for 10+ minutes straight on real
// hardware with no other activity on the bridge at all).
#define MAX_CONSECUTIVE_SEND_FAILURES 8

static bool add_client_locked(int fd) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) return true;
    }
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) { s_client_fds[i] = fd; s_send_fail_count[i] = 0; s_send_pending[i] = false; return true; }
    }
    return false;
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; s_send_fail_count[i] = 0; s_send_pending[i] = false; return; }
    }
}

// Returns true and marks the slot pending if fd is tracked and not already
// waiting on a prior send; false if fd is untracked or already pending
// (caller should skip queueing this frame for fd).
static bool try_mark_pending_locked(int fd) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) {
            if (s_send_pending[i]) return false;
            s_send_pending[i] = true;
            return true;
        }
    }
    return false;
}

static void clear_pending_locked(int fd) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_send_pending[i] = false; return; }
    }
}

// Returns the new failure count for fd (0 if fd isn't currently tracked —
// e.g. it was already evicted by a previous failure in the same batch).
static int record_send_result_locked(int fd, bool ok) {
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) {
            s_send_fail_count[i] = ok ? 0 : s_send_fail_count[i] + 1;
            return s_send_fail_count[i];
        }
    }
    return 0;
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

    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    int fail_count = record_send_result_locked(ctx->fd, err == ESP_OK);
    clear_pending_locked(ctx->fd);
    xSemaphoreGive(s_client_mutex);
    // Runs on the httpd worker task (this function is only ever invoked
    // via httpd_queue_work), so calling httpd_sess_trigger_close() here —
    // documented as safe from any task — doesn't need to hop contexts.
    // remove_client_locked() isn't called here: on_client_close()
    // (ws_server.c's close_fn) will do that once the triggered close
    // actually completes, same untracking path a normal disconnect uses.
    if (fail_count >= MAX_CONSECUTIVE_SEND_FAILURES) {
        ESP_LOGW(TAG, "audio client (fd=%d) failed %d consecutive sends — forcing close (likely a stuck/dead connection)",
                 ctx->fd, fail_count);
        httpd_sess_trigger_close(s_server, ctx->fd);
    }

    free(ctx->samples);
    free(ctx);
}

void audio_ws_send_to_clients(const int16_t *samples, size_t count) {
    if (!s_server || count == 0) return;

    // Collect only fds whose PRIOR frame has already finished sending —
    // see s_send_pending's comment for why this matters. A client that's
    // fallen behind simply misses this frame (audio, not CAT — dropping a
    // 50ms window is inaudible) rather than adding to a backlog that would
    // otherwise starve the shared httpd worker task.
    int fds[AUDIO_WS_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < AUDIO_WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] >= 0 && try_mark_pending_locked(s_client_fds[i])) fds[n++] = s_client_fds[i];
    }
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no client listening, or all still draining a prior frame

    size_t bytes = count * sizeof(int16_t);
    for (int i = 0; i < n; i++) {
        async_send_ctx_t *ctx = malloc(sizeof(async_send_ctx_t));
        if (!ctx) { xSemaphoreTake(s_client_mutex, portMAX_DELAY); clear_pending_locked(fds[i]); xSemaphoreGive(s_client_mutex); continue; }
        ctx->samples = malloc(bytes);
        if (!ctx->samples) {
            free(ctx);
            xSemaphoreTake(s_client_mutex, portMAX_DELAY);
            clear_pending_locked(fds[i]);
            xSemaphoreGive(s_client_mutex);
            continue;
        }
        memcpy(ctx->samples, samples, bytes);
        ctx->count = count;
        ctx->fd = fds[i];

        if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed, dropping %d samples for fd=%d", (int)count, fds[i]);
            free(ctx->samples);
            free(ctx);
            xSemaphoreTake(s_client_mutex, portMAX_DELAY);
            clear_pending_locked(fds[i]);
            xSemaphoreGive(s_client_mutex);
        }
    }
}

void audio_ws_set_rx_callback(void (*cb)(const int16_t *samples, size_t count)) {
    s_rx_callback = cb;
}

static esp_err_t audio_ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        // Only track this fd if httpd actually completed a real WebSocket
        // upgrade — see ws_server.c's cat_ws_handler for the full
        // reasoning (found via a real bug: a plain HTTP client hitting
        // this URI without a WS handshake permanently occupied a client
        // slot, since it never triggers the close callback the same way
        // a real WS close does).
        int fd = httpd_req_to_sockfd(req);
        if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
            ESP_LOGW(TAG, "GET /audio from fd=%d without a completed WebSocket handshake — not tracking as a client", fd);
            return ESP_OK;
        }

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
