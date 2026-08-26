#include "ws_server.h"

#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "audio_sniff.h"
#include "audio_iq.h"
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
// Consecutive send-failure count per tracked client — see audio_ws.c's
// identical mechanism for the full reasoning (a client whose TCP receive
// window is permanently stuck full — weak/dead WiFi, or a tab that
// stopped reading without a clean WS close — was found on real hardware
// to fail sends forever with nothing ever evicting it; TCP keepalive
// doesn't help since the failure is flow-control EAGAIN, not a
// keepalive-detectable dead connection). This CAT socket carries actual
// radio commands, so a stuck client here is worse than on /audio: it's
// silently eating CPU/queue-work slots on the shared httpd worker
// indefinitely, not just a muted audio stream.
static int s_send_fail_count[WS_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;

#define MAX_CONSECUTIVE_SEND_FAILURES 8

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
        if (s_client_fds[i] < 0) { s_client_fds[i] = fd; s_send_fail_count[i] = 0; return true; }
    }
    return false; // full — caller logs and lets the connection through anyway;
                  // httpd's own max_open_sockets is the real backstop
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) { s_client_fds[i] = -1; s_send_fail_count[i] = 0; return; }
    }
}

// Returns the new failure count for fd (0 if fd isn't currently tracked).
static int record_send_result_locked(int fd, bool ok) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] == fd) {
            s_send_fail_count[i] = ok ? 0 : s_send_fail_count[i] + 1;
            return s_send_fail_count[i];
        }
    }
    return 0;
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

    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    int fail_count = record_send_result_locked(ctx->fd, err == ESP_OK);
    xSemaphoreGive(s_client_mutex);
    // Safe from any task per httpd_sess_trigger_close()'s own docs — this
    // runs on the httpd worker task anyway (only ever invoked via
    // httpd_queue_work). remove_client_locked()/publish_client_count_locked()
    // aren't called here directly: on_client_close() (this file's own
    // close_fn) runs once the triggered close actually completes, same
    // untracking path a normal disconnect already uses.
    if (fail_count >= MAX_CONSECUTIVE_SEND_FAILURES) {
        ESP_LOGW(TAG, "CAT client (fd=%d) failed %d consecutive sends — forcing close (likely a stuck/dead connection)",
                 ctx->fd, fail_count);
        httpd_sess_trigger_close(s_server, ctx->fd);
    }

    free(ctx->data);
    free(ctx);
}

