# ESP32 CAT bridge

Wi-Fi bridge between the uSDX BLACK_BRICK's CAT serial port and the
Signal-Decoder web app, replacing the USB-serial cable with a WebSocket over
the home network. Built on ESP-IDF's native runtime (FreeRTOS + esp-idf
components) — **not** the Arduino core.

Target board: **AI-Thinker ESP32-A1S Audio Kit**. This is a WROVER-class
module (8MB PSRAM — GPIO16/17 are internally reserved for it, not even
broken out to the header) with an onboard ES8388 audio codec and an onboard
SD card slot (SDMMC on GPIO2/4/12/13). Only 7 header GPIOs are nominally
"free" (0, 5, 18, 19, 21, 22, 23) and every one already drives an onboard
button, LED, or the amplifier-enable line — this firmware claims 2 of them
(18, 23) for the CAT UART and 1 more (22, plus 19 which doubles as a
button) for the two status LEDs. The onboard codec streams both
directions — radio speaker audio out to the browser, browser mic audio
into the radio's mic input — over a second WebSocket (see Audio bridge
below). Two more pins (GPIO2, GPIO4 — the SD card slot's unused DATA0/
DATA1 lines, since the header itself was fully spoken for) drive a PA
safety watchdog for an external amplifier (see PA safety watchdog below).

Repurposing the SD card slot's pins means this firmware can never use the
slot itself, but nothing here does — the alternative would have been
sacrificing another onboard button/LED, which the PA watchdog's pins don't
cost.

An earlier revision of this firmware targeted a bare ESP32-WROOM-32 board
with a PCD8544 LCD status display — that hardware is no longer in use; the
LCD driver/status-display code and its GPIO16/17 pin assignment were
removed rather than kept disabled. Both are still in git history if a
display ever gets wired up on a future board.

## Architecture

```text
        UART2 (CAT, ASCII, ';'-terminated)         WebSocket (binary, byte-transparent)
Radio  <----------------------------->  ESP32  <----------------------------------->  Browser(s)
                                                                                   (Signal-Decoder
                                                                                     web app)
```

- **`cat_bridge`** owns UART2 exclusively. A dedicated FreeRTOS task reads
  bytes from the radio and hands them to a callback; `cat_bridge_write()`
  sends bytes to the radio from any task. It has no idea a WebSocket exists
  — the protocol (Kenwood TS-480 + the PU7FTW BLACK_BRICK extensions, see
  the [main firmware README](../usdxBLACKBRICK/README.md) and
  `src/lib/cat/useRadioCAT.ts` in the web app) is never parsed here, only
  relayed byte-for-byte, the same way the browser's Web Serial connection
  does today — with one narrow, deliberate exception: it snoops `FA`
  (frequency) and `SM` (S-meter) frames as they pass through, purely to
  track live state for diagnostics (see `GET /status`'s `radio_linked`
  field, driven by real traffic FROM the radio, not just commands sent to it).
- **`ws_server`** runs `esp_http_server` with one WebSocket route (`/cat`)
  on port 80 (the standard HTTP port, so no `:port` suffix is needed to
  reach the control page below or any of the JSON endpoints). Bytes from
  the radio broadcast to every connected client
  (`WS_MAX_CLIENTS` in `bridge_config.h`) via `httpd_ws_send_frame_async()`
  (required since the push originates from the UART reader task, not the
  HTTP worker that owns each socket); bytes from any client forward straight
  to `cat_bridge_write()` — the radio is a single shared resource regardless
  of how many browser tabs are watching, so the last command on the wire
  wins, same as it would with one physical knob and multiple hands.
- **`http_control`** exposes a small REST-ish control surface on the same
  httpd instance: `GET /status` (live Wi-Fi/link/client-count snapshot),
  `GET /info` (firmware version + capability list, so the web app can gate
  UI on "does this bridge support X"), `POST /reset` (reboot), and
  `POST /wifi-config` (change the Wi-Fi network, persisted to NVS, reboots
  to apply).
- **`control_page`** serves a small standalone status/Wi-Fi/restart/audio/CAT
  monitor page at `GET /` (plus `/style.css`, `/app.js`), so the bridge can
  be managed and debugged directly from any browser on the LAN without
  going through the Signal-Decoder web app at all. The page is static
  HTML/CSS/JS (source in `spiffs_data/`) that calls the same `http_control`
  endpoints above plus the `/cat` and `/audio` WebSockets directly — most of
  it is thin display logic, except the audio-quality view (see Audio
  quality visualization above), which does real client-side signal
  analysis (spectrum, rolloff estimate, clip/DC/noise-floor detection) on
  the raw PCM crossing `/audio`. Files are baked into a SPIFFS image at
  build time onto the `storage` partition (see `partitions.csv`) and
  flashed alongside the app. Laid out as two responsive columns (a narrow
  sidebar for the short cards, a wide main column for the CAT monitor's
  log and the audio-quality view) that stack single-column below a 56rem
  breakpoint.
