// Persisted, user-changeable settings — stored in NVS, distinct from the
// compile-time defaults in bridge_config.h/Kconfig. The Kconfig values are
// the first-boot fallback; once a setting is saved here, it wins over
// Kconfig on every subsequent boot. This is what lets the web app's bridge
// panel change Wi-Fi credentials without a reflash.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Call once from app_main, before wifi_net_start() reads anything through
// the getters below.
void bridge_settings_init(void);

// Wi-Fi SSID/password — falls back to CONFIG_BRIDGE_WIFI_SSID/PASSWORD
// (Kconfig) if nothing has been saved yet. out_sz is the caller's buffer
// size including room for the NUL terminator.
void bridge_settings_get_wifi(char *ssid_out, size_t ssid_sz, char *pass_out, size_t pass_sz);

// Persists new Wi-Fi credentials to NVS. Does NOT apply them or reboot —
// the caller (http_control's /wifi-config handler) is responsible for
// triggering a reboot afterward, same pattern as most consumer Wi-Fi
// devices: save, then restart to reconnect with the new network.
bool bridge_settings_set_wifi(const char *ssid, const char *password);

// Optional BSSID pin — "aa:bb:cc:dd:ee:ff" format, empty string means "no
// pin, let esp_wifi pick any AP broadcasting the configured SSID" (the
// long-standing default). Added after a real investigation found a home
// network broadcasting the same SSID from MULTIPLE same-channel APs at
// similar signal strength — classic co-channel-congestion/roaming-hunt
// territory, and the direct cause of intermittent multi-second WiFi-layer
// stalls that looked like an I2S/DMA/firmware bug from every other angle
// (confirmed by isolating it on firmware/esp32-iq-minimal, a stripped-down
// single-purpose build that ruled out every OTHER task on this bridge
// first). Pinning to one physical AP removes that roaming ambiguity
// entirely. Falls back to CONFIG_BRIDGE_WIFI_BSSID (Kconfig) if nothing
// has been saved yet — same "Kconfig first-boot default, NVS override"
// pattern as Wi-Fi SSID/password above. out_sz is the caller's buffer size
// including room for the NUL terminator (18 bytes covers the format above).
void bridge_settings_get_wifi_bssid(char *bssid_out, size_t out_sz);

// Persists a new BSSID pin to NVS — empty string clears the pin (reverts
// to "any AP for this SSID"). Does NOT apply it or reboot, same pattern as
// bridge_settings_set_wifi() above — the caller triggers the reboot.
bool bridge_settings_set_wifi_bssid(const char *bssid);

// CAT UART baud rate — falls back to CONFIG_BRIDGE_CAT_UART_BAUD (Kconfig)
// if nothing has been saved yet. Unlike Wi-Fi, this has no reboot step:
// the radio's own baud is a local-menu-only setting on the radio itself
// (there's no CAT command that reports or changes it — see the firmware
// README), so once you've changed it there, the bridge needs to match
// immediately, not after a restart. The caller (http_control's /cat-baud
// handler) applies it live via cat_bridge_set_baud() AND persists it here
// so a later reboot doesn't silently revert to a baud that no longer
// matches the radio's actual menu setting.
int bridge_settings_get_cat_baud(void);
bool bridge_settings_set_cat_baud(int baud);

// ES8388 ADC input selection — one of "lin1"/"lin2"/"mic1"/"mic2"/"diff"
// (see audio_monitor.h's ADC_INPUT_OPTIONS). See the ADCCONTROL2 comment in
// audio_monitor.c for why this exists as a runtime-switchable setting at
// all — real-hardware testing showed the assumed onboard-mic-vs-P2-jack
// mapping had no effect, so this now sweeps every option the chip supports.
// Defaults to "lin2" if nothing has been saved yet (this bridge's original
// intended input — an external mic/line-in from the interface board, not
// the onboard mic) — unlike cat_baud, there's no Kconfig fallback for this,
// it's a firmware-specific default rather than something the radio's own
// menu dictates. out_sz is the caller's buffer size including room for the
// NUL terminator (the longest name, "diff", needs 5 bytes).
void bridge_settings_get_adc_input_name(char *name_out, size_t out_sz);
bool bridge_settings_set_adc_input_name(const char *name);

