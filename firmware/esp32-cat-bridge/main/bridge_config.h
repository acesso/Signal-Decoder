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
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
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

// ── Audio codec (ES8388, onboard) ───────────────────────────────────────────
// Pin map + I2C address cross-verified against community A1S v2.2 board
// support files (ESP-ADF forks, arduino-audiokit) — Espressif's own esp-adf
// repo no longer ships a board file for this exact board, so no primary
// source could be checked. PA polarity (ES8388_PA_REVERTED) is the one
// unconfirmed value — no source gave an explicit active-high/active-low
// statement, only circumstantial evidence pointing to active-high (false).
// Revisit if the amp turns out to be permanently on or permanently silent.
#define ES8388_I2C_PORT         I2C_NUM_0
#define ES8388_I2C_SDA_PIN      GPIO_NUM_33
#define ES8388_I2C_SCL_PIN      GPIO_NUM_32
#define ES8388_I2C_ADDR         0x20            // 8-bit form; esp_codec_dev right-shifts internally
#define ES8388_I2S_PORT         I2S_NUM_0
#define ES8388_I2S_MCLK_PIN     GPIO_NUM_0
#define ES8388_I2S_BCLK_PIN     GPIO_NUM_27
#define ES8388_I2S_WS_PIN       GPIO_NUM_25
#define ES8388_I2S_DOUT_PIN     GPIO_NUM_26     // ESP32 -> codec DAC (audio out)
#define ES8388_I2S_DIN_PIN      GPIO_NUM_35     // codec ADC -> ESP32 (audio in)
#define ES8388_PA_ENABLE_PIN    GPIO_NUM_21
#define ES8388_PA_REVERTED      false           // unconfirmed — see note above
#define ES8388_SAMPLE_RATE_HZ   16000           // enough for level metering, not hi-fi playback
#define ES8388_MASTER_MODE      true            // ESP32 drives I2S clocks, ES8388 is I2S slave

// ── Status LEDs (onboard, shared with buttons — see wiring notes in the
// README) ───────────────────────────────────────────────────────────────────
// GPIO22 is an independent pin; GPIO19 doubles as the KEY3 button input, so
// driving it as an output here means KEY3 can no longer be read (acceptable
// — nothing in this firmware reads any onboard button). Normal operation
// shows one LED per audio direction (brightness ~ RMS level); Wi-Fi
// connecting/AP-fallback/no-CAT states borrow the same two LEDs with
// distinct blink patterns — see led_status.c for the priority order.
#define LED_AUDIO_IN_PIN        GPIO_NUM_22
#define LED_AUDIO_OUT_PIN       GPIO_NUM_19
#define LED_PWM_FREQ_HZ         2000
#define LED_PWM_RESOLUTION      LEDC_TIMER_8_BIT

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