- **`wifi_net`** joins your home Wi-Fi in station mode (credentials via
  `idf.py menuconfig` → "CAT Bridge Config", overridable at runtime via
  `POST /wifi-config` once NVS has a saved value) and advertises the device
  as `usdx-bridge.local` via mDNS (`_cat-bridge._tcp` on port 80) once
  connected, so the web app doesn't need a hardcoded IP. Also exposes
  `wifi_net_scan()` (blocking active scan, deduped by SSID) for
  `GET /wifi-scan`, and an **AP fallback**: if the configured network can't
  be joined after `BRIDGE_WIFI_MAXIMUM_RETRY` tries, it starts broadcasting
  its own access point (`BRIDGE_AP_SSID`/`BRIDGE_AP_PASSWORD` in Kconfig,
  `WIFI_MODE_APSTA`) at the fixed IP `192.168.4.1`, so the control page and
  `POST /wifi-config` are still reachable to fix the settings — join that AP
  directly from a phone/laptop and browse to `http://192.168.4.1/`. STA
  keeps retrying the real network in the background the whole time and the
  fallback AP drops automatically the moment it reconnects.
- **`bridge_settings`** persists user-changeable settings (currently just
  Wi-Fi credentials) to NVS, distinct from the Kconfig-baked compile-time
  defaults — once something's saved here it wins over Kconfig on every
  subsequent boot.
- **`bridge_state`** is a small mutex-guarded struct that the above modules
  write to and `http_control` reads from for `GET /status` — the only
  shared state in the firmware.
- **`audio_monitor`** brings up the onboard ES8388 codec (I2C control + I2S
  audio) and bridges it bidirectionally to `audio_ws`: reads the ADC
  continuously, computes an RMS level for the status LEDs, and broadcasts
  the raw samples to every `/audio` client; writes whatever a client sends
  straight to the DAC, with its own RMS feeding the other LED.
- **`audio_ws`** is `/audio`'s WebSocket route — the same "byte-transparent,
  no framing beyond the raw payload" philosophy as `/cat`, just carrying
  16-bit PCM samples instead of ASCII CAT commands. See Audio bridge below.
- **`led_status`** drives the board's two status LEDs via LEDC PWM — see
  the LED legend below for what each state looks like.
- **`pa_watchdog`** guards against the uSDX hanging with the external
  amplifier still keyed — see PA safety watchdog below.

### Status LEDs

Two onboard LEDs (GPIO22 and GPIO19 — the latter doubles as the KEY3
button input, unused elsewhere in this firmware, so claiming it as an
output here costs nothing) show, in priority order (highest wins):

| State                | LED behavior                                                                                    |
|----------------------|-------------------------------------------------------------------------------------------------|
| PA emergency         | Both LEDs strobe VERY fast (~100ms) — hardware safety fault, outranks everything below          |
| AP fallback          | Both LEDs blink together, fast (~300ms) — network needs fixing                                  |
| Wi-Fi connecting     | LEDs alternate (~400ms) — joining, not stuck yet                                                |
| No CAT traffic (>3s) | Both LEDs pulse dim-to-bright-to-dim (2s, floors at ~17% not 0%); live audio still rides on top |
| Normal               | LED1 (GPIO22) = audio-in level, LED2 (GPIO19) = audio-out level, plain brightness, no blink     |

### Audio bridge

`GET /audio` upgrades to a WebSocket carrying raw 16-bit signed PCM, mono,
`ES8388_SAMPLE_RATE_HZ` (8000 Hz — plenty for SSB voice, ~2.7kHz bandwidth),
in both directions:

- **bridge → browser**: radio speaker audio, read continuously from the
  ES8388 ADC and broadcast to every connected `/audio` client
  (`AUDIO_WS_MAX_CLIENTS` in `bridge_config.h` — deliberately small, each
  open session is real continuous UART/I2S-competing work, unlike `/cat`'s
  near-idle text frames)
- **browser → bridge**: a remote operator's mic, written straight to the
  ES8388 DAC (feeding the radio's mic input through the board's own
  transformer/RC filtering on that physical path)

