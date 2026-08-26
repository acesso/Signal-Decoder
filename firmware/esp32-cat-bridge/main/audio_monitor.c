#include "audio_monitor.h"

#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "audio_codec_ctrl_if.h"
#include "driver/gpio.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "audio_iq.h"
#include "audio_sniff.h"
#include "audio_ws.h"
#include "bridge_config.h"
#include "bridge_settings.h"
#include "led_status.h"
#include "ws_server.h"

static const char *TAG = "audio_monitor";

// esp_codec_dev's ES8388 driver (managed_components/espressif__esp_codec_dev,
// device/es8388/es8388.c) hardcodes ADCCONTROL2 to select LIN1/RIN1 as the
// ADC input on every esp_codec_dev_open(). Community board-support
// convention SUGGESTS LIN1/RIN1 is the onboard electret mic and LIN2/RIN2
// the board's P2 (3.5mm) jack, but real-hardware testing on this exact
// board showed toggling between them has NO audible effect either way
// (onboard mic picked up regardless, P2's actual radio-audio signal never
// came through) — so that assumption is likely wrong for this board
// revision, or the mic/jack aren't separated on the LIN1-vs-LIN2 axis at
// all. Exposed as a live-switchable, ALL-5-of-the-chip's-real-options
// setting (see audio_monitor_set_adc_input() / POST /audio-input)
// specifically so the actual correct value can be found by sweeping
// through them from the browser, rather than guessing one and reflashing
// per attempt. Overridden via the codec's own I2C control interface, since
// the vendored driver's private input-select enum (es_adc_input_t in
// device/priv_include/es_common.h) isn't reachable from main/
// (PRIV_INCLUDE_DIRS-only) — the register address/values are duplicated
// here as plain constants rather than patching the vendored driver in
// place (a component-manager update would silently overwrite that).
#define ES8388_REG_ADCCONTROL2            0x0a
#define ES8388_ADC_INPUT_LINPUT1_RINPUT1  0x00 // "LIN1" — community convention: onboard mic
#define ES8388_ADC_INPUT_MIC1             0x05 // dedicated MIC1 preamp input
#define ES8388_ADC_INPUT_MIC2             0x06 // dedicated MIC2 preamp input
#define ES8388_ADC_INPUT_LINPUT2_RINPUT2  0x50 // "LIN2" — community convention: P2 jack
#define ES8388_ADC_INPUT_DIFFERENCE       0xf0 // differential LIN1-LIN2

// The vendored driver's own es8388_open() brackets ITS ADCCONTROL2 write
// with a full ADC analog-block power-down (0xff) immediately before and a
// power-up (0x09, "power on ADC") immediately after (see es8388.c around
// the ADCCONTROL2 write in es8388_open()) — real-hardware testing showed
// that writing ADCCONTROL2 alone, with the ADC left continuously powered,
// has NO audible effect on the actual input reaching the codec (every one
// of the 5 supported input modes sounded identical — the onboard mic never
// stopped, even switching to modes that shouldn't involve it at all). That
// strongly suggests this chip only actually latches its analog input mux
// selection at ADC analog-block power-up, not on a live register write
// while already running — so the live switch needs to replay the same
// power-down/write-mux/power-up bracket the initial open() does, not just
// the mux write in isolation.
#define ES8388_REG_ADCPOWER               0x03
#define ES8388_ADCPOWER_DOWN_ALL          0xff
#define ES8388_ADCPOWER_UP_ADC            0x09

// ALC (Automatic Level Control, datasheet section 8.3) and its Noise Gate
// sub-feature — both live in "ALC Control" registers 18-22 (0x12-0x16),
// which the vendored es8388_open() never writes at all, leaving them at
// power-on-reset defaults. Reg 18's own documented default (0011 1000)
// has ALCSEL[7:6] = 00 = OFF, so ALC is NOT actually running right now —
// confirmed by reading the datasheet rather than assumed. Exposed as live
// toggles anyway (POST /alc, POST /noise-gate) specifically to let this be
// verified/experimented with from the browser instead of taken on faith,
// per the same "don't guess, make it checkable" approach as the other
// audio diagnostics here — the operator suspected these might be
// contributing to the already-confirmed noise-bleed investigation.
#define ES8388_REG_ALCCONTROL1  0x12 // ALCSEL[7:6], MAXGAIN[5:3], MINGAIN[2:0]
#define ES8388_REG_ALCCONTROL5  0x16 // NGTH[7:3], NGG[2:1], NGAT[0]
#define ES8388_ALCCONTROL1_DEFAULT  0x38 // 0011 1000 — ALCSEL=00 (off), matches datasheet's stated reset default
#define ES8388_ALCSEL_STEREO        0xc0 // ALCSEL=11 in bits [7:6], MAXGAIN/MINGAIN left at the reset default's values
#define ES8388_ALCCONTROL5_DEFAULT  0x00 // datasheet reset default — NGAT=0 (noise gate off)
#define ES8388_NGAT_ENABLE_BIT      0x01

// ADC digital high-pass filter (HPF), datasheet section 6.2.6 — Register 14
// (ADCCONTROL6, 0x0e), NOT touched by the vendored es8388_open() either.
// Unlike ALC above, the datasheet's own stated reset default for THIS
// register is 0011 0000 — bits 5/4 (ADC_HPF_L/ADC_HPF_R) default to 1
// (enabled) on both channels, not disabled — confirmed directly from the
// datasheet's register table (an earlier pass at this got it backwards by
// trusting a Linux driver's misleading inline comment instead of its own
// bit table). So the HPF is already ON right now, unconditionally, on
// whichever channel is actually in use — this toggle lets the operator
// turn it OFF to compare, as part of chasing a reported broadband noise
// floor that showed up even feeding a clean sine wave from a known-clean
// source, to rule in/out whether the always-on HPF's own DC-removal is
// contributing anything audible either way.
#define ES8388_REG_ADCCONTROL6      0x0e
#define ES8388_ADCCONTROL6_DEFAULT  0x30 // 0011 0000 — both channels' HPF enabled (datasheet reset default)
#define ES8388_ADCCONTROL6_HPF_OFF  0x00 // both channels' HPF disabled, invert bits left at their default (0)

// Chip Control 2 (datasheet Register 1, section 6.1.2) — the vendored
// es8388_open() writes this to 0x50 (0101 0000), which per the datasheet's
// own bit table clears every "power down"/"low power" bit EXCEPT bit 4,
// LPVrefBuf, which stays at 1 (low power) — the ES8388's analog VOLTAGE
// REFERENCE BUFFER, the bias the entire ADC/DAC analog front end measures
// its signal against, is running in low-power mode by explicit driver
// choice, not merely an untouched reset default (this board is
// mains/USB-powered, so there's no reason to ever trade analog
// performance for power savings here). Re-applied as 0x00 (every bit
// normal/high-performance: LPVcmMod=0, LPVrefBuf=0, PdnAna=0,
// PdnIbiasgen=0, VrefLo=0, PdnVrefbuf=0) right after esp_codec_dev_open()
// returns — same "re-apply after open() writes something" pattern as the
// ADC input mux/RX slot above, since this register is written INSIDE
// es8388_open(), which esp_codec_dev_open() calls internally.
#define ES8388_REG_CONTROL2         0x01
#define ES8388_CONTROL2_DRIVER_DEFAULT 0x50 // what es8388_open() itself writes — LPVrefBuf left low-power
#define ES8388_CONTROL2_FULL_NORMAL    0x00 // every power-management bit set to its highest-performance state

// ADCCONTROL5 (datasheet Register 13, section 6.2.5) / DACCONTROL2
// (datasheet Register 24, section 6.3.2) — identical bit layout in both:
// bit 5 selects single-speed (0, datasheet-specified ~8-48kHz) vs
// double-speed (1, ~50-100kHz) mode; bits 4:0 select the MCLK:LRCK ratio
// from a fixed table (code 00010 = ratio 256 in BOTH speed modes — the
// ratio field and the speed bit are orthogonal, not a combined lookup).
// The vendored es8388_open() unconditionally writes both registers to
// 0x02 (0000 0010 — single speed, ratio 256) regardless of the actually
// configured sample rate (see the DLL-disable comment above for the
// related, separately-documented 8kHz-specific quirk in this same
// open() call) — there is no rate-aware logic in this driver at all.
// Confirmed against the actual ES8388 datasheet (Everest Semiconductor,
// 2011-06-17, section 6.2.5/6.3.2's bit table) and cross-checked against
// the mainline Linux kernel's es8328 driver (sound/soc/codecs/es8328.h,
// ES8328_DACCONTROL2_DOUBLESPEED = 1<<5, RATEMASK = 0x1f<<0) — same bit
// positions, independently confirming the layout.
//
// Re-applied to 0x22 (0010 0010 — double speed, ratio STILL 256) for
// AUDIO_INPUT_MODE_IQ at 96000Hz, right after esp_codec_dev_open()
// returns — same "re-apply after open() writes something" pattern as
// CONTROL2/ADCCONTROL2 above, since these registers are written INSIDE
// es8388_open(), which esp_codec_dev_open() calls internally. Ratio kept
// at 256 (not switched to a different valid code) specifically because
// esp_codec_dev's I2S clock config already always requests
// I2S_MCLK_MULTIPLE_256 regardless of sample rate (see
// I2S_STD_CLK_DEFAULT_CONFIG's own definition) — 256 x 96000Hz =
// 24.576MHz MCLK, the same clean, standard multiple this board already
// uses at 48kHz (12.288MHz), just doubled; picking a different ratio
// code would require also changing the I2S clock config to match a
// DIFFERENT MCLK, for no known benefit.
//
// GENUINELY UNVERIFIED ON REAL HARDWARE — see the README's Known
// Limitations note. No vendor sample code exercising this exact
// double-speed-at-96kHz combination was found during research; this is
// why 96kHz is a selectable, not-forced option (see
// bridge_settings.h's input_mode_name comment) with 48kHz stereo I/Q
// kept as an already-hardware-verified fallback.
#define ES8388_REG_ADCCONTROL5           0x0d
#define ES8388_REG_DACCONTROL2           0x18
#define ES8388_FSMODE_SINGLE_SPEED_R256  0x02 // what es8388_open() itself writes to BOTH registers — single speed, ratio 256
#define ES8388_FSMODE_DOUBLE_SPEED_R256  0x22 // double speed (bit 5), ratio still 256 (bits 4:0) — for 96kHz

// Read in ~50ms windows — fine RMS resolution for a status LED (not audio
// quality), matches led_status's own 50ms tick so every read produces a
// fresh brightness update with no wasted work. At 8000 Hz this is 400
// samples * 2 bytes = 800-byte /audio binary frames, small enough not to
// fragment on a typical Wi-Fi MTU; at higher configured sample rates the
// frame size scales up proportionally (e.g. 2400 samples/4800 bytes at
// 48000 Hz) — still comfortably under typical WiFi MTU/fragmentation
// thresholds. Computed at audio_monitor_start() from the actual
// configured rate (see s_read_samples), not a compile-time constant —
// this used to be a fixed #define back when the sample rate itself was
// fixed at boot; now that POST /sample-rate can change it (reboot to
// apply), the read-block size has to scale with whatever rate is
// currently configured.
#define READ_WINDOW_MS 50
static size_t s_read_samples = 0; // set once in audio_monitor_start(), read-only after that

