// Status LCD on the S3 bridge (Nokia 5110, doc/plans/s3-status-lcd/PLAN.md):
// a few live views of what the bridge sees, drawn 5 times a second on core 0.
//
// Views (one at a time, picked on the control page or auto-cycled):
//   radio     VFO frequency in big digits, mode, RX/TX, S-meter, CAT link
//   spectrum  the I/Q spectrum (iq_dsp's overview) with peak hold
//   levels    peak meters: WM8782 I/Q, PCM1808 left/right, PCM5102A out
//   tx        TX slots, playback progress, DAC level, the last TX report
//   system    CPU per core, internal RAM and PSRAM, chip temperature, uptime
//   network   Wi-Fi RSSI history, clients, IP address, CAT traffic
// plus up to 4 client views, drawn by a web app or another tool
// (doc/plans/lcd-client-views/PLAN.md): the client sends the picture under
// the title bar, the bridge adds the title bar, the page dots and the slide.
// Overlays, over any view: PA emergency (inverted, blinking backlight), Wi-Fi
// setup (AP fallback), firmware or page upload progress, a client's overlay
// (/display-ws below), events (POST /display/event), and "Last TX" for a few
// seconds after key-up, from the radio's TA report.
//
// A client view's picture: rows 8..47 of the frame, 420 bytes in the
// controller's layout (5 banks of 84 column bytes, bit 0 at the top); row 8
// is drawn over by the title bar. A view with no new picture for 10 s leaves
// the list (and the glass, which goes back to the built-in view it showed).
// Its id: 1..23 of a-z 0-9 - _; registering an id already in use takes it over.
//
// HTTP:
//   GET  /display        {"views":["radio",...],"client_views":[{"id":"ft8-qso","title":"FT8 QSO","live":true,
//                         "focus_on_tx":true,"via":"ws"}],"view":"radio","showing":"radio","cycle":false,
//                         "dwell_s":8,"contrast":50,"bias":4,"backlight":60,"invert":false,"lcd_ok":true,"feed_clients":1}
//   POST /display        any subset of view (a built-in name, saved; or a live client view's id, shown
//                        but not saved), cycle, dwell_s (2..60), contrast (0..127), bias (0..7),
//                        backlight (0..100), invert; or {"next":true}.
//   GET  /display/frame  the picture on the glass right now: 504 bytes in the
//                        controller's layout (6 banks of 84 columns, bit 0 at
//                        the top); X-Display-View names the view shown.
//   POST /display/client?id=<id>&title=<title>&focus_on_tx=1
//                        a client view's picture (420 bytes) for a tool without
//                        WebSocket; registers the view on first use.
//                        {"slot":N,"id":...}, or 503 {"error":"full"}.
//   POST /display/event  {"title":"QSO 12!","lines":["LU1ABC","GF05 AR","S-14 R-08"],"icon":"star","seconds":10}
//                        an announcement drawn by the bridge in its overlay panel, over any
//                        view: the title in a pill with the icon (star heart bolt warn note
//                        antenna upload smile sad cat chip thermo person arrow, or one of the
//                        library's animated icons, spiffs_data/lcd_icons.txt) each side,
//                        up to 3 lines (the first large when it fits), for seconds (1..60,
//                        default 8). Queued, 4 at most: {"event":"queued"}, or 503 when full.
//                        Text in capitals, digits and . : , - + / % < > ! ? ( ) = * _ #.
//                        Instead of "icon", "icon_rows":["..#..",".###.","#####"]: the client's
//                        own static icon, up to 11 x 11, '#' lit.
//   GET  /display/icons  {"builtin":["star",...],"library":[{"name":"rocket","w":9,"h":9,"frames":3},...]}
//                        ?rows=1: every icon as {"name","w","h","frames","rows":[...]}, builtin ones too;
//                        rows holds each frame's h rows after the previous frame's ('#' lit)
//   WS   /display-ws     up to STATUS_DISPLAY_FEED_CLIENTS (4) clients, both directions:
//     bridge -> client   BINARY the whole frame (504 bytes) when it changes;
//                        TEXT {"showing":"<view>","client_views":[{"id","title"}]}
//                        when the view or the list changes, and on joining.
//     client -> bridge   TEXT {"register":"<id>","title":"<title>","focus_on_tx":true}
//                             -> {"slot":N,"id":"<id>"} or {"error":"full","id":"<id>"}
//                        TEXT {"unregister":"<id>"}, {"show":"<view>"}, {"event":{...}} as POST /display/event
//                        BINARY [slot][420 bytes], at most 5 a second is useful
//                        BINARY [255][420 bytes]: an overlay over whatever is on the glass,
//                               the pixels inside the bridge's overlay panel (x 1..82,
//                               y 10..46, corner radius 3; the body layout as above);
//                               it stays while frames come, and 1.5 s after the last
//                        The socket closing removes its views.
//   While the radio is keyed (TX seen on CAT) the glass shows the TX view, or a
//   client view registered with focus_on_tx, and goes back to the previous view
//   2 s after key-up (not when the operator picked another view meanwhile).
#pragma once
#include "sdkconfig.h"

#if CONFIG_BRIDGE_BOARD_S3
#include "esp_http_server.h"

// /display-ws clients: the control page and a few app tabs (ws_server.c counts them in its socket budget).
#define STATUS_DISPLAY_FEED_CLIENTS 4

// Brings up the LCD and its task, and registers the HTTP handlers. Call after
// audio_monitor_start() and iq_dsp_start(), whose data it draws.
void status_display_start(httpd_handle_t server);

// An upload in progress ("FIRMWARE", "WEB PAGE"), 0..100; the overlay goes
// away a few seconds after the last call.
void status_display_progress(const char *what, int pct);

// From ws_server's close hook: drops the socket's feed and client views.
void status_display_on_client_close(int sockfd);

// Re-reads the events' icon library (spiffs_data/lcd_icons.txt): after a page upload.
void status_display_reload_icons(void);
#else
static inline void status_display_progress(const char *what, int pct) { (void)what; (void)pct; }
static inline void status_display_reload_icons(void) {}
#endif
