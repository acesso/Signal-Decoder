// Status LCD views — see status_display.h.
//
// One low-priority task on core 0 samples the bridge's state, draws the view
// and any overlay into lcd_gfx's frame buffer, and sends it (about 1 ms) five
// times a second. A copy of each frame is kept for GET /display/frame.
//
// The look: a rounded title bar with page dots on every view, rounded panels
// and bars, 50 % dither as the grey, segmented meters, and small pixel icons
// that move (a cat for the radio link that blinks, or sleeps when the radio
// is quiet; a beating heart; a radiating mast on air). A view change slides
// the content across, like a phone's home screens.
#include "status_display.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver/temperature_sensor.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "audio_monitor.h"
#include "bridge_config.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "cat_bridge.h"
#include "iq_dsp.h"
#include "lcd_gfx.h"
#include "lcd_pcd8544.h"
#include "wifi_net.h"
#include "ws_fanout.h"

static const char *TAG = "display";

#define TICK_MS          200      // 5 frames a second
#define TASK_PRIO        2        // below httpd and the network stack
#define TASK_CORE        0        // the DSP has core 1 to itself
#define SPLASH_TICKS     12
#define LAST_TX_TICKS    30       // the Last TX overlay, after key-up
#define TX_RETURN_TICKS  10       // after key-up, 2 s on the TX view before going back
#define BODY_TIMEOUTS    3        // receive timeouts allowed while reading a request body
#define PROGRESS_HOLD_US (4 * 1000000)
#define RADIO_QUIET_US   (10 * 1000000)  // the cat falls asleep

// ── Settings (saved as one record) ─────────────────────────────────────────

typedef enum { VIEW_RADIO = 0, VIEW_SPECTRUM, VIEW_LEVELS, VIEW_TX, VIEW_SYSTEM, VIEW_NETWORK, VIEW_COUNT } view_t;
static const char *const VIEW_NAMES[VIEW_COUNT] = { "radio", "spectrum", "levels", "tx", "system", "network" };
static const char *const VIEW_TITLES[VIEW_COUNT] = { "RADIO", "SPECTRUM", "LEVELS", "TX", "SYSTEM", "NETWORK" };

#define CFG_KEY     "display_cfg"
#define CFG_VERSION 1
typedef struct __attribute__((packed)) {
    uint8_t version, view, cycle, dwell_s, vop, bias, backlight, invert;
} display_cfg_t;

static display_cfg_t s_cfg = { CFG_VERSION, VIEW_RADIO, 0, 8, 50, 4, 60, 0 };
static portMUX_TYPE s_cfg_lock = portMUX_INITIALIZER_UNLOCKED;
static volatile bool s_cfg_dirty = true;  // the task applies contrast/backlight
static volatile bool s_next_req;
static volatile int s_view_req = -1;  // a view picked on the page, shown at once
static bool s_lcd_ok;

static display_cfg_t cfg_get(void) {
    portENTER_CRITICAL(&s_cfg_lock);
    display_cfg_t c = s_cfg;
    portEXIT_CRITICAL(&s_cfg_lock);
    return c;
}

// ── Client views (drawn by a web app or another tool) ──────────────────────
//
// A client sends the body of its view: banks 1..5 of the frame (rows 8..47,
// CLIENT_BODY bytes). Row 8 lies under the title bar, which the bridge draws
// with the view's title and the page dots. Client views are numbered after
// the built-in ones (VIEW_COUNT + slot) and follow them in the page order.

#define CLIENT_SLOTS   4
#define CLIENT_BODY    (LCD_FRAME_BYTES - LCD_W)
#define CLIENT_TTL_US  (10 * 1000000)   // no frame for this long: out of the list
#define CLIENT_FD_HTTP (-1)             // registered by POST /display/client
#define CLIENT_ID_LEN  24
#define CLIENT_TITLE_LEN 16
#define MAX_VIEWS      (VIEW_COUNT + CLIENT_SLOTS)

typedef struct {
    bool used, focus_on_tx;
    int fd;              // the socket that registered it, or CLIENT_FD_HTTP
    int64_t at_us;       // the last frame, 0 = none yet
    int64_t seen_us;     // the last frame or registration
    char id[CLIENT_ID_LEN], title[CLIENT_TITLE_LEN];
    uint8_t *body;       // PSRAM, CLIENT_BODY
} client_view_t;

static client_view_t s_cv[CLIENT_SLOTS];
static portMUX_TYPE s_cv_lock = portMUX_INITIALIZER_UNLOCKED;

static bool cv_live_locked(int slot, int64_t now) {
    const client_view_t *c = &s_cv[slot];
    return c->used && c->at_us && now - c->at_us < CLIENT_TTL_US;
}

static bool view_live(int v) {
    if (v >= 0 && v < VIEW_COUNT) return true;
    if (v < VIEW_COUNT || v >= MAX_VIEWS) return false;
    portENTER_CRITICAL(&s_cv_lock);
    bool live = cv_live_locked(v - VIEW_COUNT, esp_timer_get_time());
    portEXIT_CRITICAL(&s_cv_lock);
    return live;
}

// The views in page order: the built-in ones, then the live client views.
static int view_list(int *out) {
    int n = 0;
    for (int v = 0; v < VIEW_COUNT; v++) out[n++] = v;
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_cv_lock);
    for (int s = 0; s < CLIENT_SLOTS; s++) if (cv_live_locked(s, now)) out[n++] = VIEW_COUNT + s;
    portEXIT_CRITICAL(&s_cv_lock);
    return n;
}

static int view_pos(const int *list, int n, int v) {
    for (int i = 0; i < n; i++) if (list[i] == v) return i;
    return -1;
}

// The view's name for the API: a built-in name, a client view's id, or "overlay".
static void view_name(int v, char *out, size_t cap) {
    if (v < 0 || v >= MAX_VIEWS) { strlcpy(out, "overlay", cap); return; }
    if (v < VIEW_COUNT) { strlcpy(out, VIEW_NAMES[v], cap); return; }
    portENTER_CRITICAL(&s_cv_lock);
    strlcpy(out, s_cv[v - VIEW_COUNT].id, cap);
    portEXIT_CRITICAL(&s_cv_lock);
}

// A built-in name or a live client view's id, as a view number; -1 if none.
static int view_by_name(const char *name, size_t len) {
    for (int v = 0; v < VIEW_COUNT; v++)
        if (strlen(VIEW_NAMES[v]) == len && strncmp(name, VIEW_NAMES[v], len) == 0) return v;
    int found = -1;
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_cv_lock);
    for (int s = 0; s < CLIENT_SLOTS && found < 0; s++)
        if (cv_live_locked(s, now) && strlen(s_cv[s].id) == len && strncmp(name, s_cv[s].id, len) == 0) found = VIEW_COUNT + s;
    portEXIT_CRITICAL(&s_cv_lock);
    return found;
}

// Registers a client view and returns its slot, or -1 when all are taken. The
// same id takes over the earlier registration, so a reloaded page or a second
// tab replaces its view instead of adding one. A slot quiet for CLIENT_TTL_US
// is reused.
static int cv_register(const char *id, const char *title, bool focus_on_tx, int fd) {
    int64_t now = esp_timer_get_time();
    int slot = -1;
    bool same = false;
    portENTER_CRITICAL(&s_cv_lock);
    for (int s = 0; s < CLIENT_SLOTS && slot < 0; s++)
        if (s_cv[s].used && strcmp(s_cv[s].id, id) == 0) { slot = s; same = true; }
    for (int s = 0; s < CLIENT_SLOTS && slot < 0; s++) if (!s_cv[s].used) slot = s;
    for (int s = 0; s < CLIENT_SLOTS && slot < 0; s++) if (now - s_cv[s].seen_us >= CLIENT_TTL_US) slot = s;
    if (slot >= 0) {
        client_view_t *c = &s_cv[slot];
        if (!same) {
            c->at_us = 0;
            memset(c->body, 0, CLIENT_BODY);
            strlcpy(c->id, id, sizeof(c->id));
        }
        c->used = true;
        c->fd = fd;
        c->focus_on_tx = focus_on_tx;
        c->seen_us = now;
        strlcpy(c->title, title, sizeof(c->title));
    }
    portEXIT_CRITICAL(&s_cv_lock);
    return slot;
}

// A new body for a slot, accepted only from whoever registered it.
static bool cv_frame(int slot, int fd, const uint8_t *body) {
    if (slot < 0 || slot >= CLIENT_SLOTS) return false;
    portENTER_CRITICAL(&s_cv_lock);
    client_view_t *c = &s_cv[slot];
    bool ok = c->used && c->fd == fd;
    if (ok) {
        memcpy(c->body, body, CLIENT_BODY);
        c->at_us = c->seen_us = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&s_cv_lock);
    return ok;
}

// Removes the views a socket registered (all of them when id is NULL).
static void cv_drop(int fd, const char *id) {
    portENTER_CRITICAL(&s_cv_lock);
    for (int s = 0; s < CLIENT_SLOTS; s++)
        if (s_cv[s].used && s_cv[s].fd == fd && (!id || strcmp(s_cv[s].id, id) == 0)) s_cv[s].used = false;
    portEXIT_CRITICAL(&s_cv_lock);
}

// ── Client overlay ───────────────────────────────────────────────────────────
//
// A client's picture laid over whatever view is on the glass, inside the same
// rounded panel as the bridge's own overlays (OVL_X/Y/W/H): a QSO completing,
// say. Sent on /display-ws as [CLIENT_OVERLAY_SLOT][CLIENT_BODY bytes], in the
// body layout of a client view; only the panel's pixels are used. It lasts
// while frames keep coming, and CLIENT_OVERLAY_HOLD_US after the last.

#define CLIENT_OVERLAY_SLOT    0xFF
#define CLIENT_OVERLAY_HOLD_US (1500 * 1000)
#define OVL_X 1
#define OVL_Y 10
#define OVL_W (LCD_W - 2)
#define OVL_H 37

static uint8_t *s_ovl;           // PSRAM, CLIENT_BODY
static int64_t s_ovl_at_us;      // the last overlay frame, 0 = none

static void ovl_frame(const uint8_t *body) {
    portENTER_CRITICAL(&s_cv_lock);
    memcpy(s_ovl, body, CLIENT_BODY);
    s_ovl_at_us = esp_timer_get_time();
    portEXIT_CRITICAL(&s_cv_lock);
}

static bool ovl_active(int64_t now) {
    portENTER_CRITICAL(&s_cv_lock);
    bool on = s_ovl_at_us && now - s_ovl_at_us < CLIENT_OVERLAY_HOLD_US;
    portEXIT_CRITICAL(&s_cv_lock);
    return on;
}

// Copies the overlay's pixels inside the rounded panel (corner radius 3, as
// gfx_box draws it) over the frame.
static void ovl_draw(void) {
    static const uint8_t INSET[3] = { 3, 1, 1 };
    uint8_t ovl[CLIENT_BODY];
    portENTER_CRITICAL(&s_cv_lock);
    memcpy(ovl, s_ovl, CLIENT_BODY);
    portEXIT_CRITICAL(&s_cv_lock);
    for (int j = 0; j < OVL_H; j++) {
        int y = OVL_Y + j, in = j < 3 ? INSET[j] : OVL_H - 1 - j < 3 ? INSET[OVL_H - 1 - j] : 0;
        for (int x = OVL_X + in; x <= OVL_X + OVL_W - 1 - in; x++) {
            bool on = ovl[((y >> 3) - 1) * LCD_W + x] & (1 << (y & 7));
            gfx_px(x, y, on ? GFX_ON : GFX_OFF);
        }
    }
}

