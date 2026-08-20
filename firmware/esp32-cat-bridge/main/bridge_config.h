// Central pin/parameter map for the ESP32 CAT bridge. Change wiring here,
// not scattered through the drivers.
//
// Target board: AI-Thinker ESP32-A1S Audio Kit. This is a WROVER-class
// module (8MB PSRAM — GPIO16/17 are internally reserved for it and not
// even broken out to the header) with an onboard ES8388 audio codec
// (I2C control on GPIO32/33, I2S audio on GPIO0/25/26/27/35) and status
// LEDs. Only 7 header GPIOs are nominally "free" (0, 5, 18, 19, 21, 22,
// 23) and all 7 are claimed: CAT UART (18/23), the codec's PA-enable line
// (21), the status LED (22), I2S MCLK (0), and — as of the PA safety
// watchdog below — PA_SENSE_PIN/PA_EMERGENCY_PIN (19/5), freed up from an
// earlier design that used the SD card slot's GPIO2/GPIO4/GPIO13 instead
// (no clean header/pin access there).
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
#define BRIDGE_FIRMWARE_VERSION "0.3.0"

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
// GPIO18 (TX) / GPIO23 (RX) — chosen deliberately over the other free
// header pins: GPIO0 is a boot-strap pin (risky to also drive from an
// external UART), GPIO21 drives the onboard PA-enable, GPIO22 drives the
// status LED, and GPIO5/19 are now claimed by the PA safety watchdog below
// — no advantage to picking any of them instead. This leaves UART0
// (GPIO1/3, wired to the onboard USB-serial chip) completely free for
// flashing/ESP_LOG the whole time the CAT cable is connected.
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

// Separate route/client set from /cat (WS_MAX_CLIENTS above) — a browser
// tab debugging CAT doesn't necessarily want an open mic/speaker session,
// and vice versa. Same httpd instance/port, just a different URI.
// AUDIO_WS_MAX_CLIENTS is deliberately small: each open audio session
// means real, continuous UART/I2S-competing work (RMS + WS framing on
// every ~50ms buffer), unlike /cat's near-idle text frames.
#define AUDIO_WS_MAX_CLIENTS    2

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
// The /audio WebSocket's wire rate IS the codec/I2S hardware's actual
// rate — no oversampling layer (an earlier 4x-fixed-oversample design was
// tried and then dropped: A/B testing on real hardware showed the
// averaging-vs-naive-decimation toggle it enabled made no audible/visible
// difference, so it was pure complexity for no measured benefit — see
// bridge_settings.h's sample-rate comment for what actually mattered).
// Live-switchable via POST /sample-rate, but NOT reconfigured on the fly:
// changing it persists the new rate to NVS and reboots the bridge, same
// pattern as changing WiFi credentials — a live I2S/codec reclock was
// deliberately avoided after discovering esp_codec_dev_open() silently
// resets other state on every call (see audio_monitor.c's RX-slot
// re-apply comment for that history); rebooting sidesteps repeating that
// class of bug rather than trying to reconfigure this exact hardware path
// live a third time. This #define is only the FIRST-BOOT fallback (no
// Kconfig-level default exists for this any more than for WiFi
// credentials) — see bridge_settings_get_sample_rate_hz() for the actual
// value used once anything has been saved.
#define ES8388_SAMPLE_RATE_HZ   8000
#define ES8388_MASTER_MODE      true            // ESP32 drives I2S clocks, ES8388 is I2S slave
#define ES8388_MASTER_MODE      true            // ESP32 drives I2S clocks, ES8388 is I2S slave

// ── Status LED (onboard, shared with a button — see wiring notes in the
// README) ───────────────────────────────────────────────────────────────────
// Single LED on GPIO22 (an independent pin, not shared with any button).
// Used to be two LEDs (GPIO22 in + GPIO19 out, showing per-direction audio
// RMS level) — GPIO19 was freed to give the PA safety watchdog below a
// real header pin instead of the SD-card pads, so audio-level display was
// dropped rather than trying to fold two independent levels onto one LED.
// Wi-Fi connecting/AP-fallback/PA-emergency states still show as distinct
// blink patterns on this one LED — see led_status.c for the priority order.
#define LED_STATUS_PIN          GPIO_NUM_22
#define LED_PWM_FREQ_HZ         2000
#define LED_PWM_RESOLUTION      LEDC_TIMER_8_BIT

