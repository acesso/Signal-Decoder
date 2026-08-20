# ESP32 CAT bridge

Wi-Fi bridge between the uSDX BLACK_BRICK's CAT serial port and the
Signal-Decoder web app, replacing the USB-serial cable with a WebSocket over
the home network. Built on ESP-IDF's native runtime (FreeRTOS + esp-idf
components) — **not** the Arduino core.

Target board: **AI-Thinker ESP32-A1S Audio Kit**. This is a WROVER-class
module (8MB PSRAM — GPIO16/17 are internally reserved for it, not even
broken out to the header) with an onboard ES8388 audio codec and an onboard
SD card slot (SDMMC on GPIO2/4/12/13, not used by this firmware). All 7
header GPIOs that are nominally "free" (0, 5, 18, 19, 21, 22, 23) are
claimed: 2 (18, 23) for the CAT UART, 1 (22) for the single status LED, 1
(21) for the codec's onboard PA-enable line, and 2 more (19, 5) for a PA
safety watchdog for an external amplifier (see PA safety watchdog below) —
both real header pins, not the SD card slot. The onboard codec streams
both directions — radio speaker audio out to the browser, browser mic
audio into the radio's mic input — over a second WebSocket (see Audio
bridge below).

An earlier revision of the PA safety watchdog used the SD card slot's
unused GPIO2/GPIO4 (and later GPIO13) pads instead of real header pins —
abandoned after GPIO2 was found to read a permanent false HIGH from the
board's own SD-bus pull-up, and because none of those pins have any
header/pin access anyway (soldering to the SD slot directly was the only
way to reach them). See main/doc/PA_WATCHDOG_DESIGN.md's pin-choice
revision history for the full story. Freeing GPIO19 for the watchdog meant
dropping the second status LED (this board originally had two, one per
audio direction) — see Status LEDs below.

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
  continuously and broadcasts the raw samples to every `/audio` client;
  writes whatever a client sends straight to the DAC.
- **`audio_ws`** is `/audio`'s WebSocket route — the same "byte-transparent,
  no framing beyond the raw payload" philosophy as `/cat`, just carrying
  16-bit PCM samples instead of ASCII CAT commands. See Audio bridge below.
- **`led_status`** drives the board's single status LED via LEDC PWM — see
  the LED legend below for what each state looks like.
- **`pa_watchdog`** guards against the uSDX hanging with the external
  amplifier still keyed — see PA safety watchdog below.

### Status LED

One onboard LED (GPIO22) shows, in priority order (highest wins):

| State            | LED behavior                                                                  |
|------------------|--------------------------------------------------------------------------------|
| PA emergency     | Strobes VERY fast (~100ms) — hardware safety fault, outranks everything below |
| AP fallback      | Blinks fast (~300ms) — network needs fixing                                   |
| Wi-Fi connecting | Blinks (~400ms) — joining, not stuck yet                                     |
| Normal           | Pulses dim-to-bright-to-dim (2s, floors at ~17% not 0%) — "still alive"       |

The 2s pulse is a permanent "still alive" base layer, present whether or
not CAT is linked. This board originally had two status LEDs (GPIO22 +
GPIO19), one per audio direction, with real audio level riding on top of
the pulse as extra brightness — GPIO19 was reclaimed for the PA safety
watchdog's header wiring (see PA safety watchdog below), so audio-level
display was dropped rather than trying to fold two independent levels onto
the one remaining LED.

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

**Backpressure**: `/audio` and `/audio-mic-sniff` both broadcast on a fixed
~50ms timer, and both share the bridge's ONE httpd worker task with `/cat`
and every plain HTTP route (`GET /status`, etc — `httpd_queue_work()` just
posts to that same task's control socket, there's no separate worker pool
or queue depth). Broadcasting unconditionally on that timer, regardless of
whether a client's previous frame has actually finished sending, was found
on real hardware to starve the whole httpd instance once a Wi-Fi link
degraded enough that sends stopped completing within 50ms: new work kept
queuing faster than the one worker could drain it, and `/status` timed out
for as long as the backlog persisted (the device stayed reachable over
plain ICMP the entire time — this was never a Wi-Fi disconnect, just an
httpd task buried in its own backlog). Fixed by tracking one
"send-in-flight" flag per client in both `audio_ws.c` and `audio_sniff.c`:
a broadcast simply skips a client that's still waiting on its prior frame
instead of queueing another one behind it — sheds load exactly when the
worker is falling behind, and self-heals the moment sends start completing
again.