// ── Events (POST /display/event) ─────────────────────────────────────────────
//
// A short text announcement any client can send, drawn by the bridge in its
// overlay panel: a title in a pill with an icon each side, up to 3 lines.
// Queued (EVENT_QUEUE), each shown for its own seconds.

#define EVENT_QUEUE      4
#define EVENT_LINES      3
#define EVENT_LINE_LEN   22
#define EVENT_TITLE_LEN  16

#define ICON_MAX_SIDE    11

typedef struct {
    char title[EVENT_TITLE_LEN];
    char lines[EVENT_LINES][EVENT_LINE_LEN];
    int nlines, seconds;
    const gfx_icon_t *icon;   // a built-in or library icon; NULL: none (or the custom one)
    uint8_t cw, ch;           // a client's own static icon (icon_rows), 0 x 0: none
    char custom[ICON_MAX_SIDE][ICON_MAX_SIDE + 1];
} display_event_t;

static display_event_t s_evq[EVENT_QUEUE];
static int s_ev_n;              // queued, s_evq[0] first
static int64_t s_ev_until;      // the head's end, 0 = not started

// ── The icon library (spiffs_data/lcd_icons.txt) ─────────────────────────────
//
// More animated icons for events, read from the storage partition at boot and
// after a page upload, kept in PSRAM: a line "<name> <w> <h> <frames>", then
// the rows frame after frame ('#' lit). Up to ICON_MAX_SIDE square, LIB_MAX_FRAMES.

#define LIB_PATH       "/spiffs/lcd_icons.txt"
#define LIB_MAX        48
#define LIB_MAX_FRAMES 8
#define LIB_NAME_LEN   16

typedef struct {
    char name[LIB_NAME_LEN];
    gfx_icon_t icon;
} lib_icon_t;

static lib_icon_t *s_lib;     // PSRAM, LIB_MAX
static int s_lib_n;
static SemaphoreHandle_t s_lib_mutex;

// The next non-blank line, without its end. Comments ('#' first) are skipped
// by the caller, and only where a header is due: a row may start with '#'.
static bool lib_line(FILE *f, char *buf, size_t cap) {
    while (fgets(buf, (int)cap, f)) {
        buf[strcspn(buf, "\r\n")] = 0;
        if (buf[0]) return true;
    }
    return false;
}

void status_display_reload_icons(void) {
    if (!s_lib_mutex) return;
    xSemaphoreTake(s_lib_mutex, portMAX_DELAY);
    portENTER_CRITICAL(&s_cv_lock);  // queued events may point into the old library
    s_ev_n = 0;
    s_ev_until = 0;
    portEXIT_CRITICAL(&s_cv_lock);
    for (int i = 0; i < s_lib_n; i++) heap_caps_free((void *)s_lib[i].icon.rows);
    s_lib_n = 0;
    FILE *f = fopen(LIB_PATH, "r");
    if (!f) {
        xSemaphoreGive(s_lib_mutex);
        ESP_LOGW(TAG, "no %s: events have only the built-in icons", LIB_PATH);
        return;
    }
    char line[160], name[LIB_NAME_LEN];
    int w, h, frames;
    while (s_lib_n < LIB_MAX && lib_line(f, line, sizeof(line))) {
        if (line[0] == '#') continue;
        if (sscanf(line, "%15s %d %d %d", name, &w, &h, &frames) != 4 || w < 1 || h < 1 || w > ICON_MAX_SIDE ||
            h > ICON_MAX_SIDE || frames < 1 || frames > LIB_MAX_FRAMES) {
            ESP_LOGW(TAG, "%s: bad icon header \"%s\"", LIB_PATH, line);
            break;
        }
        int nrows = h * frames;
        // One block: the row pointers, then the rows.
        char **rows = heap_caps_malloc(nrows * sizeof(char *) + (size_t)nrows * (w + 1), MALLOC_CAP_SPIRAM);
        if (!rows) break;
        char *text = (char *)(rows + nrows);
        bool ok = true;
        for (int r = 0; r < nrows && ok; r++) {
            ok = lib_line(f, line, sizeof(line)) && (int)strlen(line) == w && strspn(line, ".#") == (size_t)w;
            if (ok) { rows[r] = text + r * (w + 1); memcpy(rows[r], line, (size_t)w + 1); }
        }
        if (!ok) {
            heap_caps_free(rows);
            ESP_LOGW(TAG, "%s: icon \"%s\" has a bad row", LIB_PATH, name);
            break;
        }
        lib_icon_t *li = &s_lib[s_lib_n++];
        strlcpy(li->name, name, sizeof(li->name));
        li->icon = (gfx_icon_t){ .w = (uint8_t)w, .h = (uint8_t)h, .frames = (uint8_t)frames, .rows = (const char *const *)rows };
    }
    fclose(f);
    xSemaphoreGive(s_lib_mutex);
    ESP_LOGI(TAG, "%d icons from %s", s_lib_n, LIB_PATH);
}

// A library icon by name (the library is only replaced under the mutex, and
// an event keeps its pointer only while queued: a reload clears the queue).
static const gfx_icon_t *lib_find(const char *name) {
    const gfx_icon_t *ic = NULL;
    xSemaphoreTake(s_lib_mutex, portMAX_DELAY);
    for (int i = 0; i < s_lib_n && !ic; i++) if (strcmp(s_lib[i].name, name) == 0) ic = &s_lib[i].icon;
    xSemaphoreGive(s_lib_mutex);
    return ic;
}


static const struct { const char *name; const gfx_icon_t *icon; } EVENT_ICONS[] = {
    { "star", &ICON_STAR }, { "heart", &ICON_HEART }, { "bolt", &ICON_BOLT }, { "warn", &ICON_WARN },
    { "note", &ICON_NOTE }, { "antenna", &ICON_ANTENNA }, { "upload", &ICON_UPLOAD }, { "smile", &ICON_SMILE },
    { "sad", &ICON_SAD }, { "cat", &ICON_CAT }, { "chip", &ICON_CHIP }, { "thermo", &ICON_THERMO },
    { "person", &ICON_PERSON }, { "arrow", &ICON_ARROW_DOWN },
};

// Queues an event; false when the queue is full.
static bool event_push(const display_event_t *e) {
    portENTER_CRITICAL(&s_cv_lock);
    bool ok = s_ev_n < EVENT_QUEUE;
    if (ok) s_evq[s_ev_n++] = *e;
    portEXIT_CRITICAL(&s_cv_lock);
    return ok;
}

// The event to draw now (copied into e), starting and retiring them in turn.
static bool event_current(int64_t now, display_event_t *e) {
    bool on = false;
    portENTER_CRITICAL(&s_cv_lock);
    if (s_ev_n && s_ev_until && now >= s_ev_until) {
        memmove(&s_evq[0], &s_evq[1], (size_t)(s_ev_n - 1) * sizeof(s_evq[0]));
        s_ev_n--;
        s_ev_until = 0;
    }
    if (s_ev_n) {
        if (!s_ev_until) s_ev_until = now + (int64_t)s_evq[0].seconds * 1000000;
        *e = s_evq[0];
        on = true;
    }
    portEXIT_CRITICAL(&s_cv_lock);
    return on;
}

static void event_draw(const display_event_t *e, uint32_t tick) {
    gfx_box(OVL_X, OVL_Y, OVL_W, OVL_H);
    int pw = gfx_tiny_width(e->title) + 6;
    gfx_pill(OVL_X + (OVL_W - pw) / 2, OVL_Y + 3, e->title, true);
    gfx_icon_t custom;
    const char *rows[ICON_MAX_SIDE];
    const gfx_icon_t *ic = e->icon;
    if (!ic && e->cw) {
        for (int i = 0; i < e->ch; i++) rows[i] = e->custom[i];
        custom = (gfx_icon_t){ .w = e->cw, .h = e->ch, .frames = 1, .rows = rows };
        ic = &custom;
    }
    if (ic) {  // each side of the pill, centred on it; the right one a frame ahead
        int y = OVL_Y + 6 - ic->h / 2;
        gfx_icon(OVL_X + 4, y, ic, (int)(tick / 2), GFX_ON);
        gfx_icon(OVL_X + OVL_W - 4 - ic->w, y, ic, (int)(tick / 2) + 1, GFX_ON);
    }
    int y = OVL_Y + 12;
    for (int i = 0; i < e->nlines; i++) {
        const char *l = e->lines[i];
        if (i == 0 && gfx_small_width(l) <= OVL_W - 10) {  // the first line large when it fits
            gfx_small(OVL_X + (OVL_W - gfx_small_width(l)) / 2, y, l, GFX_ON);
            y += 9;
        } else {
            char fit[EVENT_LINE_LEN];
            strlcpy(fit, l, sizeof(fit));
            for (size_t n = strlen(fit); n && gfx_tiny_width(fit) > OVL_W - 10;) fit[--n] = 0;  // inside the double border
            gfx_tiny(OVL_X + (OVL_W - gfx_tiny_width(fit)) / 2, y + 1, fit, GFX_ON);
            y += 7;
        }
    }
}

// The live client view that asked to be shown while transmitting, or -1.
static int cv_focus_view(void) {
    int v = -1;
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_cv_lock);
    for (int s = 0; s < CLIENT_SLOTS && v < 0; s++) if (cv_live_locked(s, now) && s_cv[s].focus_on_tx) v = VIEW_COUNT + s;
    portEXIT_CRITICAL(&s_cv_lock);
    return v;
}

// ── What the radio says, snooped from the CAT traffic ─────────────────────

typedef struct {
    char mode;          // MD digit, 0 = unknown
    bool ptt, diag;
    int drive;          // DR, -1 = unknown
    bool has_ta, ta_live;
    int mic, env, clip, env_avg, gated;
    int64_t ta_at_us;
} radio_t;

static radio_t s_radio = { .drive = -1 };
static portMUX_TYPE s_radio_lock = portMUX_INITIALIZER_UNLOCKED;

static bool parse_digits(const char *f, size_t len, size_t from, int *out) {
    if (from >= len) return false;
    int v = 0;
    for (size_t i = from; i < len; i++) {
        if (f[i] < '0' || f[i] > '9') return false;
        v = v * 10 + (f[i] - '0');
    }
    *out = v;
    return true;
}

// TA<mic>,<env>,<clip %>,<env avg>,<gated %>
static bool parse_ta(const char *f, size_t len, int v[5]) {
    size_t i = 2;
    for (int k = 0; k < 5; k++) {
        if (i >= len || f[i] < '0' || f[i] > '9') return false;
        int x = 0;
        while (i < len && f[i] >= '0' && f[i] <= '9') x = x * 10 + (f[i++] - '0');
        v[k] = x;
        if (k < 4) { if (i >= len || f[i] != ',') return false; i++; }
    }
    return i == len;
}

