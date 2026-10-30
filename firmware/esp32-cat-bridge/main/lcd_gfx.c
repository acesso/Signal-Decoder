// 1-bit drawing for the status LCD — see lcd_gfx.h.
#include "lcd_gfx.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "esp_heap_caps.h"

// In PSRAM (internal RAM is scarce on this board); set up by gfx_init().
static uint8_t *s_fb;

bool gfx_init(void) {
    if (!s_fb) s_fb = heap_caps_calloc(1, LCD_FRAME_BYTES, MALLOC_CAP_SPIRAM);
    if (!s_fb) s_fb = calloc(1, LCD_FRAME_BYTES);
    return s_fb != NULL;
}

uint8_t *gfx_frame(void) { return s_fb; }
void gfx_clear(void) { memset(s_fb, 0, LCD_FRAME_BYTES); }

void gfx_px(int x, int y, gfx_color_t c) {
    if ((unsigned)x >= LCD_W || (unsigned)y >= LCD_H) return;
    uint8_t *b = &s_fb[(y >> 3) * LCD_W + x], m = (uint8_t)(1 << (y & 7));
    if (c == GFX_ON) *b |= m;
    else if (c == GFX_OFF) *b &= (uint8_t)~m;
    else *b ^= m;
}

bool gfx_get(int x, int y) {
    if ((unsigned)x >= LCD_W || (unsigned)y >= LCD_H) return false;
    return s_fb[(y >> 3) * LCD_W + x] & (1 << (y & 7));
}

void gfx_hline(int x0, int x1, int y, gfx_color_t c) {
    if (x0 > x1) { int t = x0; x0 = x1; x1 = t; }
    for (int x = x0; x <= x1; x++) gfx_px(x, y, c);
}

void gfx_vline(int x, int y0, int y1, gfx_color_t c) {
    if (y0 > y1) { int t = y0; y0 = y1; y1 = t; }
    for (int y = y0; y <= y1; y++) gfx_px(x, y, c);
}

void gfx_line(int x0, int y0, int x1, int y1, gfx_color_t c) {
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
        gfx_px(x0, y0, c);
        if (x0 == x1 && y0 == y1) return;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

void gfx_fill(int x, int y, int w, int h, gfx_color_t c) {
    for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) gfx_px(i, j, c);
}

void gfx_rect(int x, int y, int w, int h, gfx_color_t c) {
    if (w <= 0 || h <= 0) return;
    gfx_hline(x, x + w - 1, y, c);
    if (h > 1) gfx_hline(x, x + w - 1, y + h - 1, c);
    if (h > 2) { gfx_vline(x, y + 1, y + h - 2, c); if (w > 1) gfx_vline(x + w - 1, y + 1, y + h - 2, c); }
}

// Corner insets for radius 1..3, row by row from the corner: pixel-art
// rounding rather than a true circle, which looks lumpy at this size.
static const uint8_t CORNER[4][3] = { { 0 }, { 1 }, { 2, 1 }, { 3, 1, 1 } };

static int corner_inset(int j, int h, int r) {
    if (r < 1) return 0;
    if (j < r) return CORNER[r][j];
    if (h - 1 - j < r) return CORNER[r][h - 1 - j];
    return 0;
}

static bool in_round(int i, int j, int w, int h, int r) {
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    int in = corner_inset(j, h, r);
    return i >= in && i <= w - 1 - in;
}

// The outline: the shape's pixels with a 4-neighbour outside it.
void gfx_round_rect(int x, int y, int w, int h, int r, gfx_color_t c) {
    if (r > 3) r = 3;
    for (int j = 0; j < h; j++)
        for (int i = 0; i < w; i++)
            if (in_round(i, j, w, h, r) && (!in_round(i - 1, j, w, h, r) || !in_round(i + 1, j, w, h, r) ||
                                            !in_round(i, j - 1, w, h, r) || !in_round(i, j + 1, w, h, r)))
                gfx_px(x + i, y + j, c);
}

void gfx_fill_round(int x, int y, int w, int h, int r, gfx_color_t c) {
    if (r > 3) r = 3;
    for (int j = 0; j < h; j++) {
        int in = corner_inset(j, h, r);
        gfx_hline(x + in, x + w - 1 - in, y + j, c);
    }
}