// Shared by ws_server_send_to_client() (no exclusion — the radio->browser
// direction has no "sender" among the browser clients) and the browser->
// radio handler below (excludes the sender's own fd — see that call site's
// comment for why). exclude_fd < 0 means "exclude nothing."
static void broadcast_excluding_locked(int exclude_fd, const uint8_t *data, size_t len) {
    if (!s_server || len == 0) return;

    int fds[WS_MAX_CLIENTS];
    int n = 0;
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (s_client_fds[i] >= 0 && s_client_fds[i] != exclude_fd) fds[n++] = s_client_fds[i];
    }
    xSemaphoreGive(s_client_mutex);
    if (n == 0) return; // no (other) client connected — drop silently, radio keeps running

    // PSRAM — same reasoning as the audio broadcast paths (audio_ws.c,
    // audio_sniff.c, audio_iq.c): pure httpd_ws_send_frame_async() staging,
    // no codec/DMA involvement. CAT frames are tiny and infrequent
    // (nowhere near the ~50ms continuous cadence of audio broadcasts), so
    // PSRAM's per-access latency here is immaterial against CAT's own
    // timing budget.
    for (int i = 0; i < n; i++) {
        async_send_ctx_t *ctx = heap_caps_malloc(sizeof(async_send_ctx_t), MALLOC_CAP_SPIRAM);
        if (!ctx) continue;
        ctx->data = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
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

void ws_server_send_to_client(const uint8_t *data, size_t len) {
    broadcast_excluding_locked(-1, data, len);
}

static esp_err_t cat_ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        // Initial handshake — but ONLY track this fd if httpd actually
        // completed a real WebSocket upgrade (Upgrade: websocket headers,
        // the Sec-WebSocket-Key exchange, etc). A plain HTTP GET to this
        // URI (curl, a browser navigated here directly, anything that
        // doesn't speak the WS handshake) still reaches this branch —
        // is_websocket=true on the URI registration doesn't reject those
        // outright — and httpd_ws_get_fd_info() is the only reliable way
        // to tell them apart. Without this check, such a client
        // permanently occupied a WS_MAX_CLIENTS slot: on_client_close()
        // only fires once httpd's own close_fn runs, which a plain HTTP
        // client that just hangs/times out (rather than sending a real WS
        // close frame) may never trigger — confirmed on real hardware,
        // where a single `curl http://.../cat` call alone was enough to
        // wedge one of only 4 slots until the bridge was rebooted.
        int fd = httpd_req_to_sockfd(req);
        if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
            ESP_LOGW(TAG, "GET /cat from fd=%d without a completed WebSocket handshake — not tracking as a client", fd);
            return ESP_OK;
        }

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

    // PSRAM: a plain per-frame receive buffer filled by httpd_ws_recv_frame()'s
    // socket read (lwIP recv(), not a peripheral DMA transfer) — no
    // internal-RAM requirement, and this only ever runs on the httpd
    // worker task, never the time-critical CAT/audio/PA-watchdog path.
    uint8_t *buf = heap_caps_malloc(frame.len + 1, MALLOC_CAP_SPIRAM);
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
        // Also broadcast this outgoing frame to every OTHER connected /cat
        // client — without this, a second viewer (e.g. the standalone
        // control page's own CAT monitor, or any other browser tab) never
        // sees traffic sent by a DIFFERENT client at all, only the radio's
        // own replies. Excludes the sender's own fd: every client already
        // renders its own just-sent frame locally the instant it calls
        // ws.send() (app.js's appendCatFrame('out', ...) right after
        // catWs.send(raw)) — echoing it back would make the sender see its
        // own frame twice, the second time mislabeled as "from radio"
        // (ws.onmessage has no way to tell "my own echo" from "a real
        // reply" apart, since both arrive as an ordinary incoming frame).
        broadcast_excluding_locked(httpd_req_to_sockfd(req), frame.payload, frame.len);
    }

    free(buf);
    return ESP_OK;
}

// httpd_close_func_t returns void — httpd itself always closes the socket
// after calling this hook, so we only need to clear our own bookkeeping.
// This is the ONLY close_fn httpd supports per server instance — since
// /audio, /audio-mic-sniff, and /iq-data all share this httpd instance
// with /cat, this hook also untracks the closed fd from each of their
// client sets (a no-op if it was never one of theirs either).
static void on_client_close(httpd_handle_t hd, int sockfd) {
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    remove_client_locked(sockfd);
    publish_client_count_locked();
    xSemaphoreGive(s_client_mutex);
    audio_ws_on_client_close(sockfd);
    audio_sniff_on_client_close(sockfd);
    audio_iq_on_client_close(sockfd);
    ESP_LOGI(TAG, "CAT client socket closed (fd=%d)", sockfd);
    close(sockfd);
}