// Runs in the CAT reader's (or a writer's) context: parse and leave.
static void on_cat_frame(bool from_radio, const char *f, size_t len) {
    if (len < 2) return;
    int v[5], x;
    portENTER_CRITICAL(&s_radio_lock);
    if (f[0] == 'M' && f[1] == 'D' && len == 3 && f[2] >= '0' && f[2] <= '9') s_radio.mode = f[2];
    // Keying is the app's TX (TX, TX0..TX2); the radio's own "TX" frames are
    // echoes around key-up, so only the client's count. Any RX un-keys.
    else if (f[0] == 'T' && f[1] == 'X' && !from_radio) s_radio.ptt = true;
    else if (f[0] == 'R' && f[1] == 'X') s_radio.ptt = false;
    else if (f[0] == 'D' && f[1] == 'G' && parse_digits(f, len, 2, &x)) s_radio.diag = x >= 1;
    else if (f[0] == 'D' && f[1] == 'R' && parse_digits(f, len, 2, &x)) s_radio.drive = x;
    else if (f[0] == 'T' && f[1] == 'A' && from_radio && parse_ta(f, len, v)) {
        s_radio.has_ta = true;
        s_radio.ta_live = s_radio.ptt;
        s_radio.mic = v[0]; s_radio.env = v[1]; s_radio.clip = v[2]; s_radio.env_avg = v[3]; s_radio.gated = v[4];
        s_radio.ta_at_us = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&s_radio_lock);
}

static radio_t radio_get(void) {
    portENTER_CRITICAL(&s_radio_lock);
    radio_t r = s_radio;
    portEXIT_CRITICAL(&s_radio_lock);
    return r;
}

static const char *mode_name(char d) {
    switch (d) {
        case '1': return "LSB"; case '2': return "USB"; case '3': return "CW"; case '4': return "FM";
        case '5': return "AM"; case '6': return "RTTY"; case '7': return "CW-R"; case '9': return "RTTY-R";
        default: return "---";
    }
}

// The same judgement as the web app's Last TX chip (src/lib/cat/txReport.ts),
// for a constant-envelope digital mode.
typedef enum { TX_OK = 0, TX_WARN, TX_BAD } tx_level_t;
#define TX_MIC_RAIL 480

static tx_level_t tx_assess(const radio_t *r, char *summary, size_t cap, int *mic_pct) {
    *mic_pct = r->mic * 100 / TX_MIC_RAIL;
    int drive = r->drive < 0 ? 2 : r->drive > 8 ? 8 : r->drive;
    int full_env = 255 >> drive;
    if (r->mic >= TX_MIC_RAIL - 10) { snprintf(summary, cap, "MIC CLIPPING"); return TX_BAD; }
    if (r->gated > 0) { snprintf(summary, cap, "CARRIER OFF %d%%", r->gated); return TX_WARN; }
    if (r->env < full_env) { snprintf(summary, cap, "BELOW FULL PWR"); return TX_WARN; }
    if (r->clip < 90) { snprintf(summary, cap, "FULL PWR %d%%", r->clip); return TX_WARN; }
    if (*mic_pct > 80) { snprintf(summary, cap, "NEAR CLIPPING"); return TX_WARN; }
    snprintf(summary, cap, "FULL POWER");
    return TX_OK;
}

// ── Uploads ────────────────────────────────────────────────────────────────

static const char *volatile s_prog_what;
static volatile int s_prog_pct;
static volatile int64_t s_prog_at;

void status_display_progress(const char *what, int pct) {
    s_prog_what = what;
    s_prog_pct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
    s_prog_at = esp_timer_get_time();
}

// ── Sampled state (task only) ──────────────────────────────────────────────

#define HIST 80
#define SPEC_COLS 82

static uint32_t s_tick;
static bridge_state_t s_st;
static radio_t s_r;
static float s_lvl[AUDIO_PEAK_COUNT], s_hold[AUDIO_PEAK_COUNT];  // dBFS
static int s_hold_t[AUDIO_PEAK_COUNT], s_clip_t[AUDIO_PEAK_COUNT];
static float s_spec[SPEC_COLS], s_spec_floor = -120;
static int s_spec_top[SPEC_COLS];
static int s_spec_fs;
static int32_t s_spec_center;
static uint8_t s_rssi_hist[HIST];
static int s_hist_n;
static int s_cpu_now[2];
static int8_t s_rssi = -127;
static bool s_rssi_ok;
static float s_temp_c = NAN;
static uint32_t s_ram_free, s_ram_total, s_ps_free, s_ps_total;
static audio_monitor_tx_status_t s_tx;
static int s_last_tx_ticks;   // > 0 while the Last TX overlay shows
static int64_t s_last_ta_seen;
static temperature_sensor_handle_t s_tsens;

static void push_hist(uint8_t *h, uint8_t v) {
    if (s_hist_n < HIST) { h[s_hist_n] = v; return; }
    memmove(h, h + 1, HIST - 1);
    h[HIST - 1] = v;
}

static void sample_levels(void) {
    float pk[AUDIO_PEAK_COUNT];
    audio_monitor_take_peaks(pk);
    for (int c = 0; c < AUDIO_PEAK_COUNT; c++) {
        float db = pk[c] > 1e-5f ? 20.0f * log10f(pk[c]) : -100;
        s_lvl[c] = db > s_lvl[c] - 3 ? db : s_lvl[c] - 3;  // fast up, 15 dB/s down
        if (db >= s_hold[c]) { s_hold[c] = db; s_hold_t[c] = 10; }
        else if (s_hold_t[c] > 0) s_hold_t[c]--;
        else s_hold[c] -= 2;
        if (pk[c] >= 0.98f) s_clip_t[c] = 10;
        else if (s_clip_t[c] > 0) s_clip_t[c]--;
    }
}

static int cmp_float(const void *a, const void *b) { float x = *(const float *)a, y = *(const float *)b; return (x > y) - (x < y); }

static void sample_spectrum(void) {
    s_spec_fs = iq_dsp_overview(s_spec, SPEC_COLS, &s_spec_center);
    if (!s_spec_fs) return;
    float sorted[SPEC_COLS];
    memcpy(sorted, s_spec, sizeof(sorted));
    qsort(sorted, SPEC_COLS, sizeof(float), cmp_float);
    s_spec_floor += 0.25f * ((sorted[SPEC_COLS / 5] - 4) - s_spec_floor);  // the noise, a little below
}

static void sample_slow(void) {
    static uint32_t prev_t, prev_idle[2];
    uint32_t now = (uint32_t)esp_timer_get_time();
    for (int core = 0; core < 2; core++) {
        uint32_t idle = ulTaskGetIdleRunTimeCounterForCore(core);
        if (prev_t && now != prev_t) {
            int load = 100 - (int)((uint64_t)(idle - prev_idle[core]) * 100 / (now - prev_t));
            s_cpu_now[core] = load < 0 ? 0 : load > 100 ? 100 : load;
        }
        prev_idle[core] = idle;
    }
    prev_t = now;
    s_rssi_ok = wifi_net_get_live_rssi(&s_rssi);
    push_hist(s_rssi_hist, s_rssi_ok ? (uint8_t)(s_rssi + 128) : 0);
    if (s_hist_n < HIST) s_hist_n++;
    s_ram_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    s_ram_total = heap_caps_get_total_size(MALLOC_CAP_INTERNAL);
    s_ps_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    s_ps_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    float t;
    if (s_tsens && temperature_sensor_get_celsius(s_tsens, &t) == ESP_OK) s_temp_c = t;
}

// ── Shared pieces of the look ──────────────────────────────────────────────

static int s_page_count = VIEW_COUNT;   // the dots: built-in views plus live client views

static void header(const char *title, int page) {
    gfx_fill_round(0, 0, LCD_W, 9, 2, GFX_ON);
    int first_dot = LCD_W - 5 - (s_page_count - 1) * 4;
    char t[CLIENT_TITLE_LEN];
    strlcpy(t, title, sizeof(t));
    for (size_t n = strlen(t); n && 4 + gfx_tiny_width(t) > first_dot - 4;) t[--n] = 0;  // keep clear of the dots
    gfx_tiny(4, 2, t, GFX_OFF);
    for (int v = 0; v < s_page_count; v++) {
        int cx = LCD_W - 5 - (s_page_count - 1 - v) * 4;
        if (v == page) gfx_fill(cx - 1, 3, 3, 3, GFX_OFF);
        else gfx_px(cx, 4, GFX_OFF);
    }
}

// A client view: its body under the title bar.
static void view_client(int slot, int page) {
    char title[CLIENT_TITLE_LEN];
    uint8_t *f = gfx_frame();
    portENTER_CRITICAL(&s_cv_lock);
    memcpy(f + LCD_W, s_cv[slot].body, CLIENT_BODY);
    strlcpy(title, s_cv[slot].title, sizeof(title));
    portEXIT_CRITICAL(&s_cv_lock);
    for (int x = 0; x < LCD_W; x++) f[LCD_W + x] &= (uint8_t)~1u;  // row 8 belongs to the title bar
    header(title, page);
}

// History as a line with a dithered fill under it; v 0..255 mapped lo..hi.
static void sparkline(int x, int y, int w, int h, const uint8_t *hist, int n, int lo, int hi) {
    gfx_round_rect(x, y, w, h, 2, GFX_ON);
    int cols = w - 4, start = n > cols ? n - cols : 0, prev_y = -1;
    for (int i = start; i < n; i++) {
        int cx = x + 2 + (i - start) + (cols - (n - start));
        int v = hist[i] < lo ? lo : hist[i] > hi ? hi : hist[i];
        int py = y + h - 3 - (v - lo) * (h - 5) / (hi - lo ? hi - lo : 1);
        for (int yy = py + 1; yy <= y + h - 3; yy++) if (((cx + yy) & 1) == 0) gfx_px(cx, yy, GFX_ON);
        if (prev_y >= 0) gfx_line(cx - 1, prev_y, cx, py, GFX_ON);
        else gfx_px(cx, py, GFX_ON);
        prev_y = py;
    }
}

static void wifi_bars(int x, int y, int level) {
    for (int b = 0; b < 4; b++) {
        int h = 1 + b * 2;
        if (b < level) gfx_fill(x + b * 2, y + 7 - h, 1, h, GFX_ON);
        else gfx_px(x + b * 2, y + 6, GFX_ON);
    }
}

static int rssi_level(int rssi) { return rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : rssi > -85 ? 1 : 0; }

static void fmt_bytes(char *out, size_t cap, uint32_t b) {
    if (b < 10000) snprintf(out, cap, "%u", (unsigned)b);
    else if (b < 10000000) snprintf(out, cap, "%uK", (unsigned)(b / 1000));
    else snprintf(out, cap, "%uM", (unsigned)(b / 1000000));
}

// The radio link: a cat that blinks now and then, or sleeps when the radio
// has been quiet.
static void cat_icon(int x, int y) {
    int64_t now = esp_timer_get_time();
    bool awake = s_st.last_radio_rx_us && now - s_st.last_radio_rx_us < RADIO_QUIET_US;
    if (awake) { gfx_icon(x, y, &ICON_CAT, (s_tick % 17) == 0, GFX_ON); return; }
    gfx_icon(x, y, &ICON_CAT, 1, GFX_ON);
    int z = (s_tick / 3) % 3;
    gfx_tiny(x - 4, y + 2 - z, "Z", GFX_ON);
}

// ── Views ──────────────────────────────────────────────────────────────────