void gfx_dither(int x, int y, int w, int h, int phase) {
    for (int j = y; j < y + h; j++)
        for (int i = x; i < x + w; i++) gfx_px(i, j, ((i + j + phase) & 1) ? GFX_ON : GFX_OFF);
}

void gfx_invert(void) { for (int i = 0; i < LCD_FRAME_BYTES; i++) s_fb[i] ^= 0xFF; }

// ── Fonts ──────────────────────────────────────────────────────────────────

// 5 x 7, ASCII 0x20..0x7E, a column a byte, bit 0 at the top.
static const uint8_t FONT5X7[95][5] = {
    {0x00,0x00,0x00,0x00,0x00},{0x00,0x00,0x5F,0x00,0x00},{0x00,0x07,0x00,0x07,0x00},{0x14,0x7F,0x14,0x7F,0x14},
    {0x24,0x2A,0x7F,0x2A,0x12},{0x23,0x13,0x08,0x64,0x62},{0x36,0x49,0x56,0x20,0x50},{0x00,0x08,0x07,0x03,0x00},
    {0x00,0x1C,0x22,0x41,0x00},{0x00,0x41,0x22,0x1C,0x00},{0x2A,0x1C,0x7F,0x1C,0x2A},{0x08,0x08,0x3E,0x08,0x08},
    {0x00,0x80,0x70,0x30,0x00},{0x08,0x08,0x08,0x08,0x08},{0x00,0x00,0x60,0x60,0x00},{0x20,0x10,0x08,0x04,0x02},
    {0x3E,0x51,0x49,0x45,0x3E},{0x00,0x42,0x7F,0x40,0x00},{0x72,0x49,0x49,0x49,0x46},{0x21,0x41,0x49,0x4D,0x33},
    {0x18,0x14,0x12,0x7F,0x10},{0x27,0x45,0x45,0x45,0x39},{0x3C,0x4A,0x49,0x49,0x31},{0x41,0x21,0x11,0x09,0x07},
    {0x36,0x49,0x49,0x49,0x36},{0x46,0x49,0x49,0x29,0x1E},{0x00,0x00,0x14,0x00,0x00},{0x00,0x40,0x34,0x00,0x00},
    {0x00,0x08,0x14,0x22,0x41},{0x14,0x14,0x14,0x14,0x14},{0x00,0x41,0x22,0x14,0x08},{0x02,0x01,0x59,0x09,0x06},
    {0x3E,0x41,0x5D,0x59,0x4E},{0x7C,0x12,0x11,0x12,0x7C},{0x7F,0x49,0x49,0x49,0x36},{0x3E,0x41,0x41,0x41,0x22},
    {0x7F,0x41,0x41,0x41,0x3E},{0x7F,0x49,0x49,0x49,0x41},{0x7F,0x09,0x09,0x09,0x01},{0x3E,0x41,0x41,0x51,0x73},
    {0x7F,0x08,0x08,0x08,0x7F},{0x00,0x41,0x7F,0x41,0x00},{0x20,0x40,0x41,0x3F,0x01},{0x7F,0x08,0x14,0x22,0x41},
    {0x7F,0x40,0x40,0x40,0x40},{0x7F,0x02,0x1C,0x02,0x7F},{0x7F,0x04,0x08,0x10,0x7F},{0x3E,0x41,0x41,0x41,0x3E},
    {0x7F,0x09,0x09,0x09,0x06},{0x3E,0x41,0x51,0x21,0x5E},{0x7F,0x09,0x19,0x29,0x46},{0x26,0x49,0x49,0x49,0x32},
    {0x03,0x01,0x7F,0x01,0x03},{0x3F,0x40,0x40,0x40,0x3F},{0x1F,0x20,0x40,0x20,0x1F},{0x3F,0x40,0x38,0x40,0x3F},
    {0x63,0x14,0x08,0x14,0x63},{0x03,0x04,0x78,0x04,0x03},{0x61,0x59,0x49,0x4D,0x43},{0x00,0x7F,0x41,0x41,0x41},
    {0x02,0x04,0x08,0x10,0x20},{0x00,0x41,0x41,0x41,0x7F},{0x04,0x02,0x01,0x02,0x04},{0x40,0x40,0x40,0x40,0x40},
    {0x00,0x03,0x07,0x08,0x00},{0x20,0x54,0x54,0x78,0x40},{0x7F,0x28,0x44,0x44,0x38},{0x38,0x44,0x44,0x44,0x28},
    {0x38,0x44,0x44,0x28,0x7F},{0x38,0x54,0x54,0x54,0x18},{0x00,0x08,0x7E,0x09,0x02},{0x18,0xA4,0xA4,0x9C,0x78},
    {0x7F,0x08,0x04,0x04,0x78},{0x00,0x44,0x7D,0x40,0x00},{0x20,0x40,0x40,0x3D,0x00},{0x7F,0x10,0x28,0x44,0x00},
    {0x00,0x41,0x7F,0x40,0x00},{0x7C,0x04,0x78,0x04,0x78},{0x7C,0x08,0x04,0x04,0x78},{0x38,0x44,0x44,0x44,0x38},
    {0xFC,0x18,0x24,0x24,0x18},{0x18,0x24,0x24,0x18,0xFC},{0x7C,0x08,0x04,0x04,0x08},{0x48,0x54,0x54,0x54,0x24},
    {0x04,0x04,0x3F,0x44,0x24},{0x3C,0x40,0x40,0x20,0x7C},{0x1C,0x20,0x40,0x20,0x1C},{0x3C,0x40,0x30,0x40,0x3C},
    {0x44,0x28,0x10,0x28,0x44},{0x4C,0x90,0x90,0x90,0x7C},{0x44,0x64,0x54,0x4C,0x44},{0x00,0x08,0x36,0x41,0x00},
    {0x00,0x00,0x77,0x00,0x00},{0x00,0x41,0x36,0x08,0x00},{0x02,0x01,0x02,0x04,0x02},
};

