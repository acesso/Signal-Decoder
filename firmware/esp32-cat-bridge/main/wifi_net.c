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
#include "led_status.h"

static const char *TAG = "wifi_net";

static EventGroupHandle_t s_wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

static int s_retry_count = 0;
static bool s_mdns_started = false;
static bool s_ap_fallback_active = false;
static esp_netif_t *s_ap_netif = NULL;

static void start_mdns(void);
static void start_ap_fallback(void);
static void stop_ap_fallback(void);

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
        led_status_set_wifi_connecting(true);
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        // Unattended device: always keep retrying so it self-heals from a
        // router reboot or a temporary outage. The retry counter only
        // gates how long the initial xEventGroupWaitBits() in
        // wifi_net_start() blocks boot, AND when AP fallback kicks in —
        // past BRIDGE_WIFI_MAXIMUM_RETRY we signal WIFI_FAIL_BIT once (to
        // unblock startup) and start broadcasting our own AP, but keep
        // calling esp_wifi_connect() on every disconnect event forever
        // after so it drops the fallback AP the moment the real network
        // comes back.
        if (s_retry_count < BRIDGE_WIFI_MAXIMUM_RETRY) {
            s_retry_count++;
            set_wifi_state(BRIDGE_WIFI_CONNECTING);
            led_status_set_wifi_connecting(true);
            ESP_LOGW(TAG, "retry connecting to AP (%d/%d)", s_retry_count, BRIDGE_WIFI_MAXIMUM_RETRY);
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            if (!s_ap_fallback_active) {
                start_ap_fallback();
            }
            set_wifi_state(BRIDGE_WIFI_AP_FALLBACK);
            led_status_set_wifi_connecting(false);
            led_status_set_ap_fallback(true);
            ESP_LOGW(TAG, "still retrying connection to AP in the background");
        }
        esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "got ip: " IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_count = 0;
        set_wifi_ip(&event->ip_info.ip);
        set_wifi_state(BRIDGE_WIFI_CONNECTED);
        led_status_set_wifi_connecting(false);
        led_status_set_ap_fallback(false);
        update_rssi();
        if (s_ap_fallback_active) {
            stop_ap_fallback();
        }
        if (!s_mdns_started) {
            start_mdns();
            s_mdns_started = true;
        }
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

// Broadcasts BRIDGE_AP_SSID (WIFI_MODE_APSTA — STA keeps retrying the real
// network underneath) so the control page stays reachable at the AP's
// fixed IP (192.168.4.1, esp_netif's default for a soft-AP) even when the
// configured home network is unreachable. Left running until
// IP_EVENT_STA_GOT_IP fires (see stop_ap_fallback()) — there is no separate
// timeout for the AP itself, since leaving it up costs nothing but a
// little extra RF/RAM and the alternative (silently giving up) would strand
// the device.
static void start_ap_fallback(void) {
    if (!s_ap_netif) {
        s_ap_netif = esp_netif_create_default_wifi_ap();
    }

    wifi_config_t ap_config = { 0 };
    strncpy((char *)ap_config.ap.ssid, CONFIG_BRIDGE_AP_SSID, sizeof(ap_config.ap.ssid) - 1);
    ap_config.ap.ssid_len = strlen(CONFIG_BRIDGE_AP_SSID);
    strncpy((char *)ap_config.ap.password, CONFIG_BRIDGE_AP_PASSWORD, sizeof(ap_config.ap.password) - 1);
    ap_config.ap.channel = 1;
    ap_config.ap.max_connection = 4;
    ap_config.ap.authmode = strlen(CONFIG_BRIDGE_AP_PASSWORD) == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    s_ap_fallback_active = true;
    ESP_LOGW(TAG, "AP fallback active: broadcasting \"%s\" at 192.168.4.1 "
                   "(control page reachable there while retrying the real network)",
              CONFIG_BRIDGE_AP_SSID);
}

static void stop_ap_fallback(void) {
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    s_ap_fallback_active = false;
    ESP_LOGI(TAG, "reconnected to home network — AP fallback dropped");
}

