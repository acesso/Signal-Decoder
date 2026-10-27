// Generic serial lines — see aux_serial.h.
#include "aux_serial.h"

#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include "driver/uart.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"

#include "bridge_config.h"

#if CONFIG_BRIDGE_BOARD_S3

static const char *TAG = "aux_serial";

#define AUX_DEFAULT_BAUD   9600
#define AUX_BUF_SIZE       1024
#define AUX_READ_CHUNK     256
#define AUX_NVS_NAMESPACE  "aux_serial"

typedef struct {
    const char *name;
    uart_port_t port;
    int tx_pin, rx_pin;
    int baud;
    bool loopback;
    int fds[AUX_SERIAL_MAX_CLIENTS];
    _Atomic uint32_t rx_bytes, tx_bytes;
} aux_line_t;

static aux_line_t s_lines[] = {
    { .name = "tuner", .port = S3_TUNER_UART_PORT, .tx_pin = S3_TUNER_TX_PIN, .rx_pin = S3_TUNER_RX_PIN },
    { .name = "freq",  .port = S3_FREQ_UART_PORT,  .tx_pin = S3_FREQ_TX_PIN,  .rx_pin = S3_FREQ_RX_PIN },
};
#define AUX_LINE_COUNT (sizeof(s_lines) / sizeof(s_lines[0]))

static httpd_handle_t s_server;
static SemaphoreHandle_t s_mutex;  // guards every line's fds[] and baud/loopback

static aux_line_t *find_line(const char *name) {
    for (size_t i = 0; i < AUX_LINE_COUNT; i++) if (strcmp(s_lines[i].name, name) == 0) return &s_lines[i];
    return NULL;
}

static bool valid_baud(int baud) { return baud >= 300 && baud <= 1000000; }

// ── Settings ────────────────────────────────────────────────────────────────

static int load_baud(const char *name) {
    nvs_handle_t h;
    int32_t v = AUX_DEFAULT_BAUD;
    if (nvs_open(AUX_NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_i32(h, name, &v);
        nvs_close(h);
    }
    return valid_baud(v) ? v : AUX_DEFAULT_BAUD;
}

static bool save_baud(const char *name, int baud) {
    nvs_handle_t h;
    if (nvs_open(AUX_NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_i32(h, name, baud) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

// ── Device -> clients ───────────────────────────────────────────────────────

typedef struct {
    int fd;
    size_t len;
    uint8_t data[];
} aux_send_t;

static void async_send(void *arg) {
    aux_send_t *m = arg;
    httpd_ws_frame_t frame = { .type = HTTPD_WS_TYPE_BINARY, .payload = m->data, .len = m->len };
    if (httpd_ws_send_frame_async(s_server, m->fd, &frame) != ESP_OK) {
        ESP_LOGW(TAG, "send to fd=%d failed", m->fd);
    }
    free(m);
}

static void broadcast(aux_line_t *line, const uint8_t *data, size_t len) {
    int fds[AUX_SERIAL_MAX_CLIENTS], n = 0;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < AUX_SERIAL_MAX_CLIENTS; i++) if (line->fds[i] >= 0) fds[n++] = line->fds[i];
    xSemaphoreGive(s_mutex);
    for (int i = 0; i < n; i++) {
        aux_send_t *m = heap_caps_malloc(sizeof(aux_send_t) + len, MALLOC_CAP_SPIRAM);
        if (!m) continue;
        m->fd = fds[i];
        m->len = len;
        memcpy(m->data, data, len);
        if (httpd_queue_work(s_server, async_send, m) != ESP_OK) free(m);
    }
}

static void reader_task(void *arg) {
    aux_line_t *line = arg;
    uint8_t buf[AUX_READ_CHUNK];
    for (;;) {
        int n = uart_read_bytes(line->port, buf, sizeof(buf), pdMS_TO_TICKS(20));
        if (n > 0) {
            atomic_fetch_add(&line->rx_bytes, (uint32_t)n);
            broadcast(line, buf, (size_t)n);
        }
    }
}

// ── WebSocket ───────────────────────────────────────────────────────────────

static aux_line_t *line_from_query(httpd_req_t *req) {
    char q[32], name[12];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK) return NULL;
    if (httpd_query_key_value(q, "line", name, sizeof(name)) != ESP_OK) return NULL;
    return find_line(name);
}

static esp_err_t serial_ws_handler(httpd_req_t *req) {
    int fd = httpd_req_to_sockfd(req);
    if (req->method == HTTP_GET) {
        aux_line_t *line = line_from_query(req);
        if (!line) {
            ESP_LOGW(TAG, "connect without a valid ?line= (fd=%d) — closing", fd);
            return ESP_FAIL;
        }
        bool added = false;
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        for (int i = 0; i < AUX_SERIAL_MAX_CLIENTS && !added; i++) {
            if (line->fds[i] < 0) { line->fds[i] = fd; added = true; }
        }
        xSemaphoreGive(s_mutex);
        if (!added) {
            ESP_LOGW(TAG, "%s: client limit (%d) reached — refusing fd=%d", line->name, AUX_SERIAL_MAX_CLIENTS, fd);
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "%s: client connected (fd=%d)", line->name, fd);
        return ESP_OK;
    }

    httpd_ws_frame_t frame = { 0 };
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) return err;
    if (frame.type == HTTPD_WS_TYPE_CLOSE || frame.len == 0) return ESP_OK;
    if (frame.type != HTTPD_WS_TYPE_BINARY && frame.type != HTTPD_WS_TYPE_TEXT) return ESP_OK;
    uint8_t *buf = heap_caps_malloc(frame.len, MALLOC_CAP_SPIRAM);
    if (!buf) return ESP_ERR_NO_MEM;
    frame.payload = buf;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err == ESP_OK) {
        aux_line_t *line = NULL;
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        for (size_t l = 0; l < AUX_LINE_COUNT && !line; l++)
            for (int i = 0; i < AUX_SERIAL_MAX_CLIENTS; i++) if (s_lines[l].fds[i] == fd) { line = &s_lines[l]; break; }
        xSemaphoreGive(s_mutex);
        if (line) {
            int w = uart_write_bytes(line->port, buf, frame.len);
            if (w > 0) atomic_fetch_add(&line->tx_bytes, (uint32_t)w);
        }
    }
    free(buf);
    return err;
}

