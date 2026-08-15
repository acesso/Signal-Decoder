// ESP32 CAT bridge — sits between the uSDX BLACK_BRICK's CAT serial port
// and the Signal-Decoder web app, replacing a USB-serial cable with Wi-Fi.
// Target board: AI-Thinker ESP32-A1S Audio Kit — see bridge_config.h.
//
// Data path: radio <--UART2--> cat_bridge <--callback--> ws_server <--WS--> browser
// Status:    bridge_state (mutex-guarded snapshot) <-- http_control --> GET /status, POST /reset
// Control UI: control_page serves a standalone status/Wi-Fi/restart page at GET /
// PA safety: pa_watchdog forces the external miniPA70 off if it's sensed
//            energized for too long — see main/doc/PA_WATCHDOG_DESIGN.md
//
// Framework-pinned Wi-Fi/lwIP tasks run on core 0; the CAT UART reader is
// pinned exclusively to core 1 (see bridge_config.h's task-placement
// notes), so radio I/O timing is never contended with network stack activity.
#include "esp_log.h"

#include "audio_monitor.h"
#include "audio_ws.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "cat_bridge.h"
#include "control_page.h"
#include "http_control.h"
#include "led_status.h"
#include "pa_watchdog.h"
#include "wifi_net.h"
#include "ws_server.h"

static const char *TAG = "app_main";

void app_main(void) {
    ESP_LOGI(TAG, "esp32-cat-bridge starting");

    bridge_settings_init();   // NVS init — must run before anything reads persisted settings
    bridge_state_init();
    led_status_start();       // no ordering dependency — wifi_net/cat_bridge feed it state after
    pa_watchdog_start();       // after led_status_start() — calls led_status_set_pa_emergency()
    wifi_net_start();
    ws_server_start();
    audio_ws_start(ws_server_get_httpd()); // needs ws_server's httpd handle — after ws_server_start()
    http_control_start();     // needs ws_server's httpd handle — after ws_server_start()
    control_page_start();     // standalone control UI — same httpd instance
    cat_bridge_start(ws_server_send_to_client);
    audio_monitor_start();    // needs audio_ws_start() already registered its rx callback slot

    ESP_LOGI(TAG, "bridge running");
}
