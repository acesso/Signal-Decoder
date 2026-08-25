// Minimal, single-purpose I/Q streaming firmware — an experiment to rule
// out starvation/contention theories for the reported "cutting/paper-
// crackling" noise on esp32-cat-bridge's /iq-data WebSocket, by removing
// EVERYTHING that firmware also does at the same time: CAT UART bridging,
// PA safety watchdog, status LED, HTTP control API (/status, /system-stats,
// every diagnostic toggle), the standalone control page, mDNS, WiFi AP
// fallback/scan, and the demodulated-audio (/audio, /audio-mic-sniff)
// paths entirely.
//
// What's left: connect to WiFi (station mode only, no fallback), bring up
// the onboard ES8388 codec in stereo I/Q capture mode (I on left ADC
// channel, Q on right — ported byte-for-byte from esp32-cat-bridge's
// audio_monitor.c, since that bring-up sequence itself is proven working,
// not a suspect), and loop: read one buffer, broadcast it to any connected
// /iq-data WebSocket client. Nothing else runs on this board.
//
// If cutting/crackling STILL happens here, the cause is in this minimal
// loop itself (I2S/DMA timing, WiFi/lwIP/httpd stack behavior, or the
// physical analog signal) — every other task in the full bridge is ruled
// out. If it does NOT happen here, the cause is contention from one of the
// stripped-out tasks (CAT UART reader, PA watchdog, LED, HTTP control
// handlers) sharing core 1 or the httpd worker with the I/Q path.
#include <string.h>
#include <unistd.h>

#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "es8388_codec.h"

static const char *TAG = "iq_minimal";

// ── Board pin map — copied verbatim from esp32-cat-bridge/main/bridge_config.h
// (AI-Thinker ESP32-A1S Audio Kit) — not re-derived, since the wiring is a
// fact about the board, not something this experiment is testing.
#define ES8388_I2C_PORT         I2C_NUM_0
#define ES8388_I2C_SDA_PIN      GPIO_NUM_33
#define ES8388_I2C_SCL_PIN      GPIO_NUM_32
#define ES8388_I2C_ADDR         0x20
#define ES8388_I2S_PORT         I2S_NUM_0
#define ES8388_I2S_MCLK_PIN     GPIO_NUM_0
#define ES8388_I2S_BCLK_PIN     GPIO_NUM_27
#define ES8388_I2S_WS_PIN       GPIO_NUM_25
#define ES8388_I2S_DOUT_PIN     GPIO_NUM_26
#define ES8388_I2S_DIN_PIN      GPIO_NUM_35
#define ES8388_PA_ENABLE_PIN    GPIO_NUM_21
#define ES8388_PA_REVERTED      false
#define ES8388_MASTER_MODE      true

// Fixed at 48000Hz — the rate the user has been testing the cutting/
// crackling symptom at throughout this investigation. No live sample-rate
// control here (that's a whole HTTP API this experiment deliberately
// doesn't have) — reflash to test a different rate.
#define IQ_SAMPLE_RATE_HZ       48000
// Read-window size history (all superseded by the queue/sender-task
// redesign below, kept for the record since each ruled something out):
//   10ms  — smaller/more-frequent frames, hoping a WiFi MAC retry would
//           cost less re-sent data per frame. WORSE: throughput ~87%, more
//           gaps, not fewer — per-message WS/TCP/httpd overhead at 5x the
//           message rate outweighs any per-retry benefit.
//   500ms/150ms — bigger frames, hoping to absorb a slow send as pure
//           added latency instead of an audible gap (the ES8388's own I2S/
//           DMA capture never stops regardless of read-window size, so in
//           THEORY a big enough buffer just delays delivery). WORSE in
//           practice: throughput dropped to 33-44% with gaps up to 7.7s.
// The real bug those attempts were papering over: broadcast_iq() called
// httpd_ws_send_frame_async() SYNCHRONOUSLY, directly inside iq_task, the
// same task that must keep calling esp_codec_dev_read() often enough to
// drain the I2S DMA ring before it overflows. ANY slow WS send (WiFi
// retry, TCP backpressure, a second client) stalled that read loop
// directly — a bigger buffer just gave the stall more DMA-ring headroom
// to eat before it became visible, not a fix. Restructured below: iq_task
// now ONLY reads and enqueues (never blocks on network I/O), a separate
// sender task drains the queue via httpd_queue_work() (the same
// async-dispatch pattern esp32-cat-bridge's own audio_iq.c uses in
// production) — a slow client now only risks that client's own queue
// slot, never the capture loop. Back to a small window: with capture
// truly decoupled from sending, there's no reason to trade latency for
// buffer headroom that no longer serves a purpose.
#define READ_WINDOW_MS          50
#define WS_SERVER_PORT          80
// Single-purpose diagnostic tool, not a shared feature — one listener at a
// time removes multi-client contention as a variable entirely (measured
// directly: 2 clients turned a 94%-throughput single-client run into 33%,
// see the read-window history above). Raise this only if simultaneous
// listeners are themselves what's being tested.
#define IQ_MAX_CLIENTS          1
// Depth of the capture->send queue — see iq_task/sender_task below. Each
// entry is one full read-window buffer, so this is also a real memory
// budget: (SEND_QUEUE_DEPTH + 1) * one-frame-size, on a board with no
// PSRAM (see the "strict minimal" scope note at the top of this file).
// At 50ms/48kHz-stereo (9600 bytes/frame), 10 gives ~106KB total — fits
// comfortably under this board's ~140KB free internal RAM with margin —
// and absorbs up to 500ms of send-side stall (WiFi retry, slow client)
// before iq_task would have to wait for a free buffer, well above the
// worst single-client gaps measured during this investigation (~380ms).
#define SEND_QUEUE_DEPTH        10

