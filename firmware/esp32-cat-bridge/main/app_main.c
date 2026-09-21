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
#include "esp_ota_ops.h"

#include "audio_monitor.h"
#include "audio_sniff.h"
#include "audio_ws.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "cat_bridge.h"
#include "cat_log.h"
#include "control_page.h"
#include "cpu_monitor.h"
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
    cpu_monitor_start();      // pins CPU freq to its fixed boot value — no ordering dependency on anything else
    cat_log_init();           // before cat_bridge_start() so no early CAT frames are missed
    led_status_start();       // no ordering dependency — wifi_net/cat_bridge feed it state after
    pa_watchdog_start();       // after led_status_start() — calls led_status_set_pa_emergency()
    wifi_net_start();
    ws_server_start();
    audio_ws_start(ws_server_get_httpd()); // needs ws_server's httpd handle — after ws_server_start()
    audio_sniff_start(ws_server_get_httpd()); // read-only mic-to-radio tap — see audio_sniff.h
    http_control_start();     // needs ws_server's httpd handle — after ws_server_start()
    control_page_start();     // standalone control UI — same httpd instance
    cat_bridge_start(ws_server_send_to_client);
    audio_monitor_start();    // needs audio_ws_start() already registered its rx callback slot


    // OTA rollback gate (see partitions.csv / ota_handler()). With
    // CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE, an image written by POST /ota
    // boots exactly ONCE in ESP_OTA_IMG_PENDING_VERIFY; if it never marks
    // itself valid, the bootloader reverts to the previous slot on the next
    // reset. Marking here — at the END of app_main, after every subsystem
    // above has started — means a build that crashes or aborts during
    // bringup (the realistic way a bad flash bricks this unit, since the
    // bridge is normally out of UART reach) rolls itself back instead of
    // needing the cable. Deliberately NOT gated on WiFi having associated:
    // the bridge must stay recoverable when it boots somewhere its
    // configured AP doesn't exist, and rolling back over a missing network
    // would strand a perfectly good image.
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t ota_state;
    if (running && esp_ota_get_state_partition(running, &ota_state) == ESP_OK &&
        ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_err_t mark_err = esp_ota_mark_app_valid_cancel_rollback();
        if (mark_err == ESP_OK) {
            ESP_LOGW(TAG, "OTA image on '%s' marked valid — rollback cancelled", running->label);
        } else {
            ESP_LOGE(TAG, "failed to mark OTA image valid (%s) — this build will roll back on next reset",
                     esp_err_to_name(mark_err));
        }
    }
    ESP_LOGI(TAG, "bridge running");
}
