// Standalone control-page UI, served directly by the bridge's own httpd so
// the physical device can be managed without going through the
// Signal-Decoder web app at all (status, Wi-Fi network change, restart).
// Files live in spiffs_data/ at the project root and are baked into a
// SPIFFS image at build time (see main/CMakeLists.txt) onto the "storage"
// partition (see partitions.csv) — not hand-written into a C string, since
// the existing /status, /info, /reset, /wifi-config JSON endpoints already
// do all the real work; this page is just static HTML/CSS/JS driving them.
//
// GET / GET /style.css GET /app.js -> the page's three static files.
#pragma once

// Mounts the "storage" SPIFFS partition and registers the static-file
// routes on the already-running httpd instance. Call after ws_server_start()
// (needs the same httpd_handle_t), any order relative to http_control_start().
void control_page_start(void);