// 3 x 5 (a few wider), columns, bit 0 at the top. Lower case draws as upper.
typedef struct { char c; uint8_t w; uint8_t col[5]; } tiny_glyph_t;
static const tiny_glyph_t TINY[] = {
    {' ',2,{0}}, {'.',1,{0x10}}, {':',1,{0x0A}}, {',',2,{0x10,0x08}}, {'-',3,{0x04,0x04,0x04}}, {'+',3,{0x04,0x0E,0x04}},
    {'/',3,{0x18,0x04,0x03}}, {'%',3,{0x19,0x04,0x13}}, {'<',3,{0x04,0x0A,0x11}}, {'>',3,{0x11,0x0A,0x04}},
    {'!',1,{0x17}}, {'?',3,{0x01,0x15,0x07}}, {'(',2,{0x0E,0x11}}, {')',2,{0x11,0x0E}}, {'=',3,{0x0A,0x0A,0x0A}},
    {'*',3,{0x02,0x05,0x02}}, {'_',3,{0x10,0x10,0x10}}, {'#',5,{0x0A,0x1F,0x0A,0x1F,0x0A}},
    {'0',3,{0x1F,0x11,0x1F}}, {'1',3,{0x12,0x1F,0x10}}, {'2',3,{0x1D,0x15,0x17}}, {'3',3,{0x15,0x15,0x1F}},
    {'4',3,{0x07,0x04,0x1F}}, {'5',3,{0x17,0x15,0x1D}}, {'6',3,{0x1F,0x15,0x1D}}, {'7',3,{0x01,0x01,0x1F}},
    {'8',3,{0x1F,0x15,0x1F}}, {'9',3,{0x17,0x15,0x1F}},
    {'A',3,{0x1E,0x05,0x1E}}, {'B',3,{0x1F,0x15,0x0A}}, {'C',3,{0x0E,0x11,0x11}}, {'D',3,{0x1F,0x11,0x0E}},
    {'E',3,{0x1F,0x15,0x11}}, {'F',3,{0x1F,0x05,0x01}}, {'G',3,{0x0E,0x11,0x1D}}, {'H',3,{0x1F,0x04,0x1F}},
    {'I',3,{0x11,0x1F,0x11}}, {'J',3,{0x08,0x10,0x0F}}, {'K',3,{0x1F,0x04,0x1B}}, {'L',3,{0x1F,0x10,0x10}},
    {'M',5,{0x1F,0x02,0x04,0x02,0x1F}}, {'N',4,{0x1F,0x02,0x04,0x1F}}, {'O',3,{0x0E,0x11,0x0E}},
    {'P',3,{0x1F,0x05,0x07}}, {'Q',4,{0x0E,0x11,0x09,0x16}}, {'R',3,{0x1F,0x05,0x1A}}, {'S',3,{0x12,0x15,0x09}},
    {'T',3,{0x01,0x1F,0x01}}, {'U',3,{0x1F,0x10,0x1F}}, {'V',3,{0x0F,0x10,0x0F}}, {'W',5,{0x1F,0x08,0x04,0x08,0x1F}},
    {'X',3,{0x1B,0x04,0x1B}}, {'Y',3,{0x03,0x1C,0x03}}, {'Z',3,{0x19,0x15,0x13}},
};