static void view_radio(void) {
    int x = gfx_pill(0, 11, mode_name(s_r.mode), true) + 2;
    if (s_r.ptt) {
        x += gfx_pill(x, 11, "TX", (s_tick / 2) % 2 == 0) + 1;
        gfx_icon(x, 11, &ICON_ANTENNA, s_tick % 3, GFX_ON);
        x += 9;
    } else {
        x += gfx_pill(x, 11, "RX", false) + 1;
        gfx_icon(x, 11 + (s_tick / 2) % 2, &ICON_ARROW_DOWN, 0, GFX_ON);
        x += 7;
    }
    if (s_st.pa_sense) gfx_pill(x, 11, "PA", true);
    cat_icon(77, 11);

    char big[12], small[6];
    uint32_t hz = s_st.last_vfo_hz;
    if (hz) {
        snprintf(big, sizeof(big), "%u.%03u", (unsigned)(hz / 1000000), (unsigned)(hz / 1000 % 1000));
        snprintf(small, sizeof(small), "%03u", (unsigned)(hz % 1000));
    } else {
        snprintf(big, sizeof(big), "-.---");
        snprintf(small, sizeof(small), "---");
    }
    int bw = gfx_big_width(big), sw = gfx_tiny_width(small), x0 = (LCD_W - bw - sw - 2) / 2;
    gfx_big(x0, 21, big, GFX_ON);
    gfx_tiny(x0 + bw + 2, 30, small, GFX_ON);

    // S-meter: nine rising bars to S9, three taller dithered ones over it.
    const int base = 46;
    int lit = 0;
    char label[10];
    if (s_r.ptt) {
        float f = (s_lvl[AUDIO_PEAK_DAC] + 60) / 60;
        lit = (int)lroundf(12 * (f < 0 ? 0 : f > 1 ? 1 : f));
        snprintf(label, sizeof(label), "DAC");
    } else if (s_st.has_smeter) {
        int dbm = s_st.last_smeter_dbm;
        if (dbm <= -73) {
            int s = (dbm + 127) / 6;
            lit = s < 0 ? 0 : s;
            snprintf(label, sizeof(label), "S%d", lit);
        } else {
            int over = dbm + 73;
            lit = 9 + (over + 9) / 10;
            if (lit > 12) lit = 12;
            snprintf(label, sizeof(label), "S9+%d", over);
        }
    } else snprintf(label, sizeof(label), "S --");
    for (int i = 0; i < 12; i++) {
        int bx = i * 5, h = i < 9 ? 3 + i / 2 : 8;
        if (i >= lit) { gfx_px(bx + 1, base, GFX_ON); gfx_px(bx + 2, base, GFX_ON); continue; }
        if (i < 9) gfx_fill(bx, base - h + 1, 4, h, GFX_ON);
        else { gfx_rect(bx, base - h + 1, 4, h, GFX_ON); gfx_dither(bx + 1, base - h + 2, 2, h - 2, 0); }
    }
    gfx_tiny(LCD_W - gfx_tiny_width(label), base - 4, label, GFX_ON);
}

static void tv_static(int x, int y, int w, int h) {
    static uint32_t seed = 12345;
    for (int j = y; j < y + h; j++)
        for (int i = x; i < x + w; i++) {
            seed = seed * 1103515245u + 12345u;
            if ((seed >> 28) < 4) gfx_px(i, j, GFX_ON);
        }
}

static void view_spectrum(void) {
    const int gx = 0, gy = 10, gw = LCD_W, gh = 33, top = gy + 1, bottom = gy + gh - 2;
    gfx_round_rect(gx, gy, gw, gh, 2, GFX_ON);
    if (!s_spec_fs) {
        tv_static(gx + 2, gy + 2, gw - 4, gh - 4);
        int w = gfx_tiny_width("NO SIGNAL") + 8;
        gfx_fill_round((LCD_W - w) / 2, gy + 12, w, 9, 2, GFX_OFF);
        gfx_pill((LCD_W - w) / 2 + 1, gy + 13, "NO SIGNAL", true);
        gfx_tiny(0, 43, "I/Q SOURCE OFF?", GFX_ON);
        return;
    }
    const float span = 50;
    for (int y = top + 1; y < bottom; y += 2) gfx_px(gx + 1 + SPEC_COLS / 2, y, GFX_ON);  // the VFO
    for (int c = 0; c < SPEC_COLS; c++) {
        int cx = gx + 1 + c;
        int hpx = (int)((s_spec[c] - s_spec_floor) * (bottom - top) / span);
        hpx = hpx < 0 ? 0 : hpx > bottom - top ? bottom - top : hpx;
        int ty = bottom - hpx;
        for (int y = ty + 1; y <= bottom; y++) if (((cx + y) & 1) == 0) gfx_px(cx, y, GFX_ON);
        gfx_px(cx, ty, GFX_ON);
        if (hpx >= s_spec_top[c]) s_spec_top[c] = hpx;
        else if (s_spec_top[c] > 0) s_spec_top[c]--;
        if (s_spec_top[c] > hpx + 1) gfx_px(cx, bottom - s_spec_top[c], GFX_ON);
    }
    // the passband centre: a small notch at the top
    int px = gx + 1 + SPEC_COLS / 2 + (int)((int64_t)s_spec_center * SPEC_COLS / s_spec_fs);
    gfx_hline(px - 2, px + 2, top, GFX_XOR);
    gfx_hline(px - 1, px + 1, top + 1, GFX_XOR);
    gfx_px(px, top + 2, GFX_XOR);

    char l[12], r[12], m[16];
    snprintf(l, sizeof(l), "-%dK", s_spec_fs / 2000);
    snprintf(r, sizeof(r), "+%dK", s_spec_fs / 2000);
    snprintf(m, sizeof(m), "%dDB", (int)lroundf(s_spec_floor));
    gfx_tiny(0, 43, l, GFX_ON);
    gfx_tiny((LCD_W - gfx_tiny_width(m)) / 2, 43, m, GFX_ON);
    gfx_tiny(LCD_W - gfx_tiny_width(r), 43, r, GFX_ON);
}

static void view_levels(void) {
    static const char *const LABELS[AUDIO_PEAK_COUNT] = { "I", "Q", "L", "R", "TX" };
    for (int c = 0; c < AUDIO_PEAK_COUNT; c++) {
        int y = 11 + c * 7;
        gfx_tiny(0, y + 1, LABELS[c], GFX_ON);
        const int bx = 10, bw = 54;
        gfx_seg_bar(bx, y, bw, 6, (s_lvl[c] + 60) / 60);
        float h = (s_hold[c] + 60) / 60;
        if (h > 0) gfx_vline(bx + 2 + (int)lroundf((bw - 5) * (h > 1 ? 1 : h)), y + 1, y + 4, GFX_ON);
        if (s_clip_t[c] > 0) {
            if ((s_tick / 2) % 2 == 0) gfx_pill(66, y - 1, "CLIP", true);
        } else {
            char v[8];
            if (s_lvl[c] <= -60) snprintf(v, sizeof(v), "--");
            else snprintf(v, sizeof(v), "%d", (int)lroundf(s_lvl[c]));
            gfx_tiny(LCD_W - gfx_tiny_width(v), y + 1, v, GFX_ON);
        }
    }
}

static void last_tx_row(int y) {
    if (!s_r.has_ta) { gfx_tiny(0, y + 1, "NO TX REPORT YET", GFX_ON); return; }
    char sum[20];
    int mic;
    tx_level_t lv = tx_assess(&s_r, sum, sizeof(sum), &mic);
    const gfx_icon_t *ic = lv == TX_OK ? &ICON_STAR : lv == TX_WARN ? &ICON_BOLT : &ICON_SAD;
    gfx_icon(0, y, ic, s_tick / 2, GFX_ON);
    gfx_tiny(9, y, sum, GFX_ON);
    gfx_bar(9, y + 6, LCD_W - 9, 4, mic / 100.0f);
}

static void view_tx(void) {
    gfx_tiny(0, 12, "SLOT", GFX_ON);
    for (int i = 0; i < TX_SLOT_COUNT; i++) {
        int x = 18 + i * 11, y = 11;
        char d[2] = { (char)('1' + i), 0 };
        bool playing = s_tx.playing && s_tx.playing_slot == i;
        if (playing) {
            gfx_round_rect(x, y, 9, 7, 1, GFX_ON);
            gfx_dither(x + 1, y + 1, 7, 5, s_tick & 1);
        } else if (s_tx.slots[i].ready) {
            gfx_fill_round(x, y, 9, 7, 1, GFX_ON);
            gfx_tiny(x + 3, y + 1, d, GFX_OFF);
        } else {
            gfx_round_rect(x, y, 9, 7, 1, GFX_ON);
            gfx_tiny(x + 3, y + 1, d, GFX_ON);
        }
    }
    audio_tx_slot_t ch = audio_monitor_get_tx_slot();
    const char *chs = ch == AUDIO_TX_SLOT_LEFT ? "L" : ch == AUDIO_TX_SLOT_RIGHT ? "R" : "L+R";
    gfx_tiny(LCD_W - gfx_tiny_width(chs), 12, chs, GFX_ON);

    // playback
    if (s_tx.playing && s_tx.duration_ms) {
        gfx_bar(0, 20, LCD_W, 7, (float)s_tx.position_ms / s_tx.duration_ms);
        char t[16];
        snprintf(t, sizeof(t), "%u.%uS", (unsigned)(s_tx.position_ms / 1000), (unsigned)(s_tx.position_ms / 100 % 10));
        int w = gfx_tiny_width(t);
        gfx_fill((LCD_W - w) / 2 - 1, 21, w + 2, 5, GFX_OFF);
        gfx_tiny((LCD_W - w) / 2, 21, t, GFX_ON);
    } else {
        gfx_round_rect(0, 20, LCD_W, 7, 2, GFX_ON);
        gfx_tiny((LCD_W - gfx_tiny_width("IDLE")) / 2, 21, "IDLE", GFX_ON);
    }

    // the DAC
    char dac[16];
    snprintf(dac, sizeof(dac), "DAC %dDB", audio_monitor_get_dac_level_db());
    gfx_icon(0, 29, &ICON_NOTE, 0, GFX_ON);
    gfx_tiny(8, 30, dac, GFX_ON);
    if (audio_monitor_get_dac_muted()) gfx_pill(LCD_W - gfx_tiny_width("MUTE") - 6, 29, "MUTE", (s_tick / 3) % 2 == 0);
    else if (s_r.diag) gfx_pill(LCD_W - gfx_tiny_width("DIAG") - 6, 29, "DIAG", false);

    last_tx_row(37);
}

static void fmt_mem(char *out, size_t cap, uint32_t b) {
    if (b >= 1000000) snprintf(out, cap, "%u.%uM", (unsigned)(b / 1000000), (unsigned)(b / 100000 % 10));
    else snprintf(out, cap, "%uK", (unsigned)(b / 1000));
}

