// Brings up the onboard ES8388 codec (see ES8388_* pins in bridge_config.h)
// just far enough to read its ADC continuously and compute a running RMS
// level for the "audio in" status LED (see led_status.h). Line 4 of a
// planned pair of features on this board: CAT bridging, this level
// metering, and — not yet built — an actual audio-out pipeline (WebRTC or
// similar) once that exists.
//
// There is no audio-out pipeline yet, so audio_monitor_report_out_samples()
// exists as the intended hook for that future feature but nothing calls it
// today — the "audio out" LED will show 0/off until it does. This is
// deliberate scope, not a bug: this module's job right now is level
// metering for whatever's real (the ADC input), not inventing a fake
// signal to make the second LED light up.
#pragma once

#include <stddef.h>
#include <stdint.h>

// Brings up I2C + I2S + the ES8388 codec, opens it in ADC+DAC mode, and
// starts a background task that reads the ADC continuously, computes RMS
// over short windows, and feeds led_status_set_audio_levels(). Safe to call
// even if no microphone/line-in is actually wired — reads back silence
// (near-zero RMS) in that case, same as a real quiet input would.
void audio_monitor_start(void);

// Feeds a block of already-computed audio-out samples (16-bit signed PCM,
// mono, ES8388_SAMPLE_RATE_HZ) into the same RMS/LED pipeline the ADC input
// uses. Intended for a future playback feature to call as it queues audio
// for the DAC — not called anywhere yet.
void audio_monitor_report_out_samples(const int16_t *samples, size_t count);