Deliberately **not real WebRTC** — there is no mature, maintained WebRTC
library for bare ESP-IDF (no ICE/DTLS-SRTP stack), so this reuses the same
WebSocket infrastructure already proven working for `/cat`, at the cost of
somewhat higher latency than true peer-to-peer RTP would have. Acceptable
for voice on a local network; revisit if this ever needs to leave the LAN.

No compression — raw PCM at 8kHz is ~128kbit/s, trivial for Wi-Fi, and
avoids running any codec math on the ESP32 (G.711/Opus were considered and
explicitly not used — see the Known Limitations note on this choice).

### Audio quality visualization (browser-side)

The interface board has manual RC filter trimpots for both audio
directions (radio → browser and browser → radio) — tuned by eye, not by
ear, since "does this sound right" isn't reliable enough for that
adjustment. Both the web app (`AudioQualityPanel.tsx`, shown/hidden via a
"Show Signal Quality" button in the Bridge panel's Audio section) and the
standalone control page (a "Show" checkbox in its own Audio quality card)
render the same analysis, driven entirely client-side from an
`AnalyserNode` tapped onto the existing playback/capture Web Audio graphs
— **zero firmware involvement**, this is pure browser-side processing of
the raw PCM already crossing `/audio`. Deliberately more than a bare VU
meter, since a trimpot problem can be easy to miss just eyeballing a
constantly-moving trace:

- **Bar spectrum** — the filter's passband shape/cutoff slope/ripple
  directly, updating live as a trimpot turns.
- **Estimated rolloff marker** — a blue dashed line + Hz readout at the
  point the spectrum drops to roughly half its peak magnitude (a simple,
  robust ~-6dB-relative-to-peak threshold, not a true -3dB reconstruction
  — 8-bit log-mapped analyser data doesn't have the resolution for that
  level of precision, and this is plenty to watch move as you tune).
- **Waterfall** — scrolling spectrum history (the web app reuses
  `GLSpectrogram`, the same GPU component the decoders use; the control
  page has no bundler, so it's a simple canvas-2D scrolling column
  instead), so an intermittent issue is visible over time, not just the
  current instant.
- **Oscilloscope** — a spectrum alone can't show clipping (it looks like
  broadband harmonic energy in the frequency domain); the time-domain
  trace shows the actual flat-topped waveform directly.
- **Clip events** — a bold flash + ring around the channel the instant a
  sample crosses ~98% of full-scale, plus a rolling "N clips in the last
  10s" counter — a trimpot set too hot clips only intermittently, easy to
  miss on a 60fps scope trace but obvious as an accumulating count.
- **DC offset** — a misadjusted analog stage can bias the signal off
  zero, eating into headroom before anything even looks "loud"; flagged
  once it's large enough to matter (≥3% of full-scale).
- **Noise floor** — rolling minimum spectrum energy over the last few
  seconds, so "is this trimpot position noisier" has a number instead of
  just a vibe.

All of this runs in the browser specifically because it has real CPU/GPU
budget to spend that the ESP32 doesn't — deliberately not attempted in
firmware.

### CAT baud rate

The uSDX firmware's `CAT_BAUD` menu setting (9600/19200/38400/57600) is
**local-menu-only on the radio** — there is no CAT command that reports or
changes it, so the bridge has no way to detect a change automatically.
Changing it on the radio breaks the UART link immediately (garbled bytes,
no announcement frame possible), so the bridge's own baud has to be updated
by hand to match:

- `POST /cat-baud` (body `{"baud":38400}`) applies the new rate immediately
  via `cat_bridge_set_baud()` — no reboot, unlike `/wifi-config` — and
  persists it to NVS (`bridge_settings.c`) so a later reboot doesn't revert
  to a stale value that no longer matches the radio.
- The standalone control page's CAT monitor card (see below) has this as a
  dropdown + Apply button. The web app's Bridge panel has the same control,
  gated on `GET /info`'s `"cat_baud"` feature.

### CAT monitor (control page)

The standalone control page's CAT monitor card connects to the same `/cat`
WebSocket the Signal-Decoder web app uses — a plain observer (plus an
optional manual send box), not a separate protocol or firmware endpoint.
Frames are split client-side on `;` and logged with a direction arrow
(green/left = radio → bridge, red/right = bridge/browser → radio) — useful
for confirming what's actually crossing the wire without needing the full
web app open. Client-side only: the firmware doesn't buffer or replay
history, so the log starts empty on every page load (a small in-firmware
ring buffer was considered and explicitly skipped — this is meant to stay a
live debug view, not a persistent log).

