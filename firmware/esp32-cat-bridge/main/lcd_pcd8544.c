#include "lcd_pcd8544.h"

#include <stddef.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "font5x7.h"

static const char *TAG = "lcd_pcd8544";

// PCD8544 command bytes (DC=0). See datasheet §7.
#define PCD8544_CMD_FUNCTION_SET   0x20
#define PCD8544_CMD_DISPLAY_CTRL   0x08
#define PCD8544_CMD_SET_Y_ADDR     0x40
#define PCD8544_CMD_SET_X_ADDR     0x80
#define PCD8544_CMD_TEMP_CTRL      0x04
#define PCD8544_CMD_BIAS           0x10
#define PCD8544_CMD_VOP            0x80 // extended-mode only, OR'd with contrast 0-127

#define PCD8544_FUNC_EXTENDED      0x01
#define PCD8544_DISPLAY_NORMAL     0x04

#define LCD_ROWS (LCD_HEIGHT_PX / 8) // 48/8 = 6 banks
#define LCD_COLS LCD_WIDTH_PX        // 84

static spi_device_handle_t s_spi;
// One byte per column per bank — the controller's native addressing.
static uint8_t s_framebuf[LCD_ROWS][LCD_COLS];

static void gpio_out_init(gpio_num_t pin, int level) {
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << pin,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&io);
    gpio_set_level(pin, level);
}

static void lcd_send(uint8_t byte, bool is_data) {
    gpio_set_level(LCD_PIN_DC, is_data ? 1 : 0);
    spi_transaction_t t = {
        .length = 8,
        .tx_buffer = &byte,
    };
    spi_device_polling_transmit(s_spi, &t);
}

// Sends `len` data bytes (DC=1) as ONE SPI transaction instead of `len`
// separate polling calls. spi_device_polling_transmit() busy-waits the CPU
// for the whole transfer either way (no DMA — SPI_DMA_DISABLED — and no
// task-yielding in between), so the difference isn't less CPU time spent
// transmitting, it's collapsing hundreds of per-byte call/setup overheads
// (GPIO write + transaction descriptor + driver bookkeeping) into one: the
// original per-byte lcd_send() loop in lcd_pcd8544_flush() was blocking
// core 1 (shared with the higher-priority CAT UART reader task) for far
// longer per redraw than the raw bit time at LCD_SPI_CLOCK_HZ justified,
// which was long enough to make the reader miss the radio's auto-report
// pushes during a redraw window.
static void lcd_send_data_burst(const uint8_t *data, size_t len) {
    gpio_set_level(LCD_PIN_DC, 1);
    spi_transaction_t t = {
        .length = len * 8,
        .tx_buffer = data,
    };
    spi_device_polling_transmit(s_spi, &t);
}

static void lcd_reset_sequence(void) {
    gpio_set_level(LCD_PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(LCD_PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
}

static void backlight_pwm_init(void) {
    ledc_timer_config_t timer_cfg = {
        .speed_mode      = LCD_BACKLIGHT_LEDC_MODE,
        .timer_num       = LCD_BACKLIGHT_LEDC_TIMER,
        .duty_resolution = LCD_BACKLIGHT_DUTY_RES,
        .freq_hz         = LCD_BACKLIGHT_PWM_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer_cfg));

    ledc_channel_config_t channel_cfg = {
        .speed_mode = LCD_BACKLIGHT_LEDC_MODE,
        .channel    = LCD_BACKLIGHT_LEDC_CHANNEL,
        .timer_sel  = LCD_BACKLIGHT_LEDC_TIMER,
        .gpio_num   = LCD_PIN_BACKLIGHT,
        .duty       = 0, // start off; status_display turns it on at its configured level
        .hpoint     = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel_cfg));
}

