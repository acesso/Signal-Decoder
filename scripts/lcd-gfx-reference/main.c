// Draws a scene file with the firmware's own lcd_gfx.c and writes the frames,
// the reference src/lib/lcd/__tests__/gfx.test.ts holds the web app's copy
// (src/lib/lcd/gfx.ts) to. Rerun after changing lcd_gfx.c (npm run lcd:reference).
//
// Scene file, one command a line ('#' starts a comment); c is 0 off, 1 on, 2 xor;
// text runs to the end of the line:
//   clear | invert | frame (writes the frame so far)
//   px x y c | hline x0 x1 y c | vline x y0 y1 c | line x0 y0 x1 y1 c
//   fill x y w h c | rect x y w h c | round x y w h r c | fillround x y w h r c
//   dither x y w h phase
//   tiny|small|big x y c text        tinyw|smallw|bigw x y text (a line as long as the text's width)
//   icon x y NAME frame c | iconk x y NAME frame k
//   pill x y filled text | segbar x y w h frac | bar x y w h frac | box x y w h
#include <stdio.h>
#include <string.h>
#include "lcd_gfx.h"

static const struct { const char *name; const gfx_icon_t *icon; } ICONS[] = {
    {"CAT", &ICON_CAT}, {"HEART", &ICON_HEART}, {"BOLT", &ICON_BOLT}, {"ARROW_DOWN", &ICON_ARROW_DOWN},
    {"WARN", &ICON_WARN}, {"PERSON", &ICON_PERSON}, {"CHIP", &ICON_CHIP}, {"THERMO", &ICON_THERMO},
    {"STAR", &ICON_STAR}, {"SMILE", &ICON_SMILE}, {"SAD", &ICON_SAD}, {"NOTE", &ICON_NOTE},
    {"ANTENNA", &ICON_ANTENNA}, {"UPLOAD", &ICON_UPLOAD},
};

static const gfx_icon_t *icon_named(const char *n) {
    for (size_t i = 0; i < sizeof(ICONS) / sizeof(ICONS[0]); i++) if (strcmp(ICONS[i].name, n) == 0) return ICONS[i].icon;
    fprintf(stderr, "unknown icon %s\n", n);
    return &ICON_CAT;
}

// The text after the first n fields.
static const char *rest(const char *line, int n) {
    const char *p = line;
    for (int i = 0; i < n; i++) {
        while (*p == ' ') p++;
        while (*p && *p != ' ') p++;
    }
    if (*p == ' ') p++;
    return p;
}

int main(int argc, char **argv) {
    if (argc != 3) { fprintf(stderr, "usage: %s scene.txt out.bin\n", argv[0]); return 2; }
    FILE *in = fopen(argv[1], "r"), *out = fopen(argv[2], "wb");
    if (!in || !out || !gfx_init()) { perror("open"); return 1; }
    char line[256], op[16], name[32], *nl;
    int a, b, c, d, e, f, frames = 0;
    float x;
    while (fgets(line, sizeof(line), in)) {
        if ((nl = strchr(line, '\n'))) *nl = 0;
        if (!line[0] || line[0] == '#' || sscanf(line, "%15s", op) != 1) continue;
        if (!strcmp(op, "clear")) gfx_clear();
        else if (!strcmp(op, "invert")) gfx_invert();
        else if (!strcmp(op, "frame")) { fwrite(gfx_frame(), 1, LCD_FRAME_BYTES, out); frames++; }
        else if (!strcmp(op, "px") && sscanf(line, "%*s %d %d %d", &a, &b, &c) == 3) gfx_px(a, b, c);
        else if (!strcmp(op, "hline") && sscanf(line, "%*s %d %d %d %d", &a, &b, &c, &d) == 4) gfx_hline(a, b, c, d);
        else if (!strcmp(op, "vline") && sscanf(line, "%*s %d %d %d %d", &a, &b, &c, &d) == 4) gfx_vline(a, b, c, d);
        else if (!strcmp(op, "line") && sscanf(line, "%*s %d %d %d %d %d", &a, &b, &c, &d, &e) == 5) gfx_line(a, b, c, d, e);
        else if (!strcmp(op, "fill") && sscanf(line, "%*s %d %d %d %d %d", &a, &b, &c, &d, &e) == 5) gfx_fill(a, b, c, d, e);
        else if (!strcmp(op, "rect") && sscanf(line, "%*s %d %d %d %d %d", &a, &b, &c, &d, &e) == 5) gfx_rect(a, b, c, d, e);
        else if (!strcmp(op, "round") && sscanf(line, "%*s %d %d %d %d %d %d", &a, &b, &c, &d, &e, &f) == 6) gfx_round_rect(a, b, c, d, e, f);
        else if (!strcmp(op, "fillround") && sscanf(line, "%*s %d %d %d %d %d %d", &a, &b, &c, &d, &e, &f) == 6) gfx_fill_round(a, b, c, d, e, f);
        else if (!strcmp(op, "dither") && sscanf(line, "%*s %d %d %d %d %d", &a, &b, &c, &d, &e) == 5) gfx_dither(a, b, c, d, e);
        else if (!strcmp(op, "tiny") && sscanf(line, "%*s %d %d %d", &a, &b, &c) == 3) gfx_tiny(a, b, rest(line, 4), c);
        else if (!strcmp(op, "small") && sscanf(line, "%*s %d %d %d", &a, &b, &c) == 3) gfx_small(a, b, rest(line, 4), c);
        else if (!strcmp(op, "big") && sscanf(line, "%*s %d %d %d", &a, &b, &c) == 3) gfx_big(a, b, rest(line, 4), c);
        else if (!strcmp(op, "tinyw") && sscanf(line, "%*s %d %d", &a, &b) == 2) gfx_hline(a, a + gfx_tiny_width(rest(line, 3)) - 1, b, GFX_ON);
        else if (!strcmp(op, "smallw") && sscanf(line, "%*s %d %d", &a, &b) == 2) gfx_hline(a, a + gfx_small_width(rest(line, 3)) - 1, b, GFX_ON);
        else if (!strcmp(op, "bigw") && sscanf(line, "%*s %d %d", &a, &b) == 2) gfx_hline(a, a + gfx_big_width(rest(line, 3)) - 1, b, GFX_ON);
        else if (!strcmp(op, "icon") && sscanf(line, "%*s %d %d %31s %d %d", &a, &b, name, &c, &d) == 5) gfx_icon(a, b, icon_named(name), c, d);
        else if (!strcmp(op, "iconk") && sscanf(line, "%*s %d %d %31s %d %d", &a, &b, name, &c, &d) == 5) gfx_icon_scaled(a, b, icon_named(name), c, d);
        else if (!strcmp(op, "pill") && sscanf(line, "%*s %d %d %d", &a, &b, &c) == 3) gfx_pill(a, b, rest(line, 4), c);
        else if (!strcmp(op, "segbar") && sscanf(line, "%*s %d %d %d %d %f", &a, &b, &c, &d, &x) == 5) gfx_seg_bar(a, b, c, d, x);
        else if (!strcmp(op, "bar") && sscanf(line, "%*s %d %d %d %d %f", &a, &b, &c, &d, &x) == 5) gfx_bar(a, b, c, d, x);
        else if (!strcmp(op, "box") && sscanf(line, "%*s %d %d %d %d", &a, &b, &c, &d) == 4) gfx_box(a, b, c, d);
        else { fprintf(stderr, "bad line: %s\n", line); return 1; }
    }
    fclose(out);
    printf("%d frames\n", frames);
    return 0;
}
