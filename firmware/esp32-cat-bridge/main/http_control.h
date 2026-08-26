// Small REST-ish control surface alongside the CAT WebSocket, for the web
// app's on-demand bridge status/control panel (not part of any poll loop —
// queried once when that panel opens, same pattern as the radio's own PA
// bias/factory-defaults advanced settings in useRadioCAT.ts).
//
// GET  /status      -> JSON: {"wifi_state":"connected","ssid":"...","bssid":"",
//                              "rssi":-67,
//                              "ip":"192.168.0.7","ws_clients":1,"ws_max_clients":4,
//                              "radio_linked":true,"cat_baud":38400,
//                              "pa_sense":false,"pa_emergency_tripped":false,
//                              "adc_input":"lin2","rx_slot_right":false,
//                              "led_enabled":true,"alc_enabled":false,
//                              "noise_gate_enabled":false,"cpu_freq_mhz":240,
//                              "wifi_tx_power_quarter_dbm":78,"adc_hpf_enabled":true,
//                              "sample_rate_hz":48000,"speaker_amp_enabled":true,
//                              "mic_gain_db":0.0,"cat_log_enabled":false,"uptime_s":1234}
//                       wifi_state is one of "connected"/"connecting"/
//                       "disconnected"/"ap_fallback" — the last one means
//                       the bridge couldn't join its configured network
//                       and is now broadcasting its own AP at 192.168.4.1
//                       (see wifi_net.c) so it's still reachable to fix.
//                       pa_sense/pa_emergency_tripped — see pa_watchdog.h.
//                       adc_input — see POST /audio-input below.
//                       rx_slot_right — see POST /rx-slot below.
//                       led_enabled — see POST /led-enable below.
//                       alc_enabled — see POST /alc below.
//                       noise_gate_enabled — see POST /noise-gate below.
//                       cpu_freq_mhz — see POST /cpu-freq below.
//                       wifi_tx_power_quarter_dbm — see POST /wifi-tx-power below.
//                       adc_hpf_enabled — see POST /adc-hpf below.
//                       sample_rate_hz — see POST /sample-rate below.
//                       speaker_amp_enabled — see POST /speaker-amp below.
//                       mic_gain_db — see POST /mic-gain below.
//                       cat_log_enabled — see POST /cat-log-enable below.
//                       bssid — "" means no pin (esp_wifi picks any AP for
//                       ssid); "aa:bb:cc:dd:ee:ff" means pinned. See POST
//                       /wifi-config below.
// GET  /info        -> JSON: {"firmware_version":"0.2.0","features":["cat",
//                              "wifi_config","wifi_scan","reset","audio",
//                              "cat_baud","pa_watchdog","audio_input_select",
//                              "mic_gain","rx_slot_select","led_enable",
//                              "alc_control","noise_gate_control","cpu_monitor",
//                              "wifi_tx_power_control","adc_hpf_control",
//                              "sample_rate_select","speaker_amp_control",
//                              "cat_log","audio_mic_sniff","input_mode_select",
//                              "tx_buffer_playback"]} —
//                       see the versioning note in bridge_config.h.
// GET  /wifi-scan    -> JSON: {"networks":[{"ssid":"...","rssi":-58},...]}
//                       Blocking active scan (~1-3s), deduped by SSID
//                       (strongest RSSI kept). Safe to call in AP fallback
//                       too (APSTA mode).
// POST /reset       -> 200 "restarting" then reboots the ESP32 after replying
//                       (so the HTTP response actually reaches the browser first).
// POST /wifi-config -> body {"ssid":"...","password":"...","bssid":"..."};
//                       bssid is OPTIONAL ("aa:bb:cc:dd:ee:ff" format, or
//                       omit/empty to clear an existing pin) — pins the
//                       bridge to one specific AP instead of letting
//                       esp_wifi pick any AP broadcasting ssid. Only
//                       useful on a network broadcasting the same SSID
//                       from multiple same-channel APs (confirmed cause of
//                       intermittent multi-second WiFi-layer stalls in
//                       that setup — see bridge_settings_get_wifi_bssid()'s
//                       comment). Persists to NVS (bridge_settings.c) and
//                       reboots to apply, same as /reset.
// POST /cat-baud    -> body {"baud":38400}; one of 9600/19200/38400/57600
//                       (the uSDX firmware's own CAT_BAUD menu options).
//                       Applied immediately (cat_bridge_set_baud(), no
//                       reboot needed — unlike Wi-Fi, the radio's baud is a
//                       local-menu-only setting with no CAT command to
//                       announce a change, so the bridge must be told by
//                       hand the moment the radio's own setting changes)
//                       AND persisted to NVS so a later reboot doesn't
//                       revert to a stale value.
// POST /pa-emergency-clear -> JSON {"pa_emergency_tripped":false}; un-trips
//                       a latched PA safety cutoff (see pa_watchdog.h) —
//                       no body needed, no auto-recovery exists on the
//                       firmware side, so this is the only way to restore
//                       PA_EMERGENCY_PIN to its permissive HIGH default
//                       after a trip.
// POST /audio-input -> body {"input":"lin1"|"lin2"|"mic1"|"mic2"|"diff"};
//                       live-switches the ES8388's ADC input mux to one of
//                       its 5 real supported modes — see the ADCCONTROL2
//                       comment in audio_monitor.c for why this sweeps
//                       every option instead of a single onboard-mic-vs-P2-
//                       jack guess (that guess was tested on real hardware
//                       and had no audible effect either way). Applied
//                       immediately (a live I2C write) AND persisted to
//                       NVS. Response: {"input":"lin2","applied":true,"saved":true}.
// POST /mic-gain    -> body {"db":0}; live-adjusts the ES8388's MIC preamp
//                       (PGA) gain via esp_codec_dev's public API — the
//                       onboard MIC1/MIC2 preamps were found bleeding
//                       audibly into every ADCCONTROL2 input mode on real
//                       hardware (including modes that shouldn't route
//                       them at all, a board-wiring issue no gain setting
//                       actually fixes); db<=0 drives the PGA to its
//                       minimum. Applied immediately AND persisted to NVS
//                       — defaults to 0.0dB, the ES8388's own PGA default.
//                       Response: {"db":0.0,"applied":true,"saved":true}.
// POST /wifi-tx-power -> body {"quarter_dbm":78}; live-sets the WiFi
//                       radio's max TX power via esp_wifi_set_max_tx_power()
//                       — units are quarter-dBm (78 == ~19.5dBm, the
//                       driver's REAL maximum on this board, confirmed by
//                       sweeping real hardware — the API accepts requests
//                       up to 84 but anything above 78 silently snaps down
//                       to it, so 84 was never actually achievable),
//                       accepted input range [8,84] (2..21dBm), snapped
//                       internally to the driver's own nearest supported
//                       step (not a continuous scale). A low-confidence
//                       experiment for whether the WiFi radio's own
//                       transmit activity couples noise into the analog
//                       audio path. Applied immediately AND persisted to
//                       NVS. Response: {"quarter_dbm":78,"applied":true,"saved":true}.
// POST /rx-slot     -> body {"right":true|false}; live-switches which I2S
//                       slot the ADC capture side reads — a SEPARATE axis
//                       from /audio-input's ADCCONTROL2 mux selection (see
//                       audio_monitor_set_rx_slot()'s comment): a jack's
//                       tip signal can land on either ADC channel
//                       depending on board wiring, independent of which
//                       physical pins the mux selects. Briefly pauses
//                       capture while the I2S channel is disabled/
//                       reconfigured/re-enabled. Applied immediately AND
//                       persisted to NVS — right confirmed on real
//                       hardware to be where this board's P2 jack tip
//                       signal lands. Response:
//                       {"right":true,"applied":true,"saved":true}.
// POST /led-enable  -> body {"enabled":true|false}; reversible kill-switch
//                       for both status LEDs (see led_status_set_enabled())
//                       — a one-time test for whether their own PWM
//                       switching is injecting noise into the analog audio
//                       path, on top of the already-confirmed onboard-mic
//                       bleed-through. Applied immediately; NOT persisted
//                       to NVS (defaults back to on after a reboot).
//                       Response: {"enabled":false}.
// POST /alc         -> body {"enabled":true|false}; live-toggles the
//                       ES8388's Automatic Level Control (see
//                       audio_monitor_set_alc_enabled()) — confirmed OFF by
//                       the chip's own power-on-reset default and never
//                       touched by the vendored driver, exposed as a
//                       checkable diagnostic since the operator suspected
//                       it might be contributing to the already-confirmed
//                       audio-noise investigation. Applied immediately; NOT
//                       persisted to NVS. Response: {"enabled":false,"applied":true}.
// POST /noise-gate  -> body {"enabled":true|false}; live-toggles the ALC's
//                       Noise Gate sub-feature — same reasoning as /alc
//                       above. Only has an audible effect while ALC itself
//                       is also enabled (same register block per the
//                       datasheet). Applied immediately; NOT persisted to
//                       NVS. Response: {"enabled":false,"applied":true}.
// POST /adc-hpf     -> body {"enabled":true|false}; live-toggles the
//                       ES8388's ADC digital high-pass filter (DC-offset
//                       removal, datasheet Register 14/ADCCONTROL6).
//                       UNLIKE /alc and /noise-gate above, this one is ON
//                       by the chip's own power-on-reset default and was
//                       never touched by the vendored driver either — so
//                       "disabling" is the actual diagnostic direction,
//                       exposed to let the operator compare with/without
//                       while chasing a reported broadband noise floor.
//                       Applied immediately; NOT persisted to NVS.
//                       Response: {"enabled":true,"applied":true}.
// POST /sample-rate -> body {"hz":48000}; one of 8000/16000/22050/32000/
//                       44100/48000 — the /audio WebSocket's wire rate,
//                       which IS the codec/I2S hardware's own rate too
//                       (no oversampling layer — see bridge_config.h).
//                       Defaults to 48000, matching a typical laptop
//                       sound card/browser AudioContext's native device
//                       rate, so an A/B comparison against a direct
//                       sound-card capture isn't also comparing two
//                       different sample rates. Persists to NVS AND
//                       REBOOTS to apply (not a live reconfig — same
//                       pattern as POST /wifi-config). Rejects any other
//                       value with 400. Response: "saved, restarting"
//                       (text/plain, matching /wifi-config's response
//                       shape, not JSON).
// POST /speaker-amp -> body {"enabled":true|false}; live-forces the
//                       onboard NS4150 speaker amplifier's own
//                       enable/shutdown GPIO (ES8388_PA_ENABLE_PIN),
//                       bypassing the codec driver's own PA-power logic.
//                       A class-D amp has its own free-running switching
//                       oscillator — a physically real on-board noise
//                       source. Exposed live specifically because the
//                       enable pin's polarity (ES8388_PA_REVERTED) was
//                       only ever a guess, never confirmed on real
//                       hardware — this lets the operator test/compare
//                       both real GPIO states without reflashing. Applied
//                       immediately; NOT persisted to NVS (a live
//                       experiment, not a permanent setting yet).
//                       Response: {"enabled":true,"applied":true}.
// POST /cpu-freq    -> body {"mhz":80|160|240}; live-repins the ESP32's CPU
//                       frequency via esp_pm_configure() (min==max, so this
//                       is pinning, not dynamic scaling — see cpu_monitor.c)
//                       — a low-confidence experiment for whether digital
//                       switching activity couples into the analog audio
//                       path. Rejects any other value with 400. Applied
//                       immediately; NOT persisted to NVS (reverts to
//                       CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ, 160, after a
//                       reboot). Response: {"mhz":160,"applied":true}.
// GET  /cat-log     -> JSON: {"entries":[{"from_radio":true,
//                       "uptime_ms":12345,"frame":"FA00014225000"},...]},
//                       oldest first. Persisted CAT-frame ring buffer (see
//                       cat_log.h) surviving reboots — unlike the control
//                       page's own browser-only live log — specifically to
//                       help diagnose "what was the radio doing right
//                       before a restart". Reads the in-RAM shadow only
//                       (never touches flash), so this is cheap enough to
//                       call on demand. Holds up to CAT_LOG_CAPACITY (1000)
//                       entries; no pagination.
// POST /cat-log/clear -> JSON {"cleared":true}; erases the persisted log
//                       (flash + RAM shadow). No body needed. Distinct from
//                       the control page's own "Clear" button, which only
//                       clears the live DOM view.
// POST /cat-log-enable -> body {"enabled":true|false}; turns the persistent
//                       CAT log on/off. Defaults OFF — a debug feature
//                       whose boot-time flash-recovery scan (cat_log.c's
//                       recover_from_flash()) grows with the log's own
//                       accumulated record count; left enabled
//                       indefinitely on real hardware, that scan grew
//                       close enough to the 5s task-watchdog timeout to
//                       cause a genuine crash-loop. cat_log_init() only
//                       reads this once at boot, so (like /sample-rate)
//                       this persists to NVS AND REBOOTS to apply, rather
//                       than live-starting/stopping the background task.
//                       Response: "saved, restarting" (text/plain).
// POST /tx-audio    -> body: raw Int16 PCM bytes (NOT JSON — a binary
//                       body), mono, fixed at 16000Hz (TX_BUFFER_SAMPLE_RATE_HZ
//                       in audio_monitor.h) — the exact wire format /audio's
//                       live mic-send path already uses. Uploads a WHOLE
//                       pre-encoded TX message (e.g. an FT8/FT4 waveform)
//                       in one shot, replacing the /audio WebSocket's
//                       chunk-by-chunk live streaming for this use case —
//                       real-hardware testing found that path "noisy,
//                       cutting and full of unwanted artifacts" whenever
//                       any single ~2048-sample chunk's Wi-Fi delivery
//                       jittered even slightly, an unavoidable property of
//                       feeding a real-time codec write rate from
//                       network-timed packets. Uploading the whole buffer
//                       first (this handler doesn't return until every
//                       byte has actually arrived) converts that into a
//                       one-shot transfer problem: playback (POST
//                       /tx-play below) then walks a known-good local
//                       buffer at the codec's own pace, with the network
//                       no longer any part of the timing picture. Stored
//                       in PSRAM (see audio_monitor.h's "One-shot
//                       pre-encoded TX buffer playback" comment for why —
//                       the same previously-fixed real bug as
//                       s_tx_stereo_scratch/s_tx_upsample_scratch in
//                       audio_monitor.c: nothing downstream ever needs
//                       DMA-capable source memory, and this buffer is too
//                       large to reliably survive internal RAM's normal
//                       fragmentation). Rejects with 400 if a playback is
//                       currently in progress (POST /tx-stop it first) —
//                       an upload mid-playback would clobber the buffer
//                       the playback task is actively reading from. Also
//                       rejects with 400 for an odd byte count (not valid
//                       Int16 PCM) or a body over 5 minutes' worth (a loose
//                       sanity cap, not a tuned limit — both FT8 and FT4
//                       top out well under 20s). Response:
//                       {"bytes":123456,"duration_ms":12640,"saved":true}
//                       (duration_ms derived from byte count at the fixed
//                       16000Hz mono rate).
// POST /tx-play     -> no body. Starts a dedicated FreeRTOS task
//                       (audio_monitor.c's tx_play_task(), pinned to
//                       RELAY_TASK_CORE at AUDIO_MONITOR_TASK_PRIO — see
//                       bridge_config.h's TX_PLAY_TASK_CORE/PRIO comment)
//                       that feeds the uploaded buffer into
//                       audio_monitor_report_out_samples() — the SAME
//                       DAC-write/RMS/LED pipeline /audio's live mic-send
//                       path uses, reused rather than duplicated — in
//                       READ_WINDOW_MS-cadence chunks (the same chunk
//                       size/timing audio_task's own RX read loop already
//                       uses at this rate), paced with vTaskDelay rather
//                       than dumped in one call. CRITICAL implementation
//                       detail, not just a style preference: this runs as
//                       a genuinely separate task, never inline in this
//                       httpd worker's own request-handling context —
//                       there's a real documented prior incident (see the
//                       UPSAMPLE_SINC_HALF_WIDTH comment block in
//                       audio_monitor.c) where CPU-heavy work landed in
//                       that shared httpd worker context during TX and
//                       starved IDLE0 long enough to trip the task
//                       watchdog and force a full device reboot mid-
//                       transmission — exactly the failure this
//                       architecture exists to make structurally
//                       impossible here. Rejects with 400 if no buffer has
//                       been uploaded yet (POST /tx-audio first) or a
//                       playback is already running. Response:
//                       {"playing":true,"duration_ms":12640}.
// GET  /tx-status   -> JSON: {"playing":true,"position_ms":1234,
//                       "duration_ms":12640}. Deliberately cheap and
//                       poll-friendly — just reads shared atomic state the
//                       playback task itself updates once per chunk, no
//                       I/O, safe for a browser progress bar to poll every
//                       few hundred ms for an entire playback's duration.
// POST /tx-stop     -> no body. Sets a flag the playback task checks once
//                       per chunk (so it stops at the next chunk boundary,
//                       not instantly) and blocks briefly (bounded at 1s)
//                       until the task has actually exited before
//                       replying — never leaves the caller unsure whether
//                       playback (and therefore TX) is really still live.
//                       Always returns 200, including the trivial case
//                       where nothing was playing. Response:
//                       {"stopped":true}.
// GET  /system-stats -> JSON: {"cpu_freq_mhz":160,"heap_free":123456,
//                              "heap_min_free":98765,"heap_total":327680,
//                              "heap_largest_free_block":65432,"dma_free":54321,
//                              "dma_largest_free_block":43210,
//                              "rx_max_loop_interval_us":52341,
//                              "rx_max_read_duration_us":1023,
//                              "rx_max_broadcast_duration_us":412,
//                              "rx_loop_count":198,
//                              "tasks":[{"name":"...","cpu_pct":12.3,
//                              "core":0,"stack_free":1234},...]}
//                       Heap usage (heap_caps_get_info()) and per-task CPU%
//                       (delta between successive calls — see
//                       cpu_monitor_write_tasks_json()), core affinity, and
//                       stack headroom. Kept separate from GET /status since
//                       it's meant to be polled on its own cadence by a
//                       live-refreshing diagnostics panel. rx_* fields are
//                       audio_task's RX read-loop timing (see
//                       audio_monitor_get_rx_timing()) — max value seen
//                       since the LAST call to this endpoint, not an
//                       all-time max, and rx_loop_count is how many
//                       iterations contributed to that max (a low count
//                       means the values aren't a reliable peak yet).
#pragma once

// Registers all control routes on the already-running httpd instance. Call
// after ws_server_start() (needs the same httpd_handle_t).
void http_control_start(void);
