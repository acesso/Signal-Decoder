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

// One-shot pre-encoded TX buffer playback — see http_control.h's POST
// /tx-audio, /tx-play, /tx-status, /tx-stop doc comments for the full
// motivation: streaming TX audio live over /audio (audio_rx_callback above)
// means any single ~2048-sample WebSocket chunk arriving late/jittery
// glitches the transmission audibly, on real hardware, every time — an
// unavoidable property of feeding a real-time codec write rate from
// packets whose arrival time is at Wi-Fi's mercy. Uploading the WHOLE
// message first and then walking a known-good in-PSRAM buffer at the
// codec's own pace converts that into a one-shot transfer problem: once
// POST /tx-audio returns 200, every single sample is already on the
// device, and playback jitter can only come from THIS device's own task
// scheduling (core-1, same priority band as audio_task, effectively immune
// to Wi-Fi timing) rather than the network's.
//
// Mirrors audio_monitor.c's private MIC_SEND_SAMPLE_RATE_HZ #define (kept
// private there since nothing else outside this one feature needs it) —
// exposed here specifically so http_control.c's POST /tx-audio handler can
// sanity-bound an uploaded body's byte count against a real time duration
// without hardcoding the wire rate a second time in a different file.
#define TX_BUFFER_SAMPLE_RATE_HZ 16000

// Fixed at MIC_SEND_SAMPLE_RATE_HZ (16000 Hz mono Int16) — the exact same
// wire format /audio's mic-send path already uses (see that constant's own
// comment in audio_monitor.c), so tx_play_task() (audio_monitor.c) can hand
// chunks straight to audio_monitor_report_out_samples() (the
// audio_rx_callback alias) with zero format translation — the browser side
// encodes its FT8/FT4 waveform at this rate once, up front, instead of
// resampling a live capture in real time.
typedef struct {
    bool playing;
    uint32_t position_ms;
    uint32_t duration_ms;
} audio_monitor_tx_status_t;

// POST /tx-audio's handler: (re)places the uploaded TX buffer with
// `data`/`byte_count` (raw Int16 PCM, MIC_SEND_SAMPLE_RATE_HZ mono — the
// caller has already read the full HTTP body into `data`). Grows/allocates
// the backing store in PSRAM (MALLOC_CAP_SPIRAM) — same reasoning as
// s_tx_stereo_scratch/s_tx_upsample_scratch in audio_monitor.c: nothing
// downstream of this buffer (audio_monitor_report_out_samples() ->
// esp_codec_dev_write() -> i2s_channel_write()) ever uses it as a DMA
// source, so there's no capability requirement forcing internal RAM, and a
// ~480KB single allocation has no realistic chance of succeeding against
// internal RAM's normal fragmentation level (see that comment for the
// real 9600-byte realloc() failure this exact class of bug already caused
// once). Returns false (leaving any PREVIOUS buffer untouched) if a
// playback is currently in progress — the caller (http_control's
// /tx-audio handler) is expected to reject with 400 in that case rather
// than let an upload clobber a buffer the playback task is mid-read on.
bool audio_monitor_tx_buffer_upload(const int16_t *data, size_t byte_count);

// True if a buffer from audio_monitor_tx_buffer_upload() is present and
// ready for audio_monitor_tx_play() to start on — for POST /tx-play's
// "no buffer uploaded yet" 400 check.
bool audio_monitor_tx_buffer_ready(void);

// Byte count / duration of whatever audio_monitor_tx_buffer_upload() last
// stored — for POST /tx-audio's own response body (it needs to report
// these right after the upload that produced them).
size_t audio_monitor_tx_buffer_byte_count(void);
uint32_t audio_monitor_tx_buffer_duration_ms(void);

// POST /tx-play's handler: starts the dedicated playback task (see
// audio_monitor.c's tx_play_task() for why this MUST be its own
// xTaskCreatePinnedToCore task rather than work done inline on the httpd
// worker — a real prior incident, documented on UPSAMPLE_SINC_HALF_WIDTH's
// comment, had CPU-heavy work land in that shared httpd worker context and
// starve IDLE0 long enough to trip the task watchdog and reboot the device
// mid-TX; this task is pinned to RELAY_TASK_CORE at AUDIO_MONITOR_TASK_PRIO
// specifically so it can never repeat that failure mode). Returns false if
// no buffer has been uploaded yet, or a playback is already running.
bool audio_monitor_tx_play(void);

// GET /tx-status's handler: reads the shared playback state — cheap,
// poll-friendly, no I/O (just atomic loads), safe to call every few hundred
// ms from a browser progress bar without adding any real load.
void audio_monitor_tx_get_status(audio_monitor_tx_status_t *out);

// POST /tx-stop's handler: asks the playback task to stop at the next
// chunk boundary and blocks (briefly) until it actually has — see
// audio_monitor.c's implementation for the exact wait/force-stop bound.
// Returns true once the task has genuinely stopped (playing == false),
// including the trivial case where nothing was playing to begin with.
bool audio_monitor_tx_stop(void);

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