static esp_codec_dev_handle_t s_codec_dev = NULL;
// Kept past audio_monitor_start() (unlike the other codec-bringup handles,
// which are only needed during setup) specifically so
// audio_monitor_set_adc_input() can re-issue the ADCCONTROL2 write live,
// without tearing down and rebuilding the whole codec device.
static const audio_codec_ctrl_if_t *s_codec_ctrl_if = NULL;

// Kept past audio_monitor_start() so audio_monitor_set_rx_slot() can
// live-reconfigure which I2S slot (left/right) the ADC capture side reads
// — see that function's comment for why this needed to become switchable:
// the ES8388's ADCCONTROL2 input-mux selection (which physical pins reach
// the ADC) and the I2S slot mask (which of the ADC's two resulting digital
// channels the ESP32 keeps) are two independent axes, and real-hardware
// testing needed to sweep both together to find where a jack's tip signal
// actually lands.
static i2s_chan_handle_t s_rx_handle = NULL;
// True while audio_task must not call esp_codec_dev_read() — set for the
// brief disable/reconfig/enable window in audio_monitor_set_rx_slot(),
// since esp_codec_dev's I2S data interface has no awareness of a caller
// reconfiguring the channel out from under it (see
// platform/audio_codec_data_i2s.c's own i2s_channel_enable/disable calls,
// which we're deliberately bypassing here rather than fighting over).
static _Atomic bool s_rx_paused = false;
static _Atomic bool s_rx_slot_is_right = false; // real value set from bridge_settings in audio_monitor_start() — this initializer is just the pre-boot placeholder

// RX-loop timing instrumentation — added specifically to investigate a
// real report of "cutting/paper-crackling" noise on the digitized I/Q
// signal (heard on the ESP32/ES8388 path, confirmed ABSENT when the same
// analog I/Q signal is instead fed directly into a PC sound card — i.e.
// isolated to this board's capture/broadcast path, not the radio or the
// analog tap). Rather than guess at another fix (two earlier WiFi/DMA
// mitigations tried for a DIFFERENT, TX-side symptom both made things
// WORSE per real-hardware listening tests), this measures the actual
// read-to-read cadence and where time is spent inside audio_task's loop,
// exposed via GET /system-stats so it can be correlated live against
// real WebSocket/client activity. Reset-on-read (GET) — each field
// reports the max seen since the LAST stats fetch, not since boot, so a
// live-polling diagnostics panel sees fresh peaks each time rather than
// one stale all-time value.
static _Atomic int64_t s_rx_max_loop_interval_us = 0;  // time between successive esp_codec_dev_read() call STARTS
static _Atomic int64_t s_rx_max_read_duration_us = 0;  // time INSIDE esp_codec_dev_read() itself
static _Atomic int64_t s_rx_max_broadcast_duration_us = 0; // time inside audio_iq_broadcast()/audio_ws_send_to_clients()
static _Atomic uint32_t s_rx_loop_count = 0; // how many iterations contributed to the above since the last reset

// Both default to false — the ES8388's own power-on-reset defaults, per
// the datasheet, already have ALC and the noise gate off (see the
// ALCCONTROL comment above). These track whatever the operator has since
// toggled via POST /alc / POST /noise-gate.
static _Atomic bool s_alc_enabled = false;
static _Atomic bool s_noise_gate_enabled = false;
// Defaults to true — UNLIKE ALC/noise-gate above, the ADC HPF's own
// datasheet reset default is ENABLED on both channels (see the
// ADCCONTROL6 comment above) and the vendored driver never touches it
// either, so this is already on, right now, before any POST /adc-hpf call
// ever happens. Initialized true here so GET /status reports the truth
// from first boot, not a false "off" placeholder.
static _Atomic bool s_adc_hpf_enabled = true;

// Tracks whatever audio_monitor_set_mic_gain_db() last applied — es8388_open()
// itself hardcodes a non-zero gain at boot (see that function's own comment),
// so this is corrected to the real value the moment audio_monitor_start()
// re-applies bridge_settings_get_mic_gain_db(). Exists so GET /status (and
// therefore the control page's slider) can show the actual live value
// instead of drifting out of sync with what's really applied — without
// this, the slider had no way to reflect a persisted gain after a reboot
// or page reload, which looked exactly like "the setting didn't persist"
// even though the codec register itself was correctly re-applied.
static _Atomic float s_mic_gain_db = 0.0f;

// Live kill-switch for the onboard NS4150 speaker amplifier (its own
// enable/shutdown pin, ES8388_PA_ENABLE_PIN — see bridge_config.h; the
// vendored driver's es8388_pa_power() drives it via codec->gpio_if->set()
// whenever the codec device is enabled, i.e. continuously in normal
// operation). The NS4150 is a class-D (filterless PWM + spread-spectrum)
// amp — a free-running switching source on the same board as the analog
// ADC input, physically distinct from the WiFi/ground-loop/cable-routing
// causes already ruled out. ES8388_PA_REVERTED's polarity is its own
// unconfirmed guess (see that #define's comment) — this toggle exists
// specifically so the operator can test BOTH GPIO states live, without
// reflashing, to find out which one actually silences the amp (multimeter
// or by-ear comparison) rather than trusting the guess. Defaults to true
// (matches whatever the driver already asserts at boot — see
// audio_monitor_start()'s initial sync) so GET /status reports the real
// state from first boot, not an assumed one.
static _Atomic bool s_speaker_amp_enabled = true;

// Every ADC input option the ES8388 actually supports, keyed by name for
// GET /status / POST /audio-input — see the ADCCONTROL2 comment above for
// why this became a full sweep instead of a single onboard-mic-vs-P2-jack
// guess. Index 0 is the default (matches the driver's own default and
// bridge_settings' fallback).
typedef struct {
    const char *name;
    int reg_value;
} adc_input_option_t;

static const adc_input_option_t ADC_INPUT_OPTIONS[] = {
    { "lin2", ES8388_ADC_INPUT_LINPUT2_RINPUT2 }, // community convention: P2 jack
    { "lin1", ES8388_ADC_INPUT_LINPUT1_RINPUT1 }, // community convention: onboard mic
    { "mic1", ES8388_ADC_INPUT_MIC1 },
    { "mic2", ES8388_ADC_INPUT_MIC2 },
    { "diff", ES8388_ADC_INPUT_DIFFERENCE },
};
#define ADC_INPUT_OPTIONS_COUNT (sizeof(ADC_INPUT_OPTIONS) / sizeof(ADC_INPUT_OPTIONS[0]))

// Set once in audio_monitor_start() from bridge_settings_get_input_mode_name()
// and never changed afterward — this is a reboot-to-apply setting, same as
// sample_rate_hz, not a live toggle like adc_input/rx_slot above (switching
// I2S slot MODE — mono vs stereo — isn't the same class of change as
// switching which slot a mono config keeps, and doesn't have the same
// established live-reconfig precedent to build on).
static _Atomic int s_input_mode = AUDIO_INPUT_MODE_AUDIO;

bool audio_monitor_parse_input_mode(const char *name, audio_input_mode_t *mode_out) {
    if (strcmp(name, "audio") == 0) { *mode_out = AUDIO_INPUT_MODE_AUDIO; return true; }
    if (strcmp(name, "iq") == 0) { *mode_out = AUDIO_INPUT_MODE_IQ; return true; }
    return false;
}

const char *audio_monitor_input_mode_name(audio_input_mode_t mode) {
    return mode == AUDIO_INPUT_MODE_IQ ? "iq" : "audio";
}

audio_input_mode_t audio_monitor_get_input_mode(void) {
    return (audio_input_mode_t)atomic_load(&s_input_mode);
}

static _Atomic int s_adc_input_idx = 0; // index into ADC_INPUT_OPTIONS — must match audio_monitor_start()'s initial write

// Browser -> radio: called by audio_ws whenever a /audio client sends a
// binary frame (remote operator's mic, already resampled by the browser
// to the bridge's configured sample rate — see useAudioBridge.ts, which
// reads that rate from GET /status rather than assuming a fixed value).
// Writes straight to the DAC; if no client is actually sending anything,
// this simply never gets called and the DAC just carries whatever silence
// esp_codec_dev/I2S underruns to on its own.
// In AUDIO_INPUT_MODE_IQ, the TX/DAC I2S slot is STEREO (see
// audio_monitor_start()'s std_cfg comment for why — esp_codec_dev_open()
// forces both directions to the same channel count, so this handle can't
// stay mono just because /audio's mic-send data itself always is). This
// scratch buffer holds one write's worth of samples duplicated onto both
// L/R slots (dual-mono — the same signal on both channels, not silence on
// one) before esp_codec_dev_write() — writing raw mono byte counts into
// what the driver now treats as an interleaved stereo stream would
// misinterpret every other sample as the "other" channel, corrupting the
// actual signal reaching the radio's mic input. Growable rather than
// fixed-size since /audio's frame size varies with configured sample rate
// (up to 2400 samples at 48kHz per audio_monitor.c's READ_WINDOW_MS
// comment) — freed/regrown only when a bigger frame than seen before
// arrives, not per-call.
//
// PSRAM (MALLOC_CAP_SPIRAM), NOT internal RAM — this was originally kept
// internal on the (wrong) assumption that feeding esp_codec_dev_write()
// required DMA-capable source memory. It doesn't: esp_codec_dev_write()
// -> _i2s_data_write() (audio_codec_data_i2s.c) calls i2s_channel_write(),
// ESP-IDF's I2S driver API, which memcpy()s the caller's buffer into its
// OWN separately-allocated DMA descriptors — the source pointer itself is
// never used as a DMA source and has no capability requirement. Confirmed
// as a REAL bug on real hardware: at internal-RAM's realistic fragmentation
// level under normal operation, a 9600-byte realloc() (2400 samples * 2ch *
// 2 bytes, the common case at 48kHz) failed every single time
// (heap_largest_free_block was as low as 7168 bytes while heap_free
// reported 18644 — fragmented, not actually out of memory), silently
// dropping every /audio mic-send frame — the direct cause of both "TX
// audio is terrible clipping/cutting in audio mode" (every frame dropped)
// and "no sound at the sniffer in I/Q mode" (audio_sniff_broadcast() below
// is never reached once this early-returns).
static int16_t *s_tx_stereo_scratch = NULL;
static size_t s_tx_stereo_scratch_cap = 0;

// Fixed, not negotiated: the radio's mic/TX input doesn't need or accept
// anything above 16kHz mono (per real-hardware characterization), and
// making this a fixed known constant instead of something the browser
// reports per-connection is simpler and avoids adding wire-protocol
// negotiation for a value that never actually needs to vary. The browser
// (useAudioBridge.ts's MIC_SEND_SAMPLE_RATE_HZ, kept in sync with this
// constant by hand — no shared header between these two languages/
// runtimes) resamples its own mic capture down to this rate before
// sending, cutting /audio's WebSocket bandwidth up to ~6x versus sending
// at the bridge's full RX rate (which can be up to 96kHz in I/Q mode) for
// no audible benefit on a voice-bandwidth signal. This function upsamples
// back to the codec's actual configured rate before writing, since the
// shared I2S bus's sample rate is a single hardware property of the port
// (TX and RX cannot run at independently different rates — see
// audio_monitor_start()'s std_cfg comment on the analogous TX/RX CHANNEL
// coupling, same underlying "one shared port config" constraint).
#define MIC_SEND_SAMPLE_RATE_HZ 16000