### Mic → radio sniffer

`/audio`'s browser→bridge direction (mic audio written straight to the
ES8388 DAC, feeding the radio's mic input) has no return signal at all —
once sent, there's no way to confirm the audio actually reached the radio,
or what it sounded like once it got there. `GET /audio-mic-sniff` upgrades
to a **read-only** WebSocket broadcasting a copy of the exact samples just
written to the DAC (`audio_sniff.c`/`.h`), so an operator debugging their
own transmitted signal has something to actually look at and listen to.

Deliberately a fully separate endpoint from `/audio` rather than echoing
through it: mixing a sniffed copy into `/audio`'s existing radio-speaker
broadcast would make a listener unable to tell "this is what I just sent"
apart from "this is what the radio is doing", and would add load/risk to
a path (`/audio`) that's already had real reliability problems (see
`audio_ws.c`'s zombie-client eviction history) for a debug feature that
doesn't need to share it. Server → client only — closing or stalling a
sniffer client can never affect the real mic-to-radio write it mirrors.

On the standalone control page, "Start Sniffing" (with a "Play through
speakers" option) replaces what used to be a "Send Mic to Radio" button —
that button let the operator send their own computer's mic to the radio
from this page, which had no real use case once the actual mic-send path
lives in the Signal-Decoder web app itself; the sniffer is what's
actually useful here, since it's the only way to inspect signal already
in flight from that app. The sniffer feeds the same bar
spectrum/waterfall/oscilloscope/stats quality view described below.

### Audio quality visualization (browser-side)

The interface board has manual RC filter trimpots for both audio
directions (radio → browser and browser → radio) — tuned by eye, not by
ear, since "does this sound right" isn't reliable enough for that
adjustment. The standalone control page's Audio card renders this
analysis, driven entirely client-side from an `AnalyserNode` tapped onto
the existing playback graph (radio → browser) and onto the mic → radio
sniffer's own playback graph (see "Mic → radio sniffer" below) — **zero
firmware involvement** beyond the sniffer's own read-only tap, this is
pure browser-side processing of raw PCM already crossing `/audio` and
`/audio-mic-sniff`. Always rendered (no show/hide toggle — the per-frame
canvas work is cheap enough at this size not to bother hiding), and
merged into the same card as the Listen/Sniff controls and level meters
rather than a separate section, since operating the bridge and checking
audio quality are the same task. Deliberately more than a bare VU meter,
since a trimpot problem can be easy to miss just eyeballing a
constantly-moving trace:

- **Bar spectrum** — the filter's passband shape/cutoff slope/ripple
  directly, updating live as a trimpot turns. Axis-labeled (Hz across the
  bottom, dBFS up the side) and tuned for actual movement at typical
  signal levels — `smoothingTimeConstant` 0.4 (not the default 0.8, which
  reads as almost static) and a -90dBFS…-10dBFS range (not the default
  -100…-30, which clipped most real signal into a narrow low band). A
  **Max freq** slider (500Hz–4kHz, default 4kHz) crops both the bar
  spectrum and waterfall's frequency axis to whatever span the operator's
  actual signal occupies — the radio's own passband tops out well below
  the full 0–Nyquist span these views default to, and cropping in gives a
  bigger, more legible view of just that range.
- **Estimated rolloff marker** — a blue dashed **horizontal** line +
  Hz readout at the amplitude the spectrum drops to roughly half its peak
  magnitude (a simple, robust ~-6dB-relative-to-peak threshold, not a
  true -3dB reconstruction — 8-bit log-mapped analyser data doesn't have
  the resolution for that level of precision, and this is plenty to watch
  move as you tune). Drawn at that half-peak amplitude's position on the
  dB axis, not at a frequency position, so it reads directly against the
  bar spectrum's side axis.
- **Waterfall** — scrolling spectrum history via a simple canvas-2D
  scrolling column (this page has no bundler/GPU component), so an
  intermittent issue is visible over time, not just the current instant.
  Axis-labeled in Hz (respects the same Max freq slider as the bar
  spectrum); a **Contrast** slider (gamma 0.2–3, default 1.2) controls
  how aggressively faint signal is boosted into visible color.
- **Oscilloscope** — a spectrum alone can't show clipping (it looks like
  broadband harmonic energy in the frequency domain); the time-domain
  trace shows the actual flat-topped waveform directly. Axis-labeled in
  ms (time) and %FS (amplitude).
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

