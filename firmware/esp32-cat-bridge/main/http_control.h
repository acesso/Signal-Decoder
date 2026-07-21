// Small REST-ish control surface alongside the CAT WebSocket, for the web
// app's on-demand bridge status/control panel (not part of any poll loop —
// queried once when that panel opens, same pattern as the radio's own PA
// bias/factory-defaults advanced settings in useRadioCAT.ts).
//
// GET  /status      -> JSON: {"wifi_state":"connected","ssid":"...","rssi":-67,
//                              "ip":"192.168.0.7","ws_clients":1,"ws_max_clients":4,
//                              "radio_linked":true,"uptime_s":1234}
// GET  /info        -> JSON: {"firmware_version":"0.1.0","features":["cat",
//                              "backlight","wifi_config","reset","contrast"]} —
//                       see the versioning note in bridge_config.h.
// POST /reset       -> 200 "restarting" then reboots the ESP32 after replying
//                       (so the HTTP response actually reaches the browser first).
// POST /wifi-config -> body {"ssid":"...","password":"..."}; persists to NVS
//                       (bridge_settings.c) and reboots to apply, same as /reset.
// POST /backlight   -> body {"duty":N} (0..LCD_BACKLIGHT_MAX_DUTY); applies
//                       immediately AND persists as the new boot default.
// POST /contrast    -> body {"vop":N} (0..LCD_CONTRAST_MAX); applies
//                       immediately AND persists — pure software (PCD8544
//                       Vop register over the same SPI bus), no extra wiring.
#pragma once

// Registers all control routes on the already-running httpd instance. Call
// after ws_server_start() (needs the same httpd_handle_t).
void http_control_start(void);