// Streaming windowed-sinc bandlimited upsampler — replaces an earlier
// naive linear-interpolation version. That version was confirmed (via a
// synthetic-tone analysis: a clean 1500Hz tone through both browser
// resampleLinear() down to MIC_SEND_SAMPLE_RATE_HZ AND this upsample back
// to the codec rate) to introduce a real, measurable broadband noise floor
// — two stacked naive-linear stages where the old code path had only ONE
// native/high-quality browser resample. Visually this showed up as a
// "green haze" spread across the whole spectrum around the otherwise clean
// FT8 tone, reported directly against real hardware.
//
// FIRST VERSION of this fix called cos()/sin() per tap per output sample
// (a real windowed-sinc evaluated at each output's exact fractional
// position) — CONFIRMED, via a real-hardware crash backtrace, to be far
// too CPU-expensive: it ran inside the shared httpd worker task (audio_ws
// -> audio_rx_callback), and its trig-heavy inner loop starved IDLE0 long
// enough to trip the task watchdog and force a full device reboot mid-TX
// — a worse failure than the noise artifact it was fixing. This version
// fixes THAT by precomputing a small POLYPHASE tap table once (lazily, on
// the first call after boot, keyed to the codec's actual configured rate
// — sample_rate_hz only ever changes via a reboot, so "once per boot" is
// correct, not a shortcut), instead of evaluating sinc/window trig
// functions at runtime: MIC_SEND_SAMPLE_RATE_HZ (16000) is fixed and the
// codec's rate is one of a small, known set (8000/16000/22050/32000/
// 44100/48000 — see bridge_settings.c), so the exact rational resample
// ratio (and therefore the exact, finite set of fractional phases that
// ever occur) is fully known once the codec rate is read — a genuine
// integer-ratio polyphase design (L/M, both derived via GCD), not a
// float-position sinc evaluated fresh each time.
#define UPSAMPLE_SINC_HALF_WIDTH 8 // taps extend +-8 INPUT samples around each output's fractional position — 17 taps/phase, ample for voice-bandwidth content
#define UPSAMPLE_TAPS (UPSAMPLE_SINC_HALF_WIDTH * 2 + 1)
#define UPSAMPLE_HISTORY_LEN UPSAMPLE_TAPS

static uint32_t s_upsample_l = 1; // input-side step (in_rate_hz / gcd), i.e. how many INPUT samples one full output cycle spans
static uint32_t s_upsample_m = 1; // output-side step (out_rate_hz / gcd), i.e. how many OUTPUT samples one full output cycle spans — also the phase count
static float *s_upsample_kernel = NULL; // s_upsample_m phases x UPSAMPLE_TAPS taps, built once per boot/rate
static uint32_t s_upsample_kernel_rate_hz = 0; // out_rate_hz the current kernel was built for — 0 means "not built yet"

static int16_t s_upsample_history[UPSAMPLE_HISTORY_LEN]; // last UPSAMPLE_HISTORY_LEN input samples, carried across calls for continuity at frame boundaries
static size_t s_upsample_hist_len = 0; // how much of s_upsample_history is real history vs. zero-padding (only < full briefly, right after (re)init)
// Exact-rational position tracking (Bresenham-style, no floating-point
// drift over a long-running session): the NEXT output sample is centered
// on input index s_upsample_center, using kernel phase s_upsample_phase
// (0..M-1). Advancing one output sample adds L to s_upsample_phase; every
// time that sum reaches/exceeds M, subtract M and advance
// s_upsample_center by 1 — i.e. plain integer long division done
// incrementally instead of recomputed from scratch each sample.
static int64_t s_upsample_center = 0; // input-sample index (in the same running-stream space s_upsample_history's carry logic uses) the NEXT output sample is centered on
static uint32_t s_upsample_phase = 0; // 0..s_upsample_m-1

static uint32_t gcd_u32(uint32_t a, uint32_t b) {
    while (b != 0) { uint32_t t = b; b = a % b; a = t; }
    return a;
}

// Builds the s_upsample_m x UPSAMPLE_TAPS windowed-sinc kernel table —
// called once per boot (the first time upsample_bandlimited() runs), all
// trig evaluated here rather than in the per-sample hot path. PSRAM: pure
// startup-only scratch class of allocation (same reasoning as this file's
// other PSRAM comments) — never touched again after this function returns.
static bool upsample_build_kernel(uint32_t in_rate_hz, uint32_t out_rate_hz) {
    uint32_t g = gcd_u32(in_rate_hz, out_rate_hz);
    s_upsample_l = in_rate_hz / g;
    s_upsample_m = out_rate_hz / g;

    float *kernel = heap_caps_malloc((size_t)s_upsample_m * UPSAMPLE_TAPS * sizeof(float), MALLOC_CAP_SPIRAM);
    if (!kernel) return false;

    for (uint32_t phase = 0; phase < s_upsample_m; phase++) {
        // This phase's output sample sits at input-position offset
        // (phase * L) / M relative to its nearest input sample (center) —
        // frac is that offset's fractional part.
        double exact = ((double)phase * (double)s_upsample_l) / (double)s_upsample_m;
        double frac = exact - floor(exact);
        for (int t = 0; t < UPSAMPLE_TAPS; t++) {
            double x = (t - UPSAMPLE_SINC_HALF_WIDTH) - frac; // distance from this tap's input sample to the exact output position
            double sinc = (x == 0.0) ? 1.0 : sin(M_PI * x) / (M_PI * x);
            double tw = (x + UPSAMPLE_SINC_HALF_WIDTH) / (2.0 * UPSAMPLE_SINC_HALF_WIDTH);
            double window = (tw <= 0.0 || tw >= 1.0) ? 0.0 : 0.42 - 0.5 * cos(2.0 * M_PI * tw) + 0.08 * cos(4.0 * M_PI * tw);
            kernel[phase * UPSAMPLE_TAPS + t] = (float)(sinc * window);
        }
    }

    if (s_upsample_kernel) free(s_upsample_kernel);
    s_upsample_kernel = kernel;
    s_upsample_kernel_rate_hz = out_rate_hz;
    memset(s_upsample_history, 0, sizeof(s_upsample_history));
    s_upsample_hist_len = 0;
    s_upsample_center = 0;
    s_upsample_phase = 0;
    return true;
}

static size_t upsample_bandlimited(const int16_t *in, size_t in_count, int16_t *out, size_t out_cap, uint32_t in_rate_hz, uint32_t out_rate_hz) {
    if (in_count == 0 || in_rate_hz == 0 || out_rate_hz == 0) return 0;
    if (s_upsample_kernel_rate_hz != out_rate_hz) {
        if (!upsample_build_kernel(in_rate_hz, out_rate_hz)) {
            ESP_LOGW(TAG, "failed to build upsample kernel — dropping this frame");
            return 0;
        }
    }

    // Working buffer: carried history in front, this call's fresh samples
    // after — s_upsample_center/s_upsample_history use the SAME running-
    // stream index space (0 = oldest sample still in history), so
    // s_upsample_hist_len is this call's offset from that call's own
    // window into buf[]. Plain malloc() (internal RAM) — a PSRAM move was
    // tried here as a mitigation for /iq-data-during-TX heap contention,
    // but the user reported it made real-world TX degradation WORSE, not
    // better, and reverting the separate WiFi-buffer-count change alone
    // didn't help — pointing at this move itself: this buffer is
    // allocated fresh on EVERY /audio write (~every 50ms during TX), and
    // PSRAM's materially higher access latency on original ESP32 (see
    // sdkconfig.defaults's SPIRAM_USE_CAPS_ALLOC comment on why the
    // time-critical I2S/CAT/PA-watchdog path avoids it) likely cost more
    // in per-call latency/jitter than the reduced internal-RAM
    // fragmentation saved. Reverted; don't re-try this specific
    // buffer without re-confirming against real hardware first.
    size_t total = s_upsample_hist_len + in_count;
    int16_t *buf = malloc(total * sizeof(int16_t));
    if (!buf) return 0;
    memcpy(buf, s_upsample_history + (UPSAMPLE_HISTORY_LEN - s_upsample_hist_len), s_upsample_hist_len * sizeof(int16_t));
    memcpy(buf + s_upsample_hist_len, in, in_count * sizeof(int16_t));

    // INVARIANT: s_upsample_center, read back at the top of the NEXT
    // call, is the absolute index (within THIS call's buf[], i.e.
    // already offset by this call's s_upsample_hist_len) that the next
    // output sample is centered on — center below is tracked in that
    // exact same space throughout, so no extra offset is added when
    // reading it in. An EARLIER version of this function added
    // s_upsample_hist_len on read AND subtracted it again on write,
    // believing those two canceled out to a no-op — they don't: proven
    // via a whole-vs-chunked numerical test (feeding the same signal as
    // one unchunked call vs. several real-sized chunks must produce
    // byte-identical output; the old version diverged with errors in the
    // tens of thousands, out of a +-32768 range, starting at the second
    // chunk boundary). This is what caused a real, confirmed-on-hardware
    // intermittent bug: the SAME FT8 message sometimes sending cleanly
    // and sometimes with broadband noise, depending on exact chunk-
    // boundary history lengths — see useAudioBridge.ts's
    // downsampleBandlimited(), the matched fix on the browser side.
    int64_t center = s_upsample_center;
    uint32_t phase = s_upsample_phase;
    size_t out_count = 0;
    // Stop once the kernel's forward reach would need input beyond what
    // this call actually has (i.e. UPSAMPLE_SINC_HALF_WIDTH samples past
    // center aren't in buf[] yet) — the remaining, not-yet-supportable
    // output picks up seamlessly on the NEXT call once more input arrives,
    // via the carried center/phase state below.
    while (center + UPSAMPLE_SINC_HALF_WIDTH < (int64_t)total && out_count < out_cap) {
        const float *taps = &s_upsample_kernel[phase * UPSAMPLE_TAPS];
        float acc = 0.0f;
        for (int t = 0; t < UPSAMPLE_TAPS; t++) {
            int64_t idx = center + (t - UPSAMPLE_SINC_HALF_WIDTH);
            if (idx < 0) continue; // only possible right after boot, before history has filled once
            acc += buf[idx] * taps[t];
        }
        float clamped = acc > 32767.0f ? 32767.0f : (acc < -32768.0f ? -32768.0f : acc);
        out[out_count++] = (int16_t)clamped;

        // Exact-rational advance (Bresenham-style) — see s_upsample_center's
        // own comment for why this avoids floating-point position drift.
        phase += s_upsample_l;
        while (phase >= s_upsample_m) { phase -= s_upsample_m; center++; }
    }
    s_upsample_phase = phase;

    size_t carry = total < UPSAMPLE_HISTORY_LEN ? total : UPSAMPLE_HISTORY_LEN;
    memset(s_upsample_history, 0, sizeof(s_upsample_history));
    memcpy(s_upsample_history + (UPSAMPLE_HISTORY_LEN - carry), buf + (total - carry), carry * sizeof(int16_t));
    // The NEXT call's buf[] will start with `carry` history samples, i.e.
    // its own absolute index 0 corresponds to THIS call's buf[] index
    // (total - carry) — shift center by that same amount so it lands on
    // the identical real position once re-based into the next call's space.
    s_upsample_center = center - (int64_t)(total - carry);
    s_upsample_hist_len = carry;

    free(buf);
    return out_count;
}

static int16_t *s_tx_upsample_scratch = NULL;
static size_t s_tx_upsample_scratch_cap = 0;