void ws_server_start(void) {
    s_client_mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < WS_MAX_CLIENTS; i++) s_client_fds[i] = -1;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = WS_SERVER_PORT;
    // Default is tskNO_AFFINITY — explicitly pinned to core 0 instead
    // (Wi-Fi/network/control's core, see bridge_config.h's Task placement
    // notes) so this task can never drift onto core 1 and contend with the
    // CAT UART reader/audio codec I/O/PA watchdog pinned there. This
    // matters here specifically because httpd's own worker task is what
    // actually calls httpd_ws_send_frame_async() for every /cat and
    // /audio broadcast (queued via httpd_queue_work from cat_bridge's and
    // audio_monitor's core-1 tasks) — if it ran on core 1 too, it would be
    // competing directly with the very tasks core-1 isolation exists to protect.
    config.core_id = 0;
    // Default is 4096 — too tight once /wifi-scan's handler chain
    // (wifi_scan_handler's on-stack result/body buffers calling into
    // wifi_net_scan's own wifi_ap_record_t[32] buffer, ~3.2KB alone) is
    // layered on top of esp_http_server's own per-request stack usage —
    // discovered as a LoadStoreAlignment panic (stack overflow corrupting
    // the call frame) on real hardware when /wifi-scan was first added.
    // Bumped again from 6144: GET /system-stats's live task-list snapshot
    // showed only 364 bytes free on this task even at 32000 Hz — this
    // same httpd worker task is also what runs httpd_ws_send_frame_async()
    // for every /audio broadcast frame (queued from audio_monitor's core-1
    // task via httpd_queue_work), and that per-frame payload now scales
    // with the configured sample rate (800 bytes at 8000 Hz -> 4800 bytes
    // at 48000 Hz, see audio_monitor.c's READ_WINDOW_MS comment) — a
    // near-empty stack margin here, on the one task that also serves every
    // control-page /status poll, matches a real report of the control
    // page going unresponsive specifically at higher configured sample
    // rates. Doubled to give real headroom rather than inching it up by a
    // few hundred bytes and risking hitting this exact wall again at the
    // next feature added to this httpd instance.
    config.stack_size = 12288;
    // +2 headroom for a short-lived /status/etc request landing alongside
    // every already-open CAT AND audio socket at once (every route shares
    // this one httpd instance/socket pool). AUDIO_WS_MAX_CLIENTS covers
    // /audio; the flat +6 covers /audio-mic-sniff and /iq-data's own
    // client caps (2 each — see audio_sniff.c/audio_iq.c, both deliberately
    // small debug/instrument taps, not exposed via header so duplicated
    // here as a constant rather than an include) plus 2 spare. This was
    // previously under-counted (missing /audio-mic-sniff's 2 entirely) —
    // caught while adding /iq-data, not something that had caused a
    // visible failure, since max_open_sockets is a soft cap httpd enforces
    // by refusing new connections, not by silently corrupting existing ones.
    config.max_open_sockets = WS_MAX_CLIENTS + AUDIO_WS_MAX_CLIENTS + 6;
    config.close_fn = on_client_close;
    // Default is disabled — there's no WS-level ping/pong anywhere in this
    // server either, so without this a socket whose peer vanished without a
    // clean FIN (laptop WiFi roam/sleep, router NAT table timeout) would sit
    // as a silent zombie: this side sees no error and keeps trying to write
    // to it, only for the OS's own default TCP retransmit timeout — which
    // can be many minutes — to eventually notice. TCP-level keepalive here
    // is the cheap fix: after 5s idle, probe every 5s, give up (and let
    // close_fn/on_client_close reap it) after 3 missed probes — long enough
    // to not fire during ordinary CAT-poll gaps, short enough to reclaim a
    // dead socket in well under a minute instead of waiting on OS defaults.
    config.keep_alive_enable = true;
    config.keep_alive_idle = 5;
    config.keep_alive_interval = 5;
    config.keep_alive_count = 3;
    // Default is 8 — this server now registers roughly 30 URI handlers
    // (/cat, /audio, /status, /info, /wifi-scan, /reset, /wifi-config,
    // /cat-baud, /pa-emergency-clear, /audio-input, /mic-gain,
    // /wifi-tx-power, /rx-slot, /led-enable, /alc, /noise-gate, /cpu-freq,
    // /system-stats, /adc-hpf, /sample-rate, /input-mode, /cat-log-enable,
    // /speaker-amp, /cat-log, /cat-log/clear, /tx-audio, /tx-play,
    // /tx-status, /tx-stop, /* OPTIONS, plus control_page's /, /style.css,
    // /app.js, plus /iq-data and /audio-mic-sniff), so the default
    // silently overflows (ESP_ERR_HTTPD_HANDLERS_FULL, a boot-loop on real
    // hardware — this cap has already been hit and bumped multiple times:
    // first when control_page.c was added, again for the audio-input/
    // mic-gain/rx-slot/led-enable diagnostics, again for alc/noise-gate/
    // cpu-freq/system-stats). Bumped from 40 to 48 for the tx-audio/
    // tx-play/tx-status/tx-stop addition, with real headroom left again
    // rather than inching it up by exactly 4 — cheap insurance (this only
    // costs a bit of static handler-table memory, not a scarce resource
    // worth rationing tightly).
    config.max_uri_handlers = 48;
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