static esp_codec_dev_handle_t s_codec_dev = NULL;
static httpd_handle_t s_server = NULL;
static int s_client_fds[IQ_MAX_CLIENTS];
static SemaphoreHandle_t s_client_mutex;

// ── Capture -> send decoupling ───────────────────────────────────────────
// iq_task (below) must keep calling esp_codec_dev_read() often enough to
// drain the I2S DMA ring — ANY time it spends blocked on network I/O is
// time the ring isn't being drained, and it WILL overflow if that stall
// gets close to dma_desc_num's own buffered headroom (see audio_start()'s
// comment). This queue is what makes that impossible by construction:
// iq_task only ever enqueues a pointer (never blocks on the network
// itself), and a separate sender_task is the only thing that ever calls
// into httpd. A slow/stalled WS send now only risks this queue filling up
// (logged and the frame dropped, see sender_task) — it can no longer ever
// stall the capture loop itself.
//
// Buffers are a fixed pool, not malloc/free per frame — same reasoning as
// production's audio_iq.c: avoids per-frame heap churn/fragmentation risk
// on a board with no PSRAM to fall back into. Sized SEND_QUEUE_DEPTH + 1
// (not just SEND_QUEUE_DEPTH) so iq_task always has a free buffer to fill
// while up to SEND_QUEUE_DEPTH previously-filled ones are queued/in-flight.
static size_t s_read_buf_bytes = 0;
static uint8_t *s_buf_pool[SEND_QUEUE_DEPTH + 1];
static QueueHandle_t s_free_bufs;  // holds indices into s_buf_pool not currently in use
static QueueHandle_t s_send_queue; // holds indices into s_buf_pool ready to send

static bool add_client_locked(int fd) {
    for (int i = 0; i < IQ_MAX_CLIENTS; i++) if (s_client_fds[i] == fd) return true;
    for (int i = 0; i < IQ_MAX_CLIENTS; i++) {
        if (s_client_fds[i] < 0) { s_client_fds[i] = fd; return true; }
    }
    return false;
}

static void remove_client_locked(int fd) {
    for (int i = 0; i < IQ_MAX_CLIENTS; i++) if (s_client_fds[i] == fd) s_client_fds[i] = -1;
}

// Runs on the httpd worker task via httpd_queue_work() — NEVER called
// directly from iq_task/sender_task, so a slow socket write only blocks
// httpd's own worker, never capture. Same async-dispatch shape as
// audio_iq.c's async_send_frame() in production.
typedef struct {
    int buf_idx;
    size_t len;
    int fd;
} async_send_ctx_t;

static void async_send_frame(void *arg) {
    async_send_ctx_t *ctx = (async_send_ctx_t *)arg;
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_BINARY,
        .payload = s_buf_pool[ctx->buf_idx],
        .len = ctx->len,
    };
    esp_err_t err = httpd_ws_send_frame_async(s_server, ctx->fd, &frame);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "send to fd=%d failed: %s", ctx->fd, esp_err_to_name(err));
    }
    xQueueSend(s_free_bufs, &ctx->buf_idx, portMAX_DELAY); // buffer free for reuse
    free(ctx);
}