void lcd_pcd8544_init(void) {
    gpio_out_init(LCD_PIN_DC, 0);
    gpio_out_init(LCD_PIN_RST, 1);
    gpio_out_init(LCD_PIN_CE, 1);
    backlight_pwm_init();

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = LCD_PIN_DIN,
        .miso_io_num = -1, // write-only panel
        .sclk_io_num = LCD_PIN_CLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_COLS,
    };
    // DMA (not SPI_DMA_DISABLED): without it, spi_device_polling_transmit()
    // is capped by the hardware FIFO at 16 words/64 bytes per transaction
    // (SPI_LL_CPU_MAX_BIT_LEN) — too small for the 84-byte-per-bank burst
    // lcd_pcd8544_flush() sends (see lcd_send_data_burst). The driver copies
    // our plain static s_framebuf into an internal DMA-capable bounce
    // buffer automatically, so no change needed to how the framebuffer
    // itself is allocated.
    ESP_ERROR_CHECK(spi_bus_initialize(LCD_SPI_HOST, &bus_cfg, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev_cfg = {
        .clock_speed_hz = LCD_SPI_CLOCK_HZ,
        .mode = 0,
        .spics_io_num = LCD_PIN_CE,
        .queue_size = 1,
        .flags = SPI_DEVICE_HALFDUPLEX,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(LCD_SPI_HOST, &dev_cfg, &s_spi));

    lcd_reset_sequence();

    // Extended instruction set to configure bias/Vop, then back to basic
    // mode with the display in normal (non-inverted) mode — standard
    // PCD8544 bring-up sequence.
    lcd_send(PCD8544_CMD_FUNCTION_SET | PCD8544_FUNC_EXTENDED, false);
    lcd_send(PCD8544_CMD_VOP | LCD_CONTRAST_DEFAULT_VOP, false); // contrast, mid-range default — status_display applies the persisted value right after init
    lcd_send(PCD8544_CMD_TEMP_CTRL | 0x02, false);    // temp coefficient 2 (common default)
    lcd_send(PCD8544_CMD_BIAS | 0x03, false);         // bias 1:48 (common for 84x48)
    lcd_send(PCD8544_CMD_FUNCTION_SET, false);        // back to basic instruction set
    lcd_send(PCD8544_CMD_DISPLAY_CTRL | PCD8544_DISPLAY_NORMAL, false);

    lcd_pcd8544_clear();
    lcd_pcd8544_flush();
    ESP_LOGI(TAG, "PCD8544 initialized (%dx%d)", LCD_WIDTH_PX, LCD_HEIGHT_PX);
}

void lcd_pcd8544_clear(void) {
    memset(s_framebuf, 0, sizeof(s_framebuf));
}

// The framebuffer is one byte per (bank, column) — the PCD8544's native
// addressing, 8 vertically-stacked pixels per byte, LSB = topmost of the 8.
// A per-pixel set has to touch only its own bit, unlike draw_text's whole-
// byte glyph writes (which are safe because each glyph fully owns its 8
// vertical pixels within one text row/bank).
void lcd_pcd8544_set_pixel(int x, int y, bool on) {
    if (x < 0 || x >= LCD_COLS || y < 0 || y >= LCD_HEIGHT_PX) return;
    int bank = y / 8;
    uint8_t bit = 1 << (y % 8);
    if (on) s_framebuf[bank][x] |= bit;
    else    s_framebuf[bank][x] &= (uint8_t)~bit;
}

void lcd_pcd8544_draw_rect(int x, int y, int w, int h) {
    if (w <= 0 || h <= 0) return;
    for (int i = 0; i < w; i++) {
        lcd_pcd8544_set_pixel(x + i, y, true);
        lcd_pcd8544_set_pixel(x + i, y + h - 1, true);
    }
    for (int j = 0; j < h; j++) {
        lcd_pcd8544_set_pixel(x, y + j, true);
        lcd_pcd8544_set_pixel(x + w - 1, y + j, true);
    }
}

// Standard midpoint-circle algorithm, restricted to the single quadrant
// facing a corner's own outer point — a well-known, gap-free way to trace a
// discrete circular arc (unlike a naive distance-threshold scan per pixel,
// which can leave diagonal gaps or double-thickness spots at small radii;
// verified in isolation for radius 2-5 before use here). Calls `emit` with
// each arc point as (dx, dy) offsets in 0..radius, measured inward from the
// corner's outer point — the caller mirrors that into all four corners.
static void trace_corner_arc(int radius, void (*emit)(int dx, int dy, void *ctx), void *ctx) {
    int px = radius, py = 0;
    int d = 1 - radius;
    while (px >= py) {
        emit(radius - px, radius - py, ctx);
        emit(radius - py, radius - px, ctx);
        py++;
        if (d < 0) {
            d += 2 * py + 1;
        } else {
            px--;
            d += 2 * py - 2 * px + 1;
        }
    }
}

typedef struct { int x, y, w, h, radius; } corner_ctx_t;

static void emit_corner_pixel(int dx, int dy, void *ctx_) {
    corner_ctx_t *c = (corner_ctx_t *)ctx_;
    if (dx < 0 || dx >= c->radius || dy < 0 || dy >= c->radius) return; // arc briefly exits the quadrant near the diagonal
    lcd_pcd8544_set_pixel(c->x + c->radius - 1 - dx,         c->y + c->radius - 1 - dy,         true); // top-left
    lcd_pcd8544_set_pixel(c->x + c->w - c->radius + dx,      c->y + c->radius - 1 - dy,         true); // top-right
    lcd_pcd8544_set_pixel(c->x + c->radius - 1 - dx,         c->y + c->h - c->radius + dy,      true); // bottom-left
    lcd_pcd8544_set_pixel(c->x + c->w - c->radius + dx,      c->y + c->h - c->radius + dy,      true); // bottom-right
}

void lcd_pcd8544_draw_rounded_rect(int x, int y, int w, int h, int radius) {
    if (w <= 0 || h <= 0) return;
    if (radius <= 0 || radius * 2 > w || radius * 2 > h) { lcd_pcd8544_draw_rect(x, y, w, h); return; }

    // Straight edges, shortened to leave room for the corner arcs.
    for (int i = radius; i < w - radius; i++) {
        lcd_pcd8544_set_pixel(x + i, y, true);
        lcd_pcd8544_set_pixel(x + i, y + h - 1, true);
    }
    for (int j = radius; j < h - radius; j++) {
        lcd_pcd8544_set_pixel(x, y + j, true);
        lcd_pcd8544_set_pixel(x + w - 1, y + j, true);
    }

    corner_ctx_t ctx = { x, y, w, h, radius };
    trace_corner_arc(radius, emit_corner_pixel, &ctx);
}

void lcd_pcd8544_draw_text(int x0, int y, const char *text) {
    int x = x0;
    for (const char *p = text; *p && x + 5 <= LCD_COLS; p++, x += 6) {
        unsigned char c = (unsigned char)*p;
        if (c < FONT5X7_FIRST_CHAR || c > FONT5X7_LAST_CHAR) c = ' ';
        const uint8_t *glyph = font5x7[c - FONT5X7_FIRST_CHAR];
        // Per-pixel (not whole-byte) writes so glyphs can straddle two
        // hardware banks when y isn't bank-aligned — costs a few hundred
        // set_pixel calls per redraw, negligible next to the SPI flush.
        for (int col = 0; col < 5; col++) {
            uint8_t bits = glyph[col];
            for (int row = 0; row < 7; row++) {
                lcd_pcd8544_set_pixel(x + col, y + row, (bits >> row) & 1);
            }
        }
        // column x+5 stays clear as the 1px inter-glyph gap
    }
}

void lcd_pcd8544_flush(void) {
    for (int bank = 0; bank < LCD_ROWS; bank++) {
        lcd_send(PCD8544_CMD_SET_X_ADDR | 0, false);
        lcd_send(PCD8544_CMD_SET_Y_ADDR | bank, false);
        lcd_send_data_burst(s_framebuf[bank], LCD_COLS);
    }
}

void lcd_pcd8544_set_contrast(uint8_t vop) {
    if (vop > 0x7F) vop = 0x7F; // 7-bit register
    // Same extended-mode dance as init: Vop only exists in the extended
    // instruction set, so switch there, write it, then switch back to basic
    // mode and re-assert display-normal — the controller doesn't remember
    // basic-mode display state across an excursion into extended mode.
    lcd_send(PCD8544_CMD_FUNCTION_SET | PCD8544_FUNC_EXTENDED, false);
    lcd_send(PCD8544_CMD_VOP | vop, false);
    lcd_send(PCD8544_CMD_FUNCTION_SET, false);
    lcd_send(PCD8544_CMD_DISPLAY_CTRL | PCD8544_DISPLAY_NORMAL, false);
}

void lcd_pcd8544_set_backlight(uint8_t duty) {
    // No clamp needed: duty's uint8_t range (0..255) already matches
    // LCD_BACKLIGHT_MAX_DUTY exactly, since LCD_BACKLIGHT_DUTY_RES is 8-bit
    // (see bridge_config.h) — revisit if that resolution ever changes.
    ledc_set_duty(LCD_BACKLIGHT_LEDC_MODE, LCD_BACKLIGHT_LEDC_CHANNEL, duty);
    ledc_update_duty(LCD_BACKLIGHT_LEDC_MODE, LCD_BACKLIGHT_LEDC_CHANNEL);
}
