// Bridge self-description and routing (IO_ROUTING_PLAN.md).
//
//   GET  /capabilities  what this bridge has: PA monitoring, its inputs and
//                       outputs (chip, jack, kinds, rate, channels), the
//                       stream endpoints and the DSP it can do. Versioned;
//                       new fields are additive.
//   GET  /routing       which input feeds the I/Q and the audio streams,
//                       which channel, and where TX audio goes.
//   POST /routing       any subset of the GET shape, e.g.
//                       {"iq":{"input":"pcm1808"},"audio":{"channel":"right"}}.
//                       Saved, so it survives reboots. Answers with the new
//                       routing plus "reboot_required" (true on the A1S when
//                       the input kind changes: one codec, audio or I/Q).
//
// The older endpoints (/iq-config "source", /audio-source, /rx-slot, /tx-slot,
// /input-mode) keep working and change the same state.
#pragma once
#include "esp_http_server.h"

void io_routing_start(httpd_handle_t server);
