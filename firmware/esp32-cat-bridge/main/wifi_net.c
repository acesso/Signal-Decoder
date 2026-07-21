#include "wifi_net.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "mdns.h"
#include "nvs_flash.h"

#include "bridge_config.h"
#include "bridge_settings.h"
#include "bridge_state.h"

static const char *TAG = "wifi_net";

static EventGroupHandle_t s_wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

static int s_retry_count = 0;
static bool s_mdns_started = false;

static void start_mdns(void);

// bridge_state_update() mutator callbacks — plain static functions (not
// nested functions) so this builds with any standard C compiler and never
// needs a trampoline on the stack.
static void mutate_wifi_state(bridge_state_t *state, void *ctx) {
    state->wifi_state = *(bridge_wifi_state_t *)ctx;
}

static void set_wifi_state(bridge_wifi_state_t st) {
    bridge_state_update(mutate_wifi_state, &st);
}

static void mutate_wifi_ip(bridge_state_t *state, void *ctx) {
    strncpy(state->ip_addr, (const char *)ctx, sizeof(state->ip_addr) - 1);
}

static void set_wifi_ip(const esp_ip4_addr_t *ip) {
    char buf[16];
    esp_ip4addr_ntoa(ip, buf, sizeof(buf));
    bridge_state_update(mutate_wifi_ip, buf);
}

static void mutate_wifi_rssi(bridge_state_t *state, void *ctx) {
    state->wifi_rssi = *(int8_t *)ctx;
}

static void update_rssi(void) {
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        int8_t rssi = ap_info.rssi;
        bridge_state_update(mutate_wifi_rssi, &rssi);
    }
}

bool wifi_net_get_live_rssi(int8_t *rssi) {
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) != ESP_OK) return false;
    *rssi = ap_info.rssi;
    return true;
}

static void event_handler(void *arg, esp_event_base_t event_base,
                           int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        set_wifi_state(BRIDGE_WIFI_CONNECTING);
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        set_wifi_state(s_retry_count < BRIDGE_WIFI_MAXIMUM_RETRY
            ? BRIDGE_WIFI_CONNECTING : BRIDGE_WIFI_DISCONNECTED);
        // Unattended device: always keep retrying so it self-heals from a
        // router reboot or a temporary outage. The retry counter only
        // gates how long the initial xEventGroupWaitBits() in
        // wifi_net_start() blocks boot — past BRIDGE_WIFI_MAXIMUM_RETRY we
        // signal WIFI_FAIL_BIT once (to unblock startup) but keep calling
        // esp_wifi_connect() on every disconnect event forever after.
        if (s_retry_count < BRIDGE_WIFI_MAXIMUM_RETRY) {
            s_retry_count++;
            ESP_LOGW(TAG, "retry connecting to AP (%d/%d)", s_retry_count, BRIDGE_WIFI_MAXIMUM_RETRY);
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            ESP_LOGW(TAG, "still retrying connection to AP in the background");
        }
        esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "got ip: " IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_count = 0;
        set_wifi_ip(&event->ip_info.ip);
        set_wifi_state(BRIDGE_WIFI_CONNECTED);
        update_rssi();
        if (!s_mdns_started) {
            start_mdns();
            s_mdns_started = true;
        }
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void start_mdns(void) {
    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(BRIDGE_HOSTNAME));
    ESP_ERROR_CHECK(mdns_instance_name_set("uSDX CAT Bridge"));

    mdns_txt_item_t txt[] = {
        { "board",   "esp32-wroom-32" },
        { "service", "cat" },
    };
    ESP_ERROR_CHECK(mdns_service_add("uSDX CAT Bridge", "_cat-bridge", "_tcp",
                                      WS_SERVER_PORT, txt, 2));
    ESP_LOGI(TAG, "mDNS advertised as %s.local", BRIDGE_HOSTNAME);
}

void wifi_net_start(void) {
    // NVS is already initialized by bridge_settings_init() in app_main,
    // before this runs — no need to repeat it here.
    s_wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(sta_netif, BRIDGE_HOSTNAME);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL, &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL, &instance_got_ip));

    // Credentials come from NVS if the web app's bridge panel has ever set
    // them there, otherwise the Kconfig-baked compile-time default — see
    // bridge_settings.c.
    char ssid[33], password[65];
    bridge_settings_get_wifi(ssid, sizeof(ssid), password, sizeof(password));

    // wifi_sta_config_t.ssid/.password are [32]/[64] with no ssid_len set
    // here, so esp_wifi treats them as NUL-terminated strings internally —
    // copy at most sizeof(field)-1 bytes to guarantee the NUL survives even
    // for a full-length (32-char) SSID/password, at the cost of silently
    // truncating anything longer than that (WPA2's own SSID/password limits
    // are 32/63 chars, so this only bites a maximally-long SSID by 1 char).
    wifi_config_t wifi_config = { 0 };
    strncpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, password, sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.sta.pmf_cfg.capable = true;
    wifi_config.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "connecting to SSID:%s", ssid);

    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(20000));

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "connected to SSID:%s", ssid);
    } else {
        ESP_LOGW(TAG, "wifi not yet connected after 20s — continuing boot; "
                       "mDNS/connection will start as soon as an IP is obtained "
                       "in the background (event_handler retries unboundedly "
                       "past the initial fast-retry counter)");
    }
}