// Drains s_send_queue and dispatches each buffer to httpd's worker task.
// This is the ONLY task that ever touches httpd/the network for /iq-data
// — iq_task never does. If no client is connected, buffers are returned
// to the free pool immediately without ever touching httpd.
static void sender_task(void *arg) {
    for (;;) {
        int buf_idx;
        if (xQueueReceive(s_send_queue, &buf_idx, portMAX_DELAY) != pdTRUE) continue;

        int fd = -1;
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        for (int i = 0; i < IQ_MAX_CLIENTS; i++) if (s_client_fds[i] >= 0) { fd = s_client_fds[i]; break; }
        xSemaphoreGive(s_client_mutex);

        if (fd < 0 || !s_server) {
            xQueueSend(s_free_bufs, &buf_idx, portMAX_DELAY);
            continue;
        }

        async_send_ctx_t *ctx = malloc(sizeof(async_send_ctx_t));
        if (!ctx) {
            ESP_LOGW(TAG, "async_send_ctx_t alloc failed, dropping frame");
            xQueueSend(s_free_bufs, &buf_idx, portMAX_DELAY);
            continue;
        }
        ctx->buf_idx = buf_idx;
        ctx->len = s_read_buf_bytes;
        ctx->fd = fd;
        if (httpd_queue_work(s_server, async_send_frame, ctx) != ESP_OK) {
            ESP_LOGW(TAG, "httpd_queue_work failed, dropping frame");
            free(ctx);
            xQueueSend(s_free_bufs, &buf_idx, portMAX_DELAY);
        }
    }
}

static esp_err_t iq_ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        int fd = httpd_req_to_sockfd(req);
        if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) return ESP_OK;
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        bool added = add_client_locked(fd);
        xSemaphoreGive(s_client_mutex);
        ESP_LOGI(TAG, "client %s (fd=%d)", added ? "connected" : "connected but slots full", fd);
        return ESP_OK;
    }

    httpd_ws_frame_t frame = { .type = HTTPD_WS_TYPE_BINARY };
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) return err;
    if (frame.len == 0) return ESP_OK;

    uint8_t *buf = malloc(frame.len);
    if (!buf) return ESP_ERR_NO_MEM;
    frame.payload = buf;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err == ESP_OK && frame.type == HTTPD_WS_TYPE_CLOSE) {
        int fd = httpd_req_to_sockfd(req);
        xSemaphoreTake(s_client_mutex, portMAX_DELAY);
        remove_client_locked(fd);
        xSemaphoreGive(s_client_mutex);
        ESP_LOGI(TAG, "client disconnected (fd=%d)", fd);
    }
    free(buf);
    return err;
}

static void on_client_close(httpd_handle_t hd, int sockfd) {
    xSemaphoreTake(s_client_mutex, portMAX_DELAY);
    remove_client_locked(sockfd);
    xSemaphoreGive(s_client_mutex);
    close(sockfd);
}

static void http_start(void) {
    s_client_mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < IQ_MAX_CLIENTS; i++) s_client_fds[i] = -1;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = WS_SERVER_PORT;
    config.stack_size = 8192;
    config.max_open_sockets = IQ_MAX_CLIENTS + 2;
    config.close_fn = on_client_close;
    ESP_ERROR_CHECK(httpd_start(&s_server, &config));

    httpd_uri_t iq_uri = {
        .uri = "/iq-data",
        .method = HTTP_GET,
        .handler = iq_ws_handler,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &iq_uri));
    ESP_LOGI(TAG, "ws://<device>/iq-data listening");
}

