# ESP32 CAT bridge

Wi-Fi bridge between the uSDX BLACK_BRICK's CAT serial port and the
Signal-Decoder web app, replacing the USB-serial cable with a WebSocket over
the home network. Built on ESP-IDF's native runtime (FreeRTOS + esp-idf
components) — **not** the Arduino core.

Target board: **AI-Thinker ESP32-A1S Audio Kit**. This is a WROVER-class
module (8MB PSRAM — GPIO16/17 are internally reserved for it, not even
broken out to the header) with an onboard ES8388 audio codec and an onboard
SD card slot (SDMMC on GPIO2/4/12/13 — disjoint from the CAT UART pins
below, unused by this firmware). Only 7 header GPIOs are free (0, 5, 18, 19,
21, 22, 23) and every one already drives an onboard button, LED, or the
amplifier-enable line — this firmware claims just 2 of them (18, 23) for
the CAT UART and leaves the rest alone. The onboard codec is reserved for a
future audio/WebRTC feature, not used yet — this is the first of a planned
pair of features on this hardware: CAT now, audio in/out later (RX/TX audio
streamed over the same link instead of a USB sound-card interface), plus
any other small radio controls that make sense to add once the bridge exists.

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
- **`control_page`** serves a small standalone status/Wi-Fi/restart page at
  `GET /` (plus `/style.css`, `/app.js`), so the bridge can be managed
  directly from any browser on the LAN without going through the
  Signal-Decoder web app at all. The page is static HTML/CSS/JS (source in
  `spiffs_data/`) that just calls the same `http_control` endpoints above —
  it has no logic of its own beyond that. Files are baked into a SPIFFS
  image at build time onto the `storage` partition (see `partitions.csv`)
  and flashed alongside the app.
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

### Core placement

ESP-IDF's Wi-Fi driver task defaults to core 0
(`CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0`); lwIP's TCPIP task is explicitly
pinned there too (`CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y`, see
`sdkconfig.defaults`) rather than left at "no affinity", which could
otherwise let network activity drift onto core 1. The CAT UART reader is
pinned exclusively to core 1 (`CAT_BRIDGE_TASK_CORE` in `bridge_config.h`)
— nothing else this firmware creates runs there, so radio I/O timing is
never contended by network stack activity. This matters more once audio
streaming is added, but costs nothing to set up now.

## Wiring (see `main/bridge_config.h` to change)

| Signal      | ESP32 GPIO | Notes                                  |
|-------------|------------|----------------------------------------|
| CAT UART TX | GPIO18     | to radio's CAT RX                      |
| CAT UART RX | GPIO23     | to radio's CAT TX                      |
| CAT ground  | —          | common ground with the radio, required |

GPIO18/23 were picked deliberately over the board's other 5 free header
pins: GPIO0 is a boot-strap pin (risky to also drive from an external
UART), GPIO21 drives the onboard PA-enable, and GPIO5/19/22 cost the SAME
onboard button/LED functions 18/23 do anyway — no advantage to picking them
instead. This leaves UART0 (GPIO1/3, wired to the board's own USB-serial
chip on its "UART" micro-USB port) completely free for flashing/`ESP_LOG`
output the whole time the CAT cable is connected.

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
  deliberately deferred until the audio feature's flash/RAM budget is
  known. `partitions.csv`'s `storage` partition (256KB) has room to spare
  if that's wanted later, but a full app bundle is a different order of
  size than the control page's few KB.
- **Baud rate is boot-time only.** `cat_bridge_set_baud()` exists for a
  future runtime control message but nothing calls it yet — changing baud
  today means editing Kconfig and reflashing.
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
`http_control` endpoints above — status, restart, Wi-Fi network change —
gated on whatever `GET /info` reports the connected bridge supports.
