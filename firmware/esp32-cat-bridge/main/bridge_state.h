// Shared, thread-safe snapshot of bridge status — written by wifi_net/
// cat_bridge/ws_server, read by status_display for the LCD. Deliberately a
// flat struct behind a mutex rather than per-field atomics: the LCD only
// samples this a few times a second, so a single lock is simple and cheap.
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    BRIDGE_WIFI_DISCONNECTED = 0,
    BRIDGE_WIFI_CONNECTING,
    BRIDGE_WIFI_CONNECTED,
} bridge_wifi_state_t;

typedef struct {
    bridge_wifi_state_t wifi_state;
    char ip_addr[16];           // "0.0.0.0" style, empty until DHCP completes
    int8_t wifi_rssi;           // dBm, valid only when wifi_state == CONNECTED

    uint8_t ws_client_count;    // 0..WS_MAX_CLIENTS, currently-open browser sockets
    uint32_t cat_bytes_from_radio;
    uint32_t cat_bytes_from_client;
    // Kept separate deliberately: bytes-from-radio is the ONLY thing that
    // proves the CAT cable is actually plugged in and the radio is actually
    // replying — writing to the UART TX pin succeeds whether or not anything
    // is connected on the other end (no hardware loopback/ack), so
    // bytes-from-client alone tells you a browser is sending commands, not
    // that the radio ever saw them.
    int64_t last_radio_rx_us;   // esp_timer_get_time() at last byte FROM the radio
    int64_t last_client_tx_us;  // esp_timer_get_time() at last byte TO the radio

    // Last VFO-A frequency seen on the CAT line, in Hz — snooped from "FA…;"
    // frames (radio's replies to FA; queries, or the browser's own FA SETs)
    // as they pass through cat_bridge. 0 until the first frame is seen.
    uint32_t last_vfo_hz;

    // Last S-meter reading snooped from "SM<n>;" frames (n signed, dBm).
    // has_smeter is false until the first reading, AND whenever the radio
    // replies the special empty "SM;" frame (no signal to measure — the
    // firmware does this during TX, see the web app's useRadioCAT.ts) —
    // that's a meaningful "no reading right now", not the same as 0 dBm.
    int16_t last_smeter_dbm;
    bool has_smeter;
} bridge_state_t;

// Initializes the internal mutex. Call once from app_main before any task
// that touches bridge_state starts.
void bridge_state_init(void);

// Copies the current state under lock.
void bridge_state_get(bridge_state_t *out);

// Read-modify-write helper: locks, calls mutate(ctx) with a pointer to the
// live state, unlocks. Keeps callers from having to manage the mutex
// themselves for simple field updates.
void bridge_state_update(void (*mutate)(bridge_state_t *state, void *ctx), void *ctx);