// ── WiFi — station mode only, no AP fallback, no mDNS, no scan, no power-
// save toggle beyond the same WIFI_PS_NONE the full bridge already applies
// (that mitigation's own history — see wifi_net.c's comment on it — is
// exactly the class of multi-second stall this experiment is hunting for,
// so it stays applied here too rather than reverting to the default and
// reintroducing a KNOWN stall mechanism this test isn't trying to re-prove).
static EventGroupHandle_t s_wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "wifi disconnected, retrying");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "got ip: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void wifi_start(void) {
    s_wifi_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

    wifi_config_t wifi_config = { 0 };
    strncpy((char *)wifi_config.sta.ssid, CONFIG_IQMIN_WIFI_SSID, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, CONFIG_IQMIN_WIFI_PASSWORD, sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.sta.pmf_cfg.capable = true;
    // Pinned to the specific AP this board has consistently associated
    // with across every boot this session, not left to esp_wifi's own
    // BSSID selection — a live scan from a DIFFERENT physical location
    // (a laptop elsewhere in the building) found this SSID broadcast by
    // MULTIPLE same-SSID APs on the SAME channel (11) at similar signal
    // strength, exactly the co-channel-congestion/roaming-hunt setup that
    // causes intermittent multi-second WiFi-layer stalls independent of
    // ANYTHING this firmware does — measured directly: even with capture
    // fully decoupled from network send (see the s_send_queue design
    // above, which eliminated all DMA-ring data loss), delivery still
    // stalled for seconds at a time, unpredictably. Locking to one BSSID
    // removes roaming/AP-hunting as a variable; if stalls persist with
    // this pin in place, the cause is elsewhere (channel congestion from
    // OTHER devices, not this board choosing between APs).
    wifi_config.sta.bssid_set = true;
    uint8_t pinned_bssid[6] = { 0xD8, 0x44, 0x89, 0x83, 0x75, 0x05 };
    memcpy(wifi_config.sta.bssid, pinned_bssid, sizeof(pinned_bssid));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    esp_err_t ps_err = esp_wifi_set_ps(WIFI_PS_NONE);
    if (ps_err != ESP_OK) ESP_LOGW(TAG, "esp_wifi_set_ps(NONE) failed: %s", esp_err_to_name(ps_err));

    ESP_LOGI(TAG, "connecting to SSID:%s", CONFIG_IQMIN_WIFI_SSID);
    xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
}

// ── ES8388 bring-up — stereo I/Q capture at IQ_SAMPLE_RATE_HZ, ported
// verbatim from esp32-cat-bridge/main/audio_monitor.c's audio_monitor_start()
// I/Q-mode branch. This sequence (DMA sizing, TX-must-match-RX-channel-
// count quirk, CONTROL2 VREF re-apply, lin2 ADC input select) is already
// proven correct on this exact board — reproduced here rather than
// redesigned, since the bring-up itself isn't what this experiment is
// testing.
static void audio_start(void) {
    i2c_master_bus_config_t i2c_bus_cfg = {
        .i2c_port = ES8388_I2C_PORT,
        .sda_io_num = ES8388_I2C_SDA_PIN,
        .scl_io_num = ES8388_I2C_SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus));

    // 1000 frames/descriptor is the same cap esp32-cat-bridge uses for I/Q
    // mode (4 bytes/frame stereo 16-bit, under the I2S driver's 4092-byte
    // single-descriptor limit). dma_desc_num is NOT just hardcoded to a
    // bigger number, unlike this file's first attempt at bumping it to 16
    // — that silently exceeded this board's real free DMA-capable pool
    // (a STRICTLY NARROWER pool than general internal RAM, and this board
    // has no PSRAM to fall back into) and left too little contiguous
    // internal RAM for iq_task's own read-buffer malloc() right after,
    // failing that allocation at every boot with no visible I2S/DMA error
    // of its own (i2s_new_channel() had already "succeeded" by then).
    // Ported from esp32-cat-bridge/main/audio_monitor.c's own real
    // pre-flight check instead: measure the ACTUAL largest free DMA block
    // first, and only grow the descriptor count while comfortably (25%
    // margin) under it, never below the proven-safe baseline of 6.
    uint32_t dma_frame_num = 1000;
    uint32_t ideal_desc_num = 16;
    uint32_t dma_desc_num = 6;
    size_t dma_free_now = heap_caps_get_largest_free_block(MALLOC_CAP_DMA);
    for (uint32_t candidate = ideal_desc_num; candidate > dma_desc_num; candidate--) {
        size_t needed = (size_t)dma_frame_num * 4 /* bytes/frame, stereo 16-bit */ * candidate * 2 /* TX+RX both stereo-sized */;
        if (needed <= dma_free_now * 3 / 4) { dma_desc_num = candidate; break; }
    }
    ESP_LOGI(TAG, "dma_frame_num=%u dma_desc_num=%u (dma_free=%u)",
             (unsigned)dma_frame_num, (unsigned)dma_desc_num, (unsigned)dma_free_now);

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(ES8388_I2S_PORT, I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = dma_desc_num;
    chan_cfg.dma_frame_num = dma_frame_num;
    i2s_chan_handle_t tx_handle, rx_handle;
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, &tx_handle, &rx_handle));

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(IQ_SAMPLE_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = ES8388_I2S_MCLK_PIN,
            .bclk = ES8388_I2S_BCLK_PIN,
            .ws = ES8388_I2S_WS_PIN,
            .dout = ES8388_I2S_DOUT_PIN,
            .din = ES8388_I2S_DIN_PIN,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &std_cfg));

    i2s_std_config_t rx_std_cfg = std_cfg;
    i2s_std_slot_config_t rx_slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
    rx_std_cfg.slot_cfg = rx_slot_cfg;
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx_handle, &rx_std_cfg));

    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    ESP_ERROR_CHECK(i2s_channel_enable(rx_handle));

    audio_codec_i2c_cfg_t i2c_cfg = { .port = ES8388_I2C_PORT, .addr = ES8388_I2C_ADDR, .bus_handle = i2c_bus };
    const audio_codec_ctrl_if_t *ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);

    audio_codec_i2s_cfg_t i2s_cfg = { .port = ES8388_I2S_PORT, .rx_handle = rx_handle, .tx_handle = tx_handle };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();

    es8388_codec_cfg_t es8388_cfg = {
        .ctrl_if = ctrl_if,
        .gpio_if = gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH,
        .master_mode = ES8388_MASTER_MODE,
        .pa_pin = ES8388_PA_ENABLE_PIN,
        .pa_reverted = ES8388_PA_REVERTED,
    };
    const audio_codec_if_t *codec_if = es8388_codec_new(&es8388_cfg);
    ESP_ERROR_CHECK(codec_if ? ESP_OK : ESP_FAIL);

    esp_codec_dev_cfg_t dev_cfg = { .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT, .codec_if = codec_if, .data_if = data_if };
    s_codec_dev = esp_codec_dev_new(&dev_cfg);
    ESP_ERROR_CHECK(s_codec_dev ? ESP_OK : ESP_FAIL);

    esp_codec_dev_sample_info_t fs = { .bits_per_sample = 16, .channel = 2, .sample_rate = IQ_SAMPLE_RATE_HZ };
    ESP_ERROR_CHECK(esp_codec_dev_open(s_codec_dev, &fs) == ESP_CODEC_DEV_OK ? ESP_OK : ESP_FAIL);

    // CONTROL2 VREF-buffer re-apply — same as audio_monitor.c, must run
    // after esp_codec_dev_open().
    int control2_value = 0x00; // ES8388_CONTROL2_FULL_NORMAL
    ctrl_if->write_reg(ctrl_if, 0x01 /* ES8388_REG_CONTROL2 */, 1, &control2_value, 1);

    // ADC input = lin2 (P2 jack), same register value ADC_INPUT_OPTIONS[0]
    // uses in audio_monitor.c. ES8388_ADC_INPUT_LINPUT2_RINPUT2 = 0x50.
    int adccontrol2_value = 0x50;
    ctrl_if->write_reg(ctrl_if, 0x0a /* ES8388_REG_ADCCONTROL2 */, 1, &adccontrol2_value, 1);

    ESP_LOGI(TAG, "ES8388 I/Q capture started at %uHz, lin2 input", IQ_SAMPLE_RATE_HZ);
}

