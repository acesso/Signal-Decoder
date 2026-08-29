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

// Live-adjusts the ES8388's DAC output volume via esp_codec_dev's public
// API (esp_codec_dev_set_out_vol — a 0-100 scale on the driver's own
// volume curve, NOT dB, unlike mic gain above). See bridge_settings.h's
// own comment on DEFAULT_SPEAKER_VOL for the real bug this fixes: this
// firmware never called this API at all, so every boot silently inherited
// esp_codec_dev's zero-initialized volume (0), which the driver treats as
// its -96dB floor — real audio reached the DAC and the separate NS4150 amp-
// enable GPIO was on, but the codec's own output attenuator left it
// inaudible. vol_value <= 0 drives the DAC output to its minimum (not a
// mute — see esp_codec_dev_set_out_mute() if a true mute is ever needed).
// Returns false if the codec never came up or the underlying call failed.
bool audio_monitor_set_speaker_vol(int8_t vol_value);

// Returns whatever audio_monitor_set_speaker_vol() last successfully
// applied — for GET /status to report the live value, e.g. after a reboot
// re-applies a persisted setting.
int8_t audio_monitor_get_speaker_vol(void);

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

// Which physical output slot(s) TX/playback audio (mic-send AND the
// TX-buffer-pool /tx-play mechanism — both funnel through the same
// audio_rx_callback()/audio_monitor_report_out_samples() DAC-write path)
// reaches — tri-state, unlike RX's plain left/right: "both" is a real,
// useful default (mono source audibly duplicated to both physical
// channels/ears) that RX has no equivalent for (RX genuinely only wants
// ONE physical ADC channel, since the other one may carry something
// different depending on board wiring).
typedef enum {
    AUDIO_TX_SLOT_LEFT = 0,
    AUDIO_TX_SLOT_RIGHT,
    AUDIO_TX_SLOT_BOTH,
} audio_tx_slot_t;

// Live-switches which I2S output slot(s) TX/playback audio reaches. Real
// bug this fixes: TX was always LEFT-only (esp_codec_dev_open()'s own
// channel==1 special-case clobbers slot_mask to LEFT for BOTH tx and rx
// when the codec is opened IN_OUT, the same mechanism audio_monitor_set_rx_slot()
// already works around for RX — see that function's own comment). "Both"
// uses I2S_SLOT_MODE_MONO + I2S_STD_SLOT_BOTH together — confirmed via the
// ESP-IDF HAL source (I2S_SLOT_MODE_MONO's own doc: "transmit same data in
// all slots for tx mode") that this duplicates one written sample to both
// physical outputs in HARDWARE, not something this firmware's own sample
// buffer needs to pre-duplicate. Same brief disable/reconfigure/re-enable
// cost as audio_monitor_set_rx_slot() — expect a short gap on switch, but
// TX-play only ever runs this at idle (not mid-playback) so that gap is
// never audible in practice. Returns false if the codec never came up or
// any step failed.
bool audio_monitor_set_tx_slot(audio_tx_slot_t slot);

// Current TX slot selection, reflecting the last successful
// audio_monitor_set_tx_slot() call — for GET /status to report.
audio_tx_slot_t audio_monitor_get_tx_slot(void);

// Pre-encoded TX buffer playback, now a fixed pool of TX_SLOT_COUNT
// independently-addressable slots — see http_control.h's POST /tx-audio,
// /tx-play, GET /tx-status, POST /tx-stop doc comments for the full
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
// Grew from a single global buffer to a 4-slot pool on 2026-08-25: with
// only one buffer, an auto-CQ loop and a queued reply competed for the same
// storage — whichever POST /tx-audio landed last silently clobbered the
// other, forcing a re-upload right at the TX window boundary and putting
// Wi-Fi latency straight back into the critical path this feature exists to
// remove. Independent slots let the browser pre-stage several candidate
// messages (e.g. slot 0 = standing auto-CQ, slots 1-3 = queue lookahead)
// and pick one to play with zero upload on the hot path — the auto-CQ slot
// in particular can be uploaded once and left alone indefinitely, re-checked
// via its content hash (see audio_monitor_tx_slot_hash() below) rather than
// blindly re-uploaded every cycle.
#define TX_SLOT_COUNT 4

