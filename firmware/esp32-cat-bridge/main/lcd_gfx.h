// 1-bit drawing for the status LCD: one 84 x 48 frame buffer in the PCD8544's
// own layout (lcd_pcd8544.h), so it goes to the glass and to GET
// /display/frame as is.
//
// Colours: GFX_ON (a dark pixel), GFX_OFF, GFX_XOR (flip).
//
// Fonts:
//   tiny   3 x 5 capitals, digits and a few signs (M, N, W, Q wider); labels
//   small  the classic 5 x 7 ASCII, 6 px a character
//   big    the 5 x 7 digits doubled to 10 x 14, for the frequency
//
// Icons are 1-bit pixel art with one or more animation frames
// (gfx_icon_t, drawn by frame number so callers animate them off a tick).
//
// The web app has a copy of all of this for the LCD views it draws
// (src/lib/lcd/gfx.ts); its tests check the copy against this file, so a
// change here shows up there as a failing test until the copy follows.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "lcd_pcd8544.h"

typedef enum { GFX_OFF = 0, GFX_ON = 1, GFX_XOR = 2 } gfx_color_t;

typedef struct {
    uint8_t w, h, frames;
    const char *const *rows;  // h rows per frame, frame after frame; '#' = on
} gfx_icon_t;

// Allocates the frame buffer; call once before drawing.
bool gfx_init(void);
uint8_t *gfx_frame(void);
void gfx_clear(void);
void gfx_px(int x, int y, gfx_color_t c);
bool gfx_get(int x, int y);
void gfx_hline(int x0, int x1, int y, gfx_color_t c);
void gfx_vline(int x, int y0, int y1, gfx_color_t c);
void gfx_line(int x0, int y0, int x1, int y1, gfx_color_t c);
void gfx_fill(int x, int y, int w, int h, gfx_color_t c);
void gfx_rect(int x, int y, int w, int h, gfx_color_t c);
void gfx_round_rect(int x, int y, int w, int h, int r, gfx_color_t c);
void gfx_fill_round(int x, int y, int w, int h, int r, gfx_color_t c);
// 50 % checkerboard (the "grey" of a 1-bit screen), phase 0 or 1.
void gfx_dither(int x, int y, int w, int h, int phase);
void gfx_invert(void);

int gfx_tiny(int x, int y, const char *s, gfx_color_t c);   // returns the width drawn
int gfx_tiny_width(const char *s);
int gfx_small(int x, int y, const char *s, gfx_color_t c);
int gfx_small_width(const char *s);
int gfx_big(int x, int y, const char *s, gfx_color_t c);     // digits, '.', '-', ' '
int gfx_big_width(const char *s);

void gfx_icon(int x, int y, const gfx_icon_t *icon, int frame, gfx_color_t c);
// Each pixel as a k x k block, always GFX_ON.
void gfx_icon_scaled(int x, int y, const gfx_icon_t *icon, int frame, int k);

// Pieces of the look, shared by every view:
// a pill: tiny text in a rounded block (filled) or outline, 7 high; returns its width
int gfx_pill(int x, int y, const char *s, bool filled);
// a rounded bar for 0..1, segmented (two lit columns, one dark)
void gfx_seg_bar(int x, int y, int w, int h, float frac);
// a smooth bar for 0..1 in a rounded outline
void gfx_bar(int x, int y, int w, int h, float frac);
// a cleared panel with a double rounded border (the overlays)
void gfx_box(int x, int y, int w, int h);

// The icons the views use.
extern const gfx_icon_t ICON_CAT, ICON_HEART, ICON_BOLT, ICON_ARROW_DOWN, ICON_WARN, ICON_PERSON,
    ICON_CHIP, ICON_THERMO, ICON_STAR, ICON_SMILE, ICON_SAD, ICON_NOTE, ICON_ANTENNA, ICON_UPLOAD;
