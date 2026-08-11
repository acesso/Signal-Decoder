#include "bridge_settings.h"

#include <inttypes.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "bridge_config.h"

static const char *TAG = "bridge_settings";

// Separate NVS namespace from anything Wi-Fi-driver-internal (esp_wifi uses
// its own "nvs.net80211"-style namespaces) — this is purely our own
// user-settings blob, one namespace, plain string/u8 keys.
#define NVS_NAMESPACE "bridge_cfg"
#define NVS_KEY_SSID     "wifi_ssid"
#define NVS_KEY_PASSWORD "wifi_pass"
#define NVS_KEY_CAT_BAUD "cat_baud"

// nvs_flash_init() is already called once by wifi_net_start() (Wi-Fi driver
// requires it) — but bridge_settings_init() runs first in app_main, before
// wifi_net_start(), so it needs its own init here too. Calling
// nvs_flash_init() a second time later is safe/idempotent per the ESP-IDF
// docs (it no-ops if already initialized), so no ordering fragility either way.
void bridge_settings_init(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
}

void bridge_settings_get_wifi(char *ssid_out, size_t ssid_sz, char *pass_out, size_t pass_sz) {
    nvs_handle_t h;
    bool have_ssid = false, have_pass = false;

    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = ssid_sz;
        if (nvs_get_str(h, NVS_KEY_SSID, ssid_out, &len) == ESP_OK) have_ssid = true;
        len = pass_sz;
        if (nvs_get_str(h, NVS_KEY_PASSWORD, pass_out, &len) == ESP_OK) have_pass = true;
        nvs_close(h);
    }

    if (!have_ssid) strncpy(ssid_out, CONFIG_BRIDGE_WIFI_SSID, ssid_sz - 1);
    if (!have_pass) strncpy(pass_out, CONFIG_BRIDGE_WIFI_PASSWORD, pass_sz - 1);
    ssid_out[ssid_sz - 1] = '\0';
    pass_out[pass_sz - 1] = '\0';

    ESP_LOGI(TAG, "Wi-Fi credentials source: ssid=%s, password=%s",
              have_ssid ? "NVS" : "Kconfig default", have_pass ? "NVS" : "Kconfig default");
}

bool bridge_settings_set_wifi(const char *ssid, const char *password) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_str(h, NVS_KEY_SSID, ssid);
    esp_err_t e2 = nvs_set_str(h, NVS_KEY_PASSWORD, password);
    esp_err_t e3 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK && e3 == ESP_OK;
    ESP_LOGI(TAG, "saved new Wi-Fi credentials to NVS (ssid=%s): %s", ssid, ok ? "ok" : "FAILED");
    return ok;
}

int bridge_settings_get_cat_baud(void) {
    nvs_handle_t h;
    int32_t baud = 0;
    bool have_baud = false;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        have_baud = nvs_get_i32(h, NVS_KEY_CAT_BAUD, &baud) == ESP_OK;
        nvs_close(h);
    }
    if (!have_baud) baud = CONFIG_BRIDGE_CAT_UART_BAUD;
    ESP_LOGI(TAG, "CAT baud source: %s (%" PRId32 ")", have_baud ? "NVS" : "Kconfig default", baud);
    return (int)baud;
}

bool bridge_settings_set_cat_baud(int baud) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_i32(h, NVS_KEY_CAT_BAUD, (int32_t)baud);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved new CAT baud to NVS (%d): %s", baud, ok ? "ok" : "FAILED");
    return ok;
}
