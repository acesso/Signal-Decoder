// Wi-Fi station bring-up + mDNS advertisement (usdx-bridge.local). Runs the
// standard ESP-IDF Wi-Fi/lwIP driver tasks (framework-pinned to core 0).
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