void aux_serial_on_client_close(int sockfd) {
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (size_t l = 0; l < AUX_LINE_COUNT; l++)
        for (int i = 0; i < AUX_SERIAL_MAX_CLIENTS; i++) if (s_lines[l].fds[i] == sockfd) s_lines[l].fds[i] = -1;
    xSemaphoreGive(s_mutex);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

static esp_err_t status_handler(httpd_req_t *req) {
    char body[512];
    size_t o = (size_t)snprintf(body, sizeof(body), "{\"lines\":[");
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (size_t l = 0; l < AUX_LINE_COUNT && o < sizeof(body); l++) {
        aux_line_t *x = &s_lines[l];
        int clients = 0;
        for (int i = 0; i < AUX_SERIAL_MAX_CLIENTS; i++) if (x->fds[i] >= 0) clients++;
        o += (size_t)snprintf(body + o, sizeof(body) - o,
            "%s{\"name\":\"%s\",\"port\":%d,\"tx_pin\":%d,\"rx_pin\":%d,\"baud\":%d,\"loopback\":%s,"
            "\"clients\":%d,\"rx_bytes\":%" PRIu32 ",\"tx_bytes\":%" PRIu32 "}",
            l ? "," : "", x->name, (int)x->port, x->tx_pin, x->rx_pin, x->baud, x->loopback ? "true" : "false",
            clients, atomic_load(&x->rx_bytes), atomic_load(&x->tx_bytes));
    }
    xSemaphoreGive(s_mutex);
    if (o < sizeof(body)) o += (size_t)snprintf(body + o, sizeof(body) - o, "]}");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, MIN(o, sizeof(body) - 1));
}

// Tiny parsers for this endpoint's fixed body shape.
static bool json_str(const char *j, const char *key, char *out, size_t sz) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(j, pat);
    if (!p || !(p = strchr(p + strlen(pat), '"'))) return false;
    const char *e = strchr(++p, '"');
    if (!e || (size_t)(e - p) >= sz) return false;
    memcpy(out, p, e - p);
    out[e - p] = 0;
    return true;
}
static const char *json_val(const char *j, const char *key) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(j, pat);
    if (!p || !(p = strchr(p + strlen(pat), ':'))) return NULL;
    while (*++p == ' ') {}
    return p;
}

