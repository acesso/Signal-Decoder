// Brings up the onboard ES8388 codec (see ES8388_* pins in bridge_config.h)
// and bridges it bidirectionally to the /audio WebSocket (see audio_ws.h):
//   radio speaker (ADC) -> RMS for the "in" status LED -> broadcast to browsers
//   browser mic (via /audio) -> RMS for the "out" status LED -> radio mic (DAC)
// Line 4 of a planned pair of features on this board: CAT bridging and this
// audio bridge, plus any other small radio controls that make sense once
// both exist.
#pragma once

#include <stddef.h>
#include <stdint.h>

// Brings up I2C + I2S + the ES8388 codec, opens it in ADC+DAC mode, registers
// its /audio rx callback (see audio_ws_set_rx_callback), and starts the
// background task that reads the ADC continuously, computes RMS, feeds
// led_status_set_audio_levels(), and broadcasts samples to /audio clients.
// Call after audio_ws_start() — needs its rx-callback slot already available.
// Safe to call even if no microphone/line-in is actually wired — reads back
// silence (near-zero RMS) in that case, same as a real quiet input would.
void audio_monitor_start(void);

// Feeds a block of samples (16-bit signed PCM, mono, ES8388_SAMPLE_RATE_HZ)
// into the same DAC-write/RMS/LED pipeline the /audio WebSocket's rx
// callback uses. A thin alias kept for any future in-firmware playback
// source that isn't the WebSocket itself (e.g. a locally-generated tone)
// — nothing calls it today, /audio's rx callback is the only real producer.
void audio_monitor_report_out_samples(const int16_t *samples, size_t count);
