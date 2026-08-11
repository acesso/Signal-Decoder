// Small REST-ish control surface alongside the CAT WebSocket, for the web
// app's on-demand bridge status/control panel (not part of any poll loop —
// queried once when that panel opens, same pattern as the radio's own PA
// bias/factory-defaults advanced settings in useRadioCAT.ts).
//
// GET  /status      -> JSON: {"wifi_state":"connected","ssid":"...","rssi":-67,
//                              "ip":"192.168.0.7","ws_clients":1,"ws_max_clients":4,
//                              "radio_linked":true,"uptime_s":1234}
//                       wifi_state is one of "connected"/"connecting"/
//                       "disconnected"/"ap_fallback" — the last one means
//                       the bridge couldn't join its configured network
//                       and is now broadcasting its own AP at 192.168.4.1
//                       (see wifi_net.c) so it's still reachable to fix.
// GET  /info        -> JSON: {"firmware_version":"0.2.0","features":["cat",
//                              "wifi_config","wifi_scan","reset"]} — see the
//                       versioning note in bridge_config.h.
// GET  /wifi-scan    -> JSON: {"networks":[{"ssid":"...","rssi":-58},...]}
//                       Blocking active scan (~1-3s), deduped by SSID
//                       (strongest RSSI kept). Safe to call in AP fallback
//                       too (APSTA mode).
// POST /reset       -> 200 "restarting" then reboots the ESP32 after replying
//                       (so the HTTP response actually reaches the browser first).
// POST /wifi-config -> body {"ssid":"...","password":"..."}; persists to NVS
//                       (bridge_settings.c) and reboots to apply, same as /reset.
#pragma once

// Registers all control routes on the already-running httpd instance. Call
// after ws_server_start() (needs the same httpd_handle_t).
void http_control_start(void);