### PA safety watchdog

Guards against the uSDX hanging with the external **miniPA70** amplifier's
PTT still asserted. Full design rationale, alternatives considered, and
sources in `main/doc/PA_WATCHDOG_DESIGN.md` — summary:

- **`PA_SENSE_PIN` (GPIO2, input)** reads a signal the *user's own
  interface board* derives from the miniPA70's actual energized 12V leg
  (after their own level-shifting down to safe logic) — not the uSDX's
  PA-send command line. The miniPA70 itself is a bare, undocumented kit
  amp (two-pin PTT-in via a PNP-driven relay) with no feedback of its own,
  so this is the only signal that proves the PA hardware is truly on,
  independent of whether the uSDX's command line or the interface board's
  own level-shifting are behaving correctly — that independence is the
  entire point of a watchdog.
- **`PA_EMERGENCY_PIN` (GPIO4, output)** is a permissive line in series
  with the uSDX's PA-send path on the interface board: HIGH (idle) lets
  the radio's own signal control the PA normally; pulled LOW once
  `PA_MAX_ON_SECONDS` (default 300s — a placeholder, tune to the longest
  realistic legitimate transmission for this station) of continuous
  `PA_SENSE_PIN` HIGH has elapsed, forcing the PA off regardless of what
  the radio is doing.
- **Latches.** Once tripped, `PA_EMERGENCY_PIN` stays LOW even after
  `PA_SENSE_PIN` drops back to LOW on its own — only
  `POST /pa-emergency-clear` (or the control page's / web app's Clear
  button) restores it. Deliberately no auto-recovery: a real hardware
  fault should require a human to notice and clear it, not silently flap
  the PA back on the moment the sense signal looks okay again.
- Debounced in software (3 consecutive 100ms polls agreeing before a level
  change is believed) — a raw digital input crossing a relay/PA switching
  event is exactly the kind of line that can glitch for a poll or two.
- GPIO2/GPIO4 were chosen because every other A1S header GPIO was already
  claimed (see the intro above) — they're the SD card slot's DATA0/DATA1
  lines, unused since this firmware never mounts the slot. Deliberately
  NOT GPIO12 (also the MTDI strapping pin — risky to drive externally at
  boot) or GPIO13 (DIP-switch-shared with KEY2 on this board).
- **Not yet electrically verified against real hardware** — needs a
  continuity/multimeter check for SD-slot pull resistors on GPIO2/4 and
  confirmation of the interface board's actual output logic levels before
  trusting this on a live PA, same caution already applied to
  `ES8388_PA_REVERTED` elsewhere in this firmware.

### Core placement

ESP-IDF's Wi-Fi driver task defaults to core 0
(`CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0`); lwIP's TCPIP task is explicitly
pinned there too (`CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y`, see
`sdkconfig.defaults`) rather than left at "no affinity", which could
otherwise let network activity drift onto core 1. The CAT UART reader is
pinned exclusively to core 1 (`CAT_BRIDGE_TASK_CORE` in `bridge_config.h`)
— nothing else this firmware creates runs there, so radio I/O timing is
never contended by network stack activity.

## Wiring (see `main/bridge_config.h` to change)

| Signal       | ESP32 GPIO | Notes                                             |
|--------------|------------|---------------------------------------------------|
| CAT UART TX  | GPIO18     | to radio's CAT RX                                 |
| CAT UART RX  | GPIO23     | to radio's CAT TX                                 |
| CAT ground   | —          | common ground with the radio, required            |
| PA Sense in  | GPIO2      | from the interface board's PA-energized feedback  |
| PA Emergency | GPIO4      | to the interface board's PA-send permissive input |

GPIO18/23 were picked deliberately over the board's other 5 free header
pins: GPIO0 is a boot-strap pin (risky to also drive from an external
UART, though it's also the codec's MCLK — see below, both uses are
internal to the board, not exposed on the header, so no conflict),
GPIO21 drives the onboard PA-enable, and GPIO5/19/22 cost the SAME
onboard button/LED functions 18/23 do anyway — no advantage to picking them
instead. This leaves UART0 (GPIO1/3, wired to the board's own USB-serial
chip on its "UART" micro-USB port) completely free for flashing/`ESP_LOG`
output the whole time the CAT cable is connected.

GPIO2/GPIO4 (PA Sense/PA Emergency — see PA safety watchdog above) are the
SD card slot's DATA0/DATA1 lines, repurposed since the header itself had
nothing left free. **Not yet electrically verified** — check for SD-slot
pull resistors and the interface board's actual output levels before
wiring these up on real hardware.