static void audio_rx_callback(const int16_t *samples, size_t count) {
    if (count == 0) return;

    // Upsample from the fixed wire rate to whatever the codec is actually
    // running at right now — see MIC_SEND_SAMPLE_RATE_HZ's comment. A
    // no-op ratio-1 pass whenever the two happen to match (e.g. the bridge
    // is configured at 16kHz already), so this is never a correctness
    // hazard even if MIC_SEND_SAMPLE_RATE_HZ and the codec rate ever
    // coincide.
    uint32_t codec_rate_hz = bridge_settings_get_sample_rate_hz();
    size_t upsample_cap = (size_t)((uint64_t)count * codec_rate_hz / MIC_SEND_SAMPLE_RATE_HZ) + 2;
    if (s_tx_upsample_scratch_cap < upsample_cap) {
        int16_t *grown = heap_caps_realloc(s_tx_upsample_scratch, upsample_cap * sizeof(int16_t), MALLOC_CAP_SPIRAM);
        if (!grown) {
            ESP_LOGW(TAG, "failed to grow TX upsample scratch buffer (%u samples) — dropping this frame", (unsigned)upsample_cap);
            return;
        }
        s_tx_upsample_scratch = grown;
        s_tx_upsample_scratch_cap = upsample_cap;
    }
    size_t up_count = upsample_bandlimited(samples, count, s_tx_upsample_scratch, s_tx_upsample_scratch_cap, MIC_SEND_SAMPLE_RATE_HZ, codec_rate_hz);
    samples = s_tx_upsample_scratch;
    count = up_count;
    if (count == 0) return;

    const void *write_buf = samples;
    size_t write_bytes = count * sizeof(int16_t);
    if (audio_monitor_get_input_mode() == AUDIO_INPUT_MODE_IQ) {
        if (s_tx_stereo_scratch_cap < count) {
            int16_t *grown = heap_caps_realloc(s_tx_stereo_scratch, count * 2 * sizeof(int16_t), MALLOC_CAP_SPIRAM);
            if (!grown) {
                ESP_LOGW(TAG, "failed to grow TX stereo scratch buffer (%u samples) — dropping this frame", (unsigned)count);
                return;
            }
            s_tx_stereo_scratch = grown;
            s_tx_stereo_scratch_cap = count;
        }
        for (size_t i = 0; i < count; i++) {
            s_tx_stereo_scratch[i * 2] = samples[i];
            s_tx_stereo_scratch[i * 2 + 1] = samples[i];
        }
        write_buf = s_tx_stereo_scratch;
        write_bytes = count * 2 * sizeof(int16_t);
    }

    int ret = esp_codec_dev_write(s_codec_dev, (void *)write_buf, write_bytes);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGW(TAG, "codec write failed (%d)", ret);
    }
    // Read-only tap for GET /audio-mic-sniff — see audio_sniff.h for why
    // this exists (browser -> radio mic audio had no way to verify what
    // actually got written, at all). Broadcasts the UPSAMPLED mono samples
    // (post upsample_bandlimited(), pre stereo-duplication) regardless of
    // whether the write above succeeded — a sniffer showing "here's what I
    // sent" should reflect the actual mono signal at the actual rate it
    // was written at, not either the original 16kHz wire samples (a
    // sniffer client has no way to know that rate without asking) or the
    // stereo-duplicated wire representation (redundant, same signal twice);
    // audio_sniff_broadcast() itself no-ops instantly if no client is
    // listening, so this never adds real cost to the normal (no sniffer
    // attached) case.
    audio_sniff_broadcast(samples, count);
}

void audio_monitor_report_out_samples(const int16_t *samples, size_t count) {
    // Kept as a thin alias — a future in-firmware playback source (rather
    // than the /audio WebSocket) could feed the same level/LED pipeline
    // this way without needing to know about audio_rx_callback at all.
    audio_rx_callback(samples, count);
}

// ── One-shot TX buffer playback (POST /tx-audio, /tx-play, /tx-status,
//    /tx-stop) ─────────────────────────────────────────────────────────────
// The whole point of this feature: /audio's live mic-send path glitches on
// real hardware whenever a single ~2048-sample WebSocket chunk arrives late
// (any Wi-Fi jitter on that one chunk is instantly audible in the
// transmitted signal, since audio_rx_callback() above writes straight
// through to the codec at its own real-time rate with no buffering to
// absorb a late arrival). A pre-encoded FT8/FT4 message is fully known
// ahead of time, so there's no reason to stream it live at all — upload it
// once, confirm every byte actually arrived (this POST returns 200 only
// once httpd_req_recv() has the whole thing), THEN walk it out to the
// codec locally, where the only remaining timing source is this device's
// own task scheduler rather than the network.

// PSRAM (MALLOC_CAP_SPIRAM) — identical reasoning to s_tx_stereo_scratch/
// s_tx_upsample_scratch above: esp_codec_dev_write() never uses its source
// pointer as a DMA source (i2s_channel_write() memcpy()s into its OWN DMA
// descriptors), so nothing here has a DMA-capability requirement, and a
// single ~480KB allocation (15s of 16kHz mono Int16) has effectively no
// chance of succeeding against internal RAM's normal fragmentation level —
// the same class of "heap_free looks fine, heap_largest_free_block doesn't"
// failure that silently dropped every /audio mic-send frame before those
// buffers moved to PSRAM.
static int16_t *s_tx_buffer = NULL;
static size_t s_tx_buffer_cap_bytes = 0;   // heap_caps_realloc()'d capacity — may exceed s_tx_buffer_len_bytes after a later, smaller upload
static size_t s_tx_buffer_len_bytes = 0;   // actual uploaded length; 0 means "no buffer uploaded yet"

// Playback state, read by GET /tx-status and written only by tx_play_task()
// (plus s_tx_play_stop_requested, written by POST /tx-stop) — atomics
// rather than a mutex since every field is independently meaningful and
// GET /tx-status is explicitly meant to be cheap/poll-friendly with no
// blocking, same reasoning as the RX-timing stats above.
static _Atomic bool s_tx_playing = false;
static _Atomic uint32_t s_tx_position_ms = 0;
static _Atomic bool s_tx_play_stop_requested = false;
// Distinct from s_tx_playing: set true the moment tx_play_task() is
// spawned, cleared only once that task has actually exited — closes the
// real race where POST /tx-play is called twice back-to-back before the
// first task's very first loop iteration has run (s_tx_playing itself is
// set true from INSIDE the task, not by the xTaskCreatePinnedToCore() call
// site, so there'd otherwise be a window where audio_monitor_tx_play()
// could see s_tx_playing == false and spawn a second task on top of one
// that's already starting up).
static _Atomic bool s_tx_play_task_alive = false;

bool audio_monitor_tx_buffer_upload(const int16_t *data, size_t byte_count) {
    if (atomic_load(&s_tx_playing)) return false; // don't clobber a buffer the playback task is mid-read on

    if (s_tx_buffer_cap_bytes < byte_count) {
        int16_t *grown = heap_caps_realloc(s_tx_buffer, byte_count, MALLOC_CAP_SPIRAM);
        if (!grown) {
            ESP_LOGW(TAG, "failed to grow TX playback buffer to %u bytes", (unsigned)byte_count);
            return false;
        }
        s_tx_buffer = grown;
        s_tx_buffer_cap_bytes = byte_count;
    }
    memcpy(s_tx_buffer, data, byte_count);
    s_tx_buffer_len_bytes = byte_count;
    ESP_LOGI(TAG, "TX playback buffer uploaded: %u bytes (%u ms @ %dHz)",
              (unsigned)byte_count, (unsigned)audio_monitor_tx_buffer_duration_ms(), MIC_SEND_SAMPLE_RATE_HZ);
    return true;
}

bool audio_monitor_tx_buffer_ready(void) {
    return s_tx_buffer_len_bytes > 0;
}

size_t audio_monitor_tx_buffer_byte_count(void) {
    return s_tx_buffer_len_bytes;
}

uint32_t audio_monitor_tx_buffer_duration_ms(void) {
    // bytes -> samples (2 bytes/sample, mono) -> ms, at the fixed wire rate
    // this buffer is always stored at (see MIC_SEND_SAMPLE_RATE_HZ's own
    // comment for why this never varies with the codec's configured rate).
    return (uint32_t)(((uint64_t)s_tx_buffer_len_bytes / 2) * 1000 / MIC_SEND_SAMPLE_RATE_HZ);
}

// Chunk size/cadence matches READ_WINDOW_MS exactly — not a new, separately
// invented timing constant. This is deliberate: audio_task's RX side (and
// therefore the /audio wire format's own chunking, since the browser's
// mic-send path targets the same real-time rate) already characterizes
// "how much real-time audio work is reasonable to do, in one go, on this
// core" for this exact codec — reusing it means this task's blocking
// profile is a known quantity, not a fresh guess that could turn out too
// coarse (a chunk so large it risks its own watchdog-adjacent stall) or too
// fine (needless task-wake overhead for no benefit).
#define TX_PLAY_CHUNK_SAMPLES ((size_t)((uint64_t)MIC_SEND_SAMPLE_RATE_HZ * READ_WINDOW_MS / 1000))

// No task-arg struct needed (unlike a generic FreeRTOS task that takes
// caller-specific parameters) — every value this task needs
// (s_tx_buffer/s_tx_buffer_len_bytes) is already file-scope state, stable
// for the task's whole run since audio_monitor_tx_buffer_upload() refuses
// to touch it while s_tx_playing is true (set true below before this task
// does anything else observable).
static void tx_play_task(void *arg) {
    (void)arg;
    uint32_t duration_ms = audio_monitor_tx_buffer_duration_ms();
    size_t total_samples = s_tx_buffer_len_bytes / sizeof(int16_t);
    size_t pos_samples = 0;
    atomic_store(&s_tx_position_ms, 0);
    atomic_store(&s_tx_playing, true);

    ESP_LOGI(TAG, "TX playback started: %u samples, %u ms", (unsigned)total_samples, (unsigned)duration_ms);

    while (pos_samples < total_samples) {
        if (atomic_load(&s_tx_play_stop_requested)) {
            ESP_LOGI(TAG, "TX playback stopped early at %u/%u samples", (unsigned)pos_samples, (unsigned)total_samples);
            break;
        }
        size_t chunk = total_samples - pos_samples;
        if (chunk > TX_PLAY_CHUNK_SAMPLES) chunk = TX_PLAY_CHUNK_SAMPLES;

        // Same DAC-write/RMS/LED pipeline /audio's live mic-send path uses
        // — see audio_monitor_report_out_samples()'s own comment for why
        // this is the one and only sink to feed rather than re-deriving
        // audio_rx_callback()'s upsample/stereo-duplication/
        // esp_codec_dev_write() logic a second time here.
        audio_monitor_report_out_samples(s_tx_buffer + pos_samples, chunk);

        pos_samples += chunk;
        atomic_store(&s_tx_position_ms, (uint32_t)(((uint64_t)pos_samples * 1000) / MIC_SEND_SAMPLE_RATE_HZ));

        // NO vTaskDelay here, deliberately — a real bug (2026-08-25,
        // confirmed via the bridge's own audio-mic-sniff waterfall showing
        // periodic gaps/dropouts after the clipping fix landed) was an
        // earlier version of this loop sleeping READ_WINDOW_MS on top of
        // esp_codec_dev_write() itself, on the mistaken belief that the
        // write call "mostly" paces this and the sleep was just a safety
        // margin. It's not a safety margin — esp_codec_dev_write() ->
        // i2s_channel_write() already BLOCKS for the real time this
        // chunk's worth of samples takes to play (that's the actual DMA
        // pacing mechanism, the same one audio_task's RX-side
        // esp_codec_dev_read() relies on with NO extra vTaskDelay of its
        // own — see that function above, the pattern this was supposed to
        // mirror). Adding a full extra READ_WINDOW_MS sleep after an
        // already-~READ_WINDOW_MS-long blocking write made each chunk
        // cycle take roughly DOUBLE real time, starving the DMA ring
        // buffer between writes — audible/visible as periodic dropouts,
        // not the "dump everything instantly" failure this was guarding
        // against (which was never actually possible here, since the
        // write call itself blocks).
    }

    atomic_store(&s_tx_playing, false);
    atomic_store(&s_tx_play_stop_requested, false);
    ESP_LOGI(TAG, "TX playback finished");
    atomic_store(&s_tx_play_task_alive, false);
    vTaskDelete(NULL);
}