// Allocates the fixed buffer pool + free/send queues sized for one
// READ_WINDOW_MS frame each. Must run before iq_task/sender_task start.
// Returns false (logs why) if the pool can't be allocated — callers should
// treat that as fatal, same as any other audio_start()-time failure.
static bool alloc_buffer_pool(void) {
    size_t sample_pairs = (size_t)((uint64_t)IQ_SAMPLE_RATE_HZ * READ_WINDOW_MS / 1000);
    s_read_buf_bytes = sample_pairs * 2 /* stereo */ * sizeof(int16_t);

    size_t largest_free = heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT);
    ESP_LOGI(TAG, "buffer pool: %d x %u bytes, largest free internal-RAM block is %u bytes",
             SEND_QUEUE_DEPTH + 1, (unsigned)s_read_buf_bytes, (unsigned)largest_free);

    s_free_bufs = xQueueCreate(SEND_QUEUE_DEPTH + 1, sizeof(int));
    s_send_queue = xQueueCreate(SEND_QUEUE_DEPTH, sizeof(int));
    if (!s_free_bufs || !s_send_queue) {
        ESP_LOGE(TAG, "failed to create free/send queues");
        return false;
    }

    for (int i = 0; i < SEND_QUEUE_DEPTH + 1; i++) {
        s_buf_pool[i] = malloc(s_read_buf_bytes);
        if (!s_buf_pool[i]) {
            ESP_LOGE(TAG, "failed to allocate pool buffer %d/%d (%u bytes each) — reduce READ_WINDOW_MS or SEND_QUEUE_DEPTH",
                     i, SEND_QUEUE_DEPTH + 1, (unsigned)s_read_buf_bytes);
            return false;
        }
        xQueueSend(s_free_bufs, &i, 0);
    }
    return true;
}

