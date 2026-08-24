// Read-only WebSocket broadcast for raw I/Q capture — a SEPARATE input mode
// from the existing /audio (demodulated audio) path, not a replacement for
// it. The uSDX can put raw in-phase/quadrature (pre-demodulation, wideband)
// on the SAME line-in jack /audio already uses, with I on the ADC's left
// channel and Q on the right (confirmed on real hardware) — selected via
// bridge_settings_get_input_mode_name()/audio_monitor.c's stereo capture
// path, reboot-to-apply exactly like sample_rate_hz.
//
// Deliberately its OWN endpoint rather than a mode flag on /audio, for the
// same reasons audio_sniff.c is its own endpoint rather than folded into
// /audio: /audio is bidirectional (mic-send to the radio) and I/Q receive
// has nothing to do with that; the wire format is untyped raw PCM already,
// so a distinct URI is a free type tag instead of needing new metadata; and
// backpressure/eviction needs to be independent so a wideband I/Q stream
// can never starve the narrowband audio an operator is actively listening
// to on /audio. Modeled closely on audio_sniff.c's broadcast/backpressure
// machinery, with one deliberate difference: PREALLOCATED per-client
// buffers instead of a malloc/free per frame, since I/Q's byte rate can be
// far higher than /audio's (up to 96kHz stereo = ~19.2KB per 50ms window,
// vs /audio's mono ~800B-4.8KB) on a device with a documented heap-
// fragmentation history and no PSRAM — see audio_iq_start()'s comment.
//
// Server -> client only, same as audio_sniff.c — a client sending anything
// here is simply ignored.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_http_server.h"

// Registers the /iq-data WebSocket route on the given httpd instance and
// preallocates each client slot's send buffer at max_bytes_per_frame bytes
// (the largest single audio_iq_broadcast() call this session will ever
// make — i.e. the configured sample rate's own 50ms-window byte count,
// stereo 16-bit: rate_hz/1000*50*2*sizeof(int16_t)). Call after
// ws_server_start() (needs the same httpd_handle_t as /cat and /audio), and
// AFTER the input mode / sample rate for this boot are known (both are
// reboot-to-apply settings, so this is always calculable once at startup).
void audio_iq_start(httpd_handle_t server, size_t max_bytes_per_frame);

// Broadcasts one block of interleaved I/Q samples (I, Q, I, Q, ... as
// signed 16-bit PCM — the ADC's left/right channels, captured together via
// I2S_SLOT_MODE_STEREO, count is the number of int16 VALUES, i.e. 2x the
// number of I/Q sample PAIRS) to every connected /iq-data client. No-op if
// none are connected — call unconditionally from the I/Q capture task, same
// "caller doesn't need to check first" pattern as audio_ws_send_to_clients().
// count * sizeof(int16_t) must not exceed the max_bytes_per_frame passed to
// audio_iq_start() — an over-size call is logged and dropped rather than
// overflowing a preallocated slot buffer.
void audio_iq_broadcast(const int16_t *samples, size_t count);

// Untracks a closed socket fd — see audio_ws_on_client_close()'s identical
// reasoning; ws_server.c's single close_fn calls this too.
void audio_iq_on_client_close(int fd);