bool audio_monitor_tx_play(void) {
    if (!audio_monitor_tx_buffer_ready()) return false;
    if (atomic_load(&s_tx_playing) || atomic_load(&s_tx_play_task_alive)) return false;

    atomic_store(&s_tx_play_task_alive, true);
    // Pinned to RELAY_TASK_CORE at AUDIO_MONITOR_TASK_PRIO (see
    // bridge_config.h's TX_PLAY_TASK_CORE/TX_PLAY_TASK_PRIO comment) — a
    // GENUINELY SEPARATE task from the httpd worker that answered this very
    // POST /tx-play request, not more work stuffed into that request's own
    // handler function. That distinction is the entire point: a real prior
    // incident (documented on UPSAMPLE_SINC_HALF_WIDTH's comment above) had
    // CPU-heavy work running inside the httpd worker context during TX
    // starve IDLE0 long enough to trip the task watchdog and force a full
    // reboot mid-transmission — exactly the failure this architecture
    // exists to make structurally impossible for this feature, not just
    // unlikely.
    BaseType_t created = xTaskCreatePinnedToCore(tx_play_task, "tx_play", 4096, NULL,
                                                  TX_PLAY_TASK_PRIO, NULL, TX_PLAY_TASK_CORE);
    if (created != pdPASS) {
        ESP_LOGW(TAG, "failed to create TX playback task");
        atomic_store(&s_tx_play_task_alive, false);
        return false;
    }
    return true;
}

void audio_monitor_tx_get_status(audio_monitor_tx_status_t *out) {
    out->playing = atomic_load(&s_tx_playing);
    out->position_ms = atomic_load(&s_tx_position_ms);
    out->duration_ms = audio_monitor_tx_buffer_duration_ms();
}

// Bounded wait rather than an unbounded one — tx_play_task() checks
// s_tx_play_stop_requested once per TX_PLAY_CHUNK_SAMPLES chunk (up to
// READ_WINDOW_MS between checks), so this should normally return within a
// loop iteration or two; the timeout exists purely so a caller can never
// hang forever if the task somehow got stuck (e.g. blocked for longer than
// expected inside esp_codec_dev_write()) rather than genuinely finishing —
// matching this codebase's general preference (see /reset's restart_task
// vTaskDelay, /rx-slot's own brief pause) for bounded waits over open-ended
// blocking on hardware-adjacent state.
#define TX_STOP_WAIT_TIMEOUT_MS 1000
#define TX_STOP_WAIT_POLL_MS 20

bool audio_monitor_tx_stop(void) {
    if (!atomic_load(&s_tx_playing)) return true; // nothing playing — trivially "stopped"

    atomic_store(&s_tx_play_stop_requested, true);
    int waited_ms = 0;
    while (atomic_load(&s_tx_playing) && waited_ms < TX_STOP_WAIT_TIMEOUT_MS) {
        vTaskDelay(pdMS_TO_TICKS(TX_STOP_WAIT_POLL_MS));
        waited_ms += TX_STOP_WAIT_POLL_MS;
    }
    bool stopped = !atomic_load(&s_tx_playing);
    if (!stopped) {
        // Never observed on real hardware as of writing — logged rather
        // than silently reported as success so a genuinely stuck task
        // would leave a trace to investigate, instead of POST /tx-stop
        // quietly lying about having actually stopped it.
        ESP_LOGW(TAG, "TX playback did not stop within %dms of a stop request", TX_STOP_WAIT_TIMEOUT_MS);
    }
    return stopped;
}

int audio_monitor_find_adc_input(const char *name) {
    for (size_t i = 0; i < ADC_INPUT_OPTIONS_COUNT; i++) {
        if (strcmp(ADC_INPUT_OPTIONS[i].name, name) == 0) return (int)i;
    }
    return -1;
}

// Live-switches the ES8388's ADC input mux to one of ADC_INPUT_OPTIONS —
// see the ADCCONTROL2 comment above for why this sweeps every option the
// chip supports rather than a single onboard-mic-vs-P2-jack guess: that
// guess was tested on real hardware and had no audible effect either way,
// so the actual correct value (if any of these even map to the physically
// wired mic/jack the way expected) needs to be found by trying each one.
bool audio_monitor_set_adc_input(int idx) {
    if (!s_codec_ctrl_if) return false; // codec never came up — audio monitor disabled
    if (idx < 0 || (size_t)idx >= ADC_INPUT_OPTIONS_COUNT) return false;
    int adc_input = ADC_INPUT_OPTIONS[idx].reg_value;

    // Bracket the mux write with a full power-down/power-up of the ADC
    // analog block, matching es8388_open()'s own sequence exactly — see the
    // comment above ES8388_REG_ADCPOWER for why a bare mux write alone
    // doesn't actually change what's heard on this chip.
    int power_down = ES8388_ADCPOWER_DOWN_ALL;
    int reg_ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ADCPOWER, 1, &power_down, 1);
    reg_ret |= s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ADCCONTROL2, 1, &adc_input, 1);
    int power_up = ES8388_ADCPOWER_UP_ADC;
    reg_ret |= s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ADCPOWER, 1, &power_up, 1);
    if (reg_ret != 0) {
        ESP_LOGW(TAG, "ADC input switch write failed (ret=%d) — input may not have actually switched", reg_ret);
        return false;
    }
    atomic_store(&s_adc_input_idx, idx);
    ESP_LOGI(TAG, "ADC input set to \"%s\" (reg=0x%02x, power-cycled)", ADC_INPUT_OPTIONS[idx].name, adc_input);
    return true;
}

// Live-adjusts the ES8388's MIC preamp (PGA) gain, in dB — es8388_open()
// hardcodes this to 0xbb (a non-zero gain) on every boot regardless of
// which ADCCONTROL2 input mode is actually selected. Real-hardware testing
// found the onboard MIC1 preamp audibly bleeding into every input mode,
// including modes that shouldn't route MIC1 at all — this dedicated PGA
// gain register is the one clean, documented (via esp_codec_dev's public
// API, not a guessed bit) way to attenuate that bleed without touching
// ADCCONTROL2 itself. db_value <= 0 drives the PGA to its minimum gain
// (see es8388_set_mic_gain() in the vendored driver — this isn't a mute/
// power-down, just gain turned down as far as the register allows).
bool audio_monitor_set_mic_gain_db(float db_value) {
    if (!s_codec_dev) return false; // codec never came up — audio monitor disabled
    int ret = esp_codec_dev_set_in_gain(s_codec_dev, db_value);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGW(TAG, "esp_codec_dev_set_in_gain(%.1f) failed (ret=%d)", db_value, ret);
        return false;
    }
    atomic_store(&s_mic_gain_db, db_value);
    ESP_LOGI(TAG, "MIC PGA gain set to %.1f dB", db_value);
    return true;
}

float audio_monitor_get_mic_gain_db(void) {
    return atomic_load(&s_mic_gain_db);
}

// Live-toggles ALC (Automatic Level Control) — see the ALCCONTROL comment
// above for why this exists as a checkable control rather than something
// silently assumed off: it's confirmed off by the chip's own power-on-reset
// default (the vendored driver never touches these registers), but exposed
// here so that can be verified/experimented with, not just trusted.
// Enabling uses ALCSEL=stereo (both channels) with MAXGAIN/MINGAIN left at
// their reset-default values — this is a diagnostic on/off switch, not a
// tuned ALC profile; see the datasheet's own "Recommended Settings for
// ALC" table if a specific hold/decay/attack profile is ever needed.
bool audio_monitor_set_alc_enabled(bool enabled) {
    if (!s_codec_ctrl_if) return false; // codec never came up — audio monitor disabled
    int reg_value = enabled ? ES8388_ALCSEL_STEREO : ES8388_ALCCONTROL1_DEFAULT;
    int ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ALCCONTROL1, 1, &reg_value, 1);
    if (ret != 0) {
        ESP_LOGW(TAG, "ALCCONTROL1 write failed (ret=%d)", ret);
        return false;
    }
    atomic_store(&s_alc_enabled, enabled);
    ESP_LOGI(TAG, "ALC %s", enabled ? "enabled" : "disabled");
    return true;
}

bool audio_monitor_get_alc_enabled(void) {
    return atomic_load(&s_alc_enabled);
}

// Live-toggles the ALC's Noise Gate sub-feature (NGAT bit in ALC Control
// 5) — same "confirmed off by reset default, exposed as a checkable
// toggle" reasoning as ALC above. Note the noise gate only has any effect
// while ALC itself is enabled (it's part of the same ALC block per the
// datasheet's block diagram) — toggling this on with ALC off is harmless
// but won't audibly do anything until ALC is also on.
bool audio_monitor_set_noise_gate_enabled(bool enabled) {
    if (!s_codec_ctrl_if) return false; // codec never came up — audio monitor disabled
    int reg_value = enabled ? (ES8388_ALCCONTROL5_DEFAULT | ES8388_NGAT_ENABLE_BIT) : ES8388_ALCCONTROL5_DEFAULT;
    int ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ALCCONTROL5, 1, &reg_value, 1);
    if (ret != 0) {
        ESP_LOGW(TAG, "ALCCONTROL5 write failed (ret=%d)", ret);
        return false;
    }
    atomic_store(&s_noise_gate_enabled, enabled);
    ESP_LOGI(TAG, "Noise gate %s", enabled ? "enabled" : "disabled");
    return true;
}

bool audio_monitor_get_noise_gate_enabled(void) {
    return atomic_load(&s_noise_gate_enabled);
}

// Live-toggles the ADC's digital high-pass filter (see the ADCCONTROL6
// comment above) — UNLIKE ALC/noise-gate, this one is ON by datasheet
// default and was never touched by the vendored driver, so "disabling" is
// the actual diagnostic direction here: exposed as a checkable toggle to
// let the operator compare with/without while chasing a reported broadband
// noise floor. Does not track which physical channel is active — both
// ADC_HPF_L and ADC_HPF_R bits are always written together, since this
// board only ever uses one channel at a time (see audio_monitor_set_rx_slot())
// and it's simpler/harmless to keep both in lockstep than to track which
// bit corresponds to whichever channel is currently selected.
bool audio_monitor_set_adc_hpf_enabled(bool enabled) {
    if (!s_codec_ctrl_if) return false; // codec never came up — audio monitor disabled
    int reg_value = enabled ? ES8388_ADCCONTROL6_DEFAULT : ES8388_ADCCONTROL6_HPF_OFF;
    int ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ADCCONTROL6, 1, &reg_value, 1);
    if (ret != 0) {
        ESP_LOGW(TAG, "ADCCONTROL6 write failed (ret=%d)", ret);
        return false;
    }
    atomic_store(&s_adc_hpf_enabled, enabled);
    ESP_LOGI(TAG, "ADC HPF %s", enabled ? "enabled" : "disabled");
    return true;
}