static void start_mdns(void) {
    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(BRIDGE_HOSTNAME));
    ESP_ERROR_CHECK(mdns_instance_name_set("uSDX CAT Bridge"));

    mdns_txt_item_t txt[] = {
        { "board",   "esp32-a1s" },
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

    // esp_wifi_start() leaves the driver at its own default station
    // power-save mode, WIFI_PS_MIN_MODEM (confirmed by the "wifi:pm start,
    // type: 1" boot log line — type 1 IS WIFI_PS_MIN_MODEM) — the radio
    // sleeps between DTIM beacons and only wakes to receive the AP's
    // buffered frame. That's the documented cause of exactly the symptom
    // reported on this bridge: the /cat and /audio WebSockets randomly
    // stall for seconds at a time while ICMP ping still gets through with
    // elevated latency (ping replies ride the next DTIM wake window; an
    // active WS connection with data queued mid-sleep-interval has to wait
    // for it too, and any packet loss or AP-side buffering hiccup at this
    // board's borderline RSSI (-70 to -72 dBm) compounds that into a
    // multi-second-or-longer stall that either recovers on the next good
    // wake or doesn't). This bridge is mains-powered, not battery, so
    // there's no tradeoff to weigh — disabling power-save entirely trades a
    // few hundred mA for eliminating the sleep-window stalls outright.
    esp_err_t ps_err = esp_wifi_set_ps(WIFI_PS_NONE);
    if (ps_err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_set_ps(WIFI_PS_NONE) failed: %s — modem sleep may still be active", esp_err_to_name(ps_err));
    }

    // esp_wifi_set_max_tx_power() requires WiFi already started (see
    // wifi_net.h) — applied here, once, right after esp_wifi_start(), so a
    // previously-persisted experiment survives a reboot instead of silently
    // reverting to the driver's own power-on default.
    int8_t saved_tx_power = bridge_settings_get_wifi_tx_power_quarter_dbm();
    if (!wifi_net_set_tx_power_quarter_dbm(saved_tx_power)) {
        ESP_LOGW(TAG, "failed to apply saved TX power (%d quarter-dBm) at boot", (int)saved_tx_power);
    }

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

int wifi_net_scan(wifi_net_scan_result_t *out, int max_results) {
    // block=true: simplest for a request/response HTTP handler — the
    // caller (http_control's /wifi-scan) is already off the Wi-Fi/lwIP
    // core-0 tasks (httpd worker), so blocking here doesn't contend with
    // CAT UART on core 1, and a synchronous "scan done, here are the
    // results" response is easier to reason about than a two-step
    // start/poll API for something the control page only calls when the
    // user clicks refresh.
    wifi_scan_config_t scan_config = { 0 };
    esp_err_t err = esp_wifi_scan_start(&scan_config, true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "scan failed: %s", esp_err_to_name(err));
        return -1;
    }

    uint16_t found = 0;
    esp_wifi_scan_get_ap_num(&found);
    if (found == 0) return 0;

    // Static, not stack-local: wifi_ap_record_t is ~90 bytes, so a [32]
    // array is ~2.9KB — layered on top of the caller's own httpd-worker
    // stack usage, that overflowed the httpd worker's stack and corrupted
    // the call frame (LoadStoreAlignment panic) the first time this ran on
    // real hardware. wifi_net_scan() is only ever called synchronously
    // from one HTTP request at a time (the control page's single refresh
    // button), so a shared static buffer is safe — no concurrent scan can
    // be in flight to race it.
    static wifi_ap_record_t records[32];
    uint16_t to_fetch = found < 32 ? found : 32;
    err = esp_wifi_scan_get_ap_records(&to_fetch, records);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to fetch scan results: %s", esp_err_to_name(err));
        return -1;
    }

    // Dedup by SSID, keeping the strongest RSSI — the same home network
    // is often visible on multiple APs/channels (mesh systems, repeaters),
    // and a select box listing "MyWiFi" three times is just confusing.
    int count = 0;
    for (uint16_t i = 0; i < to_fetch && count < max_results; i++) {
        const char *ssid = (const char *)records[i].ssid;
        if (ssid[0] == '\0') continue; // hidden network, nothing to show/select

        int existing = -1;
        for (int j = 0; j < count; j++) {
            if (strcmp(out[j].ssid, ssid) == 0) { existing = j; break; }
        }
        if (existing >= 0) {
            if (records[i].rssi > out[existing].rssi) out[existing].rssi = records[i].rssi;
            continue;
        }
        strncpy(out[count].ssid, ssid, sizeof(out[count].ssid) - 1);
        out[count].ssid[sizeof(out[count].ssid) - 1] = '\0';
        out[count].rssi = records[i].rssi;
        count++;
    }
    return count;
}

#define WIFI_TX_POWER_MIN_QUARTER_DBM 8
#define WIFI_TX_POWER_MAX_QUARTER_DBM 84

bool wifi_net_set_tx_power_quarter_dbm(int8_t quarter_dbm) {
    if (quarter_dbm < WIFI_TX_POWER_MIN_QUARTER_DBM || quarter_dbm > WIFI_TX_POWER_MAX_QUARTER_DBM) {
        ESP_LOGW(TAG, "TX power %d out of range [%d,%d] quarter-dBm",
                 (int)quarter_dbm, WIFI_TX_POWER_MIN_QUARTER_DBM, WIFI_TX_POWER_MAX_QUARTER_DBM);
        return false;
    }
    esp_err_t err = esp_wifi_set_max_tx_power(quarter_dbm);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_set_max_tx_power(%d) failed: %s", (int)quarter_dbm, esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "TX power set to %d quarter-dBm (%.1f dBm)", (int)quarter_dbm, quarter_dbm * 0.25f);
    return true;
}

bool wifi_net_get_tx_power_quarter_dbm(int8_t *quarter_dbm) {
    esp_err_t err = esp_wifi_get_max_tx_power(quarter_dbm);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_get_max_tx_power failed: %s", esp_err_to_name(err));
        return false;
    }
    return true;
}