Everything below this point is **onboard, not header wiring** — nothing to
physically connect, listed here only because it's not obvious from the
schematic which pins the firmware actually uses:

| Signal           | ESP32 GPIO | Notes                                                   |
|------------------|------------|---------------------------------------------------------|
| Status LED (in)  | GPIO22     | audio-in level (see Status LEDs above)                  |
| Status LED (out) | GPIO19     | audio-out level; doubles as the KEY3 button pin         |
| Codec I2C SDA    | GPIO33     | ES8388 control                                          |
| Codec I2C SCL    | GPIO32     | ES8388 control                                          |
| Codec PA enable  | GPIO21     | amplifier power, polarity unconfirmed — see limitations |
| Codec I2S MCLK   | GPIO0      | shares the boot-strap pin, internal-only use            |
| Codec I2S BCLK   | GPIO27     |                                                         |
| Codec I2S WS     | GPIO25     |                                                         |
| Codec I2S DOUT   | GPIO26     | ESP32 → codec DAC                                       |
| Codec I2S DIN    | GPIO35     | codec ADC → ESP32                                       |

The board has **two micro-USB ports** — one labeled power, one labeled
UART. Flash and monitor over the UART port; the power port is for
supplying current only (relevant if the radio/USB host can't supply enough
through the UART port alone).

## Build / flash

Requires the ESP-IDF toolchain (v5.x), installed separately — not present
in this repo. See Espressif's [Get Started
guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/)
if you don't have it set up (`install.sh` + `export.sh` from an `esp-idf`
checkout, or the VS Code/CLion extension).

```bash
cd firmware/esp32-cat-bridge
idf.py set-target esp32
idf.py menuconfig     # set Wi-Fi SSID/password under "CAT Bridge Config"
                       # (CAT UART baud default is also here — match the
                       # radio's CAT menu setting)
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor   # adjust the port — the A1S's "UART"
                                        # micro-USB port, typically a
                                        # CP2102 (Silicon Labs) adapter
```

`sdkconfig` (generated by the above, containing your Wi-Fi password) and
`build/` are gitignored — never commit `sdkconfig`.

Flash layout is a custom table (`partitions.csv`, not the ESP-IDF default)
so there's room for both the app and the control page's SPIFFS partition on
the same 4MB chip: a 1.5MB app slot (no OTA — same single-slot model as the
default single-app table, just resized) plus a 256KB `storage` partition
for `spiffs_data/`. `idf.py flash` writes both; editing anything under
`spiffs_data/` just needs a rebuild + reflash, same as any other source change.

## Known limitations (first pass — fine for now, worth revisiting later)

- **Wi-Fi reconnect bookkeeping is minimal.** The retry/backoff event bits
  aren't cleared across a connect → disconnect → reconnect cycle. Nothing
  currently re-reads them after boot, so this has no observed effect, but a
  future feature that inspects Wi-Fi state transitions should double-check
  this first.
- **No forced eviction of a stale WebSocket client.** If a browser tab
  disconnects uncleanly (no clean WS close frame — e.g. laptop sleep), the
  old socket relies on the OS/httpd's own timeout to notice; until then it
  still counts toward `WS_MAX_CLIENTS` even though nothing's really there.
- **Static-file hosting is SPIFFS-only, for the control page alone.** The
  ESP32 does not serve the Signal-Decoder web app's own `dist/` —
  `partitions.csv`'s `storage` partition (256KB) has room to spare if
  that's wanted later, but a full app bundle is a different order of size
  than the control page's few KB.
- **PA_MAX_ON_SECONDS (300s default) is a placeholder.** Should reflect the
  longest realistic legitimate transmission for this station's actual use
  (a long FT8 sequence, a ragchew on SSB, etc.) with real margin — not yet
  tuned against any real-world usage pattern.
- **PA Sense/Emergency wiring is not yet electrically verified.** GPIO2/
  GPIO4 need a continuity/multimeter check against the real board (SD-slot
  pull resistors, the interface board's actual output logic levels)
  before trusting this on a live PA — see PA safety watchdog above.
- **`/pa-emergency-clear` has no auth beyond reaching the bridge at all**
  — same trust model as the rest of `http_control`'s LAN-only surface (see
  the standalone-control-page no-auth note just below), but worth calling
  out separately here since this one re-enables a safety-critical path
  rather than just changing settings or restarting.