bool audio_monitor_get_adc_hpf_enabled(void) {
    return atomic_load(&s_adc_hpf_enabled);
}

// Live-forces ES8388_PA_ENABLE_PIN (the NS4150 speaker amp's own
// enable/shutdown line) to whichever level corresponds to "enabled" or
// "disabled" — see s_speaker_amp_enabled's comment for why this exists as
// a live A/B toggle rather than a one-shot guess. Direct gpio_set_level(),
// bypassing the codec's own gpio_if abstraction entirely: the vendored
// driver already configured this pin as a plain output during
// esp_codec_dev_open() (es8388_pa_power() -> gpio_if->setup(...,
// AUDIO_GPIO_DIR_OUT, ...)), and nothing in this firmware ever calls back
// into es8388_enable()/es8388_close() during normal operation (the codec
// is opened once at boot and stays open) — so a direct override here holds
// indefinitely with no risk of the driver silently re-asserting its own
// value over it moments later. Always "succeeds" (a plain GPIO write can't
// meaningfully fail) — kept as a bool return for symmetry with the other
// audio_monitor_set_* toggles.
bool audio_monitor_set_speaker_amp_enabled(bool enabled) {
    // ES8388_PA_REVERTED's own polarity is an unconfirmed guess (see
    // bridge_config.h) — applying that SAME guess here (rather than
    // hardcoding a direction) means this toggle's "enabled"/"disabled"
    // labels stay meaningful regardless of which way the guess turns out
    // to be: if the guess is right, "enabled" really does enable the amp;
    // if it's backwards, the operator will hear/measure that immediately
    // and know to flip ES8388_PA_REVERTED itself, rather than this toggle
    // silently doing the opposite of what its label claims.
    bool level_high = ES8388_PA_REVERTED ? !enabled : enabled;
    gpio_set_level(ES8388_PA_ENABLE_PIN, level_high ? 1 : 0);
    atomic_store(&s_speaker_amp_enabled, enabled);
    ESP_LOGI(TAG, "Speaker amp (NS4150) forced %s (GPIO%d driven %s)",
             enabled ? "enabled" : "disabled", ES8388_PA_ENABLE_PIN, level_high ? "HIGH" : "LOW");
    return true;
}

bool audio_monitor_get_speaker_amp_enabled(void) {
    return atomic_load(&s_speaker_amp_enabled);
}

// Live-switches which I2S slot (left/right) the ADC capture side reads —
// independent of audio_monitor_set_adc_input()'s ADCCONTROL2 mux
// selection. These are two separate axes: ADCCONTROL2 picks which physical
// pins (LIN1/LIN2/MIC1/MIC2/diff) reach the ES8388's internal ADC, while
// this I2S slot mask picks which of the ADC's two resulting digital
// channels (left or right) the ESP32 actually keeps once digitized. A
// jack's tip signal could land on EITHER channel depending on board
// wiring, and real-hardware testing needed to sweep both axes together
// (5 inputs x 2 slots = 10 combinations) rather than assuming left is
// always correct (I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG's mono default).
//
// Requires disabling, reconfiguring, and re-enabling the RX channel —
// unlike the ES8388 register writes above, this isn't a single I2C
// transaction. audio_task is paused (s_rx_paused) for the brief window so
// it never calls esp_codec_dev_read() on a channel we've just disabled out
// from under esp_codec_dev's own (unaware) state tracking.
bool audio_monitor_set_rx_slot(bool use_right) {
    if (!s_rx_handle) return false; // codec never came up — audio monitor disabled
    atomic_store(&s_rx_paused, true);
    vTaskDelay(pdMS_TO_TICKS(30)); // let any in-flight esp_codec_dev_read() finish before we touch the channel

    esp_err_t err = i2s_channel_disable(s_rx_handle);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "i2s_channel_disable failed: %s", esp_err_to_name(err));
        atomic_store(&s_rx_paused, false);
        return false;
    }

    i2s_std_slot_config_t slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    slot_cfg.slot_mask = use_right ? I2S_STD_SLOT_RIGHT : I2S_STD_SLOT_LEFT;
    err = i2s_channel_reconfig_std_slot(s_rx_handle, &slot_cfg);
    bool ok = err == ESP_OK;
    if (!ok) {
        ESP_LOGW(TAG, "i2s_channel_reconfig_std_slot failed: %s", esp_err_to_name(err));
    }

    err = i2s_channel_enable(s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable failed after RX slot switch: %s — audio capture may be dead until reboot", esp_err_to_name(err));
        ok = false;
    }

    atomic_store(&s_rx_paused, false);
    if (ok) {
        atomic_store(&s_rx_slot_is_right, use_right);
        ESP_LOGI(TAG, "ADC RX slot set to %s", use_right ? "right" : "left");
    }
    return ok;
}

bool audio_monitor_get_rx_slot_is_right(void) {
    return atomic_load(&s_rx_slot_is_right);
}

const char *audio_monitor_get_adc_input_name(void) {
    int idx = atomic_load(&s_adc_input_idx);
    return ADC_INPUT_OPTIONS[idx].name;
}