// Mirrors audio_monitor.c's private MIC_SEND_SAMPLE_RATE_HZ #define (kept
// private there since nothing else outside this one feature needs it) —
// exposed here specifically so http_control.c's POST /tx-audio handler can
// sanity-bound an uploaded body's byte count against a real time duration
// without hardcoding the wire rate a second time in a different file.
#define TX_BUFFER_SAMPLE_RATE_HZ 16000

// Upper bounds for the per-slot descriptive metadata below. Fixed-size
// char arrays inside tx_slot_t, not pointers: a few dozen bytes x 4 slots
// is nothing next to the ~480KB audio buffer each slot already carries,
// and inlining them keeps the whole struct allocation-free (no lifetime
// or free() ordering to get wrong on a path that already has to stay
// safe against a concurrent tx_play_task()).
// MESSAGE: the browser's TX message field caps at 40 chars
// (FTTransmitPanel.tsx's maxLength), so 48 leaves real headroom.
// LABEL: a short operator note ("CQ (auto)", "reply to XX1ABC").
#define TX_SLOT_MESSAGE_MAX 48
#define TX_SLOT_LABEL_MAX   32

// Per-slot state for GET /tx-status — bytes/duration/hash of whatever that
// slot last had uploaded (ready == false means "never uploaded", all other
// fields 0). hash is the CRC32 (esp_rom_crc32_le(), ROM-resident — no flash
// cost) of the exact uploaded bytes, exposed so a browser re-checking an
// unchanged message (e.g. a standing auto-CQ waveform re-derived every
// cycle) can compare against what's already on-device and skip the re-POST
// /tx-audio entirely when nothing actually changed.
//
// message/label/audio_hz are DESCRIPTIVE metadata the uploader supplies
// alongside the PCM (see audio_monitor_tx_buffer_upload()). The firmware
// never interprets them — it can't: the audio Hz is already baked into the
// uploaded waveform's own samples (the browser's encoder folds the carrier
// into its phase accumulator before synthesis), so this value is a LABEL
// for what was encoded, never something playback derives anything from.
// They exist because the hash alone is a one-way fingerprint: it can tell
// a browser "this slot already holds exactly these bytes", but it can
// never tell it WHAT those bytes are. Without these fields, any client
// that didn't itself perform the upload — a fresh page load, a cleared
// cache, a different browser, the bridge's own control page — can only
// show an opaque hash for a slot that plainly holds a real, describable
// message. audio_hz is 0 when the uploader didn't supply one.
typedef struct {
    bool ready;
    size_t byte_count;
    uint32_t duration_ms;
    uint32_t hash;
    uint32_t audio_hz;
    char message[TX_SLOT_MESSAGE_MAX];
    char label[TX_SLOT_LABEL_MAX];
} audio_monitor_tx_slot_status_t;

// Fixed at MIC_SEND_SAMPLE_RATE_HZ (16000 Hz mono Int16) — the exact same
// wire format /audio's mic-send path already uses (see that constant's own
// comment in audio_monitor.c), so tx_play_task() (audio_monitor.c) can hand
// chunks straight to audio_monitor_report_out_samples() (the
// audio_rx_callback alias) with zero format translation — the browser side
// encodes its FT8/FT4 waveform at this rate once, up front, instead of
// resampling a live capture in real time.
//
// playing_slot is -1 when nothing is playing (never a valid slot index) —
// only ONE slot can ever be playing at a time (see audio_monitor_tx_play()),
// this device has exactly one audio output path, so "which slot" is shared
// global state, not per-slot.
typedef struct {
    int playing_slot;
    bool playing;
    uint32_t position_ms;
    uint32_t duration_ms;
    audio_monitor_tx_slot_status_t slots[TX_SLOT_COUNT];
} audio_monitor_tx_status_t;

