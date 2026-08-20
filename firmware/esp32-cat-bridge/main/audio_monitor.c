#include "audio_monitor.h"

#include <stdatomic.h>
#include <string.h>

#include "audio_codec_ctrl_if.h"
#include "driver/gpio.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "audio_sniff.h"
#include "audio_ws.h"
#include "bridge_config.h"
#include "bridge_settings.h"
#include "led_status.h"

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

static _Atomic int s_adc_input_idx = 0; // index into ADC_INPUT_OPTIONS — must match audio_monitor_start()'s initial write

// Browser -> radio: called by audio_ws whenever a /audio client sends a
// binary frame (remote operator's mic, already resampled by the browser
// to the bridge's configured sample rate — see useAudioBridge.ts, which
// reads that rate from GET /status rather than assuming a fixed value).
// Writes straight to the DAC; if no client is actually sending anything,
// this simply never gets called and the DAC just carries whatever silence
// esp_codec_dev/I2S underruns to on its own.
static void audio_rx_callback(const int16_t *samples, size_t count) {
    if (count == 0) return;
    int ret = esp_codec_dev_write(s_codec_dev, (void *)samples, count * sizeof(int16_t));
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGW(TAG, "codec write failed (%d)", ret);
    }
    // Read-only tap for GET /audio-mic-sniff — see audio_sniff.h for why
    // this exists (browser -> radio mic audio had no way to verify what
    // actually got written, at all). Broadcasts the SAME samples
    // regardless of whether the write above succeeded — a sniffer showing
    // "here's what we tried to send" is still useful even on a failed
    // write, and audio_sniff_broadcast() itself no-ops instantly if no
    // client is listening, so this never adds real cost to the normal
    // (no sniffer attached) case.
    audio_sniff_broadcast(samples, count);
}

void audio_monitor_report_out_samples(const int16_t *samples, size_t count) {
    // Kept as a thin alias — a future in-firmware playback source (rather
    // than the /audio WebSocket) could feed the same level/LED pipeline
    // this way without needing to know about audio_rx_callback at all.
    audio_rx_callback(samples, count);
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

// Radio -> browser: continuously reads the ADC (mono — this board only
// ever keeps one I2S slot, see audio_monitor_set_rx_slot()), updates the
// "in" LED level, and broadcasts to every connected /audio client. Reads
// s_read_samples-sized blocks — sized once in audio_monitor_start() from
// the actual configured sample rate, not a compile-time constant, since
// POST /sample-rate can change that rate (reboot to apply).
static void audio_task(void *arg) {
    int16_t *buf = malloc(s_read_samples * sizeof(int16_t));
    if (!buf) {
        ESP_LOGE(TAG, "failed to allocate read buffer, audio monitor disabled");
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        if (atomic_load(&s_rx_paused)) {
            // audio_monitor_set_rx_slot() is mid-reconfig — see its comment.
            // Not reading during this window is deliberate; it's a brief,
            // rare, operator-triggered event (a diagnostic live-switch),
            // not a steady-state condition worth optimizing around.
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        int ret = esp_codec_dev_read(s_codec_dev, buf, s_read_samples * sizeof(int16_t));
        if (ret != ESP_CODEC_DEV_OK) {
            ESP_LOGW(TAG, "codec read failed (%d), retrying", ret);
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        audio_ws_send_to_clients(buf, s_read_samples);
    }
}

void audio_monitor_start(void) {
    uint32_t sample_rate_hz = bridge_settings_get_sample_rate_hz();
    s_read_samples = (size_t)((uint64_t)sample_rate_hz * READ_WINDOW_MS / 1000);

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
    // across every supported rate. Capped so dma_frame_num * 2 bytes/frame
    // (mono 16-bit) never exceeds the I2S driver's 4092-byte
    // single-descriptor limit — the cap only actually bites at 48000 Hz
    // (1440 * 6 = 8640 frames uncapped -> would be 17280 bytes; capped to
    // 2000 frames/4000 bytes, still ~42ms of headroom per descriptor,
    // 6 descriptors deep).
    uint32_t dma_frame_num = 240 * sample_rate_hz / ES8388_SAMPLE_RATE_HZ;
    if (dma_frame_num > 2000) dma_frame_num = 2000;
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(ES8388_I2S_PORT,
        ES8388_MASTER_MODE ? I2S_ROLE_MASTER : I2S_ROLE_SLAVE);
    chan_cfg.dma_desc_num = 6;
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
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sample_rate_hz),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = ES8388_I2S_MCLK_PIN,
            .bclk = ES8388_I2S_BCLK_PIN,
            .ws = ES8388_I2S_WS_PIN,
            .dout = ES8388_I2S_DOUT_PIN,
            .din = ES8388_I2S_DIN_PIN,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &std_cfg));

    // This initial slot choice gets clobbered back to LEFT by
    // esp_codec_dev_open() below regardless of what's set here (see the
    // re-apply comment after that call for why) — kept anyway so the
    // channel starts in a defined, matching state rather than whatever
    // I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG's own untouched default is,
    // in case that ever changes upstream.
    i2s_std_config_t rx_std_cfg = std_cfg;
    bool rx_slot_right = bridge_settings_get_rx_slot_is_right();
    rx_std_cfg.slot_cfg.slot_mask = rx_slot_right ? I2S_STD_SLOT_RIGHT : I2S_STD_SLOT_LEFT;
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx_handle, &rx_std_cfg));
    atomic_store(&s_rx_slot_is_right, rx_slot_right);
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    ESP_ERROR_CHECK(i2s_channel_enable(rx_handle));
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

    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = 16,
        .channel = 1,
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
    if (!audio_monitor_set_rx_slot(rx_slot_right)) {
        ESP_LOGW(TAG, "failed to re-apply saved RX slot (%s) after esp_codec_dev_open() reset it to left",
                 rx_slot_right ? "right" : "left");
    }

    // Same "start from whatever was last saved" reasoning as ADC input
    // above — see bridge_settings_get_mic_gain_db()'s comment for the
    // confirmed-on-real-hardware default (21dB).
    audio_monitor_set_mic_gain_db(bridge_settings_get_mic_gain_db());

    audio_ws_set_rx_callback(audio_rx_callback);
    // Pinned to RELAY_TASK_CORE alongside the CAT UART reader (higher
    // priority, so it always wins contention) and the PA watchdog — see
    // bridge_config.h's Task placement notes for the full reasoning.
    xTaskCreatePinnedToCore(audio_task, "audio_monitor", 4096, NULL,
                             AUDIO_MONITOR_TASK_PRIO, NULL, AUDIO_MONITOR_TASK_CORE);
    ESP_LOGI(TAG, "ES8388 audio monitor started (in=ADC -> /audio broadcast, out=/audio rx -> DAC)");
}
