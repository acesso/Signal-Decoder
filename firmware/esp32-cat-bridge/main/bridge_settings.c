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
#define NVS_KEY_ADC_INPUT "adc_input"
#define DEFAULT_ADC_INPUT_NAME "lin2"
#define NVS_KEY_RX_SLOT_RIGHT "rx_slot_r"
#define NVS_KEY_MIC_GAIN_DB "mic_gain_db"
#define NVS_KEY_WIFI_TX_POWER "wifi_tx_pwr"
#define DEFAULT_WIFI_TX_POWER_QUARTER_DBM 84 // 21.0 dBm — the driver's own maximum
#define NVS_KEY_SAMPLE_RATE "sample_rate"
#define DEFAULT_SAMPLE_RATE_HZ 48000 // matches a typical browser AudioContext's native device rate
#define NVS_KEY_INPUT_MODE "input_mode"
#define DEFAULT_INPUT_MODE_NAME "audio"
#define NVS_KEY_CAT_LOG_ENABLED "cat_log_en"
// Defaults OFF — this is a debug feature (see cat_log.h), and its boot-time
// flash-recovery scan grows with the log's own record count; left running
// indefinitely it was found to grow past the 5s task-watchdog timeout on
// real hardware, causing a genuine crash-loop (see cat_log.c's yield fix
// for the immediate mitigation). Defaulting off means most units never
// build up enough records for that scan to matter — an operator explicitly
// debugging a CAT issue opts in via POST /cat-log-enable and cat_log_init()
// respects this the same way audio_monitor_start() respects sample_rate_hz.
#define DEFAULT_CAT_LOG_ENABLED false
// Confirmed on real hardware: LIN2 (P2 jack) + right ADC channel produces a
// clean, strong signal — see the ADCCONTROL2/RX-slot comments in
// audio_monitor.c for the full investigation that found this. MIC gain
// itself defaults to 0dB (the ES8388's own PGA default) — 21dB was an
// earlier attempt to fight onboard-mic bleed-through, but that bleed turned
// out to be a board-wiring issue no gain setting actually fixes, so there's
// no reason to default away from unity gain.
#define DEFAULT_RX_SLOT_IS_RIGHT true
#define DEFAULT_MIC_GAIN_DB 0.0f

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

void bridge_settings_get_adc_input_name(char *name_out, size_t out_sz) {
    nvs_handle_t h;
    bool have_it = false;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = out_sz;
        have_it = nvs_get_str(h, NVS_KEY_ADC_INPUT, name_out, &len) == ESP_OK;
        nvs_close(h);
    }
    if (!have_it) strncpy(name_out, DEFAULT_ADC_INPUT_NAME, out_sz - 1);
    name_out[out_sz - 1] = '\0';
}

bool bridge_settings_set_adc_input_name(const char *name) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_str(h, NVS_KEY_ADC_INPUT, name);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved ADC input selection to NVS (%s): %s", name, ok ? "ok" : "FAILED");
    return ok;
}

bool bridge_settings_get_rx_slot_is_right(void) {
    nvs_handle_t h;
    uint8_t v = DEFAULT_RX_SLOT_IS_RIGHT ? 1 : 0;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, NVS_KEY_RX_SLOT_RIGHT, &v);
        nvs_close(h);
    }
    return v != 0;
}

bool bridge_settings_set_rx_slot_is_right(bool use_right) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_u8(h, NVS_KEY_RX_SLOT_RIGHT, use_right ? 1 : 0);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved RX slot selection to NVS (%s): %s", use_right ? "right" : "left", ok ? "ok" : "FAILED");
    return ok;
}

float bridge_settings_get_mic_gain_db(void) {
    nvs_handle_t h;
    float db = DEFAULT_MIC_GAIN_DB;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(db);
        nvs_get_blob(h, NVS_KEY_MIC_GAIN_DB, &db, &len);
        nvs_close(h);
    }
    return db;
}

bool bridge_settings_set_mic_gain_db(float db_value) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_blob(h, NVS_KEY_MIC_GAIN_DB, &db_value, sizeof(db_value));
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved MIC gain to NVS (%.1f dB): %s", db_value, ok ? "ok" : "FAILED");
    return ok;
}

int8_t bridge_settings_get_wifi_tx_power_quarter_dbm(void) {
    nvs_handle_t h;
    int8_t v = DEFAULT_WIFI_TX_POWER_QUARTER_DBM;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_i8(h, NVS_KEY_WIFI_TX_POWER, &v);
        nvs_close(h);
    }
    return v;
}

bool bridge_settings_set_wifi_tx_power_quarter_dbm(int8_t quarter_dbm) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_i8(h, NVS_KEY_WIFI_TX_POWER, quarter_dbm);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved WiFi TX power to NVS (%d quarter-dBm): %s", (int)quarter_dbm, ok ? "ok" : "FAILED");
    return ok;
}

uint32_t bridge_settings_get_sample_rate_hz(void) {
    nvs_handle_t h;
    uint32_t v = DEFAULT_SAMPLE_RATE_HZ;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u32(h, NVS_KEY_SAMPLE_RATE, &v);
        nvs_close(h);
    }
    return v;
}

bool bridge_settings_set_sample_rate_hz(uint32_t rate_hz) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_u32(h, NVS_KEY_SAMPLE_RATE, rate_hz);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved sample rate to NVS (%u Hz): %s", (unsigned)rate_hz, ok ? "ok" : "FAILED");
    return ok;
}

void bridge_settings_get_input_mode_name(char *name_out, size_t out_sz) {
    nvs_handle_t h;
    bool have_it = false;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = out_sz;
        have_it = nvs_get_str(h, NVS_KEY_INPUT_MODE, name_out, &len) == ESP_OK;
        nvs_close(h);
    }
    if (!have_it) strncpy(name_out, DEFAULT_INPUT_MODE_NAME, out_sz - 1);
    name_out[out_sz - 1] = '\0';
}

bool bridge_settings_set_input_mode_name(const char *name) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_str(h, NVS_KEY_INPUT_MODE, name);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved input mode selection to NVS (%s): %s", name, ok ? "ok" : "FAILED");
    return ok;
}

bool bridge_settings_get_cat_log_enabled(void) {
    nvs_handle_t h;
    uint8_t v = DEFAULT_CAT_LOG_ENABLED ? 1 : 0;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, NVS_KEY_CAT_LOG_ENABLED, &v);
        nvs_close(h);
    }
    return v != 0;
}

bool bridge_settings_set_cat_log_enabled(bool enabled) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e1 = nvs_set_u8(h, NVS_KEY_CAT_LOG_ENABLED, enabled ? 1 : 0);
    esp_err_t e2 = nvs_commit(h);
    nvs_close(h);
    bool ok = e1 == ESP_OK && e2 == ESP_OK;
    ESP_LOGI(TAG, "saved persistent CAT log enabled=%s to NVS: %s", enabled ? "true" : "false", ok ? "ok" : "FAILED");
    return ok;
}
