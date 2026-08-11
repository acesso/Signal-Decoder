// Central pin/parameter map for the ESP32 CAT bridge. Change wiring here,
// not scattered through the drivers.
//
// Target board: AI-Thinker ESP32-A1S Audio Kit. This is a WROVER-class
// module (8MB PSRAM — GPIO16/17 are internally reserved for it and not
// even broken out to the header) with an onboard ES8388 audio codec
// (I2C control on GPIO32/33, I2S audio on GPIO0/25/26/27/35 — reserved for
// a future audio/WebRTC feature, not used yet). Only 7 header GPIOs are
// free (0, 5, 18, 19, 21, 22, 23) and every one already drives an onboard
// button, LED, or the PA-enable line — this firmware claims just 2 of them
// (18, 23) for the CAT UART and leaves the rest alone.
#pragma once

#include "driver/gpio.h"
#include "driver/uart.h"

// ── Bridge firmware version + capabilities ──────────────────────────────────
// Follows the same versioning spirit as the radio firmware itself (queried
// over CAT via FV; — see firmware/usdxBLACKBRICK): a version string the web
// app can display/log, PLUS a capability list so it can gate UI on "does
// THIS bridge support X" instead of parsing/comparing version numbers.
// Bump BRIDGE_FIRMWARE_VERSION on any change to the HTTP control surface or
// wire protocol; add to BRIDGE_FEATURES (http_control.c) when a whole new
// capability lands (e.g. "audio" once WebRTC firmware exists) — features are
// additive and never removed once shipped, so an older web app talking to a
// newer bridge just ignores flags it doesn't recognize.
#define BRIDGE_FIRMWARE_VERSION "0.2.0"

// ── Wi-Fi (station mode) ────────────────────────────────────────────────────
// Credentials come from Kconfig (idf.py menuconfig -> "CAT Bridge Config"),
// not hardcoded here, so they aren't committed to the repo in plaintext.
#define BRIDGE_HOSTNAME        "usdx-bridge"   // usdx-bridge.local via mDNS
#define BRIDGE_WIFI_MAXIMUM_RETRY 10

// ── CAT UART (radio side) ───────────────────────────────────────────────────
// Plugs into the uSDX BLACK_BRICK's CAT cable in place of the USB-serial
// adapter. Kenwood TS-480-style ASCII protocol, semicolon-terminated frames,
// baud is configurable at the radio (menu) — the bridge just has to match it.
//
// GPIO18 (TX) / GPIO23 (RX) — chosen deliberately over the other 5 free
// header pins: GPIO0 is a boot-strap pin (risky to also drive from an
// external UART), GPIO21 drives the onboard PA-enable, and GPIO5/19/22 cost
// the SAME onboard button/LED functions 18/23 do anyway — no advantage to
// picking them instead. This leaves UART0 (GPIO1/3, wired to the onboard
// USB-serial chip) completely free for flashing/ESP_LOG the whole time the
// CAT cable is connected.
#define CAT_UART_TX_PIN        GPIO_NUM_18
#define CAT_UART_RX_PIN        GPIO_NUM_23
#define CAT_UART_PORT          UART_NUM_2
#define CAT_UART_BAUD_DEFAULT  38400
#define CAT_UART_RX_BUF_SIZE   1024
#define CAT_UART_TX_BUF_SIZE   1024

// ── WebSocket server (browser side) ─────────────────────────────────────────
// The radio itself is a single shared resource, but multiple browser tabs/
// operators can watch the same session concurrently — bytes from the radio
// broadcast to every connected client, and a command from any of them goes
// straight to the radio (last writer wins on the wire, same as it would if
// two people fought over one physical knob).
#define WS_SERVER_PORT          80
#define WS_MAX_CLIENTS          4

// ── Task placement ───────────────────────────────────────────────────────────
// Wi-Fi/lwIP/httpd's own internal tasks are explicitly pinned to core 0 via
// sdkconfig (CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0, already the ESP-IDF
// default; CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y — see sdkconfig.defaults)
// rather than left at "no affinity", which could otherwise let network
// activity drift onto core 1 and contend with the CAT UART reader, which is
// pinned there exclusively — nothing else this firmware creates runs on
// core 1, so radio I/O timing is never contended.
#define CAT_BRIDGE_TASK_CORE     1
#define CAT_BRIDGE_TASK_PRIO     10
