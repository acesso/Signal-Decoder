// One-way WebSocket fan-out: a fixed set of client sockets that each get a
// copy of every frame. Frames are copied into PSRAM and sent from the httpd
// task (httpd_queue_work), the only task allowed to write the sockets. A
// client that falls behind by more than WS_FANOUT_MAX_PENDING frames misses
// frames instead of piling up memory.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define WS_FANOUT_MAX_CLIENTS 2
#define WS_FANOUT_MAX_PENDING 6

typedef struct {
    const char *name;
    httpd_handle_t server;
    SemaphoreHandle_t mutex;
    int fds[WS_FANOUT_MAX_CLIENTS];
    int pending[WS_FANOUT_MAX_CLIENTS];
    uint32_t dropped;  // frames skipped for a slow client
} ws_fanout_t;

void ws_fanout_init(ws_fanout_t *f, const char *name, httpd_handle_t server);
bool ws_fanout_add(ws_fanout_t *f, int fd);       // false when full
void ws_fanout_remove(ws_fanout_t *f, int fd);
int  ws_fanout_count(ws_fanout_t *f);
// Sends header + payload as one BINARY frame to every client.
void ws_fanout_send(ws_fanout_t *f, const void *hdr, size_t hdr_len, const void *data, size_t len);