static void view_system(void) {
    char v[16];
    for (int core = 0; core < 2; core++) {
        int y = 10 + core * 7;
        snprintf(v, sizeof(v), "C%d", core);
        gfx_tiny(0, y + 1, v, GFX_ON);
        gfx_seg_bar(16, y, 48, 6, s_cpu_now[core] / 100.0f);
        snprintf(v, sizeof(v), "%d%%", s_cpu_now[core]);
        gfx_tiny(LCD_W - gfx_tiny_width(v), y + 1, v, GFX_ON);
    }
    gfx_tiny(0, 25, "RAM", GFX_ON);
    gfx_bar(16, 24, 48, 6, s_ram_total ? 1.0f - (float)s_ram_free / s_ram_total : 0);
    fmt_mem(v, sizeof(v), s_ram_free);
    gfx_tiny(LCD_W - gfx_tiny_width(v), 25, v, GFX_ON);
    gfx_tiny(0, 32, "PSR", GFX_ON);
    gfx_bar(16, 31, 48, 6, s_ps_total ? 1.0f - (float)s_ps_free / s_ps_total : 0);
    fmt_mem(v, sizeof(v), s_ps_free);
    gfx_tiny(LCD_W - gfx_tiny_width(v), 32, v, GFX_ON);

    gfx_hline(0, LCD_W - 1, 39, GFX_ON);
    for (int x = 1; x < LCD_W; x += 2) gfx_px(x, 39, GFX_OFF);  // a dotted rule
    // the chip's temperature: a bar as tall as the text, filled 20..80 C
    gfx_rect(0, 41, 3, 7, GFX_ON);
    if (!isnan(s_temp_c)) {
        int fill = (int)lroundf((s_temp_c - 20) / 60 * 5);
        fill = fill < 0 ? 0 : fill > 5 ? 5 : fill;
        if (fill) gfx_vline(1, 47 - fill, 46, GFX_ON);
        snprintf(v, sizeof(v), "%d*C", (int)lroundf(s_temp_c));
    } else snprintf(v, sizeof(v), "--");
    gfx_tiny(5, 42, v, GFX_ON);
    // uptime, with a heartbeat (two quick beats, then a pause)
    int beat = s_tick % 6;
    gfx_icon(36, 41, &ICON_HEART, beat == 0 || beat == 2, GFX_ON);
    uint32_t up = (uint32_t)(esp_timer_get_time() / 1000000);
    if (up >= 86400) snprintf(v, sizeof(v), "%uD %02uH", (unsigned)(up / 86400), (unsigned)(up / 3600 % 24));
    else snprintf(v, sizeof(v), "%02u:%02u:%02u", (unsigned)(up / 3600), (unsigned)(up / 60 % 60), (unsigned)(up % 60));
    gfx_tiny(LCD_W - gfx_tiny_width(v), 42, v, GFX_ON);
}

static void view_network(void) {
    char v[24];
    bool joined = s_st.wifi_state == BRIDGE_WIFI_CONNECTED && s_rssi_ok;
    wifi_bars(0, 10, joined ? rssi_level(s_rssi) : (int)(s_tick % 5));
    if (joined) snprintf(v, sizeof(v), "%dDBM", s_rssi);
    else snprintf(v, sizeof(v), s_st.wifi_state == BRIDGE_WIFI_AP_FALLBACK ? "AP MODE" : "JOINING");
    gfx_tiny(10, 12, v, GFX_ON);
    gfx_icon(48, 10, &ICON_PERSON, 0, GFX_ON);
    snprintf(v, sizeof(v), "%u", s_st.ws_client_count);
    gfx_tiny(55, 12, v, GFX_ON);
    cat_icon(77, 10);

    sparkline(0, 19, LCD_W, 15, s_rssi_hist, s_hist_n, 128 - 90, 128 - 30);

    gfx_tiny(0, 36, "IP", GFX_ON);
    gfx_tiny(10, 36, s_st.ip_addr[0] ? s_st.ip_addr : "-", GFX_ON);
    char rx[8], tx[8];
    fmt_bytes(rx, sizeof(rx), s_st.cat_bytes_from_radio);
    fmt_bytes(tx, sizeof(tx), s_st.cat_bytes_from_client);
    snprintf(v, sizeof(v), "CAT <%s >%s", rx, tx);
    gfx_tiny(0, 42, v, GFX_ON);
}

// ── Overlays ───────────────────────────────────────────────────────────────

static void overlay_last_tx(void) {
    gfx_box(1, 10, LCD_W - 2, 37);
    char sum[20];
    int mic;
    tx_level_t lv = tx_assess(&s_r, sum, sizeof(sum), &mic);
    gfx_pill((LCD_W - gfx_tiny_width("LAST TX") - 6) / 2, 13, "LAST TX", true);
    const gfx_icon_t *ic = lv == TX_OK ? &ICON_STAR : lv == TX_WARN ? &ICON_BOLT : &ICON_SAD;
    gfx_icon_scaled(6, 23 - (lv == TX_OK ? 0 : (s_tick / 3) % 2), ic, s_tick / 2, 2);
    gfx_tiny(22, 23, sum, GFX_ON);
    char m[16];
    snprintf(m, sizeof(m), "MIC %d%%", mic);
    gfx_tiny(22, 30, m, GFX_ON);
    gfx_seg_bar(22, 37, LCD_W - 27, 6, mic / 100.0f);
}

// TUNE: the app keyed the radio in CW, which in this radio firmware is only
// ever the CW Tune carrier (useRadioCAT's startTune()). Band, frequency and
// how long the carrier has been on; DRY when diagnostic mode keeps it off air.
static const char *band_name(uint32_t hz) {
    static const struct { uint32_t lo, hi; const char *name; } BANDS[] = {
        { 1800000, 2000000, "160M" }, { 3500000, 4000000, "80M" }, { 5300000, 5410000, "60M" },
        { 7000000, 7300000, "40M" }, { 10100000, 10150000, "30M" }, { 14000000, 14350000, "20M" },
        { 18068000, 18168000, "17M" }, { 21000000, 21450000, "15M" }, { 24890000, 24990000, "12M" },
        { 28000000, 29700000, "10M" }, { 50000000, 54000000, "6M" },
    };
    for (size_t i = 0; i < sizeof(BANDS) / sizeof(BANDS[0]); i++)
        if (hz >= BANDS[i].lo && hz <= BANDS[i].hi) return BANDS[i].name;
    return "";
}

static void overlay_tune(int ticks) {
    gfx_box(1, 10, LCD_W - 2, 37);
    const char *t = s_r.diag ? "TUNE DRY" : "TUNE";
    gfx_pill((LCD_W - gfx_tiny_width(t) - 6) / 2, 13, t, true);
    gfx_icon_scaled(6, 22, &ICON_ANTENNA, s_tick % 3, 2);
    char v[16];
    uint32_t hz = s_st.last_vfo_hz;
    if (hz) snprintf(v, sizeof(v), "%u.%03u", (unsigned)(hz / 1000000), (unsigned)(hz / 1000 % 1000));
    else snprintf(v, sizeof(v), "-.---");
    gfx_tiny(24, 23, band_name(hz), GFX_ON);
    gfx_tiny(24, 30, v, GFX_ON);
    snprintf(v, sizeof(v), "%dS", ticks * TICK_MS / 1000);
    gfx_tiny(LCD_W - 6 - gfx_tiny_width(v), 23, v, GFX_ON);
    gfx_seg_bar(6, 39, LCD_W - 12, 4, (s_tick % 10) / 9.0f);  // alive while keyed
}

static void overlay_progress(const char *what, int pct) {
    gfx_box(1, 10, LCD_W - 2, 37);
    gfx_pill((LCD_W - gfx_tiny_width("UPLOAD") - 6) / 2, 13, "UPLOAD", true);
    gfx_icon(7, 24 - (s_tick / 2) % 2, &ICON_UPLOAD, 0, GFX_ON);
    gfx_tiny(18, 24, what, GFX_ON);
    char p[8];
    snprintf(p, sizeof(p), "%d%%", pct);
    gfx_tiny(LCD_W - 6 - gfx_tiny_width(p), 24, p, GFX_ON);
    gfx_seg_bar(6, 33, LCD_W - 12, 8, pct / 100.0f);
}

static void overlay_ap(void) {
    gfx_clear();
    header("WI-FI SETUP", -1);
    gfx_icon(0, 12, &ICON_ANTENNA, s_tick % 3, GFX_ON);
    gfx_tiny(10, 13, "JOIN THE NETWORK", GFX_ON);
    int w = gfx_small_width(CONFIG_BRIDGE_AP_SSID);
    if (w <= LCD_W) gfx_small((LCD_W - w) / 2, 22, CONFIG_BRIDGE_AP_SSID, GFX_ON);
    else gfx_tiny((LCD_W - gfx_tiny_width(CONFIG_BRIDGE_AP_SSID)) / 2, 23, CONFIG_BRIDGE_AP_SSID, GFX_ON);
    gfx_tiny(0, 34, "THEN OPEN", GFX_ON);
    gfx_pill(0, 40, "192.168.4.1", true);
    cat_icon(77, 40);
}

static void overlay_pa_emergency(void) {
    gfx_clear();
    gfx_icon_scaled((LCD_W - 14) / 2, 2, &ICON_WARN, 0, 2);
    const char *t = "PA EMERGENCY";
    gfx_small((LCD_W - gfx_small_width(t)) / 2, 20, t, GFX_ON);
    gfx_tiny((LCD_W - gfx_tiny_width("CLAMP LATCHED")) / 2, 31, "CLAMP LATCHED", GFX_ON);
    gfx_tiny((LCD_W - gfx_tiny_width("CLEAR IT ON THE WEB")) / 2, 38, "CLEAR IT ON THE WEB", GFX_ON);
    if ((s_tick / 2) % 2) gfx_invert();
}

static void splash(void) {
    gfx_round_rect(0, 0, LCD_W, LCD_H, 3, GFX_ON);
    gfx_round_rect(2, 2, LCD_W - 4, LCD_H - 4, 2, GFX_ON);
    gfx_icon_scaled((LCD_W - 21) / 2, 5, &ICON_CAT, s_tick == 6, 3);
    const char *t = "USDX BRIDGE S3";
    gfx_tiny((LCD_W - gfx_tiny_width(t)) / 2, 29, t, GFX_ON);
    gfx_tiny((LCD_W - gfx_tiny_width(BRIDGE_FIRMWARE_VERSION)) / 2, 35, BRIDGE_FIRMWARE_VERSION, GFX_ON);
    gfx_seg_bar(10, 41, LCD_W - 20, 4, (float)(s_tick + 1) / SPLASH_TICKS);
}

// ── The task ───────────────────────────────────────────────────────────────

static uint8_t *s_shown;   // in PSRAM, LCD_FRAME_BYTES
static int s_shown_view = -1;   // -1 while an overlay or the splash shows
static portMUX_TYPE s_shown_lock = portMUX_INITIALIZER_UNLOCKED;

static void (*const VIEWS[VIEW_COUNT])(void) = { view_radio, view_spectrum, view_levels, view_tx, view_system, view_network };

// View change: the content slides across like a phone's home screens, the
// title bar (with the new title) stays put. Run as a quick burst of frames
// between two regular ticks; ease-out offsets, in columns. About half a
// second: the glass responds in ~100 ms, so a faster slide only blurs.
static const uint8_t SLIDE_STEPS[] = { 8, 18, 29, 40, 51, 61, 70, 77, 82, 84 };
#define SLIDE_FRAME_MS 50
static uint8_t *s_prev;   // the frame before the change (PSRAM)

