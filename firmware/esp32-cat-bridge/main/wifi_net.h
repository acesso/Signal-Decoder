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