static const tiny_glyph_t *tiny_find(char c) {
    if (c >= 'a' && c <= 'z') c = (char)(c - 32);
    for (size_t i = 0; i < sizeof(TINY) / sizeof(TINY[0]); i++) if (TINY[i].c == c) return &TINY[i];
    return &TINY[0];
}

int gfx_tiny_width(const char *s) {
    int w = 0;
    for (; *s; s++) w += tiny_find(*s)->w + 1;
    return w ? w - 1 : 0;
}

int gfx_tiny(int x, int y, const char *s, gfx_color_t c) {
    int x0 = x;
    for (; *s; s++) {
        const tiny_glyph_t *g = tiny_find(*s);
        for (int i = 0; i < g->w; i++)
            for (int j = 0; j < 5; j++) if (g->col[i] & (1 << j)) gfx_px(x + i, y + j, c);
        x += g->w + 1;
    }
    return x > x0 ? x - x0 - 1 : 0;
}

int gfx_small_width(const char *s) { int n = (int)strlen(s); return n ? n * 6 - 1 : 0; }

int gfx_small(int x, int y, const char *s, gfx_color_t c) {
    int x0 = x;
    for (; *s; s++, x += 6) {
        unsigned ch = (unsigned char)*s;
        if (ch < 0x20 || ch > 0x7E) ch = '?';
        const uint8_t *g = FONT5X7[ch - 0x20];
        for (int i = 0; i < 5; i++)
            for (int j = 0; j < 8; j++) if (g[i] & (1 << j)) gfx_px(x + i, y + j, c);
    }
    return x > x0 ? x - x0 - 1 : 0;
}

// Big: each 5 x 7 pixel as 2 x 2; '.' is a 2 x 2 dot in a 4 px cell.
static int big_cell(char ch) { return ch == '.' ? 4 : ch == ' ' ? 6 : 12; }

int gfx_big_width(const char *s) {
    int w = 0;
    for (; *s; s++) w += big_cell(*s);
    return w ? w - 2 : 0;
}

int gfx_big(int x, int y, const char *s, gfx_color_t c) {
    int x0 = x;
    for (; *s; s++) {
        if (*s == '.') gfx_fill(x, y + 12, 2, 2, c);
        else if (*s != ' ') {
            const uint8_t *g = FONT5X7[(unsigned char)*s - 0x20];
            for (int i = 0; i < 5; i++)
                for (int j = 0; j < 7; j++) if (g[i] & (1 << j)) gfx_fill(x + 2 * i, y + 2 * j, 2, 2, c);
        }
        x += big_cell(*s);
    }
    return x > x0 ? x - x0 - 2 : 0;
}

// ── Icons ──────────────────────────────────────────────────────────────────

void gfx_icon(int x, int y, const gfx_icon_t *icon, int frame, gfx_color_t c) {
    const char *const *rows = icon->rows + (frame % icon->frames) * icon->h;
    for (int j = 0; j < icon->h; j++)
        for (int i = 0; i < icon->w && rows[j][i]; i++) if (rows[j][i] == '#') gfx_px(x + i, y + j, c);
}

void gfx_icon_scaled(int x, int y, const gfx_icon_t *icon, int frame, int k) {
    const char *const *rows = icon->rows + (frame % icon->frames) * icon->h;
    for (int j = 0; j < icon->h; j++)
        for (int i = 0; i < icon->w && rows[j][i]; i++) if (rows[j][i] == '#') gfx_fill(x + i * k, y + j * k, k, k, GFX_ON);
}

// ── Pieces of the look ─────────────────────────────────────────────────────

int gfx_pill(int x, int y, const char *s, bool filled) {
    int w = gfx_tiny_width(s) + 6;
    if (filled) { gfx_fill_round(x, y, w, 7, 2, GFX_ON); gfx_tiny(x + 3, y + 1, s, GFX_OFF); }
    else { gfx_round_rect(x, y, w, 7, 2, GFX_ON); gfx_tiny(x + 3, y + 1, s, GFX_ON); }
    return w;
}

