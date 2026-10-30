// PCD8544 driver (Nokia 5110/3310 LCD, 84 x 48, 1 bit) on the S3 bridge's
// edge-mounted module: SPI2 write-only, without DMA, D/C and reset on GPIOs, the backlight
// as PWM on its own pin (bridge_config.h S3_LCD_*).
//
// Frame layout, as the controller stores it: 6 banks of 84 bytes, each byte a
// column of 8 pixels, bit 0 at the top. lcd_gfx.h draws into that layout.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define LCD_W 84
#define LCD_H 48
#define LCD_FRAME_BYTES (LCD_W * LCD_H / 8)

// Sets up the bus, resets the controller and applies contrast/bias. False if
// the SPI bus could not be set up (nothing is drawn then).
bool lcd_init(uint8_t vop, uint8_t bias);

// Contrast (Vop, 0..127) and bias (0..7; 3 or 4 suit most modules).
void lcd_set_contrast(uint8_t vop, uint8_t bias);
void lcd_set_inverted(bool inverted);
// Backlight, 0..100 %.
void lcd_set_backlight(int pct);
// Sends a whole frame (LCD_FRAME_BYTES); about 1 ms at 4 MHz.
void lcd_send_frame(const uint8_t *frame);