- **PSRAM is present but unused.** `CONFIG_SPIRAM` is deliberately left
  disabled — nothing in this firmware needs it yet. Revisit once the audio
  feature needs the extra RAM for buffering.
- **The standalone control page has no auth.** Anyone on the LAN — or, while
  in AP fallback, anyone who joins the fallback AP itself — can view
  status, change its Wi-Fi network, or restart it. Acceptable for a
  home-network device with no sensitive data behind it, but worth a second
  look before ever exposing this bridge beyond a trusted network, and worth
  remembering that the fallback AP's password is a fixed Kconfig default,
  not something the control page lets you change.
- **ES8388 PA-enable polarity (`ES8388_PA_REVERTED` in `bridge_config.h`) is
  unconfirmed.** Cross-referenced community sources for this exact board
  (v2.2) didn't give an explicit active-high/active-low statement — current
  value is a best guess based on circumstantial evidence. If the amp turns
  out permanently on, permanently silenced, or audio_monitor's level
  readings look inverted/wrong, this is the first thing to check.
- **No compression on `/audio`.** Raw PCM was a deliberate choice (see Audio
  bridge above) — trivial bitrate at 8kHz on a home LAN, zero codec CPU cost
  on the ESP32. G.711 (halves bandwidth, negligible CPU) and Opus (much
  better quality/compression, real CPU + flash cost, WebRTC-grade) were both
  considered; revisit if this bridge ever needs to run over a link where
  128kbit/s actually matters.
- **`/audio` has no per-client mixing.** If more than one browser sends mic
  audio at once, whichever `esp_codec_dev_write()` call lands last on a
  given ~50ms window wins — same "last command on the wire" model `/cat`
  already uses for CAT commands, just applied to audio instead. Fine for
  the expected one-remote-operator-at-a-time use case; would need real
  mixing if that assumption ever changes.
- **Audio sample rate is fixed at 8kHz mono.** `ES8388_SAMPLE_RATE_HZ` in
  `bridge_config.h` — plenty for SSB voice (~2.7kHz bandwidth) and keeps
  `/audio`'s bitrate trivial; revisit only if a future mode needs wider
  audio bandwidth than voice.

## Web app integration

`src/lib/cat/useRadioCAT.ts` supports both transports — pick "Wi-Fi CAT
bridge" instead of "USB / Serial cable" in the Radio CAT panel's connection
settings and point it at the bridge's WebSocket URL (defaults to
`ws://usdx-bridge.local/cat`, or use its IP if mDNS doesn't resolve on your
network — check `GET http://<ip>/status` from another device on the same
network to confirm the bridge is up and see its reported IP). The
parsing/queueing logic (frame prefixes, batched queries, poll loop,
auto-report handling) is identical either way; only the `connect`/`write`/
read-loop plumbing at the bottom of `useRadioCAT.ts` differs per transport.
The web app's Bridge panel (in the Radio CAT settings) also exposes the
`http_control` endpoints above — status, restart, Wi-Fi network change, CAT
baud rate, PA emergency clear — gated on whatever `GET /info` reports the
connected bridge supports. A tripped PA emergency shows as a prominent red
banner at the top of the Bridge panel (above the normal status grid),
distinct from the panel's PA-sense status row further down. The web app
itself doesn't have a CAT frame monitor/log — that's
only on the standalone control page (see CAT monitor above); the web app's
own `useRadioCAT.ts` already parses every frame it needs for its own UI, so
a raw log there would just duplicate what the control page already covers
for debugging.

`src/lib/cat/useAudioBridge.ts` (also gated on `GET /info`'s `"audio"`
feature) opens the `/audio` WebSocket, plays received samples via Web Audio
(back-to-back `AudioBufferSourceNode`s, since there's no "append to an
ongoing stream" primitive), and captures the browser's mic through the
same `createCaptureNode` AudioWorklet the app's decoders use, linearly
resampled to `ES8388_SAMPLE_RATE_HZ` before sending. It also exposes an
`AnalyserNode` per direction (tapped onto the existing playback/capture
graphs) for `src/components/AudioQualityPanel.tsx` — see Audio quality
visualization above. The standalone control page (`spiffs_data/app.js`)
implements the same audio protocol AND the same quality-analysis logic
independently in plain JS (`ScriptProcessorNode` instead of an AudioWorklet
module, a hand-rolled canvas-2D scrolling waterfall instead of
`GLSpectrogram`, since that page has no bundler) — useful for debugging the
audio path directly from the bridge itself, without the web app in the
loop at all.
