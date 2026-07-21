// Central pin/parameter map for the ESP32 CAT bridge. Change wiring here,
// not scattered through the drivers.
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
#define BRIDGE_FIRMWARE_VERSION "0.1.0"

// ── Wi-Fi (station mode) ────────────────────────────────────────────────────
// Credentials come from Kconfig (idf.py menuconfig -> "CAT Bridge Config"),
// not hardcoded here, so they aren't committed to the repo in plaintext.
#define BRIDGE_HOSTNAME        "usdx-bridge"   // usdx-bridge.local via mDNS
#define BRIDGE_WIFI_MAXIMUM_RETRY 10

// ── CAT UART (radio side) ───────────────────────────────────────────────────
// Plugs into the uSDX BLACK_BRICK's CAT cable in place of the USB-serial
// adapter. Kenwood TS-480-style ASCII protocol, semicolon-terminated frames,
// baud is configurable at the radio (menu) — the bridge just has to match it.
#define CAT_UART_PORT          UART_NUM_2
#define CAT_UART_TX_PIN        GPIO_NUM_17
#define CAT_UART_RX_PIN        GPIO_NUM_16
#define CAT_UART_BAUD_DEFAULT  38400
#define CAT_UART_RX_BUF_SIZE   1024
#define CAT_UART_TX_BUF_SIZE   1024

// ── WebSocket server (browser side) ─────────────────────────────────────────
// The radio itself is a single shared resource, but multiple browser tabs/
// operators can watch the same session concurrently — bytes from the radio
// broadcast to every connected client, and a command from any of them goes
// straight to the radio (last writer wins on the wire, same as it would if
// two people fought over one physical knob).
#define WS_SERVER_PORT          8765
#define WS_MAX_CLIENTS          4

// ── PCD8544 (Nokia 5110) LCD, 84x48, 1bpp, SPI-like bit-banged/HW SPI ───────
// Standard 5-wire wiring (no MISO — the display is write-only).
#define LCD_PIN_CLK             GPIO_NUM_18   // SCLK
#define LCD_PIN_DIN             GPIO_NUM_23   // MOSI / SDIN
#define LCD_PIN_CE              GPIO_NUM_5    // chip-select / SCE
#define LCD_PIN_DC              GPIO_NUM_2    // data/command select
#define LCD_PIN_RST             GPIO_NUM_4    // reset
#define LCD_PIN_BACKLIGHT       GPIO_NUM_15   // optional, active-high, PWM-driven (LEDC)

#define LCD_WIDTH_PX            84
#define LCD_HEIGHT_PX           48
#define LCD_SPI_HOST            SPI2_HOST
#define LCD_SPI_CLOCK_HZ        (4 * 1000 * 1000)

// Backlight dimming (LEDC PWM) — the panel's LED backlight is startlingly
// bright straight off 3.3V with no series resistor beyond what's on the
// breakout, so this drives it via PWM instead of a hard on/off GPIO. Duty
// is 0..LCD_BACKLIGHT_MAX_DUTY; default picked dim enough to be readable in
// a dark room without lighting up the whole desk — raise it if the room is
// bright. 5kHz is well above flicker-fusion and PCD8544 refresh timing.
#define LCD_BACKLIGHT_LEDC_TIMER    LEDC_TIMER_0
#define LCD_BACKLIGHT_LEDC_CHANNEL  LEDC_CHANNEL_0
#define LCD_BACKLIGHT_LEDC_MODE     LEDC_LOW_SPEED_MODE
#define LCD_BACKLIGHT_PWM_FREQ_HZ   5000
#define LCD_BACKLIGHT_DUTY_RES      LEDC_TIMER_8_BIT
#define LCD_BACKLIGHT_MAX_DUTY      255
// Still too bright at 40 (~16%) on the actual panel — PWM duty vs. perceived
// LED brightness isn't linear, so numeric-looking-dim doesn't mean actually
// dim. Cut further; raise if a brighter room needs it.
#define LCD_BACKLIGHT_DEFAULT_DUTY  18   // ~7%

// PCD8544 Vop ("contrast") register is 7 bits (0..127) — matches the value
// already sent once at init time (see lcd_pcd8544_init); now also settable
// live via lcd_pcd8544_set_contrast() / bridge_settings/http_control.
#define LCD_CONTRAST_MAX            0x7F
#define LCD_CONTRAST_DEFAULT_VOP    0x3F   // same mid-range value init used before this was adjustable

// ── Task placement ───────────────────────────────────────────────────────────
// Core 1 is reserved for the CAT UART reader ALONE — nothing else runs
// there, so radio I/O timing is never contended by anything else this
// firmware creates. Wi-Fi/lwIP/httpd's own internal tasks are explicitly
// pinned to core 0 via sdkconfig (CONFIG_ESP_WIFI_TASK_CORE_ID=0,
// CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y — see sdkconfig.defaults) rather
// than left at "no affinity", which could otherwise let network activity
// drift onto core 1 and contend with the UART reader.
//
// The LCD/status_display task also moved to core 0: it used to share core 1
// with the UART reader (lower priority, so it normally lost contention to
// the reader — but a *lower*-priority task can still block a higher-priority
// one when it's mid-syscall in something non-preemptible, and
// spi_device_polling_transmit() busy-waits the CPU rather than yielding.
// Batching the LCD's SPI writes (see lcd_pcd8544_flush) fixed most of that
// blocking directly, but keeping the LCD off core 1 entirely removes the
// remaining risk instead of just shrinking its window.
#define CAT_BRIDGE_TASK_CORE     1
#define STATUS_DISPLAY_TASK_CORE 0

#define CAT_BRIDGE_TASK_PRIO     10
#define STATUS_DISPLAY_TASK_PRIO 5
