#include "cat_bridge.h"

#include <stdbool.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "bridge_state.h"

static const char *TAG = "cat_bridge";

static cat_bridge_rx_cb_t s_rx_cb = NULL;

// Kenwood CAT frames are short (a batched poll string is ~60 bytes at most —
// see the web app's BLACKBRICK_POLL_CMDS); this just needs to be big enough
// that one uart_read_bytes() call drains a burst without looping excessively.
#define UART_READ_CHUNK 256

static void mutate_radio_bytes(bridge_state_t *state, void *ctx) {
    state->cat_bytes_from_radio += *(size_t *)ctx;
    state->last_radio_rx_us = esp_timer_get_time();
}

static void record_radio_bytes(size_t n) {
    bridge_state_update(mutate_radio_bytes, &n);
}

static void mutate_client_bytes(bridge_state_t *state, void *ctx) {
    state->cat_bytes_from_client += *(size_t *)ctx;
    state->last_client_tx_us = esp_timer_get_time();
}

static void record_client_bytes(size_t n) {
    bridge_state_update(mutate_client_bytes, &n);
}

// ── CAT frame snooping (VFO frequency + S-meter) ────────────────────────────
// The bridge is otherwise deliberately protocol-blind (see cat_bridge.h) —
// this is the one narrow exception, so the LCD can show something more
// useful than raw byte counters. Both directions carry the frames of
// interest: "FA<11 digits>;" is either the radio's own reply to an "FA;"
// query or a SET from a client tuning the VFO — either way it's the current
// frequency; "SM<signed digits>;" (or empty "SM;" during TX) is always a
// radio reply, never something a client sends (S-meter is read-only). Both
// feed the same per-direction line buffer. Kenwood frames are short and
// always ';'-terminated; a small buffer per direction is enough to
// reassemble one even if a read() happens to split it mid-frame.
#define CAT_LINEBUF_CAP 32

typedef struct {
    char buf[CAT_LINEBUF_CAP];
    size_t len;
} cat_linebuf_t;

static cat_linebuf_t s_radio_linebuf;
static cat_linebuf_t s_client_linebuf;

static void mutate_vfo_hz(bridge_state_t *state, void *ctx) {
    state->last_vfo_hz = *(uint32_t *)ctx;
}

// Frame is "FA" + 11 decimal digits, e.g. "FA00014225000" for 14.225 MHz.
static void try_extract_vfo(const char *frame, size_t frame_len) {
    if (frame_len != 13 || frame[0] != 'F' || frame[1] != 'A') return;
    uint32_t hz = 0;
    for (size_t i = 2; i < frame_len; i++) {
        char c = frame[i];
        if (c < '0' || c > '9') return; // not all digits — malformed/garbled, ignore
        hz = hz * 10 + (uint32_t)(c - '0');
    }
    if (hz == 0) return; // firmware never reports 0 Hz; guards against a garbled all-zero frame
    bridge_state_update(mutate_vfo_hz, &hz);
}

static void mutate_smeter(bridge_state_t *state, void *ctx) {
    state->last_smeter_dbm = *(int16_t *)ctx;
    state->has_smeter = true;
}

static void mutate_smeter_unavailable(bridge_state_t *state, void *ctx) {
    (void)ctx;
    state->has_smeter = false;
}

// Frame is "SM" + an optional '-' + 1-3 decimal digits, e.g. "SM-68" or
// "SM0". An empty "SM" (just the two prefix letters, no digits) is the
// firmware's deliberate "nothing to measure right now" reply during TX —
// that's meaningful and distinct from a garbled frame, so it clears
// has_smeter rather than being silently dropped like a real parse failure.
static void try_extract_smeter(const char *frame, size_t frame_len) {
    if (frame_len < 2 || frame[0] != 'S' || frame[1] != 'M') return;
    if (frame_len == 2) { bridge_state_update(mutate_smeter_unavailable, NULL); return; }
    size_t i = 2;
    bool negative = false;
    if (frame[i] == '-') { negative = true; i++; }
    if (i >= frame_len || frame_len - i > 3) return; // no digits, or implausibly long — malformed
    int16_t dbm = 0;
    for (; i < frame_len; i++) {
        char c = frame[i];
        if (c < '0' || c > '9') return;
        dbm = (int16_t)(dbm * 10 + (c - '0'));
    }
    if (negative) dbm = (int16_t)-dbm;
    bridge_state_update(mutate_smeter, &dbm);
}