// ── PA safety watchdog ───────────────────────────────────────────────────────
// Guards against the uSDX hanging with the external miniPA70 amplifier's PTT
// still asserted — see main/doc/PA_WATCHDOG_DESIGN.md for the full design
// and the miniPA70/GPIO research it's based on.
//
// PA_SENSE_PIN reads a signal the user's own interface board derives from
// the miniPA70's OWN energized 12V leg (after their level-shifting down to
// safe logic) — not the uSDX's PA-send command line. The miniPA70 itself
// (a bare, undocumented kit amp — two-pin PTT-in via a PNP-driven relay, no
// feedback of its own) can't be sensed directly; this is the one signal
// that proves the PA hardware is truly on, independent of whether the
// uSDX's command line or the interface board's own level-shifting are
// behaving correctly. That independence is the entire point of a watchdog.
//
// PA_EMERGENCY_PIN is a permissive line in series with the uSDX's PA-send
// path on the interface board — HIGH (idle) lets the radio's own signal
// control the PA normally; pulled LOW only once PA_MAX_ON_SECONDS of
// continuous PA_SENSE_PIN=HIGH has elapsed, forcing the PA off regardless
// of what the radio is doing. Latches LOW until manually cleared (see
// POST /pa-emergency-clear) — deliberately does not auto-recover once
// PA_SENSE_PIN drops, so a real hardware fault can't flap silently.
//
// Both pins are now on the main header, not the SD-card pads — GPIO19 (was
// LED_AUDIO_OUT_PIN, freed above) for PA_SENSE_PIN, GPIO5 (previously the
// one genuinely unused header pin) for PA_EMERGENCY_PIN. This replaces an
// earlier design that used GPIO13/GPIO2/GPIO4 (all SD-card pads, with no
// clean header/pin access) — see git history for that design's own
// hard-won pull-up findings (GPIO2 in particular reads a permanent false
// HIGH from the board's own SD-bus pull-up) if these header pins ever turn
// out to have similar surprises. NEITHER of these header pins has been
// bench-verified yet with the real interface board wired up — confirm both
// read/drive as expected before trusting the watchdog on real hardware.
#define PA_SENSE_PIN            GPIO_NUM_19
#define PA_EMERGENCY_PIN        GPIO_NUM_5
#define PA_MAX_ON_SECONDS       300     // placeholder — tune to the longest
                                        // realistic legitimate transmission
                                        // for this station, with real margin

// ── Task placement ───────────────────────────────────────────────────────────
// Two-core split, deliberately along "what this bridge fundamentally does"
// lines: core 0 owns Wi-Fi/network/control — the framework's own Wi-Fi/lwIP
// tasks, pinned there by sdkconfig (CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0
// is the ESP-IDF default, CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y makes lwIP
// match it explicitly rather than floating); the httpd worker task,
// EXPLICITLY pinned there too (ws_server.c's config.core_id = 0) since it's
// what actually sends every /cat and /audio broadcast frame — if it drifted
// onto core 1 it would contend directly with the tasks core-1 isolation
// exists to protect; and led_status, purely cosmetic visual feedback with
// no timing requirement core-sharing would ever break, left unpinned.
// Core 1 owns every task that's actually the bridge's real-time "relay"
// work — CAT UART, audio codec I/O, and the PA safety watchdog's polling —
// grouped deliberately so none of it is ever contended by Wi-Fi/network activity.
//
// Priority order on RELAY_TASK_CORE (highest wins): CAT UART reader (radio
// protocol correctness — a dropped/garbled CAT byte breaks the whole
// session, the highest possible stakes here) > PA watchdog (safety-
// critical timing, but genuinely light work — one GPIO read per 100ms) >
// audio codec I/O (a dropped audio buffer is a barely-perceptible glitch,
// tolerant of occasional scheduling jitter the other two aren't). All
// three use blocking-with-timeout calls under the hood (uart_read_bytes'
// own 20ms timeout, esp_codec_dev's DMA-backed I2S, GPIO polling's own
// vTaskDelay) — none of them busy-wait, so this is normal FreeRTOS
// preemption between real tasks, not a risk of one starving another.
#define RELAY_TASK_CORE          1
#define CAT_BRIDGE_TASK_CORE     RELAY_TASK_CORE
#define CAT_BRIDGE_TASK_PRIO     10
#define PA_WATCHDOG_TASK_CORE    RELAY_TASK_CORE
#define PA_WATCHDOG_TASK_PRIO    4
#define AUDIO_MONITOR_TASK_CORE  RELAY_TASK_CORE
#define AUDIO_MONITOR_TASK_PRIO  3
