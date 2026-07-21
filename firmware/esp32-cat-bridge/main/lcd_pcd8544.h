// Minimal driver for the PCD8544 controller (Nokia 5110-style LCD, 84x48,
// 1 bit per pixel). A handful of pixel/rect primitives plus text — enough
// for a status display with a border and small icons, not a general
// graphics library. Uses the ESP32 hardware SPI master driver (LCD_SPI_HOST)
// in half-duplex, write-only mode (the panel has no MISO).
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Initializes SPI, resets and configures the controller, the backlight PWM
// channel (LEDC — see LCD_BACKLIGHT_* in bridge_config.h), and clears the screen.
void lcd_pcd8544_init(void);

// Clears the in-memory framebuffer (does not push to the panel — call
// lcd_pcd8544_flush() after).
void lcd_pcd8544_clear(void);

// Sets/clears a single pixel in the framebuffer. Out-of-range coordinates
// are silently ignored (safe to call at the panel's edges without bounds
// checks at every call site).
void lcd_pcd8544_set_pixel(int x, int y, bool on);

// Draws a 1px rectangle outline (e.g. a frame border) in the framebuffer.
void lcd_pcd8544_draw_rect(int x, int y, int w, int h);

// Draws a 1px rectangle outline with the corners rounded by `radius` pixels
// (a real discrete arc, via the midpoint circle algorithm — verified gap-free
// for radius 2-6 at this resolution). radius <= 0, or too large for the
// given w/h, falls back to a plain lcd_pcd8544_draw_rect.
void lcd_pcd8544_draw_rounded_rect(int x, int y, int w, int h, int radius);

// Draws a string with its glyph top-left at pixel (x, y) using a fixed 5x7
// font (6px advance including a 1px inter-glyph gap, 7px glyph height).
// Pixel-addressed (not bank/cell-aligned) so callers can inset text from a
// border or align it next to an icon — out-of-range coordinates or
// overlong strings are clipped safely.
void lcd_pcd8544_draw_text(int x, int y, const char *text);

// Pushes the in-memory framebuffer to the panel over SPI.
void lcd_pcd8544_flush(void);

// Sets the backlight brightness via PWM, 0 (off) .. LCD_BACKLIGHT_MAX_DUTY
// (full brightness). Values outside that range are clamped.
void lcd_pcd8544_set_backlight(uint8_t duty);

// Sets the PCD8544's Vop (operating voltage / "contrast") register, 0..127
// — pure software, same SPI bus already used for the framebuffer, no extra
// wiring. Takes effect immediately; doesn't require a lcd_pcd8544_flush()
// call. Values outside 0..127 are clamped (the register is 7 bits).
void lcd_pcd8544_set_contrast(uint8_t vop);