static esp_err_t config_handler(httpd_req_t *req) {
    char body[128] = { 0 }, name[12];
    int len = httpd_req_recv(req, body, MIN(req->content_len, sizeof(body) - 1));
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    if (len <= 0 || !json_str(body, "line", name, sizeof(name)))
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body must name a line: {\"line\":\"tuner\"|\"freq\", ...}");
    aux_line_t *line = find_line(name);
    if (!line) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "unknown line (tuner, freq)");

    const char *b = json_val(body, "baud"), *lb = json_val(body, "loopback");
    if (b) {
        int baud = atoi(b);
        if (!valid_baud(baud)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "baud must be 300..1000000");
        if (uart_set_baudrate(line->port, baud) != ESP_OK) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "uart_set_baudrate failed");
        xSemaphoreTake(s_mutex, portMAX_DELAY); line->baud = baud; xSemaphoreGive(s_mutex);
        if (!save_baud(line->name, baud)) ESP_LOGW(TAG, "%s: baud %d applied but not saved", line->name, baud);
        ESP_LOGI(TAG, "%s: baud %d", line->name, baud);
    }
    if (lb) {
        bool on = strncmp(lb, "true", 4) == 0;
        uart_set_loop_back(line->port, on);
        xSemaphoreTake(s_mutex, portMAX_DELAY); line->loopback = on; xSemaphoreGive(s_mutex);
        ESP_LOGI(TAG, "%s: loopback %s", line->name, on ? "on" : "off");
    }
    char out[96];
    int n = snprintf(out, sizeof(out), "{\"line\":\"%s\",\"baud\":%d,\"loopback\":%s}",
                     line->name, line->baud, line->loopback ? "true" : "false");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, out, n);
}

// ── Start ───────────────────────────────────────────────────────────────────

void aux_serial_start(httpd_handle_t server) {
    s_server = server;
    s_mutex = xSemaphoreCreateMutex();
    for (size_t l = 0; l < AUX_LINE_COUNT; l++) {
        aux_line_t *x = &s_lines[l];
        for (int i = 0; i < AUX_SERIAL_MAX_CLIENTS; i++) x->fds[i] = -1;
        x->baud = load_baud(x->name);
        uart_config_t cfg = {
            .baud_rate = x->baud, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE,
            .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
        };
        if (uart_driver_install(x->port, AUX_BUF_SIZE, AUX_BUF_SIZE, 0, NULL, 0) != ESP_OK ||
            uart_param_config(x->port, &cfg) != ESP_OK ||
            uart_set_pin(x->port, x->tx_pin, x->rx_pin, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) {
            ESP_LOGE(TAG, "%s: UART%d setup failed — line disabled", x->name, (int)x->port);
            continue;
        }
        gpio_pullup_en(x->rx_pin);  // an unconnected RX floats and reads noise otherwise
        char task_name[16];
        snprintf(task_name, sizeof(task_name), "aux_%s", x->name);
        xTaskCreate(reader_task, task_name, 3072, x, 5, NULL);
        ESP_LOGI(TAG, "%s: UART%d at %d 8N1 (TX=%d RX=%d) — ws://<bridge>/serial?line=%s",
                 x->name, (int)x->port, x->baud, x->tx_pin, x->rx_pin, x->name);
    }
    httpd_uri_t ws = { .uri = "/serial", .method = HTTP_GET, .handler = serial_ws_handler, .is_websocket = true };
    httpd_uri_t st = { .uri = "/serial-status", .method = HTTP_GET, .handler = status_handler };
    httpd_uri_t cf = { .uri = "/serial-config", .method = HTTP_POST, .handler = config_handler };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &ws));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &st));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cf));
}

#else  // A1S: no extra serial lines

void aux_serial_start(httpd_handle_t server) { (void)server; }
void aux_serial_on_client_close(int sockfd) { (void)sockfd; }

#endif
