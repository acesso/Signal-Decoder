#include "bridge_state.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static bridge_state_t s_state;
static SemaphoreHandle_t s_mutex;

void bridge_state_init(void) {
    memset(&s_state, 0, sizeof(s_state));
    s_state.wifi_state = BRIDGE_WIFI_DISCONNECTED;
    s_mutex = xSemaphoreCreateMutex();
}

void bridge_state_get(bridge_state_t *out) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_state;
    xSemaphoreGive(s_mutex);
}

void bridge_state_update(void (*mutate)(bridge_state_t *state, void *ctx), void *ctx) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    mutate(&s_state, ctx);
    xSemaphoreGive(s_mutex);
}