// The capture task: read, enqueue, repeat. NEVER touches httpd/the network
// — see the s_send_queue block above for why that split exists. No timing
// instrumentation here beyond plain log lines — the whole POINT of this
// firmware is that there's nothing else running to instrument against.
static void iq_task(void *arg) {
    uint32_t loop_count = 0;
    uint32_t dropped_count = 0;
    int64_t last_log_us = esp_timer_get_time();
    for (;;) {
        int buf_idx;
        if (xQueueReceive(s_free_bufs, &buf_idx, pdMS_TO_TICKS(500)) != pdTRUE) {
            // Every pool buffer is stuck in the send queue/in flight —
            // means sender_task/httpd have fallen far behind (SEND_QUEUE_DEPTH
            // read-windows' worth). Log and keep waiting rather than
            // silently skip a read: the DMA ring (audio_start()'s
            // dma_desc_num) has its own separate headroom for exactly this.
            ESP_LOGW(TAG, "no free send buffer available — sender falling behind");
            continue;
        }

        int ret = esp_codec_dev_read(s_codec_dev, s_buf_pool[buf_idx], s_read_buf_bytes);
        if (ret != ESP_CODEC_DEV_OK) {
            ESP_LOGW(TAG, "codec read failed (%d), retrying", ret);
            xQueueSend(s_free_bufs, &buf_idx, portMAX_DELAY);
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        if (xQueueSend(s_send_queue, &buf_idx, 0) != pdTRUE) {
            // Send queue itself is full — sender_task/httpd are behind by
            // more than SEND_QUEUE_DEPTH frames. Drop this one frame
            // (return its buffer directly to the free pool) rather than
            // block iq_task waiting for room, which would risk the DMA
            // ring overflowing instead — a dropped WS frame is a brief,
            // bounded gap; a DMA overflow is unbounded/worse.
            dropped_count++;
            xQueueSend(s_free_bufs, &buf_idx, portMAX_DELAY);
        }
        loop_count++;

        int64_t now_us = esp_timer_get_time();
        if (now_us - last_log_us > 10000000) { // once per 10s — enough to confirm it's alive, not enough to itself perturb timing
            wifi_ap_record_t ap_info;
            int8_t tx_power = 0;
            esp_wifi_sta_get_ap_info(&ap_info);
            esp_wifi_get_max_tx_power(&tx_power);
            ESP_LOGI(TAG, "alive: %u reads (%u dropped) in last ~10s, heap_free=%u, rssi=%d phy=%s%s%s%s tx_power=%d(quarter-dBm)",
                     (unsigned)loop_count, (unsigned)dropped_count, (unsigned)heap_caps_get_free_size(MALLOC_CAP_DEFAULT),
                     (int)ap_info.rssi,
                     ap_info.phy_11b ? "b" : "", ap_info.phy_11g ? "g" : "",
                     ap_info.phy_11n ? "n" : "", ap_info.phy_lr ? "+lr" : "",
                     (int)tx_power);
            loop_count = 0;
            dropped_count = 0;
            last_log_us = now_us;
        }
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "esp32-iq-minimal starting — single-purpose I/Q streaming test firmware");
    ESP_ERROR_CHECK(nvs_flash_init());
    wifi_start();
    http_start();
    audio_start();
    if (!alloc_buffer_pool()) {
        ESP_LOGE(TAG, "buffer pool allocation failed — cannot start");
        return;
    }
    // sender_task on core 0 (alongside WiFi/lwIP/httpd — it's the only task
    // besides those that ever touches the network) so it can never contend
    // with iq_task's core-1 I2S/DMA timing; iq_task on core 1, same
    // placement as the production bridge's own real-time relay tasks (see
    // esp32-cat-bridge/main/bridge_config.h's Task placement notes) — this
    // firmware has no CAT UART/PA watchdog to share that core with, but the
    // same "keep capture off the network's core" reasoning still applies.
    xTaskCreatePinnedToCore(sender_task, "sender_task", 4096, NULL, 5, NULL, 0);
    xTaskCreatePinnedToCore(iq_task, "iq_task", 4096, NULL, 5, NULL, 1);
    ESP_LOGI(TAG, "running — connect to ws://<device-ip>/iq-data");
}
