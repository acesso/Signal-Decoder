// UART bridge to the radio's CAT port. Owns UART2 exclusively; ws_server
// pushes bytes in (from the browser) and registers a callback to receive
// bytes out (from the radio) — cat_bridge has no knowledge of WebSocket
// framing, so the transport can be swapped later without touching this file.
#pragma once

#include <stddef.h>
#include <stdint.h>

// Called from the CAT bridge's own task context whenever bytes arrive from
// the radio. Keep this fast/non-blocking (it just hands off to a queue in
// ws_server) — it runs on the same task that's servicing the UART, so a
// slow callback delays the next read and risks radio-side RX overrun.
typedef void (*cat_bridge_rx_cb_t)(const uint8_t *data, size_t len);

// Starts UART2 at CAT_UART_BAUD_DEFAULT (or the Kconfig override) and spawns
// the reader task pinned to CAT_BRIDGE_TASK_CORE, plus a short-lived task
// that fires a one-shot "FA;SM;" query (retried a few times) so the LCD has
// real VFO/S-meter data on boot instead of waiting for a client to poll —
// the only place this bridge talks to the radio without being asked to.
// Call once from app_main.
void cat_bridge_start(cat_bridge_rx_cb_t rx_cb);

// Writes bytes to the radio (bytes received from a WebSocket client).
// Thread-safe — may be called from the WS server's own task/context.
// Returns the number of bytes actually written (mirrors uart_write_bytes).
int cat_bridge_write(const uint8_t *data, size_t len);

// Re-opens UART2 at a new baud rate without restarting the reader task —
// used if/when the app adds a runtime baud-change control message. Safe to
// call at any time after cat_bridge_start().
void cat_bridge_set_baud(int baud);
