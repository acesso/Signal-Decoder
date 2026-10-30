// One-way WebSocket fan-out — see ws_fanout.h.
#include "ws_fanout.h"

#include <stdlib.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "ws_fanout";

typedef struct {
    ws_fanout_t *f;
    int fd;
    httpd_ws_type_t type;
    size_t len;
    uint8_t data[];
} fanout_msg_t;

static void send_work(void *arg) {
    fanout_msg_t *m = arg;
    httpd_ws_frame_t frame = { .type = m->type, .payload = m->data, .len = m->len };
    if (httpd_ws_send_frame_async(m->f->server, m->fd, &frame) != ESP_OK) {
        ESP_LOGD(TAG, "%s: send to fd=%d failed", m->f->name, m->fd);
    }
    xSemaphoreTake(m->f->mutex, portMAX_DELAY);
    for (int i = 0; i < WS_FANOUT_CAPACITY; i++)
        if (m->f->fds[i] == m->fd && m->f->pending[i] > 0) m->f->pending[i]--;
    xSemaphoreGive(m->f->mutex);
    free(m);
}

void ws_fanout_init_max(ws_fanout_t *f, const char *name, httpd_handle_t server, int max_clients) {
    memset(f, 0, sizeof(*f));
    f->name = name;
    f->server = server;
    f->max_clients = max_clients < 1 ? 1 : max_clients > WS_FANOUT_CAPACITY ? WS_FANOUT_CAPACITY : max_clients;
    f->mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < WS_FANOUT_CAPACITY; i++) f->fds[i] = -1;
}

void ws_fanout_init(ws_fanout_t *f, const char *name, httpd_handle_t server) {
    ws_fanout_init_max(f, name, server, WS_FANOUT_MAX_CLIENTS);
}

bool ws_fanout_add(ws_fanout_t *f, int fd) {
    bool ok = false;
    xSemaphoreTake(f->mutex, portMAX_DELAY);
    for (int i = 0; i < f->max_clients && !ok; i++)
        if (f->fds[i] < 0) { f->fds[i] = fd; f->pending[i] = 0; ok = true; }
    xSemaphoreGive(f->mutex);
    return ok;
}

void ws_fanout_remove(ws_fanout_t *f, int fd) {
    if (!f->mutex) return;
    xSemaphoreTake(f->mutex, portMAX_DELAY);
    for (int i = 0; i < WS_FANOUT_CAPACITY; i++) if (f->fds[i] == fd) f->fds[i] = -1;
    xSemaphoreGive(f->mutex);
}

int ws_fanout_count(ws_fanout_t *f) {
    int n = 0;
    xSemaphoreTake(f->mutex, portMAX_DELAY);
    for (int i = 0; i < WS_FANOUT_CAPACITY; i++) if (f->fds[i] >= 0) n++;
    xSemaphoreGive(f->mutex);
    return n;
}

static void send_typed(ws_fanout_t *f, httpd_ws_type_t type, const void *hdr, size_t hdr_len, const void *data, size_t len) {
    int fds[WS_FANOUT_CAPACITY], n = 0;
    xSemaphoreTake(f->mutex, portMAX_DELAY);
    for (int i = 0; i < WS_FANOUT_CAPACITY; i++) {
        if (f->fds[i] < 0) continue;
        if (f->pending[i] >= WS_FANOUT_MAX_PENDING) { f->dropped++; continue; }
        f->pending[i]++;
        fds[n++] = f->fds[i];
    }
    xSemaphoreGive(f->mutex);
    for (int i = 0; i < n; i++) {
        fanout_msg_t *m = heap_caps_malloc(sizeof(fanout_msg_t) + hdr_len + len, MALLOC_CAP_SPIRAM);
        if (m) {
            m->f = f;
            m->fd = fds[i];
            m->type = type;
            m->len = hdr_len + len;
            if (hdr_len) memcpy(m->data, hdr, hdr_len);
            memcpy(m->data + hdr_len, data, len);
            if (httpd_queue_work(f->server, send_work, m) == ESP_OK) continue;
            free(m);
        }
        xSemaphoreTake(f->mutex, portMAX_DELAY);  // not queued: undo its pending count
        for (int k = 0; k < WS_FANOUT_CAPACITY; k++) if (f->fds[k] == fds[i] && f->pending[k] > 0) f->pending[k]--;
        xSemaphoreGive(f->mutex);
    }
}

void ws_fanout_send(ws_fanout_t *f, const void *hdr, size_t hdr_len, const void *data, size_t len) {
    send_typed(f, HTTPD_WS_TYPE_BINARY, hdr, hdr_len, data, len);
}

void ws_fanout_send_text(ws_fanout_t *f, const char *text) {
    send_typed(f, HTTPD_WS_TYPE_TEXT, NULL, 0, text, strlen(text));
}