// Forward-declared: fires the bounded recovery query below, defined further
// down alongside the boot query it shares its rate-limit/task machinery with.
// `from_radio` is only used for the log line — the recovery action itself
// (one "FA;SM;") is identical regardless of which direction overflowed,
// since either way the LCD's cached VFO/S-meter may now be stale.
static void request_snoop_recovery(bool from_radio);

// Appends `data` to the line buffer, splitting on ';' and handing each
// complete frame to the extractors above. Overflow (no ';' seen for
// CAT_LINEBUF_CAP bytes — line noise on the shared LCD/UART pins, see the
// firmware README's "known hardware quirk", garbles or drops bytes) is the
// one unambiguous "something went wrong on the wire" signal available here:
// a frame that terminates normally but doesn't parse as FA/SM is just some
// OTHER CAT command going by (e.g. "MD2;"), not corruption, so only the
// overflow case triggers recovery — everything else stays purely passive.
static void feed_cat_snoop(cat_linebuf_t *lb, const uint8_t *data, size_t len, bool from_radio) {
    for (size_t i = 0; i < len; i++) {
        char c = (char)data[i];
        if (c == ';') {
            try_extract_vfo(lb->buf, lb->len);
            try_extract_smeter(lb->buf, lb->len);
            lb->len = 0;
            continue;
        }
        if (lb->len >= CAT_LINEBUF_CAP) {
            lb->len = 0; // resync on the next ';'
            request_snoop_recovery(from_radio);
            continue;
        }
        lb->buf[lb->len++] = c;
    }
}

static void uart_reader_task(void *arg) {
    uint8_t buf[UART_READ_CHUNK];
    ESP_LOGI(TAG, "reader task started on core %d", xPortGetCoreID());
    for (;;) {
        int n = uart_read_bytes(CAT_UART_PORT, buf, sizeof(buf), pdMS_TO_TICKS(20));
        if (n > 0) {
            record_radio_bytes((size_t)n);
            feed_cat_snoop(&s_radio_linebuf, buf, (size_t)n, true);
            if (s_rx_cb) s_rx_cb(buf, (size_t)n);
        }
        // No extra delay needed — uart_read_bytes' own timeout paces the loop.
    }
}