// POST /tx-audio's handler: (re)places slot `slot`'s uploaded TX buffer with
// `data`/`byte_count` (raw Int16 PCM, MIC_SEND_SAMPLE_RATE_HZ mono — the
// caller has already read the full HTTP body into `data`). Grows/allocates
// that slot's backing store in PSRAM (MALLOC_CAP_SPIRAM) — same reasoning as
// s_tx_stereo_scratch/s_tx_upsample_scratch in audio_monitor.c: nothing
// downstream of this buffer (audio_monitor_report_out_samples() ->
// esp_codec_dev_write() -> i2s_channel_write()) ever uses it as a DMA
// source, so there's no capability requirement forcing internal RAM, and a
// single large allocation has no realistic chance of succeeding against
// internal RAM's normal fragmentation level (see that comment for the real
// 9600-byte realloc() failure this exact class of bug already caused once).
// Realistic FT8/FT4 case: ~480KB/slot (15s of 16kHz mono Int16) * 4 slots =
// ~1.9MB, under 24% of this board's 8MB PSRAM. Worst case, if every slot
// were independently pushed to http_control.c's own loose 5-minute sanity
// ceiling: 300s * 16000Hz * 2 bytes = ~9.4MB/slot * 4 = ~37.5MB — far past
// this board's 8MB, but that ceiling exists precisely to reject a garbled/
// misdirected upload with a clear 400 rather than let any single slot's
// allocation get anywhere near that (both real protocols top out well under
// 20s, i.e. ~640KB, so a genuine upload never comes close to the 5-minute
// cap in the first place). Returns false (leaving that slot's PREVIOUS buffer
// untouched) if slot is out of range or that SPECIFIC slot is currently
// playing — the caller (http_control's /tx-audio handler) is expected to
// reject with 400 in that case rather than let an upload clobber a buffer
// the playback task is mid-read on. Uploading to a DIFFERENT slot while some
// OTHER slot plays is always allowed — that's the entire point of the pool.
//
// message/label/audio_hz are optional descriptive metadata stored verbatim
// alongside the audio and echoed back by GET /tx-status — see
// audio_monitor_tx_slot_status_t's own comment for why they exist (the hash
// is one-way; nothing else lets a client that didn't do the upload say what
// a slot actually holds). Pass NULL/NULL/0 to store none. Strings longer
// than TX_SLOT_MESSAGE_MAX/TX_SLOT_LABEL_MAX-1 are truncated, never
// rejected: this is descriptive text for a UI, so losing the tail of an
// over-long label is strictly better than failing an upload whose AUDIO is
// perfectly valid.
bool audio_monitor_tx_buffer_upload(int slot, const int16_t *data, size_t byte_count,
                                    const char *message, const char *label, uint32_t audio_hz);

// True if slot has a buffer from audio_monitor_tx_buffer_upload() present
// and ready for audio_monitor_tx_play() to start on — for POST /tx-play's
// "no buffer uploaded yet" 400 check. False for an out-of-range slot.
bool audio_monitor_tx_buffer_ready(int slot);

// Byte count / duration / CRC32 of whatever audio_monitor_tx_buffer_upload()
// last stored in slot — for POST /tx-audio's own response body (it needs to
// report these right after the upload that produced them) and for GET
// /tx-status's per-slot listing. All return 0 for an out-of-range slot or
// one nothing has ever been uploaded to.
size_t audio_monitor_tx_buffer_byte_count(int slot);
uint32_t audio_monitor_tx_buffer_duration_ms(int slot);
uint32_t audio_monitor_tx_slot_hash(int slot);

// POST /tx-clear's handler: marks slot empty (as if never uploaded) without
// freeing its PSRAM allocation — see audio_monitor.c's own comment for why
// this exists (an honest "remove" for a browser slot-pool UI, not just a
// client-side label hide) and why the allocation itself is kept around.
// Returns false if slot is out of range or slot is the one currently
// playing (same rule as audio_monitor_tx_buffer_upload() — clearing a
// DIFFERENT slot mid-playback is always allowed).
bool audio_monitor_tx_buffer_clear(int slot);