static void slide(const uint8_t *from, const uint8_t *to, int dir) {
    uint8_t *f = gfx_frame();
    for (size_t k = 0; k < sizeof(SLIDE_STEPS); k++) {
        int off = SLIDE_STEPS[k];
        for (int bank = 1; bank < LCD_H / 8; bank++) {
            const uint8_t *a = from + bank * LCD_W, *b = to + bank * LCD_W;
            uint8_t *d = f + bank * LCD_W;
            if (dir > 0) {  // forward: the old view leaves to the left
                memcpy(d, a + off, LCD_W - off);
                memcpy(d + LCD_W - off, b, off);
            } else {
                memcpy(d, b + LCD_W - off, off);
                memcpy(d + off, a, LCD_W - off);
            }
            if (bank == 1)  // row 8 is the title bar's bottom edge: keep the new one whole
                for (int x = 0; x < LCD_W; x++) d[x] = (uint8_t)((d[x] & ~1u) | (b[x] & 1u));
        }
        memcpy(f, to, LCD_W);  // bank 0: the title bar
        lcd_send_frame(f);
        vTaskDelay(pdMS_TO_TICKS(SLIDE_FRAME_MS));
    }
}

// ── The live feed (/display-ws, bridge to clients) ─────────────────────────

static ws_fanout_t s_feed;
static volatile bool s_feed_force;   // a client joined: send it the frame now
static uint8_t *s_feed_last;         // the last frame sent (PSRAM)

// After each frame: the frame when it changed (BINARY, LCD_FRAME_BYTES), and
// {"showing":...,"client_views":[...]} when the view or the list changed.
static void feed_send(const uint8_t *frame, int shown, const int *list, int n) {
    static int last_shown = -2;
    static uint32_t last_list_sig;
    if (!s_feed_last || ws_fanout_count(&s_feed) == 0) { last_shown = -2; return; }
    bool force = s_feed_force;
    s_feed_force = false;
    uint32_t sig = (uint32_t)n;
    for (int i = VIEW_COUNT; i < n; i++) sig = sig * 31 + (uint32_t)list[i];
    if (force || shown != last_shown || sig != last_list_sig) {
        char msg[96 + CLIENT_SLOTS * (CLIENT_ID_LEN + CLIENT_TITLE_LEN + 24)], name[CLIENT_ID_LEN];
        view_name(shown, name, sizeof(name));
        int k = snprintf(msg, sizeof(msg), "{\"showing\":\"%s\",\"client_views\":[", name);
        for (int i = VIEW_COUNT; i < n; i++) {
            char id[CLIENT_ID_LEN], title[CLIENT_TITLE_LEN];
            portENTER_CRITICAL(&s_cv_lock);
            strlcpy(id, s_cv[list[i] - VIEW_COUNT].id, sizeof(id));
            strlcpy(title, s_cv[list[i] - VIEW_COUNT].title, sizeof(title));
            portEXIT_CRITICAL(&s_cv_lock);
            k += snprintf(msg + k, sizeof(msg) - k, "%s{\"id\":\"%s\",\"title\":\"%s\"}", i > VIEW_COUNT ? "," : "", id, title);
        }
        snprintf(msg + k, sizeof(msg) - k, "]}");
        ws_fanout_send_text(&s_feed, msg);
        last_shown = shown;
        last_list_sig = sig;
    }
    if (force || memcmp(frame, s_feed_last, LCD_FRAME_BYTES) != 0) {
        memcpy(s_feed_last, frame, LCD_FRAME_BYTES);
        ws_fanout_send(&s_feed, NULL, 0, frame, LCD_FRAME_BYTES);
    }
}

static void display_task(void *arg) {
    TickType_t wake = xTaskGetTickCount();
    int view = cfg_get().view, slide_dir = 0, dwell_ticks = 0, applied_bl = -1;
    int last_builtin = view;     // where a client view that goes away falls back to
    int focus_return = -1;       // the view to go back to after transmitting
    int focus_view = -1;         // the view keying switched to (TX, or a focus_on_tx client view)
    int return_ticks = 0;        // > 0: counting down to going back after key-up
    bool was_ptt = false;
    int tune_ticks = 0;          // > 0 while keyed in CW: the TUNE carrier
    int list[MAX_VIEWS];
    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(TICK_MS));
        display_cfg_t c = cfg_get();
        if (s_cfg_dirty) {
            s_cfg_dirty = false;
            if (s_lcd_ok) lcd_set_contrast(c.vop, c.bias);
            applied_bl = -1;
        }
        int n = view_list(list);
        s_page_count = n;
        int req = s_view_req;
        if (req >= 0) {
            s_view_req = -1;
            if (view_live(req)) {
                if (req != view) slide_dir = view_pos(list, n, req) > view_pos(list, n, view) ? 1 : -1;
                view = req;
                dwell_ticks = 0;
                focus_return = -1;  // the operator's pick stays
                return_ticks = 0;
            }
        }
        if (!view_live(view)) {  // its client went away
            view = focus_return >= 0 && view_live(focus_return) ? focus_return : last_builtin;
            focus_return = -1;
            slide_dir = -1;
        }
        bool on_tx = was_ptt || return_ticks > 0;  // no auto-cycling away from the TX view meanwhile
        if (s_next_req || (c.cycle && !on_tx && ++dwell_ticks >= c.dwell_s * (1000 / TICK_MS))) {
            s_next_req = false;
            int pos = view_pos(list, n, view);
            view = list[(pos + 1) % n];
            slide_dir = 1;
            dwell_ticks = 0;
        }

        bridge_state_get(&s_st);
        s_r = radio_get();
        // Keying comes from a CAT client's TX; with every CAT client gone, nobody
        // will send the RX that ends it, so the LCD stops showing TX (the radio's
        // own RX0 report still clears it too).
        if (s_r.ptt && s_st.ws_client_count == 0) {
            portENTER_CRITICAL(&s_radio_lock);
            s_radio.ptt = false;
            portEXIT_CRITICAL(&s_radio_lock);
            s_r.ptt = false;
        }
        // Keyed: the glass shows the TX view (or a client view that asked for
        // it), and goes back TX_RETURN_TICKS after key-up, unless the operator
        // picked another view meanwhile or keyed again.
        if (s_r.ptt && !was_ptt) {
            int f = cv_focus_view();
            if (f < 0) f = VIEW_TX;
            return_ticks = 0;
            if (f != view) {
                if (focus_return < 0) focus_return = view;
                slide_dir = view_pos(list, n, f) > view_pos(list, n, view) ? 1 : -1;
                view = f;
            }
            focus_view = f;
        } else if (!s_r.ptt && was_ptt && focus_return >= 0) {
            return_ticks = TX_RETURN_TICKS;
        } else if (!s_r.ptt && return_ticks > 0 && --return_ticks == 0) {
            if (view_live(focus_return) && view == focus_view) {
                slide_dir = view_pos(list, n, focus_return) > view_pos(list, n, view) ? 1 : -1;
                view = focus_return;
            }
            focus_return = -1;
        }
        was_ptt = s_r.ptt;
        tune_ticks = s_r.ptt && (s_r.mode == '3' || s_r.mode == '7') ? tune_ticks + 1 : 0;
        if (view < VIEW_COUNT) last_builtin = view;
        sample_levels();
        sample_spectrum();
        audio_monitor_tx_get_status(&s_tx);
        if (s_tick % (1000 / TICK_MS) == 0) sample_slow();
        if (s_r.has_ta && s_r.ta_at_us != s_last_ta_seen) {
            s_last_ta_seen = s_r.ta_at_us;
            if (!s_r.ta_live) s_last_tx_ticks = LAST_TX_TICKS;  // a key-up report
        }

        gfx_clear();
        int shown = view, bl = c.backlight;
        display_event_t ev;
        int64_t now = esp_timer_get_time();
        const char *prog = s_prog_what;
        if (s_tick < SPLASH_TICKS) { splash(); shown = -1; }
        else if (s_st.pa_emergency_tripped) {
            overlay_pa_emergency();
            shown = -1;
            bl = (s_tick / 2) % 2 ? 100 : 10;
        } else if (s_st.wifi_state == BRIDGE_WIFI_AP_FALLBACK) { overlay_ap(); shown = -1; }
        else {
            if (view < VIEW_COUNT) {
                header(VIEW_TITLES[view], view_pos(list, n, view));
                VIEWS[view]();
            } else {
                view_client(view - VIEW_COUNT, view_pos(list, n, view));
            }
            if (prog && now - s_prog_at < PROGRESS_HOLD_US) { overlay_progress(prog, s_prog_pct); shown = -1; }
            else if (tune_ticks) { overlay_tune(tune_ticks); shown = -1; }
            else if (ovl_active(now)) { ovl_draw(); shown = -1; }
            // An event's library icon lives in s_lib, which a page upload reloads
            // (status_display_reload_icons): draw it under the library's lock;
            // while a reload holds it, this frame goes without the event.
            else {
                bool drawn = false;
                if (xSemaphoreTake(s_lib_mutex, 0) == pdTRUE) {
                    if (event_current(now, &ev)) { event_draw(&ev, s_tick); drawn = true; shown = -1; }
                    xSemaphoreGive(s_lib_mutex);
                }
                if (!drawn && s_last_tx_ticks > 0) { s_last_tx_ticks--; overlay_last_tx(); shown = -1; }
            }
        }
        if (c.invert) gfx_invert();

        // Slide only between two plain views (not out of the splash or an overlay).
        bool can_slide = slide_dir && shown >= 0 && s_shown_view >= 0 && s_prev && s_lcd_ok;
        if (can_slide) {
            memcpy(s_prev, gfx_frame(), LCD_FRAME_BYTES);  // s_prev now holds the new frame...
            slide(s_shown, s_prev, slide_dir);              // ...s_shown still the old one
            memcpy(gfx_frame(), s_prev, LCD_FRAME_BYTES);
        }
        slide_dir = 0;
        if (s_lcd_ok) {
            lcd_send_frame(gfx_frame());
            if (bl != applied_bl) { lcd_set_backlight(bl); applied_bl = bl; }
        }
        portENTER_CRITICAL(&s_shown_lock);
        memcpy(s_shown, gfx_frame(), LCD_FRAME_BYTES);
        s_shown_view = shown;
        portEXIT_CRITICAL(&s_shown_lock);
        feed_send(gfx_frame(), shown, list, n);
        s_tick++;
    }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

static const char *json_val(const char *j, const char *key) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(j, pat);
    if (!p || !(p = strchr(p + strlen(pat), ':'))) return NULL;
    while (*++p == ' ') {}
    return p;
}