static void uart_open(int baud) {
    uart_config_t cfg = {
        .baud_rate = baud,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_param_config(CAT_UART_PORT, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(CAT_UART_PORT, CAT_UART_TX_PIN, CAT_UART_RX_PIN,
                                  UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    ESP_LOGI(TAG, "UART2 open at %d baud (TX=%d RX=%d)", baud, CAT_UART_TX_PIN, CAT_UART_RX_PIN);
}

// One-shot query fired right after the reader task starts, so the LCD (and
// any client that connects moments later) has real VFO/S-meter data instead
// of sitting at "no reading yet" until something happens to poll the radio
// on its own. This is a deliberate exception to "the bridge never talks to
// the radio unprompted" — it's a single query, not an ongoing poll loop; the
// UART TX side isn't attributed to any client (it isn't one), so it neither
// bumps cat_bytes_from_client nor updates last_client_tx_us — only the
// radio's reply (via the normal uart_reader_task path) touches state, the
// same as if a browser had asked.
static const char BOOT_QUERY[] = "FA;SM;";

// Retried a few times, spaced out, since a reply can be eaten by the LCD/
// UART pin-share noise (see the firmware README's "known hardware quirk")
// or simply miss the radio's boot window — same reasoning as the web app's
// own FV;/AI; discovery retries in useRadioCAT.ts. Each attempt is
// unconditional (no "did the last one already succeed?" check) since
// re-asking a redundant FA;/SM; is harmless and simpler than wiring this
// task to watch bridge_state for confirmation.
#define BOOT_QUERY_RETRIES   3
#define BOOT_QUERY_RETRY_MS  500

static void boot_query_task(void *arg) {
    for (int i = 0; i < BOOT_QUERY_RETRIES; i++) {
        vTaskDelay(pdMS_TO_TICKS(BOOT_QUERY_RETRY_MS));
        ESP_LOGI(TAG, "boot query -> radio: %s (attempt %d/%d)", BOOT_QUERY, i + 1, BOOT_QUERY_RETRIES);
        uart_write_bytes(CAT_UART_PORT, BOOT_QUERY, sizeof(BOOT_QUERY) - 1);
    }
    vTaskDelete(NULL);
}

// Snoop recovery: fired from feed_cat_snoop() (running on uart_reader_task's
// own context) when the line buffer overflows without seeing a ';' — the
// one unambiguous "the wire got corrupted/a byte got dropped" signal this
// module has. A single extra "FA;SM;" re-asks the radio for exactly the two
// values the LCD cares about, patching the display back up without turning
// this into a general poll loop — it only ever fires in response to an
// observed problem, never on a timer.
//
// Rate-limited: line noise on the shared LCD/UART pins can arrive in short
// bursts (several overflows within the same LCD write), and re-querying for
// every single one would start to look like polling and could itself
// contend with whatever legitimate traffic is already in flight. One
// recovery query per window is plenty — if the noise is bad enough to keep
// overflowing past that window, the NEXT window's query still catches up
// eventually, same as the boundedness of the boot query above.
#define SNOOP_RECOVERY_MIN_INTERVAL_US (1 * 1000 * 1000)
static int64_t s_last_recovery_us = 0;

static void request_snoop_recovery(bool from_radio) {
    int64_t now = esp_timer_get_time();
    if (now - s_last_recovery_us < SNOOP_RECOVERY_MIN_INTERVAL_US) return;
    s_last_recovery_us = now;
    ESP_LOGI(TAG, "snoop recovery -> radio: %s (line buffer overflow on the %s side — corrupted/dropped frame)",
             BOOT_QUERY, from_radio ? "radio->bridge" : "client->radio");
    uart_write_bytes(CAT_UART_PORT, BOOT_QUERY, sizeof(BOOT_QUERY) - 1);
}

void cat_bridge_start(cat_bridge_rx_cb_t rx_cb) {
    s_rx_cb = rx_cb;

    ESP_ERROR_CHECK(uart_driver_install(CAT_UART_PORT, CAT_UART_RX_BUF_SIZE,
                                         CAT_UART_TX_BUF_SIZE, 0, NULL, 0));
    uart_open(CONFIG_BRIDGE_CAT_UART_BAUD);

    xTaskCreatePinnedToCore(uart_reader_task, "cat_uart_rx", 4096, NULL,
                             CAT_BRIDGE_TASK_PRIO, NULL, CAT_BRIDGE_TASK_CORE);
    xTaskCreatePinnedToCore(boot_query_task, "cat_boot_query", 2048, NULL,
                             CAT_BRIDGE_TASK_PRIO, NULL, CAT_BRIDGE_TASK_CORE);
}

int cat_bridge_write(const uint8_t *data, size_t len) {
    int written = uart_write_bytes(CAT_UART_PORT, (const char *)data, len);
    if (written > 0) {
        record_client_bytes((size_t)written);
        feed_cat_snoop(&s_client_linebuf, data, (size_t)written, false);
    }
    return written;
}

void cat_bridge_set_baud(int baud) {
    ESP_LOGI(TAG, "changing CAT UART baud to %d", baud);
    ESP_ERROR_CHECK(uart_set_baudrate(CAT_UART_PORT, baud));
}