void gfx_seg_bar(int x, int y, int w, int h, float frac) {
    gfx_round_rect(x, y, w, h, 1, GFX_ON);
    int n = (int)lroundf((w - 4) * (frac < 0 ? 0 : frac > 1 ? 1 : frac));
    for (int i = 0; i < n; i++) if (i % 3 != 2) gfx_vline(x + 2 + i, y + 2, y + h - 3, GFX_ON);
}

void gfx_bar(int x, int y, int w, int h, float frac) {
    gfx_round_rect(x, y, w, h, 1, GFX_ON);
    int n = (int)lroundf((w - 4) * (frac < 0 ? 0 : frac > 1 ? 1 : frac));
    if (n > 0) gfx_fill(x + 2, y + 2, n, h - 4, GFX_ON);
}

void gfx_box(int x, int y, int w, int h) {
    gfx_fill_round(x, y, w, h, 3, GFX_OFF);
    gfx_round_rect(x, y, w, h, 3, GFX_ON);
    gfx_round_rect(x + 2, y + 2, w - 4, h - 4, 2, GFX_ON);
}

// ── The icons ──────────────────────────────────────────────────────────────

#define ICON(name, w, h, frames, ...) \
    static const char *const name##_ROWS[] = { __VA_ARGS__ }; \
    const gfx_icon_t name = { w, h, frames, name##_ROWS }

// The radio link: a cat face, ears and eyes only; it blinks.
ICON(ICON_CAT, 7, 7, 2,
    "#.....#", "##...##", "#######", "#.###.#", "#######", "#######", ".#####.",
    "#.....#", "##...##", "#######", "#######", "#######", "#######", ".#####.");
// Alive: a beating heart.
ICON(ICON_HEART, 7, 6, 2,
    ".##.##.", "#######", "#######", ".#####.", "..###..", "...#...",
    ".......", "..#.#..", ".#####.", "..###..", "...#...", ".......");
ICON(ICON_BOLT, 5, 7, 1,
    "...##", "..##.", ".##..", "#####", "..##.", ".##..", "##...");
ICON(ICON_ARROW_DOWN, 5, 6, 1,
    "..#..", "..#..", "#.#.#", ".###.", "..#..", ".....");
ICON(ICON_WARN, 7, 7, 1,
    "...#...", "..#.#..", "..#.#..", ".#.#.#.", ".#...#.", "#..#..#", "#######");
ICON(ICON_PERSON, 5, 7, 1,
    ".###.", ".###.", "..#..", "#####", "..#..", ".#.#.", "#...#");
ICON(ICON_CHIP, 7, 7, 1,
    ".#.#.#.", "#######", ".#...#.", "##.#.##", ".#...#.", "#######", ".#.#.#.");
ICON(ICON_THERMO, 3, 7, 1,
    "###", "#.#", "#.#", "###", "###", "###", "###");
// Full power: a twinkling star.
ICON(ICON_STAR, 7, 7, 2,
    "...#...", "...#...", "..###..", "#######", "..###..", "...#...", "...#...",
    ".......", ".......", "...#...", "..###..", "...#...", ".......", ".......");
ICON(ICON_SMILE, 7, 7, 1,
    ".#####.", "#.....#", "#.#.#.#", "#.....#", "#.#.#.#", "#..#..#", ".#####.");
ICON(ICON_SAD, 7, 7, 1,
    ".#####.", "#.....#", "#.#.#.#", "#.....#", "#..#..#", "#.#.#.#", ".#####.");
ICON(ICON_NOTE, 6, 6, 1,
    "..####", "..#..#", "..#..#", "######", "##.##.", "......");
// On air: the mast radiating, three frames.
ICON(ICON_ANTENNA, 7, 7, 3,
    ".......", ".......", "...#...", "...#...", "..#.#..", "..#.#..", ".#...#.",
    ".......", "..#.#..", ".#.#.#.", "...#...", "..#.#..", "..#.#..", ".#...#.",
    "#.....#", ".#...#.", "#..#..#", "...#...", "..#.#..", "..#.#..", ".#...#.");
ICON(ICON_UPLOAD, 7, 7, 1,
    "...#...", "..###..", ".#.#.#.", "...#...", "...#...", "#.....#", "#######");
