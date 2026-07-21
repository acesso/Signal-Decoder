#include "status_display.h"

#include <stdbool.h>
#include <stdio.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "lcd_pcd8544.h"

#define REFRESH_PERIOD_MS 500
// If nothing has arrived FROM the radio for this long, the link is
// considered down — this bounds how quickly an unplugged cable or powered-
// off radio is reflected on screen, since the bridge itself never polls the
// radio (it only reacts to real traffic — a client's poll, or the proactive
// one-shot boot query in cat_bridge_start).
#define CAT_IDLE_THRESHOLD_US (3 * 1000 * 1000)

// ── Layout ───────────────────────────────────────────────────────────────
// 84x48 panel, 1px rounded-corner border at the true screen edge (x=0,y=0
// to x=83,y=47). Text glyphs are 7px tall; rows are spaced 9px apart (7px
// glyph + 2px gap) starting at y=3. Wi-Fi state is the corner icon only —
// no text label anywhere, so no dedicated row is reserved for it. VFO
// frequency is the last row (bottom), everything else stacks above it.
#define BORDER_RADIUS  3
#define TEXT_X0        3
#define TEXT_ROW_H     9
#define TEXT_Y0        3
#define TEXT_ROW(n)    (TEXT_Y0 + (n) * TEXT_ROW_H)
// 5 rows fit (0..4); row 4's glyph bottom is at y=39+6=45, inside the y=47 border.
#define VFO_ROW        4

// Wi-Fi bars/antenna icon — top-right corner, inside the border. Margin is
// wider than the border radius so the icon's own pixels never compete with
// the rounded corner's arc for the same few pixels up there.
#define WIFI_ICON_W      10
#define WIFI_ICON_H      8
#define WIFI_ICON_MARGIN 4
#define WIFI_ICON_X      (LCD_WIDTH_PX - WIFI_ICON_MARGIN - WIFI_ICON_W)
#define WIFI_ICON_Y      WIFI_ICON_MARGIN

static void draw_wifi_icon(bridge_wifi_state_t wifi_state, int8_t rssi) {
    // 4 ascending bars, phone-signal style, drawn right-to-left so the
    // tallest bar lands at the icon's right edge. Bar n (0-indexed from the
    // left/shortest) is BAR_H0 + n*BAR_STEP px tall, 2px wide with a 1px gap.
    static const int BAR_W = 2, BAR_GAP = 1, BAR_H0 = 2, BAR_STEP = 2;

    if (wifi_state != BRIDGE_WIFI_CONNECTED) {
        // Disconnected/connecting: a solid X in the icon's box instead of
        // faint bars — a sparse "mostly empty" glyph reads as "icon missing"
        // at this resolution/backlight, not as "no signal". The X is
        // unambiguous either way and needs no bar-by-bar interpretation.
        for (int i = 0; i < WIFI_ICON_H; i++) {
            lcd_pcd8544_set_pixel(WIFI_ICON_X + i, WIFI_ICON_Y + i, true);
            lcd_pcd8544_set_pixel(WIFI_ICON_X + WIFI_ICON_H - 1 - i, WIFI_ICON_Y + i, true);
        }
        return;
    }

    int bars_lit;
    if (rssi >= -55) {
        bars_lit = 4;
    } else if (rssi >= -67) {
        bars_lit = 3;
    } else if (rssi >= -78) {
        bars_lit = 2;
    } else {
        bars_lit = 1; // still connected, but a marginal link
    }

    int x = WIFI_ICON_X;
    for (int bar = 0; bar < 4; bar++) {
        int h = BAR_H0 + bar * BAR_STEP;
        int y0 = WIFI_ICON_Y + WIFI_ICON_H - h;
        bool lit = bar < bars_lit;
        for (int col = 0; col < BAR_W; col++) {
            for (int row = 0; row < h; row++) {
                // Lit bars are solid; unlit-but-connected bars fill every
                // other row — at BAR_W=2 there's no "interior" pixel to
                // leave hollow for an outline (every column is an edge
                // column), so a half-density fill is what actually reads
                // as "dimmer than solid" rather than being indistinguishable
                // from lit at this size.
                bool on = lit || (row % 2 == 0);
                lcd_pcd8544_set_pixel(x + col, y0 + row, on);
            }
        }
        x += BAR_W + BAR_GAP;
    }
}

// Fixed-width output — MHz is space-padded to 2 digits (%2lu) so the string
// length (and therefore the decimal points' screen position) never changes
// as the band changes, e.g. " 7.040.0 kHz" and "14.225.0 kHz" are both 12
// chars. Covers the uSDX BLACK_BRICK's full HF range (1.5-60 MHz per the
// firmware's own FA validation window — see firmware/usdxBLACKBRICK); a
// 3-digit MHz value (VHF) would widen the string, but this rig never tunes there.
#define VFO_TEXT_LEN 12

// Pulsing filled-disc activity spinner (9x9px): a solid circle that grows
// from a single center pixel out to its full radius, then resets — reads as
// a deliberate "breathing" icon, unlike a single dot orbiting a ring (too
// small to read clearly at 7px) or an ASCII |/-\ character (looks like
// jittering text, not an icon). SPINNER_MAX_RADIUS frames are precomputed
// as plain pixel-inside-circle tests, since the box is tiny and this only
// runs a couple times a second — no need for anything fancier than a
// distance check per pixel.
#define SPINNER_SIZE       9
#define SPINNER_CX         4
#define SPINNER_CY         4
#define SPINNER_MAX_RADIUS 4
// Each radius step holds for this many redraws before advancing, so the
// growth is visibly a pulse rather than a blur at REFRESH_PERIOD_MS=500.
#define SPINNER_HOLD_TICKS 1