static esp_err_t display_get(httpd_req_t *req) {
    display_cfg_t c = cfg_get();
    portENTER_CRITICAL(&s_shown_lock);
    int shown = s_shown_view;
    portEXIT_CRITICAL(&s_shown_lock);
    char body[320 + CLIENT_SLOTS * (CLIENT_ID_LEN + CLIENT_TITLE_LEN + 64)], name[CLIENT_ID_LEN];
    int n = snprintf(body, sizeof(body), "{\"views\":[");
    for (int v = 0; v < VIEW_COUNT; v++) n += snprintf(body + n, sizeof(body) - n, "%s\"%s\"", v ? "," : "", VIEW_NAMES[v]);
    n += snprintf(body + n, sizeof(body) - n, "],\"client_views\":[");
    int64_t now = esp_timer_get_time();
    for (int s = 0, k = 0; s < CLIENT_SLOTS; s++) {
        client_view_t cv;
        portENTER_CRITICAL(&s_cv_lock);
        cv = s_cv[s];
        bool live = cv_live_locked(s, now);
        portEXIT_CRITICAL(&s_cv_lock);
        if (!cv.used) continue;
        n += snprintf(body + n, sizeof(body) - n, "%s{\"id\":\"%s\",\"title\":\"%s\",\"live\":%s,\"focus_on_tx\":%s,\"via\":\"%s\"}",
                      k++ ? "," : "", cv.id, cv.title, live ? "true" : "false", cv.focus_on_tx ? "true" : "false",
                      cv.fd == CLIENT_FD_HTTP ? "http" : "ws");
    }
    view_name(shown, name, sizeof(name));
    n += snprintf(body + n, sizeof(body) - n,
        "],\"view\":\"%s\",\"showing\":\"%s\",\"cycle\":%s,\"dwell_s\":%u,\"contrast\":%u,\"bias\":%u,\"backlight\":%u,"
        "\"invert\":%s,\"lcd_ok\":%s,\"feed_clients\":%d}",
        VIEW_NAMES[c.view], name, c.cycle ? "true" : "false", c.dwell_s, c.vop, c.bias,
        c.backlight, c.invert ? "true" : "false", s_lcd_ok ? "true" : "false", ws_fanout_count(&s_feed));
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, n);
}

static esp_err_t display_post(httpd_req_t *req) {
    char body[256] = { 0 };
    int len = httpd_req_recv(req, body, req->content_len < sizeof(body) - 1 ? req->content_len : sizeof(body) - 1);
    if (len <= 0) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
    }
    display_cfg_t c = cfg_get();
    const char *v, *err = NULL;
    int found = -1;
    if ((v = json_val(body, "view"))) {
        const char *end = v[0] == '"' ? strchr(v + 1, '"') : NULL;
        found = end ? view_by_name(v + 1, (size_t)(end - v - 1)) : -1;
        if (found < 0) err = "unknown view";
        else {
            if (found < VIEW_COUNT) c.view = (uint8_t)found;  // a client view is shown, not saved
        }
    }
    if ((v = json_val(body, "cycle"))) c.cycle = strncmp(v, "true", 4) == 0;
    if ((v = json_val(body, "invert"))) c.invert = strncmp(v, "true", 4) == 0;
    if ((v = json_val(body, "dwell_s"))) { int x = atoi(v); if (x < 2 || x > 60) err = "dwell_s must be 2..60"; else c.dwell_s = (uint8_t)x; }
    if ((v = json_val(body, "contrast"))) { int x = atoi(v); if (x < 0 || x > 127) err = "contrast must be 0..127"; else c.vop = (uint8_t)x; }
    if ((v = json_val(body, "bias"))) { int x = atoi(v); if (x < 0 || x > 7) err = "bias must be 0..7"; else c.bias = (uint8_t)x; }
    if ((v = json_val(body, "backlight"))) { int x = atoi(v); if (x < 0 || x > 100) err = "backlight must be 0..100"; else c.backlight = (uint8_t)x; }
    if (err) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, err);
    }
    if (found >= 0) s_view_req = found;  // only a request valid as a whole changes anything
    if ((v = json_val(body, "next")) && strncmp(v, "true", 4) == 0) s_next_req = true;
    portENTER_CRITICAL(&s_cfg_lock);
    bool changed = memcmp(&s_cfg, &c, sizeof(c)) != 0;
    s_cfg = c;
    portEXIT_CRITICAL(&s_cfg_lock);
    if (changed) {
        s_cfg_dirty = true;
        bridge_settings_set_blob(CFG_KEY, &c, sizeof(c));
    }
    return display_get(req);
}

static esp_err_t frame_get(httpd_req_t *req) {
    uint8_t f[LCD_FRAME_BYTES];
    portENTER_CRITICAL(&s_shown_lock);
    memcpy(f, s_shown, LCD_FRAME_BYTES);
    int shown = s_shown_view;
    portEXIT_CRITICAL(&s_shown_lock);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    char name[CLIENT_ID_LEN];
    view_name(shown, name, sizeof(name));
    httpd_resp_set_hdr(req, "X-Display-View", name);
    httpd_resp_set_type(req, "application/octet-stream");
    return httpd_resp_send(req, (const char *)f, sizeof(f));
}

// A view id: 1..23 of a-z, 0-9, '-', '_'.
static bool valid_id(const char *id) {
    size_t n = strlen(id);
    if (n == 0 || n >= CLIENT_ID_LEN) return false;
    for (size_t i = 0; i < n; i++)
        if (!((id[i] >= 'a' && id[i] <= 'z') || (id[i] >= '0' && id[i] <= '9') || id[i] == '-' || id[i] == '_')) return false;
    return true;
}

// A title as the tiny font draws it: capitals, digits, space and - . : / + %;
// anything else becomes a space. Empty: the id, in capitals.
static void clean_title(const char *in, const char *id, char *out) {
    if (!in || !*in) in = id;
    size_t k = 0;
    for (; *in && k < CLIENT_TITLE_LEN - 1; in++) {
        char ch = (char)toupper((unsigned char)*in);
        out[k++] = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || strchr(" -.:/+%", ch) ? ch : ' ';
    }
    out[k] = 0;
}

// A JSON string value into out (no escapes; ids and titles don't need them).
// False if the key is missing or not a string.
static bool json_str(const char *j, const char *key, char *out, size_t cap) {
    const char *v = json_val(j, key), *end;
    if (!v || v[0] != '"' || !(end = strchr(v + 1, '"'))) return false;
    size_t n = (size_t)(end - v - 1);
    if (n >= cap) n = cap - 1;
    memcpy(out, v + 1, n);
    out[n] = 0;
    return true;
}

// Event text as the fonts draw it: capitals, digits, space and the tiny
// font's signs; anything else becomes a space.
static void clean_event_text(const char *in, char *out, size_t cap) {
    size_t k = 0;
    for (; *in && k < cap - 1; in++) {
        char ch = (char)toupper((unsigned char)*in);
        out[k++] = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || strchr(" .:,-+/%<>!?()=*_#", ch) ? ch : ' ';
    }
    out[k] = 0;
}

// {"title":..,"lines":[..],"icon":..,"seconds":..} (also inside {"event":{..}})
// into an event; NULL, or what is wrong.
static const char *event_parse(const char *j, display_event_t *e) {
    memset(e, 0, sizeof(*e));
    char t[48];
    if (!json_str(j, "title", t, sizeof(t))) return "title is required";
    clean_event_text(t, e->title, sizeof(e->title));
    const char *v = json_val(j, "lines");
    if (v && *v == '[') {
        for (v++; e->nlines < EVENT_LINES;) {
            while (*v == ' ' || *v == ',') v++;
            if (*v != '"') break;
            const char *end = strchr(v + 1, '"');
            if (!end) return "lines: unterminated string";
            char l[64];
            size_t n = (size_t)(end - v - 1) < sizeof(l) - 1 ? (size_t)(end - v - 1) : sizeof(l) - 1;
            memcpy(l, v + 1, n);
            l[n] = 0;
            clean_event_text(l, e->lines[e->nlines++], EVENT_LINE_LEN);
            v = end + 1;
        }
    }
    e->seconds = 8;
    if ((v = json_val(j, "seconds"))) {
        int x = atoi(v);
        if (x < 1 || x > 60) return "seconds must be 1..60";
        e->seconds = x;
    }
    char icon[LIB_NAME_LEN];
    if (json_str(j, "icon", icon, sizeof(icon))) {
        for (size_t i = 0; i < sizeof(EVENT_ICONS) / sizeof(EVENT_ICONS[0]) && !e->icon; i++)
            if (strcmp(icon, EVENT_ICONS[i].name) == 0) e->icon = EVENT_ICONS[i].icon;
        if (!e->icon) e->icon = lib_find(icon);
        if (!e->icon) return "unknown icon (GET /display/icons lists them)";
    } else if ((v = json_val(j, "icon_rows")) && *v == '[') {  // a client's own static icon
        for (v++; e->ch < ICON_MAX_SIDE;) {
            while (*v == ' ' || *v == ',') v++;
            if (*v != '"') break;
            const char *end = strchr(v + 1, '"');
            size_t n = end ? (size_t)(end - v - 1) : 0;
            if (!end || n < 1 || n > ICON_MAX_SIDE || strspn(v + 1, ".#") < n) return "icon_rows: up to 11 rows of up to 11 '.' and '#'";
            memcpy(e->custom[e->ch], v + 1, n);
            e->custom[e->ch][n] = 0;
            if (n > e->cw) e->cw = (uint8_t)n;
            e->ch++;
            v = end + 1;
        }
        for (int i = 0; i < e->ch; i++)  // short rows padded, so every row is cw wide
            while ((int)strlen(e->custom[i]) < e->cw) strcat(e->custom[i], ".");
        if (!e->ch) e->cw = 0;
    }
    return NULL;
}

static esp_err_t ws_reply(httpd_req_t *req, const char *text) {
    httpd_ws_frame_t f = { .type = HTTPD_WS_TYPE_TEXT, .payload = (uint8_t *)text, .len = strlen(text) };
    return httpd_ws_send_frame(req, &f);
}

