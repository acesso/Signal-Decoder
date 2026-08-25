// Wi-Fi station bring-up + mDNS advertisement (usdx-bridge.local), with an
// AP-fallback safety net: if BRIDGE_WIFI_SSID can't be joined after
// BRIDGE_WIFI_MAXIMUM_RETRY tries, the bridge starts broadcasting its own
// access point (BRIDGE_AP_SSID) so it's still reachable to fix the Wi-Fi
// settings, while continuing to retry the real network in the background
// and dropping the AP the moment it reconnects. Runs the standard ESP-IDF
// Wi-Fi/lwIP driver tasks (framework-pinned to core 0).
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Starts NVS (if not already), Wi-Fi station mode, connects using
// credentials from Kconfig, and registers mDNS once an IP is obtained.
// Blocks until the first connection succeeds or retries are exhausted
// (BRIDGE_WIFI_MAXIMUM_RETRY) — after that it keeps retrying in the
// background via the event handler and returns regardless, since the CAT
// bridge/LCD should still start and show "connecting" rather than hang boot.
void wifi_net_start(void);

// Fetches the CURRENT RSSI directly from the Wi-Fi driver (not the
// bridge_state snapshot, which only updates on connect/periodic LCD
// redraws) — for the web app's on-demand bridge-status query, where a
// stale reading would be misleading. Returns false (rssi left untouched)
// if not currently connected.
bool wifi_net_get_live_rssi(int8_t *rssi);

#define WIFI_NET_SCAN_MAX_RESULTS 16

typedef struct {
    char ssid[33];
    int8_t rssi;
} wifi_net_scan_result_t;

// Blocking active scan (typically 1-3s), deduplicated by SSID (keeps the
// strongest RSSI seen when the same network is visible on multiple
// channels/BSSIDs — a select box listing the same SSID 3 times would be
// confusing, and the caller never needs the individual BSSID here). Safe to
// call in STA, AP, or APSTA mode. Returns the number of results written to
// `out` (up to WIFI_NET_SCAN_MAX_RESULTS), or -1 on scan failure.
int wifi_net_scan(wifi_net_scan_result_t *out, int max_results);

// Live-sets the WiFi radio's max TX power via esp_wifi_set_max_tx_power() —
// units are quarter-dBm (raw value 78 == 19.5 dBm), valid range [8,84]
// (2..21 dBm); the driver snaps to its own nearest-supported step internally,
// it isn't a continuous scale. A cheap, low-confidence experiment for
// whether the WiFi radio's own transmit activity couples noise into the
// analog audio path, same reasoning as cpu_monitor.h's CPU-frequency knob.
// Must be called after wifi_net_start() (esp_wifi_start() already ran) —
// returns false otherwise, or if the value is out of range, or the
// underlying esp_wifi call failed. NOT persisted itself — see
// bridge_settings_set_wifi_tx_power_quarter_dbm() for that; wifi_net_start()
// applies the persisted value once at boot.
bool wifi_net_set_tx_power_quarter_dbm(int8_t quarter_dbm);

// Current max TX power in quarter-dBm, read back live from the driver
// (esp_wifi_get_max_tx_power()) rather than cached — for GET /status to
// report the value actually in effect. Returns false (value left untouched)
// if WiFi hasn't started yet or the underlying call failed.
bool wifi_net_get_tx_power_quarter_dbm(int8_t *quarter_dbm);

// Validates a BSSID string ("aa:bb:cc:dd:ee:ff" format, exactly 6
// colon-separated hex pairs) — an empty string is considered valid too
// (it means "no pin," see bridge_settings_get_wifi_bssid()'s comment).
// Used by http_control.c's POST /wifi-config to reject a malformed value
// at save time rather than silently ignoring it at the next boot (see
// wifi_net_start()'s own parse — same format, kept in sync by hand since
// duplicating one tiny sscanf() isn't worth a shared-header dependency).
bool wifi_net_is_valid_bssid(const char *bssid);
