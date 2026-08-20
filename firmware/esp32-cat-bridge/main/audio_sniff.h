// Read-only WebSocket sniffer for the browser -> radio mic-send path,
// completely separate from /audio's own bidirectional traffic. Exists
// because /audio's browser->bridge direction (mic audio written straight
// to the ES8388 DAC) has no return signal at all today — the web app
// sends samples and has no way to confirm they actually reached the radio
// correctly, or even at all. Deliberately its OWN endpoint rather than
// echoing through /audio itself: mixing a sniffed copy into /audio's
// existing radio-speaker-audio broadcast would make a listener unable to
// tell "this is what I just sent" apart from "this is what the radio is
// actually doing", and would add load/risk to a path that already had
// real reliability problems (see audio_ws.c's zombie-client eviction
// history) for a debug feature that doesn't need to share it.
//
// Server -> client only. A client sending anything here is simply ignored
// (there's nothing to relay it to — this taps a write path, not a two-way
// conversation).
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_http_server.h"

// Registers the /audio-mic-sniff WebSocket route on the given httpd
// instance. Call after ws_server_start() (needs the same httpd_handle_t
// as /cat and /audio).
void audio_sniff_start(httpd_handle_t server);

// Broadcasts a copy of samples just written to the radio's mic input to
// every currently-connected /audio-mic-sniff client. No-op if none are
// connected — call unconditionally right after the real DAC write in
// audio_monitor.c, same "caller doesn't need to check first" pattern as
// audio_ws_send_to_clients(). Never blocks on, or affects the return value
// of, the real write this mirrors — a slow/stuck sniff client can only
// ever cost itself (evicted the same way audio_ws.c's zombie clients are),
// never the actual mic-to-radio path.
void audio_sniff_broadcast(const int16_t *samples, size_t count);

// Untracks a closed socket fd — see audio_ws_on_client_close()'s identical
// reasoning; ws_server.c's single close_fn calls this too.
void audio_sniff_on_client_close(int fd);
