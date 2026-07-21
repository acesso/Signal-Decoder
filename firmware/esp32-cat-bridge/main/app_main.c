// ESP32 CAT bridge — sits between the uSDX BLACK_BRICK's CAT serial port
// and the Signal-Decoder web app, replacing a USB-serial cable with Wi-Fi.
//
// Data path: radio <--UART2--> cat_bridge <--callback--> ws_server <--WS--> browser
// Status:    bridge_state (mutex-guarded snapshot) <-- status_display --> PCD8544 LCD
//            bridge_state, wifi_net <-- http_control --> GET /status, POST /reset
//
// Framework-pinned Wi-Fi/lwIP tasks run on core 0; the CAT UART reader and
// LCD refresh tasks are explicitly pinned to core 1 (see bridge_config.h)
// so radio I/O timing is never contended with network stack activity.
#include "esp_log.h"

#include "bridge_settings.h"
#include "bridge_state.h"
#include "cat_bridge.h"
#include "http_control.h"
#include "status_display.h"
#include "wifi_net.h"
#include "ws_server.h"

static const char *TAG = "app_main";

void app_main(void) {
    ESP_LOGI(TAG, "esp32-cat-bridge starting");

    bridge_settings_init();   // NVS init — must run before anything reads persisted settings
    bridge_state_init();
    status_display_start();   // show boot status even before Wi-Fi comes up
    wifi_net_start();
    ws_server_start();
    http_control_start();     // needs ws_server's httpd handle — after ws_server_start()
    cat_bridge_start(ws_server_send_to_client);

    ESP_LOGI(TAG, "bridge running");
}