static void draw_spinner(int x0, int y0, uint32_t tick) {
    int step = (tick / SPINNER_HOLD_TICKS) % (SPINNER_MAX_RADIUS + 1);
    int r2 = step * step;
    for (int dy = -step; dy <= step; dy++) {
        for (int dx = -step; dx <= step; dx++) {
            if (dx * dx + dy * dy <= r2) {
                lcd_pcd8544_set_pixel(x0 + SPINNER_CX + dx, y0 + SPINNER_CY + dy, true);
            }
        }
    }
}

static void format_vfo(char *out, size_t out_sz, uint32_t hz) {
    if (hz == 0) { snprintf(out, out_sz, "--.---.- kHz"); return; }
    uint32_t khz_whole  = hz / 1000;
    uint32_t khz_tenths = (hz / 100) % 10;
    uint32_t mhz        = khz_whole / 1000;
    uint32_t khz_rem    = khz_whole % 1000;
    snprintf(out, out_sz, "%2lu.%03lu.%lu kHz",
             (unsigned long)mhz, (unsigned long)khz_rem, (unsigned long)khz_tenths);
}

static void render(const bridge_state_t *st, uint32_t tick) {
    char line[32];

    lcd_pcd8544_clear();
    lcd_pcd8544_draw_rounded_rect(0, 0, LCD_WIDTH_PX, LCD_HEIGHT_PX, BORDER_RADIUS);
    draw_wifi_icon(st->wifi_state, st->wifi_rssi);

    // Radio link — based ONLY on bytes actually received FROM the radio
    // (last_radio_rx_us), never on bytes merely sent to it: writing to the
    // UART TX pin succeeds whether or not a cable/radio is on the other end
    // (no hardware handshake/ack), so this is the one signal that actually
    // proves the cable is plugged in and the radio is replying. The spinner
    // ticks only while genuinely linked, so a stalled-but-not-crashed bridge
    // (linked, but redraw stopped) is still visually distinguishable from a
    // "no radio" state showing "silent".
    // Text kept short ("RIG:link", 8 chars/48px) so the 9px spinner drawn
    // right after it (starting at x=57) still ends at x=66, before the
    // Wi-Fi icon's left edge (x=70) — the two share row 0 deliberately, no
    // row is reserved for the icon alone.
    int64_t now = esp_timer_get_time();
    bool radio_linked = (now - st->last_radio_rx_us) <= CAT_IDLE_THRESHOLD_US;
    lcd_pcd8544_draw_text(TEXT_X0, TEXT_ROW(0), radio_linked ? "RIG:link" : "RIG:silent");
    if (radio_linked) {
        draw_spinner(TEXT_X0 + 9 * 6, TEXT_ROW(0), tick);
    }

    // Connected client count — more useful than a single yes/no now that
    // several browser tabs can watch the same session at once.
    snprintf(line, sizeof(line), "Clients: %u", (unsigned)st->ws_client_count);
    lcd_pcd8544_draw_text(TEXT_X0, TEXT_ROW(1), line);

    // S-meter — snooped from the radio's own SM; replies the same way VFO
    // is, so it stays live without the bridge ever polling the radio itself.
    if (st->has_smeter) {
        snprintf(line, sizeof(line), "S: %d dBm", st->last_smeter_dbm);
    } else {
        // Either no client has ever polled SM; yet, or the radio is mid-TX
        // (its deliberate "nothing to measure" reply) — can't tell which
        // from here, "--" covers both without claiming a reading that
        // doesn't exist.
        snprintf(line, sizeof(line), "S: --");
    }
    lcd_pcd8544_draw_text(TEXT_X0, TEXT_ROW(2), line);

    // VFO frequency — bottom row, the last thing the eye lands on. Centered
    // using the format's fixed character count (VFO_TEXT_LEN), not the
    // string's actual strlen(), so the decimal points sit at the same x
    // position on every redraw regardless of which digits are showing.
    format_vfo(line, sizeof(line), st->last_vfo_hz);
    int vfo_text_px = VFO_TEXT_LEN * 6; // draw_text's per-glyph advance
    int vfo_x = (LCD_WIDTH_PX - vfo_text_px) / 2;
    lcd_pcd8544_draw_text(vfo_x, TEXT_ROW(VFO_ROW), line);

    lcd_pcd8544_flush();
}

static void status_display_task(void *arg) {
    uint32_t tick = 0;
    for (;;) {
        bridge_state_t st;
        bridge_state_get(&st);
        render(&st, tick++);
        vTaskDelay(pdMS_TO_TICKS(REFRESH_PERIOD_MS));
    }
}

void status_display_start(void) {
    lcd_pcd8544_init();
    lcd_pcd8544_set_backlight(bridge_settings_get_backlight());
    lcd_pcd8544_set_contrast(bridge_settings_get_contrast());
    xTaskCreatePinnedToCore(status_display_task, "status_lcd", 4096, NULL,
                             STATUS_DISPLAY_TASK_PRIO, NULL, STATUS_DISPLAY_TASK_CORE);
}
