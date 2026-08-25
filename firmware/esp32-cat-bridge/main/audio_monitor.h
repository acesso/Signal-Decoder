// Brings up the onboard ES8388 codec (see ES8388_* pins in bridge_config.h)
// and bridges it bidirectionally to the /audio WebSocket (see audio_ws.h):
//   radio speaker (ADC) -> broadcast to browsers
//   browser mic (via /audio) -> radio mic (DAC)
// Line 4 of a planned pair of features on this board: CAT bridging and this
// audio bridge, plus any other small radio controls that make sense once
// both exist.
//
// Also owns input-mode selection (audio_input_mode_t below) — the SAME
// line-in jack can instead carry raw I/Q from the radio (a wideband,
// pre-demodulation signal, I on the left ADC channel/Q on the right); in
// that mode this module captures true stereo instead of discarding one
// channel, and broadcasts to the separate /iq-data endpoint (audio_iq.h)
// instead of /audio.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Which physical signal the line-in jack is expected to carry — see
// bridge_settings.h's input_mode_name comment for the full reasoning.
// AUDIO_INPUT_MODE_AUDIO is today's existing, long-proven path: mono,
// demodulated, one I2S slot kept (see audio_monitor_get_rx_slot_is_right()).
// AUDIO_INPUT_MODE_IQ is new: stereo capture (BOTH I2S slots kept — I on
// left, Q on right, confirmed on real hardware), broadcast on the separate
// /iq-data endpoint (audio_iq.h) instead of /audio, since raw I/Q has
// nothing in common with /audio's mono-demodulated-audio wire format or
// its bidirectional (mic-send) semantics.
typedef enum {
    AUDIO_INPUT_MODE_AUDIO = 0,
    AUDIO_INPUT_MODE_IQ = 1,
} audio_input_mode_t;

// Parses a mode name ("audio"/"iq") into audio_input_mode_t — returns false
// (leaving *mode_out unchanged) if the name isn't recognized. Used both by
// POST /input-mode (to validate the request body) and audio_monitor_start()
// (to resolve the name last saved in bridge_settings).
bool audio_monitor_parse_input_mode(const char *name, audio_input_mode_t *mode_out);

// The reverse of audio_monitor_parse_input_mode() — for GET /status and log
// messages.
const char *audio_monitor_input_mode_name(audio_input_mode_t mode);

// Current input mode, reflecting whatever audio_monitor_start() resolved
// from bridge_settings_get_input_mode_name() at boot — this is a
// reboot-to-apply setting (see bridge_settings.h), so this never changes
// between boots the way audio_monitor_set_adc_input()'s live toggle does.
audio_input_mode_t audio_monitor_get_input_mode(void);

// Brings up I2C + I2S + the ES8388 codec, opens it in ADC+DAC mode, registers
// its /audio rx callback (see audio_ws_set_rx_callback), and starts the
// background task that reads the ADC continuously and broadcasts samples to
// /audio clients. Call after audio_ws_start() — needs its rx-callback slot
// already available. Safe to call even if no microphone/line-in is
// actually wired — reads back silence in that case, same as a real quiet
// input would.
void audio_monitor_start(void);

// Feeds a block of samples (16-bit signed PCM, mono, ES8388_SAMPLE_RATE_HZ)
// into the same DAC-write/RMS/LED pipeline the /audio WebSocket's rx
// callback uses. A thin alias kept for any future in-firmware playback
// source that isn't the WebSocket itself (e.g. a locally-generated tone)
// — nothing calls it today, /audio's rx callback is the only real producer.
void audio_monitor_report_out_samples(const int16_t *samples, size_t count);

// Live-switches the ES8388's ADC input mux to one of its real supported
// options (index into the internal ADC_INPUT_OPTIONS table — see
// audio_monitor_find_adc_input()) — see the ADCCONTROL2 comment in
// audio_monitor.c for the full reasoning (a simple onboard-mic-vs-P2-jack
// guess was tested on real hardware and had no audible effect, so this
// sweeps every input mode the chip actually supports instead of guessing
// one). Persists nothing itself — the caller (http_control's /audio-input
// handler) is responsible for calling bridge_settings_set_adc_input_name()
// too if the choice should survive a reboot. Returns false if the codec
// never came up (audio monitor disabled), idx is out of range, or the I2C
// write itself failed.
bool audio_monitor_set_adc_input(int idx);

// Looks up an ADC input option by name (e.g. "lin1", "lin2", "mic1",
// "mic2", "diff") — returns its index for audio_monitor_set_adc_input(), or
// -1 if the name isn't recognized. Used both by POST /audio-input (to
// validate the request body) and audio_monitor_start() (to resolve the
// name last saved in bridge_settings back to an index).
int audio_monitor_find_adc_input(const char *name);

// Name of the currently-selected ADC input option, reflecting the last
// successful audio_monitor_set_adc_input() call (or audio_monitor_start()'s
// initial value from bridge_settings) — for GET /status to report.
const char *audio_monitor_get_adc_input_name(void);

