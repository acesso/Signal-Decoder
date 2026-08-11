// Browser-facing audio transport: one WebSocket endpoint (ws://<device>/audio)
// carrying raw 16-bit signed PCM, mono, ES8388_SAMPLE_RATE_HZ (see
// bridge_config.h), as binary frames in both directions:
//   bridge -> browser: radio speaker audio (from the ES8388 ADC)
//   browser -> bridge: remote operator's mic audio (written to the ES8388 DAC)
// No framing/codec beyond that — a frame's payload IS the sample buffer,
// same "byte-transparent" philosophy as /cat's relay of raw CAT bytes.
// Deliberately not real WebRTC: there's no mature, maintained WebRTC
// library for bare ESP-IDF, and a second WebSocket reuses the httpd
// instance/infrastructure already proven working for /cat, at the cost of
// a little more latency than true peer-to-peer RTP would have — acceptable
// for voice on a local network.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_http_server.h"

// Registers the /audio WebSocket route on the given httpd instance. Call
// after ws_server_start() (needs the same httpd_handle_t as /cat).
void audio_ws_start(httpd_handle_t server);

// Broadcasts a block of samples (radio -> every connected browser) to all
// currently-connected /audio clients. No-op if none are connected — the
// caller (audio_monitor's read task) doesn't need to check first, same
// pattern as ws_server_send_to_client() for /cat.
void audio_ws_send_to_clients(const int16_t *samples, size_t count);

// Registers the callback audio_monitor uses to receive browser -> radio
// mic audio as it arrives (called from whichever httpd worker task owns
// that client's socket — not audio_monitor's own task, so the callback
// must not block on anything audio_monitor itself holds).
void audio_ws_set_rx_callback(void (*cb)(const int16_t *samples, size_t count));

// Untracks a closed socket fd from the audio client set. httpd only
// supports ONE close_fn per server instance (set once in
// ws_server_start()'s httpd_config_t) — since /audio shares that instance
// with /cat, ws_server.c's own close hook calls this too on every closed
// socket. A fd that was never an audio client (e.g. a CAT-only connection
// closing) is a harmless no-op lookup.
void audio_ws_on_client_close(int fd);