// Radio -> browser. Two distinct modes, resolved once at boot (see
// s_input_mode) and never mixed within one run of this task:
//   AUDIO_INPUT_MODE_AUDIO — mono (this board keeps one I2S slot, see
//     audio_monitor_set_rx_slot()), broadcasts s_read_samples samples to
//     every connected /audio client, same as always.
//   AUDIO_INPUT_MODE_IQ — stereo (both I2S slots kept — I on left, Q on
//     right), broadcasts to /iq-data instead; s_read_samples still counts
//     SAMPLE PAIRS per window (so it means the same "how many 50ms-window
//     units" thing in both modes), so twice that many int16 values are
//     actually read/sent per iteration.
// s_read_samples itself is sized once in audio_monitor_start() from the
// actual configured sample rate, not a compile-time constant, since POST
// /sample-rate can change that rate (reboot to apply).
static void audio_task(void *arg) {
    bool iq_mode = audio_monitor_get_input_mode() == AUDIO_INPUT_MODE_IQ;
    size_t values_per_read = iq_mode ? s_read_samples * 2 : s_read_samples;
    // PSRAM (MALLOC_CAP_SPIRAM) — same reasoning as s_tx_stereo_scratch
    // above: esp_codec_dev_read() -> _i2s_data_read() (audio_codec_data_i2s.c)
    // calls i2s_channel_read(), which memcpy()s FROM its own internal DMA
    // descriptors INTO this caller-supplied buffer — the destination has no
    // DMA-capability requirement, symmetric with the write side. This was
    // originally left on internal RAM under the same now-disproven
    // assumption, and it's the buffer that directly caused a real-hardware
    // failure: "failed to allocate read buffer, audio monitor disabled" at
    // boot in I/Q + 48kHz mode (a 9600-byte allocation failing under
    // internal-RAM fragmentation) — this completely disabled the audio
    // monitor for the rest of that boot, exactly the "single blip then
    // stuck" symptom this was investigating.
    int16_t *buf = heap_caps_malloc(values_per_read * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    if (!buf) {
        ESP_LOGE(TAG, "failed to allocate read buffer, audio monitor disabled");
        vTaskDelete(NULL);
        return;
    }

    int64_t last_loop_start_us = 0;
    for (;;) {
        if (atomic_load(&s_rx_paused)) {
            // audio_monitor_set_rx_slot() is mid-reconfig — see its comment.
            // Not reading during this window is deliberate; it's a brief,
            // rare, operator-triggered event (a diagnostic live-switch),
            // not a steady-state condition worth optimizing around.
            // (Only ever true in AUDIO_INPUT_MODE_AUDIO — I/Q mode has no
            // live RX-slot toggle, see audio_monitor_set_rx_slot()'s guard.)
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        int64_t loop_start_us = esp_timer_get_time();
        if (last_loop_start_us != 0) {
            int64_t interval_us = loop_start_us - last_loop_start_us;
            int64_t prev_max = atomic_load(&s_rx_max_loop_interval_us);
            if (interval_us > prev_max) atomic_store(&s_rx_max_loop_interval_us, interval_us);
        }
        last_loop_start_us = loop_start_us;

        int ret = esp_codec_dev_read(s_codec_dev, buf, values_per_read * sizeof(int16_t));
        int64_t after_read_us = esp_timer_get_time();
        {
            int64_t read_us = after_read_us - loop_start_us;
            int64_t prev_max = atomic_load(&s_rx_max_read_duration_us);
            if (read_us > prev_max) atomic_store(&s_rx_max_read_duration_us, read_us);
        }
        if (ret != ESP_CODEC_DEV_OK) {
            ESP_LOGW(TAG, "codec read failed (%d), retrying", ret);
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        if (iq_mode) {
            audio_iq_broadcast(buf, values_per_read);
        } else {
            audio_ws_send_to_clients(buf, s_read_samples);
        }
        {
            int64_t broadcast_us = esp_timer_get_time() - after_read_us;
            int64_t prev_max = atomic_load(&s_rx_max_broadcast_duration_us);
            if (broadcast_us > prev_max) atomic_store(&s_rx_max_broadcast_duration_us, broadcast_us);
        }
        atomic_fetch_add(&s_rx_loop_count, 1);
    }
}

// Read-and-reset — see s_rx_max_loop_interval_us's own comment for why
// this reports "max since the last call" rather than an all-time max.
void audio_monitor_get_rx_timing(audio_monitor_rx_timing_t *out) {
    out->max_loop_interval_us = atomic_exchange(&s_rx_max_loop_interval_us, 0);
    out->max_read_duration_us = atomic_exchange(&s_rx_max_read_duration_us, 0);
    out->max_broadcast_duration_us = atomic_exchange(&s_rx_max_broadcast_duration_us, 0);
    out->loop_count = atomic_exchange(&s_rx_loop_count, 0);
}

void audio_monitor_start(void) {
    uint32_t sample_rate_hz = bridge_settings_get_sample_rate_hz();
    s_read_samples = (size_t)((uint64_t)sample_rate_hz * READ_WINDOW_MS / 1000);

    char saved_mode_name[8];
    bridge_settings_get_input_mode_name(saved_mode_name, sizeof(saved_mode_name));
    audio_input_mode_t input_mode = AUDIO_INPUT_MODE_AUDIO;
    if (!audio_monitor_parse_input_mode(saved_mode_name, &input_mode)) {
        ESP_LOGW(TAG, "unrecognized saved input mode \"%s\" — defaulting to audio", saved_mode_name);
        input_mode = AUDIO_INPUT_MODE_AUDIO;
    }
    atomic_store(&s_input_mode, (int)input_mode);
    bool iq_mode = input_mode == AUDIO_INPUT_MODE_IQ;
    ESP_LOGI(TAG, "input mode: %s", audio_monitor_input_mode_name(input_mode));

    i2c_master_bus_config_t i2c_bus_cfg = {
        .i2c_port = ES8388_I2C_PORT,
        .sda_io_num = ES8388_I2C_SDA_PIN,
        .scl_io_num = ES8388_I2C_SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus;
    esp_err_t err = i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_new_master_bus failed: %s — audio monitor disabled", esp_err_to_name(err));
        return;
    }

    // dma_desc_num/dma_frame_num set explicitly (not left at
    // I2S_CHANNEL_DEFAULT_CONFIG's own 6/240) rather than exposed as a live
    // web control: this axis only trades latency against underrun/overrun
    // risk (a dropped-frame click/pop, a scheduling problem) — it has no
    // plausible mechanism to inject the kind of continuous analog
    // noise/hiss this board's investigation has been chasing, since the
    // ES8388 path is fully digital I2S end to end, not the ESP32's own SAR
    // ADC. A fixed FRAME COUNT would mean a shrinking wall-clock buffer
    // margin as the configured sample rate goes up (double the rate, half
    // the milliseconds of headroom) — scaled here by sample_rate_hz /
    // ES8388_SAMPLE_RATE_HZ instead, so the ~180ms of buffered headroom
    // this was originally tuned for at 8000 Hz stays roughly constant
    // across every supported rate. Capped so dma_frame_num * bytes/frame
    // never exceeds the I2S driver's 4092-byte single-descriptor limit —
    // 2000 frames/4000 bytes at mono 16-bit's 2 bytes/frame, halved to 1000
    // frames in AUDIO_INPUT_MODE_IQ (4 bytes/frame — stereo 16-bit, both
    // slots) for the same 4000-byte ceiling.
    uint32_t dma_frame_cap = iq_mode ? 1000 : 2000;
    uint32_t dma_frame_num = 240 * sample_rate_hz / ES8388_SAMPLE_RATE_HZ;
    if (dma_frame_num > dma_frame_cap) dma_frame_num = dma_frame_cap;

    // dma_desc_num compensates for the frame cap above: once dma_frame_num
    // itself gets capped (bites at 44.1kHz+ in I/Q mode, 48kHz+ mono), each
    // descriptor holds proportionally LESS time as the configured rate
    // climbs, which would otherwise quietly erode the ~180ms buffered
    // headroom the frame-count scaling above was designed to hold
    // constant — found via real-hardware task-timing analysis: I/Q mode at
    // 96kHz, capped to 1000 frames/4000 bytes per descriptor, only holds
    // ~10.4ms per descriptor; a fixed 6 descriptors would leave just
    // ~62.5ms of total headroom (vs. audio mode's ~180ms) — under 3x the
    // CAT UART reader's own worst-case 20ms uart_read_bytes() block (see
    // cat_bridge.c), a real but comfortable margin at every OTHER rate,
    // uncomfortably tight specifically here. Scaled up to restore ~180ms
    // whenever the frame cap actually bit — i.e. a no-op everywhere else,
    // since 6 already gives ~180ms once dma_frame_num itself scales freely
    // with rate.
    //
    // REAL HARDWARE INCIDENT (both parts of this fixed in the same pass):
    // at 96kHz I/Q with the persistent CAT log ALSO enabled, the naive
    // "just compute the ideal descriptor count" version of this code
    // requested more DMA-capable memory than was actually free — cat_log's
    // one-time 64KB boot-recovery buffer is freed before this point, but
    // evidently leaves the DMA-capable pool (a STRICTLY NARROWER pool than
    // general internal RAM — see cpu_monitor.h's dma_free_bytes comment)
    // too fragmented for the larger request this scaling produces. That
    // first surfaced as an ESP_ERROR_CHECK abort (fixed: the
    // i2s_channel_init_std_mode() calls below now handle allocation
    // failure gracefully), but even with that fixed, the SAME underlying
    // shortage then cascaded through esp_codec_dev's internal reconfig
    // path into a genuine memory-corruption-style crash (Guru Meditation)
    // — not something safely patchable call-by-call. The actual fix is
    // PREVENTION: check real available DMA memory before ever attempting
    // the allocation, and back off the descriptor count (never below the
    // safe-baseline 6, which this device has run at reliably at every
    // rate/mode) rather than requesting more than what's actually free.
    // A 25% margin below the measured largest-free-block (not the full
    // amount) is deliberate slack for other DMA-capable allocations still
    // to come later in this boot sequence and over the device's uptime —
    // this is a headroom decision, not an exact accounting.
    uint32_t ms_per_descriptor = (dma_frame_num * 1000) / sample_rate_hz;
    uint32_t ideal_desc_num = ms_per_descriptor > 0 ? (180 / ms_per_descriptor) + 1 : 6;
    if (ideal_desc_num < 6) ideal_desc_num = 6;
    if (ideal_desc_num > 16) ideal_desc_num = 16;

    // Both TX and RX need accounting here, not just RX: in
    // AUDIO_INPUT_MODE_IQ, std_cfg (TX) is ALSO stereo now (see its own
    // comment above for why — esp_codec_dev_open() forces both directions
    // to the same channel count regardless), so i2s_new_channel() below
    // allocates TWO stereo-sized DMA buffer sets from chan_cfg's shared
    // dma_desc_num/dma_frame_num, not one. Budgeting for only one
    // direction here is exactly the gap that let a real hardware crash
    // through even after this pre-flight check was first added.
    uint32_t dma_desc_num = 6; // safe baseline — this device runs reliably at 6 descriptors at every rate/mode
    size_t dma_free_now = heap_caps_get_largest_free_block(MALLOC_CAP_DMA);
    size_t bytes_per_frame = iq_mode ? 4 : 2;
    size_t channel_count = iq_mode ? 2 : 1; // TX + RX both stereo-sized in I/Q mode; only RX matters for the frame-cap math in audio mode (TX stays mono/small there)
    for (uint32_t candidate = ideal_desc_num; candidate > dma_desc_num; candidate--) {
        size_t needed = (size_t)dma_frame_num * bytes_per_frame * candidate * channel_count;
        if (needed <= dma_free_now * 3 / 4) { dma_desc_num = candidate; break; } // 25% margin — see comment above
    }
    if (dma_desc_num < ideal_desc_num) {
        ESP_LOGW(TAG, "only %u descriptors fit in available DMA memory (%u bytes free, largest block) — wanted %u for full anti-jitter headroom",
                 (unsigned)dma_desc_num, (unsigned)dma_free_now, (unsigned)ideal_desc_num);
    }

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(ES8388_I2S_PORT,
        ES8388_MASTER_MODE ? I2S_ROLE_MASTER : I2S_ROLE_SLAVE);
    chan_cfg.dma_desc_num = dma_desc_num;
    chan_cfg.dma_frame_num = dma_frame_num;
    i2s_chan_handle_t tx_handle, rx_handle;
    err = i2s_new_channel(&chan_cfg, &tx_handle, &rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel failed: %s — audio monitor disabled", esp_err_to_name(err));
        return;
    }

    // NOTE: the vendored es8388_open() (managed_components/
    // espressif__esp_codec_dev/device/es8388/es8388.c) unconditionally
    // writes an undocumented "disable the internal DLL to improve 8K
    // sample rate" register sequence (0x35/0x37/0x39) regardless of what
    // rate is actually configured — a targeted fix for 8kHz specifically,
    // of unknown (untested at rates above 32kHz) effect at higher
    // configured rates. No other ES8388 driver researched (Espressif's own
    // older esp-adf driver, two independent Linux ALSA drivers) touches
    // these registers at all, and none document a "restore" value for
    // them either — so there's no safe value to re-apply after the fact,
    // unlike the RX-slot/ADC-input clobbering this same open() call causes
    // elsewhere in this function. Left as-is deliberately: 8/16/32kHz have
    // been verified working on real hardware with this left in place;
    // 44.1/48kHz are untested territory for this specific interaction —
    // if audio sounds wrong specifically at those two rates and not the
    // others, this is the first place to look.
    // slot_cfg is MONO here unconditionally in AUDIO_INPUT_MODE_AUDIO — the
    // TX/DAC side (browser mic -> radio mic input, via /audio) is always
    // mono data regardless of input mode, since I/Q only concerns the ADC
    // capture side. BUT in AUDIO_INPUT_MODE_IQ this must ALSO be STEREO,
    // even though this TX handle has nothing to do with I/Q data — found
    // via a real hardware crash: esp_codec_dev_open() (below) is given
    // ONE esp_codec_dev_sample_info_t with channel=2 for I/Q mode, and
    // because this codec is opened as ESP_CODEC_DEV_TYPE_IN_OUT, its
    // internal _i2s_data_set_fmt() applies that SAME channel=2 to BOTH
    // in_fs and out_fs (see that function's IN_OUT branch) — there is no
    // way to tell it "stereo for RX, mono for TX" through this API. If
    // this TX handle were left mono here, esp_codec_dev_open() would
    // force it to stereo internally anyway, via i2s_channel_reconfig_std_slot()
    // — a SECOND, unplanned DMA reallocation this function's own
    // dma_desc_num pre-flight check (below) never accounted for, which is
    // exactly what crashed (i2s_alloc_dma_desc failing deep inside that
    // internal reconfig, cascading into a Guru Meditation crash rather
    // than a clean error — see that reconfig path's own lack of graceful
    // handling). Matching this handle's OWN initial config to what
    // esp_codec_dev_open() will end up requesting means that internal
    // reconfig becomes a no-op (buf_size unchanged, see
    // i2s_std_set_slot()'s own "only reallocate if buffer size changed"
    // check) instead of a second surprise allocation.
    i2s_slot_mode_t tx_slot_mode = iq_mode ? I2S_SLOT_MODE_STEREO : I2S_SLOT_MODE_MONO;
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sample_rate_hz),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, tx_slot_mode),
        .gpio_cfg = {
            .mclk = ES8388_I2S_MCLK_PIN,
            .bclk = ES8388_I2S_BCLK_PIN,
            .ws = ES8388_I2S_WS_PIN,
            .dout = ES8388_I2S_DOUT_PIN,
            .din = ES8388_I2S_DIN_PIN,
        },
    };
    // NOT ESP_ERROR_CHECK — the DMA descriptor buffers this call allocates
    // (lazily, inside i2s_std_set_slot()) are sized from dma_desc_num/
    // dma_frame_num above, which scale up with sample rate/input mode;
    // real hardware hit ESP_ERR_NO_MEM here under heap pressure (I/Q at
    // 96kHz + the persistent CAT log's own large one-time allocation both
    // active), and ESP_ERROR_CHECK's abort turned a "this feature can't
    // start" case into a full crash-reboot LOOP. Every other failure path
    // in this function already degrades gracefully (audio monitor
    // disabled, logged, rest of the bridge keeps running) — this needed
    // the same treatment, not a special exception.
    err = i2s_channel_init_std_mode(tx_handle, &std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_std_mode(tx) failed: %s — audio monitor disabled", esp_err_to_name(err));
        return;
    }

    // This initial slot choice (in AUDIO_INPUT_MODE_AUDIO) gets clobbered
    // back to LEFT by esp_codec_dev_open() below regardless of what's set
    // here (see the re-apply comment after that call for why) — kept
    // anyway so the channel starts in a defined, matching state rather
    // than whatever I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG's own untouched
    // default is, in case that ever changes upstream. In
    // AUDIO_INPUT_MODE_IQ this is STEREO instead — both I2S slots kept (I
    // on left, Q on right, confirmed on real hardware) — since raw I/Q
    // needs both ADC channels simultaneously, not a choice between them;
    // there is no per-slot "which one is correct" question the way there
    // is for demodulated mono audio, so no live re-toggle exists for this
    // axis (see audio_monitor_set_rx_slot()'s early-return guard below).
    i2s_std_config_t rx_std_cfg = std_cfg;
    bool rx_slot_right = bridge_settings_get_rx_slot_is_right();
    if (iq_mode) {
        i2s_std_slot_config_t iq_slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
        rx_std_cfg.slot_cfg = iq_slot_cfg; // slot_mask is already I2S_STD_SLOT_BOTH for non-mono per this macro's own definition
    } else {
        rx_std_cfg.slot_cfg.slot_mask = rx_slot_right ? I2S_STD_SLOT_RIGHT : I2S_STD_SLOT_LEFT;
    }
    // NOT ESP_ERROR_CHECK — same reasoning as the tx_handle init above,
    // and this is the specific call real hardware crash-looped on
    // (ESP_ERR_NO_MEM from i2s_alloc_dma_desc, at I/Q + 96kHz + the
    // persistent CAT log all active at once). tx_handle already
    // succeeded and holds its own DMA descriptors by this point, so it's
    // explicitly torn down on this failure path rather than leaked.
    err = i2s_channel_init_std_mode(rx_handle, &rx_std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_std_mode(rx) failed: %s — audio monitor disabled", esp_err_to_name(err));
        i2s_del_channel(tx_handle);
        i2s_del_channel(rx_handle);
        return;
    }
    atomic_store(&s_rx_slot_is_right, rx_slot_right);
    err = i2s_channel_enable(tx_handle);
    if (err == ESP_OK) err = i2s_channel_enable(rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable failed: %s — audio monitor disabled", esp_err_to_name(err));
        i2s_del_channel(tx_handle);
        i2s_del_channel(rx_handle);
        return;
    }
    s_rx_handle = rx_handle; // kept for audio_monitor_set_rx_slot()'s live re-config — see its comment

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = ES8388_I2C_PORT,
        .addr = ES8388_I2C_ADDR,
        .bus_handle = i2c_bus,
    };
    s_codec_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    const audio_codec_ctrl_if_t *ctrl_if = s_codec_ctrl_if;

    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = ES8388_I2S_PORT,
        .rx_handle = rx_handle,
        .tx_handle = tx_handle,
    };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();

    es8388_codec_cfg_t es8388_cfg = {
        .ctrl_if = ctrl_if,
        .gpio_if = gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH,
        .master_mode = ES8388_MASTER_MODE,
        .pa_pin = ES8388_PA_ENABLE_PIN,
        .pa_reverted = ES8388_PA_REVERTED,
    };
    const audio_codec_if_t *codec_if = es8388_codec_new(&es8388_cfg);
    if (!codec_if) {
        ESP_LOGE(TAG, "es8388_codec_new failed — check I2C wiring/address, audio monitor disabled");
        return;
    }

    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT,
        .codec_if = codec_if,
        .data_if = data_if,
    };
    s_codec_dev = esp_codec_dev_new(&dev_cfg);
    if (!s_codec_dev) {
        ESP_LOGE(TAG, "esp_codec_dev_new failed — audio monitor disabled");
        return;
    }

    // channel=1 (AUDIO_INPUT_MODE_AUDIO) special-cases through
    // esp_codec_dev's own _i2s_data_set_fmt() to force channel_mask to
    // LEFT-only (see that function's "When using one channel replace to
    // select channel 0 in default" comment, and the RX-slot re-apply
    // comment below for the full clobbering history this causes). channel=2
    // (AUDIO_INPUT_MODE_IQ) skips that special case entirely and falls
    // through to _i2s_data_set_fmt()'s "no channel_mask set" branch, which
    // builds a mask covering BOTH channels — i.e. genuine stereo capture,
    // through a supported path in this driver, not a workaround. Note
    // es8388_set_fs() (the ES8388-specific half of open()) only reads
    // bits_per_sample from this struct, never channel or sample_rate — see
    // the ES8388_SAMPLE_RATE_HZ comment above for why sample_rate here is
    // essentially documentation, not something this call enforces.
    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = 16,
        .channel = iq_mode ? 2 : 1,
        .sample_rate = sample_rate_hz,
    };
    int ret = esp_codec_dev_open(s_codec_dev, &fs);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "esp_codec_dev_open failed (%d) — audio monitor disabled", ret);
        return;
    }

    // Must run AFTER esp_codec_dev_open() — that call is what runs
    // es8388_open() internally, which is what writes CONTROL2 to
    // ES8388_CONTROL2_DRIVER_DEFAULT (0x50) in the first place, leaving
    // LPVrefBuf (the analog VREF buffer) in low-power mode — see the
    // ES8388_REG_CONTROL2 comment above for the full reasoning. Overwrite
    // it with every power bit at its highest-performance state; this
    // board has no power budget to protect.
    int control2_value = ES8388_CONTROL2_FULL_NORMAL;
    int control2_ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_CONTROL2, 1, &control2_value, 1);
    if (control2_ret != 0) {
        ESP_LOGW(TAG, "CONTROL2 VREF-buffer re-apply failed (ret=%d) — LPVrefBuf may still be low-power", control2_ret);
    } else {
        ESP_LOGI(TAG, "CONTROL2 set to full-normal (0x00) — VREF buffer out of low-power mode");
    }

    // Must run AFTER esp_codec_dev_open() — same reasoning as CONTROL2
    // above: es8388_open() (called internally by esp_codec_dev_open())
    // unconditionally writes ADCCONTROL5/DACCONTROL2 to single-speed mode
    // regardless of the actually configured rate, so writing any earlier
    // would just get overwritten. Only touched above 48000Hz (today's
    // top single-speed-verified rate) — leaving every other rate on the
    // driver's own untouched single-speed default rather than writing an
    // identical value back for no reason. See ES8388_REG_ADCCONTROL5's
    // comment above for the full reasoning/sourcing on this specific
    // register value, and the README's Known Limitations note — this is
    // genuinely unverified on real hardware, unlike every other register
    // override in this function.
    if (iq_mode && sample_rate_hz > 48000) {
        int fsmode_value = ES8388_FSMODE_DOUBLE_SPEED_R256;
        int adc_fsmode_ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_ADCCONTROL5, 1, &fsmode_value, 1);
        int dac_fsmode_ret = s_codec_ctrl_if->write_reg(s_codec_ctrl_if, ES8388_REG_DACCONTROL2, 1, &fsmode_value, 1);
        if (adc_fsmode_ret != 0 || dac_fsmode_ret != 0) {
            ESP_LOGW(TAG, "double-speed mode re-apply failed (adc_ret=%d, dac_ret=%d) — %uHz capture may be misclocked",
                     adc_fsmode_ret, dac_fsmode_ret, (unsigned)sample_rate_hz);
        } else {
            ESP_LOGI(TAG, "ADCCONTROL5/DACCONTROL2 set to double-speed mode (0x22, ratio 256) for %uHz — UNVERIFIED on real hardware, see README",
                     (unsigned)sample_rate_hz);
        }
    }

    // Must run AFTER esp_codec_dev_open() — that call is what programs
    // ADCCONTROL2 to the driver's hardcoded LIN1/RIN1 default in the first
    // place (see es8388_open() in the vendored driver), so writing any
    // earlier would just get overwritten. Starts from whatever was last
    // saved (see bridge_settings_get_adc_input_name()), not a hardcoded
    // guess — this setting is meant to be A/B tested and kept, not reset to
    // a default guess on every boot.
    char saved_input[8];
    bridge_settings_get_adc_input_name(saved_input, sizeof(saved_input));
    int saved_idx = audio_monitor_find_adc_input(saved_input);
    audio_monitor_set_adc_input(saved_idx >= 0 ? saved_idx : 0);

    // Also must run AFTER esp_codec_dev_open() — for the same reason as
    // ADC input above, but for the RX I2S slot: esp_codec_dev_open()'s
    // internal _i2s_data_set_fmt() (managed_components/espressif__esp_codec_dev/
    // platform/audio_codec_data_i2s.c) unconditionally forces the slot mask
    // back to LEFT/channel-0 whenever channel==1 (mono) — see that
    // function's "When using one channel replace to select channel 0 in
    // default" comment — clobbering whatever rx_std_cfg.slot_cfg.slot_mask
    // was set to above at i2s_channel_init_std_mode() time, on EVERY boot,
    // regardless of what was saved. This is why the RX slot always came up
    // Left after a reboot even though the browser's toggle (which calls
    // audio_monitor_set_rx_slot() directly, well after open() has already
    // run and won't run again) correctly fixed it live — confirmed by
    // reading the real esp_codec_dev source, not guessed. Re-applying the
    // saved slot here, the same way the live toggle does, is the fix.
    //
    // SKIPPED in AUDIO_INPUT_MODE_IQ: channel=2 above takes a DIFFERENT
    // path through _i2s_data_set_fmt() (the channel==1 special case never
    // triggers), so nothing clobbers rx_std_cfg's STEREO slot config back
    // to mono in the first place — there's nothing to re-apply. Calling
    // audio_monitor_set_rx_slot() here anyway would be actively wrong: it
    // unconditionally reconfigures to I2S_SLOT_MODE_MONO, which would
    // silently break I/Q capture right after correctly setting it up.
    if (!iq_mode && !audio_monitor_set_rx_slot(rx_slot_right)) {
        ESP_LOGW(TAG, "failed to re-apply saved RX slot (%s) after esp_codec_dev_open() reset it to left",
                 rx_slot_right ? "right" : "left");
    }

    // Same "start from whatever was last saved" reasoning as ADC input
    // above — see bridge_settings_get_mic_gain_db()'s comment for the
    // confirmed-on-real-hardware default (21dB).
    audio_monitor_set_mic_gain_db(bridge_settings_get_mic_gain_db());

    audio_ws_set_rx_callback(audio_rx_callback);

    // /iq-data only actually matters in AUDIO_INPUT_MODE_IQ, but
    // registering its route unconditionally (like audio_sniff_start()) is
    // simpler than threading input_mode through app_main.c/ws_server.c —
    // it costs nothing while idle (audio_iq_broadcast() is never called in
    // AUDIO_INPUT_MODE_AUDIO, see audio_task() above) and a client
    // connecting to /iq-data while the bridge is in audio mode just never
    // receives anything, same as any other WS endpoint with no producer
    // running. Buffer pool sized for exactly this boot's configured rate,
    // stereo (2 int16 values per sample pair) — matches audio_task()'s own
    // iq_mode byte count exactly, so a broadcast can never exceed the pool.
    audio_iq_start(ws_server_get_httpd(), s_read_samples * 2 * sizeof(int16_t));

    // Pinned to RELAY_TASK_CORE alongside the CAT UART reader (higher
    // priority, so it always wins contention) and the PA watchdog — see
    // bridge_config.h's Task placement notes for the full reasoning.
    xTaskCreatePinnedToCore(audio_task, "audio_monitor", 4096, NULL,
                             AUDIO_MONITOR_TASK_PRIO, NULL, AUDIO_MONITOR_TASK_CORE);
    ESP_LOGI(TAG, "ES8388 audio monitor started (mode=%s, in=ADC -> %s broadcast, out=/audio rx -> DAC)",
             audio_monitor_input_mode_name(input_mode), iq_mode ? "/iq-data" : "/audio");
}