// /display-ws: the live feed out (feed_send), client views in.
//   text   {"register":"<id>","title":"<title>","focus_on_tx":true}  -> {"slot":N,"id":"<id>"} or {"error":...}
//          {"unregister":"<id>"}   {"show":"<id or built-in name>"}
//          {"event":{"title":..,"lines":[..],"icon":..,"seconds":..}}  -> {"event":"queued"} or {"error":...}
//   binary [slot][CLIENT_BODY bytes], or [0xFF][CLIENT_BODY bytes]: the client overlay
static esp_err_t feed_ws(httpd_req_t *req) {
    int fd = httpd_req_to_sockfd(req);
    if (req->method == HTTP_GET) {
        if (!ws_fanout_add(&s_feed, fd)) {
            ESP_LOGW(TAG, "display-ws: client limit reached — refusing fd=%d", fd);
            return ESP_FAIL;
        }
        s_feed_force = true;
        ESP_LOGI(TAG, "display-ws: client connected (fd=%d)", fd);
        return ESP_OK;
    }
    static uint8_t buf[1 + CLIENT_BODY + 1];  // httpd runs one handler at a time
    httpd_ws_frame_t fr = { 0 };
    esp_err_t err = httpd_ws_recv_frame(req, &fr, 0);
    if (err != ESP_OK) return err;
    if (fr.len > 1 + CLIENT_BODY) {
        ESP_LOGW(TAG, "display-ws: %u-byte frame from fd=%d, closing", (unsigned)fr.len, fd);
        return ESP_FAIL;
    }
    fr.payload = buf;
    if (fr.len && (err = httpd_ws_recv_frame(req, &fr, fr.len)) != ESP_OK) return err;
    if (fr.type == HTTPD_WS_TYPE_BINARY) {
        if (fr.len == 1 + CLIENT_BODY && buf[0] == CLIENT_OVERLAY_SLOT) { ovl_frame(buf + 1); return ESP_OK; }
        if (fr.len != 1 + CLIENT_BODY || !cv_frame(buf[0], fd, buf + 1)) return ws_reply(req, "{\"error\":\"bad frame\"}");
        return ESP_OK;
    }
    if (fr.type != HTTPD_WS_TYPE_TEXT) return ESP_OK;
    buf[fr.len] = 0;
    const char *j = (const char *)buf;
    char id[CLIENT_ID_LEN + 8], title[CLIENT_TITLE_LEN + 16], reply[96];
    if (json_val(j, "event")) {
        display_event_t e;
        const char *bad = event_parse(j, &e);
        if (bad) { snprintf(reply, sizeof(reply), "{\"error\":\"%s\"}", bad); return ws_reply(req, reply); }
        return ws_reply(req, event_push(&e) ? "{\"event\":\"queued\"}" : "{\"error\":\"event queue full\"}");
    }
    if (json_str(j, "register", id, sizeof(id))) {
        if (!valid_id(id)) return ws_reply(req, "{\"error\":\"bad id\"}");
        char t[CLIENT_TITLE_LEN];
        clean_title(json_str(j, "title", title, sizeof(title)) ? title : NULL, id, t);
        const char *v = json_val(j, "focus_on_tx");
        int slot = cv_register(id, t, v && strncmp(v, "true", 4) == 0, fd);
        if (slot < 0) snprintf(reply, sizeof(reply), "{\"error\":\"full\",\"id\":\"%s\"}", id);
        else snprintf(reply, sizeof(reply), "{\"slot\":%d,\"id\":\"%s\"}", slot, id);
        return ws_reply(req, reply);
    }
    if (json_str(j, "unregister", id, sizeof(id))) { cv_drop(fd, id); return ESP_OK; }
    if (json_str(j, "show", id, sizeof(id))) {
        int v = view_by_name(id, strlen(id));
        if (v < 0) return ws_reply(req, "{\"error\":\"unknown view\"}");
        s_view_req = v;
        return ESP_OK;
    }
    return ws_reply(req, "{\"error\":\"unknown message\"}");
}

// %XX and '+' in a query value, in place.
static void url_decode(char *s) {
    char *o = s;
    for (; *s; s++) {
        if (*s == '+') *o++ = ' ';
        else if (*s == '%' && isxdigit((unsigned char)s[1]) && isxdigit((unsigned char)s[2])) {
            char hex[3] = { s[1], s[2], 0 };
            *o++ = (char)strtol(hex, NULL, 16);
            s += 2;
        } else *o++ = *s;
    }
    *o = 0;
}

// POST /display/client?id=<id>&title=<title>&focus_on_tx=1, body CLIENT_BODY bytes.
static esp_err_t client_post(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    char q[160] = { 0 }, id[CLIENT_ID_LEN + 8] = { 0 }, title[48] = { 0 }, focus[8] = { 0 };
    httpd_req_get_url_query_str(req, q, sizeof(q));
    httpd_query_key_value(q, "id", id, sizeof(id));
    httpd_query_key_value(q, "title", title, sizeof(title));
    httpd_query_key_value(q, "focus_on_tx", focus, sizeof(focus));
    url_decode(id);
    url_decode(title);
    if (!valid_id(id)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "id: 1..23 of a-z 0-9 - _");
    if (req->content_len != CLIENT_BODY) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body must be 420 bytes");
    static uint8_t body[CLIENT_BODY];  // httpd runs one handler at a time
    int timeouts = 0;
    for (size_t got = 0; got < CLIENT_BODY;) {
        int r = httpd_req_recv(req, (char *)body + got, CLIENT_BODY - got);
        if (r == HTTPD_SOCK_ERR_TIMEOUT && ++timeouts <= BODY_TIMEOUTS) continue;  // a stalled peer must not hold the httpd task
        if (r <= 0) return ESP_FAIL;
        got += (size_t)r;
    }
    char t[CLIENT_TITLE_LEN];
    clean_title(title, id, t);
    int slot = cv_register(id, t, focus[0] == '1' || strcmp(focus, "true") == 0, CLIENT_FD_HTTP);
    if (slot < 0) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "{\"error\":\"full\"}");
    }
    cv_frame(slot, CLIENT_FD_HTTP, body);
    char reply[64];
    snprintf(reply, sizeof(reply), "{\"slot\":%d,\"id\":\"%s\"}", slot, id);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, reply);
}

// POST /display/event {"title":"QSO 12!","lines":["LU1ABC","S-14 R-08"],"icon":"star","seconds":10}
static esp_err_t event_post(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    char body[384] = { 0 };
    if (req->content_len >= sizeof(body)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body too long");
    int timeouts = 0;
    for (size_t got = 0; got < req->content_len;) {
        int r = httpd_req_recv(req, body + got, req->content_len - got);
        if (r == HTTPD_SOCK_ERR_TIMEOUT && ++timeouts <= BODY_TIMEOUTS) continue;  // a stalled peer must not hold the httpd task
        if (r <= 0) return ESP_FAIL;
        got += (size_t)r;
    }
    display_event_t e;
    const char *bad = event_parse(body, &e);
    if (bad) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, bad);
    httpd_resp_set_type(req, "application/json");
    if (!event_push(&e)) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "{\"error\":\"event queue full\"}");
    }
    return httpd_resp_sendstr(req, "{\"event\":\"queued\"}");
}

// GET /display/icons: the icon names an event can use, built-in and library.
// One icon as {"name","w","h","frames"} and, with rows, every frame's rows one after another.
static void icon_json(httpd_req_t *req, bool first, const char *name, const gfx_icon_t *ic, bool rows) {
    char item[80];
    snprintf(item, sizeof(item), "%s{\"name\":\"%s\",\"w\":%u,\"h\":%u,\"frames\":%u", first ? "" : ",", name,
             ic->w, ic->h, ic->frames);
    httpd_resp_sendstr_chunk(req, item);
    if (rows) {
        httpd_resp_sendstr_chunk(req, ",\"rows\":[");
        for (int r = 0; r < ic->h * ic->frames; r++) {
            snprintf(item, sizeof(item), "%s\"%.*s\"", r ? "," : "", ic->w, ic->rows[r]);
            httpd_resp_sendstr_chunk(req, item);
        }
        httpd_resp_sendstr_chunk(req, "]");
    }
    httpd_resp_sendstr_chunk(req, "}");
}

static esp_err_t icons_get(httpd_req_t *req) {
    char q[32], v[4];
    bool rows = httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK &&
                httpd_query_key_value(q, "rows", v, sizeof(v)) == ESP_OK && v[0] == '1';
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr_chunk(req, "{\"builtin\":[");
    for (size_t i = 0; i < sizeof(EVENT_ICONS) / sizeof(EVENT_ICONS[0]); i++) {
        if (rows) { icon_json(req, i == 0, EVENT_ICONS[i].name, EVENT_ICONS[i].icon, true); continue; }
        char item[48];
        snprintf(item, sizeof(item), "%s\"%s\"", i ? "," : "", EVENT_ICONS[i].name);
        httpd_resp_sendstr_chunk(req, item);
    }
    httpd_resp_sendstr_chunk(req, "],\"library\":[");
    xSemaphoreTake(s_lib_mutex, portMAX_DELAY);
    for (int i = 0; i < s_lib_n; i++) icon_json(req, i == 0, s_lib[i].name, &s_lib[i].icon, rows);
    xSemaphoreGive(s_lib_mutex);
    httpd_resp_sendstr_chunk(req, "]}");
    return httpd_resp_sendstr_chunk(req, NULL);
}

void status_display_on_client_close(int sockfd) {
    ws_fanout_remove(&s_feed, sockfd);
    cv_drop(sockfd, NULL);
}

void status_display_start(httpd_handle_t server) {
    display_cfg_t saved;
    if (bridge_settings_get_blob(CFG_KEY, &saved, sizeof(saved)) && saved.version == CFG_VERSION && saved.view < VIEW_COUNT)
        s_cfg = saved;
    for (int c = 0; c < AUDIO_PEAK_COUNT; c++) s_lvl[c] = s_hold[c] = -100;

    size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    s_shown = heap_caps_calloc(1, LCD_FRAME_BYTES, MALLOC_CAP_SPIRAM);
    s_prev = heap_caps_calloc(1, LCD_FRAME_BYTES, MALLOC_CAP_SPIRAM);
    s_feed_last = heap_caps_calloc(1, LCD_FRAME_BYTES, MALLOC_CAP_SPIRAM);
    bool cv_ok = true;
    for (int s = 0; s < CLIENT_SLOTS; s++) cv_ok &= (s_cv[s].body = heap_caps_calloc(1, CLIENT_BODY, MALLOC_CAP_SPIRAM)) != NULL;
    cv_ok &= (s_ovl = heap_caps_calloc(1, CLIENT_BODY, MALLOC_CAP_SPIRAM)) != NULL;
    cv_ok &= (s_lib = heap_caps_calloc(LIB_MAX, sizeof(lib_icon_t), MALLOC_CAP_SPIRAM)) != NULL;
    if (!gfx_init() || !s_shown || !cv_ok) {
        ESP_LOGE(TAG, "out of memory — status display off");
        return;
    }
    ws_fanout_init_max(&s_feed, "display-ws", server, STATUS_DISPLAY_FEED_CLIENTS);
    s_lib_mutex = xSemaphoreCreateMutex();
    status_display_reload_icons();
    s_lcd_ok = lcd_init(s_cfg.vop, s_cfg.bias);
    temperature_sensor_config_t tc = TEMPERATURE_SENSOR_CONFIG_DEFAULT(10, 80);
    if (temperature_sensor_install(&tc, &s_tsens) != ESP_OK || temperature_sensor_enable(s_tsens) != ESP_OK) {
        ESP_LOGW(TAG, "temperature sensor unavailable");
        s_tsens = NULL;
    }
    cat_bridge_set_frame_observer(on_cat_frame);
    // Its stack in PSRAM: internal RAM is nearly all I2S DMA and Wi-Fi on this
    // board. The task never writes flash (NVS saves happen in the HTTP handler).
    if (xTaskCreatePinnedToCoreWithCaps(display_task, "display", 6144, NULL, TASK_PRIO, NULL, TASK_CORE, MALLOC_CAP_SPIRAM) != pdPASS)
        ESP_LOGE(TAG, "display task: out of memory");

    const httpd_uri_t uris[] = {
        { .uri = "/display", .method = HTTP_GET, .handler = display_get },
        { .uri = "/display", .method = HTTP_POST, .handler = display_post },
        { .uri = "/display/frame", .method = HTTP_GET, .handler = frame_get },
        { .uri = "/display/client", .method = HTTP_POST, .handler = client_post },
        { .uri = "/display/event", .method = HTTP_POST, .handler = event_post },
        { .uri = "/display/icons", .method = HTTP_GET, .handler = icons_get },
        { .uri = "/display-ws", .method = HTTP_GET, .handler = feed_ws, .is_websocket = true },
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++)
        if (httpd_register_uri_handler(server, &uris[i]) != ESP_OK) ESP_LOGE(TAG, "could not register %s", uris[i].uri);
    ESP_LOGI(TAG, "status display started (view %s), internal RAM used: %d bytes", VIEW_NAMES[s_cfg.view],
             (int)internal_before - (int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}