"Listen to Radio" (`/audio`) and "Start Sniffing" (`/audio-mic-sniff`) are
independent — either can be toggled without the other already running,
and each has its own WebSocket/AudioContext (see "Mic → radio sniffer"
below for why the sniffer deliberately isn't folded into `/audio`).

The Signal-Decoder web app has its own separate, unrelated
`AudioQualityPanel.tsx` implementing the same kind of analysis for its own
Bridge panel — the two are intentionally independent UIs (this page lives
on the ESP32 itself for zero-install LAN access; the web app is the full
decoder application), not something this section's fixes apply to.

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

- **`PA_SENSE_PIN` (GPIO19, input)** reads a signal the *user's own
  interface board* derives from the miniPA70's actual energized 12V leg
  (after their own level-shifting down to safe logic) — not the uSDX's
  PA-send command line. The miniPA70 itself is a bare, undocumented kit
  amp (two-pin PTT-in via a PNP-driven relay) with no feedback of its own,
  so this is the only signal that proves the PA hardware is truly on,
  independent of whether the uSDX's command line or the interface board's
  own level-shifting are behaving correctly — that independence is the
  entire point of a watchdog.
- **`PA_EMERGENCY_PIN` (GPIO5, output)** is a permissive line in series
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
- GPIO19/GPIO5 are real header pins, not the SD card slot — GPIO19 was
  freed by dropping the second status LED (see Status LED above), GPIO5
  was the one header GPIO left genuinely unclaimed. An earlier revision
  used the SD card slot's GPIO2/GPIO4 (and later GPIO13) pads instead —
  abandoned after GPIO2 was found to read a permanent false HIGH from the
  board's own SD-bus pull-up, and because none of those pins have any
  clean header/pin access anyway. See `main/doc/PA_WATCHDOG_DESIGN.md`'s
  pin-choice revision history for the full story. Deliberately NOT GPIO12
  (the MTDI strapping pin — risky to drive externally at boot).
- **Not yet electrically verified against real hardware** — needs a
  continuity/multimeter check confirming GPIO19/GPIO5 read/drive as
  expected with nothing else wired to the header (the exact check that
  caught GPIO2's false-HIGH pull-up in the earlier revision) and
  confirmation of the interface board's actual output logic levels before
  trusting this on a live PA, same caution already applied to
  `ES8388_PA_REVERTED` elsewhere in this firmware.

### Core placement

Two-core split along "what this bridge fundamentally does" lines — full
reasoning in `bridge_config.h`'s Task placement comment:

- **Core 0 — Wi-Fi/network/control.** ESP-IDF's Wi-Fi driver task defaults
  here (`CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0`); lwIP's TCPIP task is
  explicitly pinned too (`CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y`, see
  `sdkconfig.defaults`) rather than left at "no affinity". The httpd
  worker task is explicitly pinned here as well (`ws_server.c`'s
  `config.core_id = 0`) — it's what actually sends every `/cat` and
  `/audio` broadcast frame (queued via `httpd_queue_work` from the core-1
  tasks below), so leaving it unpinned could let it drift onto core 1 and
  contend directly with the tasks core-1 isolation exists to protect.
  `led_status` (purely cosmetic, no timing requirement) is left unpinned,
  which in practice means it shares core 0.
- **Core 1 — the relay itself.** CAT UART reader (`CAT_BRIDGE_TASK_CORE`),
  the audio codec I/O (`AUDIO_MONITOR_TASK_CORE`), and the PA watchdog's
  polling (`PA_WATCHDOG_TASK_CORE`) — all pinned here, all in
  `bridge_config.h`, so none of the bridge's real-time relay work is ever
  contended by Wi-Fi/network activity. Priority order (highest wins): CAT
  UART (protocol correctness — a dropped/garbled CAT byte breaks the whole
  session) > PA watchdog (safety-critical timing, but genuinely light —
  one GPIO read per 100ms) > audio (a dropped buffer is a barely
  perceptible glitch, most tolerant of the three). All three block with a
  timeout under the hood (`uart_read_bytes`' own 20ms timeout,
  `esp_codec_dev`'s DMA-backed I2S, GPIO polling's `vTaskDelay`) rather
  than busy-waiting, so this is normal FreeRTOS preemption between real
  tasks sharing a core, not a starvation risk.

## Wiring (see `main/bridge_config.h` to change)

| Signal       | ESP32 GPIO | Notes                                             |
|--------------|------------|---------------------------------------------------|
| CAT UART TX  | GPIO18     | to radio's CAT RX                                 |
| CAT UART RX  | GPIO23     | to radio's CAT TX                                 |
| CAT ground   | —          | common ground with the radio, required            |
| PA Sense in  | GPIO19     | from the interface board's PA-energized feedback  |
| PA Emergency | GPIO5      | to the interface board's PA-send permissive input |

All 7 of the header's nominally-free GPIOs (0, 5, 18, 19, 21, 22, 23) are
now claimed. GPIO18/23 were picked for CAT deliberately over the
alternatives: GPIO0 is a boot-strap pin (risky to also drive from an
external UART, though it's also the codec's MCLK — see below, both uses
are internal to the board, not exposed on the header, so no conflict),
GPIO21 drives the onboard PA-enable, GPIO22 drives the status LED, and
GPIO5/19 are claimed by the PA watchdog below — no advantage to picking
any of them instead. This leaves UART0 (GPIO1/3, wired to the board's own
USB-serial chip on its "UART" micro-USB port) completely free for
flashing/`ESP_LOG` output the whole time the CAT cable is connected.

GPIO19/GPIO5 (PA Sense/PA Emergency — see PA safety watchdog above) are
real header pins: GPIO19 was freed by dropping the second status LED,
GPIO5 was the one header GPIO left genuinely unclaimed. **Not yet
electrically verified** — check that both read/drive as expected with
nothing else wired to the header, and confirm the interface board's
actual output levels, before wiring these up on real hardware.

Everything below this point is **onboard, not header wiring** — nothing to
physically connect, listed here only because it's not obvious from the
schematic which pins the firmware actually uses:

| Signal          | ESP32 GPIO | Notes                                                   |
|-----------------|------------|----------------------------------------------------------|
| Status LED      | GPIO22     | see Status LED above                                    |
| Codec I2C SDA   | GPIO33     | ES8388 control                                          |
| Codec I2C SCL   | GPIO32     | ES8388 control                                          |
| Codec PA enable | GPIO21     | amplifier power, polarity unconfirmed — see limitations |
| Codec I2S MCLK  | GPIO0      | shares the boot-strap pin, internal-only use            |
| Codec I2S BCLK  | GPIO27     |                                                          |
| Codec I2S WS    | GPIO25     |                                                          |
| Codec I2S DOUT  | GPIO26     | ESP32 → codec DAC                                       |
| Codec I2S DIN   | GPIO35     | codec ADC → ESP32                                       |

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
- **PA Sense/Emergency wiring is not yet electrically verified.** GPIO19/
  GPIO5 need a continuity/multimeter check against the real board (confirm
  neither carries a surprise pull resistor the way GPIO2 did in an earlier
  revision, and confirm the interface board's actual output logic levels)
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
