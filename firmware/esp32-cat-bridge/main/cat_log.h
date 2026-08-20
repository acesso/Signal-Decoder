// Persistent ring buffer of recent CAT frames, surviving reboots — unlike
// the control page's own CAT log (spiffs_data/app.js's appendCatFrame),
// which lives entirely in the browser tab's memory and is lost on every
// close/reload/reboot. Backed by a dedicated raw flash partition (see
// partitions.csv's "catlog" entry), NOT a filesystem — a hand-rolled
// sequential-append-then-wrap ring buffer of fixed-size records, chosen
// specifically to spread flash erase/write wear across many more sectors
// than the live data needs (see cat_log.c's own comment for the numbers).
// Exists to help debug "what was the radio doing right before a restart" —
// the actual motivating case: this bridge has had real, otherwise
// unexplained restarts, and the in-browser log alone can't help diagnose
// those since it's gone the moment the bridge reboots.
//
// A debug feature, OFF by default (see bridge_settings_get_cat_log_enabled()
// and POST /cat-log-enable) — cat_log_init() no-ops entirely unless
// explicitly turned on. Its boot-time recovery scan (recover_from_flash())
// grows with the log's own accumulated record count; left running
// indefinitely on real hardware, that scan grew close enough to the 5s
// task-watchdog timeout to cause a genuine crash-loop, which is why this
// isn't just always-on.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// How many of the most recent frames the ring buffer holds — see cat_log.c
// for the exact record size/partition size this was sized against.
#define CAT_LOG_CAPACITY 1000

// Mounts the catlog partition and recovers the write position by scanning
// existing records (see cat_log.c — no separately-persisted pointer is
// trusted, since that pointer could itself be stale after an unclean
// reset). Call once from app_main, before cat_bridge_start() so no early
// frames are missed. Safe to call even if the partition is missing/
// corrupt — logging silently becomes a no-op rather than failing boot.
void cat_log_init(void);

// Appends one complete CAT frame (NOT including the trailing ';' —
// callers pass just the command body, e.g. "FA00014225000") to the ring
// buffer. from_radio distinguishes direction the same way
// cat_bridge.c's own feed_cat_snoop() does. Frames longer than this
// module's fixed record capacity are truncated (still logged, just
// missing their tail) rather than dropped outright — a truncated CAT
// frame is still useful debugging context.
//
// Queues the actual flash write to a low-priority background task rather
// than writing synchronously on the caller's own task: an erase can take
// tens of milliseconds, which is unacceptable latency to add to
// cat_bridge.c's UART reader task (CAT protocol timing-sensitive) or
// cat_bridge_write()'s client-facing path.
void cat_log_append(bool from_radio, const char *frame, size_t frame_len);

// One recovered record, for GET /cat-log to serialize as JSON.
typedef struct {
    bool from_radio;
    uint32_t uptime_ms_at_log; // esp_timer_get_time()/1000 at the time this record was written, THAT boot — not comparable across reboots, just orders records within one read
    char frame[41]; // cat_log.c's CAT_LOG_MAX_FRAME_LEN (40) + 1 for the NUL terminator
} cat_log_entry_t;

// Copies up to max_entries of the most recent log entries (oldest first)
// into out, returning the count actually written. Safe to call from the
// HTTP handler task — reads directly from the in-RAM shadow of the most
// recent CAT_LOG_CAPACITY records (see cat_log.c), not from flash, so this
// never blocks on a flash operation.
size_t cat_log_read_recent(cat_log_entry_t *out, size_t max_entries);

// Erases the entire persisted log and clears the in-RAM shadow — for a
// "Clear persisted log" control-page button, distinct from the existing
// browser-side "Clear" button (which only clears the live DOM view).
bool cat_log_clear(void);
