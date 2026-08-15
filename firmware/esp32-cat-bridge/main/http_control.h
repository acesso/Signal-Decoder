// Small REST-ish control surface alongside the CAT WebSocket, for the web
// app's on-demand bridge status/control panel (not part of any poll loop —
// queried once when that panel opens, same pattern as the radio's own PA
// bias/factory-defaults advanced settings in useRadioCAT.ts).
//
// GET  /status      -> JSON: {"wifi_state":"connected","ssid":"...","rssi":-67,
//                              "ip":"192.168.0.7","ws_clients":1,"ws_max_clients":4,
//                              "radio_linked":true,"cat_baud":38400,
//                              "pa_sense":false,"pa_emergency_tripped":false,
//                              "uptime_s":1234}
//                       wifi_state is one of "connected"/"connecting"/
//                       "disconnected"/"ap_fallback" — the last one means
//                       the bridge couldn't join its configured network
//                       and is now broadcasting its own AP at 192.168.4.1
//                       (see wifi_net.c) so it's still reachable to fix.
//                       pa_sense/pa_emergency_tripped — see pa_watchdog.h.
// GET  /info        -> JSON: {"firmware_version":"0.2.0","features":["cat",
//                              "wifi_config","wifi_scan","reset","audio",
//                              "cat_baud","pa_watchdog"]} — see the
//                       versioning note in bridge_config.h.
// GET  /wifi-scan    -> JSON: {"networks":[{"ssid":"...","rssi":-58},...]}
//                       Blocking active scan (~1-3s), deduped by SSID
//                       (strongest RSSI kept). Safe to call in AP fallback
//                       too (APSTA mode).
// POST /reset       -> 200 "restarting" then reboots the ESP32 after replying
//                       (so the HTTP response actually reaches the browser first).
// POST /wifi-config -> body {"ssid":"...","password":"..."}; persists to NVS
//                       (bridge_settings.c) and reboots to apply, same as /reset.
// POST /cat-baud    -> body {"baud":38400}; one of 9600/19200/38400/57600
//                       (the uSDX firmware's own CAT_BAUD menu options).
//                       Applied immediately (cat_bridge_set_baud(), no
//                       reboot needed — unlike Wi-Fi, the radio's baud is a
//                       local-menu-only setting with no CAT command to
//                       announce a change, so the bridge must be told by
//                       hand the moment the radio's own setting changes)
//                       AND persisted to NVS so a later reboot doesn't
//                       revert to a stale value.
// POST /pa-emergency-clear -> JSON {"pa_emergency_tripped":false}; un-trips
//                       a latched PA safety cutoff (see pa_watchdog.h) —
//                       no body needed, no auto-recovery exists on the
//                       firmware side, so this is the only way to restore
//                       PA_EMERGENCY_PIN to its permissive HIGH default
//                       after a trip.
#pragma once

// Registers all control routes on the already-running httpd instance. Call
// after ws_server_start() (needs the same httpd_handle_t).
void http_control_start(void);