// Live-adjusts the ES8388's MIC preamp (PGA) gain in dB via esp_codec_dev's
// public API — see the comment in audio_monitor.c for why this exists:
// the onboard MIC1 preamp was found bleeding into every ADCCONTROL2 input
// mode on real hardware, and this is the one documented way to attenuate
// it without guessing at undocumented power-control bits. db_value <= 0
// drives the PGA to its minimum. Returns false if the codec never came up
// or the underlying esp_codec_dev call failed.
bool audio_monitor_set_mic_gain_db(float db_value);

// Returns whatever audio_monitor_set_mic_gain_db() last successfully
// applied (0.0dB, the ES8388's own PGA default, until the first call) —
// for GET /status to report the live value, e.g. after a reboot re-applies
// a persisted setting.
float audio_monitor_get_mic_gain_db(void);

// Live-toggles the ES8388's ALC (Automatic Level Control) — confirmed OFF
// by the chip's own power-on-reset default (the vendored driver never
// writes these registers), exposed here as a checkable on/off diagnostic
// rather than left as an untested assumption. See audio_monitor.c's
// ALCCONTROL comment for the full reasoning.
bool audio_monitor_set_alc_enabled(bool enabled);
bool audio_monitor_get_alc_enabled(void);

// Live-toggles the ALC's Noise Gate sub-feature — same reasoning as ALC
// above. Only has an audible effect while ALC itself is also enabled (it's
// part of the same ALC block per the datasheet).
bool audio_monitor_set_noise_gate_enabled(bool enabled);
bool audio_monitor_get_noise_gate_enabled(void);

// Live-toggles the ADC's digital high-pass filter (DC-offset removal) —
// UNLIKE ALC/noise-gate above, this one is confirmed ON by the chip's own
// power-on-reset default (datasheet Register 14/ADCCONTROL6, bits 5:4) and
// the vendored driver never touches it either, so it's already active
// right now. Exposed as a checkable toggle so "disable it and compare" is
// possible while chasing a reported broadband noise floor, rather than
// assuming its always-on DC-removal is or isn't a contributing factor.
bool audio_monitor_set_adc_hpf_enabled(bool enabled);
bool audio_monitor_get_adc_hpf_enabled(void);

// Live-forces the onboard NS4150 speaker amplifier's own enable/shutdown
// GPIO (ES8388_PA_ENABLE_PIN) to either state, bypassing the codec
// driver's own PA-power logic — a class-D amp has its own free-running
// switching oscillator, a physically real on-board noise source distinct
// from WiFi/ground-loop/cable-routing causes already ruled out. Exposed
// as a live toggle specifically because ES8388_PA_ENABLE_PIN's polarity
// (bridge_config.h's ES8388_PA_REVERTED) is an unconfirmed guess — this
// lets the operator test/compare both real GPIO states without
// reflashing. Always succeeds (a plain GPIO write can't meaningfully fail).
bool audio_monitor_set_speaker_amp_enabled(bool enabled);
bool audio_monitor_get_speaker_amp_enabled(void);

// Live-switches which I2S slot (left/right) the ADC capture side reads —
// see the comment in audio_monitor.c for why this is a SEPARATE axis from
// audio_monitor_set_adc_input()'s ADCCONTROL2 mux: a jack's tip signal can
// land on either ADC channel depending on board wiring, independent of
// which physical pins the mux selects. Involves a brief RX channel
// disable/reconfigure/re-enable (not a single register write), during
// which capture is paused — expect a short audio gap on every switch.
// Returns false if the codec never came up or any step failed.
bool audio_monitor_set_rx_slot(bool use_right);

// Current RX slot selection, reflecting the last successful
// audio_monitor_set_rx_slot() call (defaults to false/left, matching
// audio_monitor_start()'s I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG default) —
// for GET /status to report.
bool audio_monitor_get_rx_slot_is_right(void);

// RX-loop timing diagnostics — added to investigate a real report of
// periodic "cutting/paper-crackling" noise on the digitized I/Q signal,
// confirmed present on THIS board's capture path but absent when the same
// analog signal is fed directly into a PC sound card instead (i.e. it's
// something in this board's read/broadcast loop, not the radio or the
// analog tap). See audio_monitor.c's s_rx_max_loop_interval_us comment for
// the full reasoning and why this reports "max since the last GET", not
// an all-time max — meant to be polled live (via GET /system-stats) while
// reproducing the noise, to see exactly where time is actually going.
typedef struct {
    int64_t max_loop_interval_us;      // longest gap between successive read-loop iterations
    int64_t max_read_duration_us;      // longest single esp_codec_dev_read() call
    int64_t max_broadcast_duration_us; // longest single audio_iq_broadcast()/audio_ws_send_to_clients() call
    uint32_t loop_count;               // how many iterations contributed to the above since the last call
} audio_monitor_rx_timing_t;
void audio_monitor_get_rx_timing(audio_monitor_rx_timing_t *out);