// POST /tx-play's handler: starts the dedicated playback task (see
// audio_monitor.c's tx_play_task() for why this MUST be its own
// xTaskCreatePinnedToCore task rather than work done inline on the httpd
// worker — a real prior incident, documented on UPSAMPLE_SINC_HALF_WIDTH's
// comment, had CPU-heavy work land in that shared httpd worker context and
// starve IDLE0 long enough to trip the task watchdog and reboot the device
// mid-TX; this task is pinned to RELAY_TASK_CORE at AUDIO_MONITOR_TASK_PRIO
// specifically so it can never repeat that failure mode) reading from
// `slot`. Returns false if slot is out of range, that slot has no buffer
// uploaded, or ANY slot (including this one) is already playing — this
// board has exactly one audio output path, so only one slot can ever play
// at a time regardless of how many have buffers ready.
bool audio_monitor_tx_play(int slot);

// GET /tx-status's handler: reads the shared playback state plus every
// slot's own ready/bytes/duration/hash — cheap, poll-friendly, no I/O (just
// atomic loads plus copying TX_SLOT_COUNT small structs), safe to call
// every few hundred ms from a browser progress bar without adding any real
// load.
void audio_monitor_tx_get_status(audio_monitor_tx_status_t *out);

// POST /tx-stop's handler: asks the playback task to stop at the next
// chunk boundary and blocks (briefly) until it actually has — see
// audio_monitor.c's implementation for the exact wait/force-stop bound.
// Returns true once the task has genuinely stopped (playing == false),
// including the trivial case where nothing was playing to begin with.
// *stopped_slot_out (if non-NULL) receives the slot that WAS playing (-1 if
// nothing was), for the HTTP handler's own response body — read before the
// stop takes effect, since s_tx_playing_slot resets to -1 once stopped.
bool audio_monitor_tx_stop(int *stopped_slot_out);

// ── Continuous test tone (POST /tone) ────────────────────────────────────
// A steady sine written to the same mic-send path the TX slots use, for
// tuning the radio's preamps against a known, unchanging reference: the
// slot-playback pool above can only ever play a FINITE pre-uploaded buffer
// (that's the whole point of it — a fully-known FT8/FT4 message), which is
// useless for "leave a tone running while I turn a trimmer and watch the
// meter". Generated in-firmware rather than looped from an uploaded buffer
// so the frequency can change instantly with no re-upload, and so phase
// stays continuous across every chunk boundary forever (a buffer loop
// would splatter the spectrum with a discontinuity at each wrap unless its
// length happened to be an exact whole number of cycles).
//
// Shares the single-audio-output-path interlock with slot playback: the
// tone refuses to start while any slot is playing, and tx_play() likewise
// refuses while the tone is running. Both feed
// audio_monitor_report_out_samples(), so the tone appears in the
// /audio-mic-sniff waterfall automatically with no extra plumbing.
//
// Deliberately NOT persisted to NVS: a test tone that survived a reboot
// would come back driving the radio's mic input with nobody watching.
// Every boot starts with the tone off.

// Lowest/highest tone the setter accepts. Upper bound is well under the
// 16kHz wire rate's 8kHz Nyquist (see MIC_SEND_SAMPLE_RATE_HZ) — this is a
// tool for audio-passband alignment, not a full-bandwidth sweep generator.
#define TONE_HZ_MIN 100
#define TONE_HZ_MAX 4000

// Starts the continuous tone, or retunes it if already running (in which
// case phase is preserved — retuning mid-run never clicks). Returns false
// only if a TX slot is currently playing, since this board has exactly one
// audio output path. hz is clamped to [TONE_HZ_MIN, TONE_HZ_MAX] and
// amplitude to [0.0, 1.0].
bool audio_monitor_tone_start(uint32_t hz, float amplitude);

// Stops the tone at the next chunk boundary and blocks (briefly) until the
// generator task has genuinely exited, flushing real silence through the
// DMA ring on its way out — same reasoning as tx_play_task()'s own silence
// flush (I2S TX DMA re-transmits its last descriptor forever on underrun,
// so a tone that just stopped writing would ring on indefinitely).
// Returns true once stopped, including the trivial "wasn't running" case.
bool audio_monitor_tone_stop(void);

// Current tone state, for GET /tone and the control page's own readout.
// running == false leaves hz/amplitude at their last-set values so the UI
// can restore the sliders where the operator left them.
typedef struct {
    bool     running;
    uint32_t hz;
    float    amplitude;
} audio_monitor_tone_status_t;

void audio_monitor_tone_get_status(audio_monitor_tone_status_t *out);

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
