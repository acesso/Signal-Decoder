// Browser-facing transport: one WebSocket endpoint (ws://usdx-bridge.local:8765/cat)
// carrying the raw CAT byte stream in both directions as binary frames.
// Deliberately no framing/parsing of the Kenwood protocol here — this module
// only moves bytes between cat_bridge and every connected browser tab (up to
// WS_MAX_CLIENTS), same as the existing Web Serial transport does today from
// the app's point of view (see src/lib/cat/useRadioCAT.ts). Multiple clients
// can watch/drive the same session at once — the radio is a single shared
// resource regardless of transport, so this doesn't try to arbitrate who's
// "allowed" to send a command, it just relays.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_http_server.h"

// Starts the HTTP server (WS_SERVER_PORT) with a single "/cat" WebSocket
// route. Registers itself as cat_bridge's rx callback so radio->browser
// bytes flow automatically. Call after cat_bridge_start().
void ws_server_start(void);

// Broadcasts bytes to every currently-connected CAT WebSocket client.
// No-op if none are connected (radio keeps running with no listener).
void ws_server_send_to_client(const uint8_t *data, size_t len);

// The shared httpd instance ws_server_start() created — so http_control.c
// can register its own routes (/status, /reset) on the SAME server instead
// of standing up a second one on a different port. NULL until
// ws_server_start() has run.
httpd_handle_t ws_server_get_httpd(void);