// I2S RX slot (which ADC channel — left/right — the capture side keeps) —
// see audio_monitor_set_rx_slot()'s comment for why this is a separate
// axis from adc_input above. Defaults to true (right) once real-hardware
// testing on this board confirmed the P2 jack's tip signal lands on the
// right ADC channel, not left (I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG's mono
// default) — a board-wiring fact, not a Kconfig-level choice.
bool bridge_settings_get_rx_slot_is_right(void);
bool bridge_settings_set_rx_slot_is_right(bool use_right);

// ES8388 MIC preamp (PGA) gain in dB — see audio_monitor_set_mic_gain_db().
// Defaults to 0.0 dB, the ES8388's own PGA default (unity gain) — a higher
// value was tried earlier to fight onboard-mic bleed-through, but that
// bleed turned out to be a board-wiring issue no gain setting fixes, so
// there's no reason to default away from unity.
float bridge_settings_get_mic_gain_db(void);
bool bridge_settings_set_mic_gain_db(float db_value);

// WiFi max TX power in quarter-dBm units (see wifi_net_set_tx_power_quarter_dbm()
// for the full range/units explanation). Defaults to 78 (~19.5 dBm, the
// driver's own real maximum on this board — 84 was never an actual
// achievable step, see bridge_settings.c's DEFAULT_WIFI_TX_POWER_QUARTER_DBM
// comment) — this control exists purely as a diagnostic for whether the
// radio's own transmit activity couples noise into the analog audio path,
// not because a lower default is known to help.
int8_t bridge_settings_get_wifi_tx_power_quarter_dbm(void);
bool bridge_settings_set_wifi_tx_power_quarter_dbm(int8_t quarter_dbm);

// The /audio WebSocket's wire rate, which IS the ES8388/I2S hardware's
// actual sample rate too (see bridge_config.h — no oversampling layer).
// Defaults to 48000 Hz, matching a typical laptop sound card/browser
// AudioContext's own native device rate (new AudioContext() with no
// explicit sampleRate option gets whatever the OS's default output device
// rate is, which is 48000 Hz on effectively every modern system) — chosen
// as the default specifically so an A/B comparison between this bridge
// and a direct sound-card capture isn't ALSO comparing two different
// sample rates on top of whatever else differs. Changing this requires a
// reboot to take effect (see POST /sample-rate) — deliberately not a live
// reconfig, same reasoning as the RX-slot/ADC-input settings that already
// get re-applied at boot rather than switched underneath a running codec.
uint32_t bridge_settings_get_sample_rate_hz(void);
bool bridge_settings_set_sample_rate_hz(uint32_t rate_hz);

// Which physical signal the line-in jack is expected to carry — "audio"
// (today's default: already-demodulated SSB/audio, mono, narrowband) or
// "iq" (raw in-phase/quadrature from the radio, pre-demodulation, wideband
// — I on the ADC's left channel, Q on the right, per real-hardware
// confirmation of the uSDX's I/Q output wiring). This is a SEPARATE axis
// from adc_input_name above: adc_input_name picks which physical pins
// reach the ES8388's ADC (LIN1/LIN2/MIC1/MIC2/diff), while this picks how
// the resulting samples are captured and interpreted once they arrive —
// "audio" mode keeps one I2S slot (see rx_slot_is_right), "iq" mode keeps
// BOTH slots (stereo capture) since I/Q needs both channels simultaneously,
// not a choice between them. Like sample_rate_hz, changing this reboots to
// apply rather than reconfiguring a running I2S/codec setup live. Defaults
// to "audio" — the existing, long-proven mode; "iq" is new and opt-in.
// out_sz is the caller's buffer size including room for the NUL terminator
// (the longest name, "audio", needs 6 bytes).
void bridge_settings_get_input_mode_name(char *name_out, size_t out_sz);
bool bridge_settings_set_input_mode_name(const char *name);

// Whether the persistent CAT-frame log (cat_log.h) should be running at
// all — a debug feature, defaults to OFF (see bridge_settings.c's default
// comment for why: its boot-time flash-recovery scan grows with the log's
// own record count and was found to cause a real crash-loop once it grew
// close to the 5s task-watchdog timeout). Read once at boot by
// cat_log_init(); changing it takes effect on the next reboot, same
// pattern as sample_rate_hz above.
bool bridge_settings_get_cat_log_enabled(void);
bool bridge_settings_set_cat_log_enabled(bool enabled);
