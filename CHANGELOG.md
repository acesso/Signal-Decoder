# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release automation reads this file: when a branch is merged into `main`, CI
creates a GitHub release for the topmost `## [x.y.z]` section if that tag does
not exist yet. Add new entries under `[Unreleased]` while developing and move
them into a version section when cutting a release.

## [Unreleased]

## [0.12.0] - 2026-08-26

### Fixed

- Fixed intermittent multi-second I/Q stream stalls (heard as metallic crackling, decode-breaking) on the ESP32 bridge's `/iq-data` WebSocket: the bridge's Wi-Fi network broadcasts one SSID from multiple same-channel APs, and the bridge could roam between them mid-session — added an optional BSSID pin (Kconfig default + `POST /wifi-config`) to keep it associated with one AP. Also gave `/iq-data` a small per-client ring buffer (was a single reused slot) so a brief send stall becomes added latency instead of a dropped frame.
- Fixed a periodic click/buzz in audio sent to the radio over the ESP32 bridge (FT8 TX and manual mic-send): the browser-side resampler treated every capture chunk as an independent buffer, discarding the fractional sample position and true next sample at each chunk boundary — now carries that state across the whole session.
- Fixed the ESP32 bridge locking up after several minutes of audio streaming (`/status` and all other requests timing out while the device stayed reachable): `/audio` and `/audio-mic-sniff` broadcasts queued a new send to the shared httpd worker task every 50ms per client with no backpressure, and a degraded Wi-Fi link let that backlog grow faster than the single worker could drain it. Broadcasts now skip a client whose previous frame hasn't finished sending instead of piling on more work.
- Fixed the ESP32 bridge's persistent CAT log crash-looping on boot once it grew large enough that its flash-scan recovery starved the task watchdog.
- Fixed a client-slot leak on `/cat` and `/audio`: a plain HTTP GET (not a real WebSocket handshake) permanently occupied a client slot.
- Fixed CAT frames sent from one browser tab not being broadcast to other connected tabs.
- Fixed the web app's TX audio defaulting to the local speaker instead of the ESP32 bridge even when the bridge was connected.
- Fixed a reconnect storm on weak Wi-Fi: the CAT and audio bridge sockets now back off exponentially (2s–30s) instead of retrying every 2s indefinitely.
- Fixed `GET /cat-log` failing once the log filled, due to a single large heap allocation for the response.
- Fixed the Signal Analysis panel's spectrum/waterfall graphs slowing down since I/Q mode was introduced (most noticeable zoomed into a small slice of a wide I/Q band, or while viewing "Decoded audio"): the I/Q spectrum FFT ran on every incoming frame regardless of whether anything on screen was actually reading it. It now only runs while a panel is genuinely displaying the raw I/Q tap.
- Fixed the Signal Analysis panel's "View" zoom-preset chips (1k/2k/3k/6k etc.) silently reverting the moment they were clicked whenever the preset's range didn't fully fit the current source's bounds. Replaced with 1k/2k/3k/6k presets plus one dynamic preset for the full currently-available span, each capped so it can never request a range wider than the source.
- Fixed CW/RTTY/MFSK's own tone/channel markers no longer appearing on the Signal Analysis panel once I/Q mode was introduced — they were never wired into that code path at all. They now reappear when "Decoded audio" is selected as the panel's signal source (and stay hidden on "Raw I/Q", where they don't correspond to anything).
- Fixed a real decoded callsign, `VP2MAA` (Anguilla), being rejected as invalid: the callsign-shape parser preferred a 2-letter prefix reading ("VP") that isn't itself an ITU allocation, when the correct reading is the 2-letter+digit prefix ("VP2") — same class of ambiguity already handled for D2/V2/A2/T7, just one prefix-length further. Also fixes VP5 (Turks & Caicos) and VP9 (Bermuda).

### Changed

- Signal Analysis panel: numeric Hz fields (Center/Width/View range) no longer clamp or show spinner arrows while typing — a value could get silently snapped back mid-edit before the operator finished entering it.
- Signal Analysis panel: switching the "Signal source" between Raw I/Q and Decoded audio no longer resets the current zoom/pan range back to a default; it's preserved unless the current view is entirely outside what the new source can show.
- Signal Analysis panel: added an icon-only signal-strength meter next to the panel title (I/Q mode only), and moved the "Signal source" selector up next to the title instead of at the bottom of the panel.
- Transmit panel: reworked the top control row for less wasted vertical space — Output device selection, OutputSelector, and "Suspend I/Q spectrum during TX" are one row instead of three; the always-on/off toggles (Auto-CQ, Auto-PTT, Consecutive TX, Auto-Reply) are grouped into a compact 2-column grid; removed the "Output selection requires Chrome 110+" fallback text, which broke the row's alignment on unsupported browsers; and the Auto-CQ interval field is now labeled and sits with the panel's other numeric fields instead of floating unlabeled next to Start TX.

### Added

- ESP32 bridge: a read-only mic→radio audio sniffer (`/audio-mic-sniff`) so the operator can hear and visually inspect the exact audio just written to the radio's mic input — the web app's mic-send path has no return signal otherwise.
- ESP32 bridge control page: the sniffer replaces the previous "Send Mic to Radio" button, with the same spectrum/waterfall/oscilloscope/stats quality view as the "Listen to Radio" channel, including an operator-adjustable max-frequency slider on both channels and a horizontal (rather than frequency-position) rolloff marker.
- ESP32 bridge: an on/off toggle for the persistent CAT log (`POST /cat-log-enable`), default off since it's a debug feature.
- ESP32 bridge: PA sense/emergency-cutoff wiring moved from SD-card pads to header pins (GPIO19/GPIO5), consolidating the two status LEDs into one.
- ESP32 bridge: RX-loop timing diagnostics in `GET /system-stats` (longest loop interval/read/broadcast duration since the last poll) — used to isolate the I/Q stream stall fixed above.

## [0.11.5] - 2026-08-07

### Fixed

- SSTV VIS detection no longer requires a pristine signal: tolerates real HF noise and hard-silence dropouts in the leader/break tones, calibrates for receiver frequency/tuning offset, and fixed a bit-timing bug that could misdecode the VIS header even on a clean signal.
- SSTV decoder recovers from a stale sync lock after an extended noisy stretch instead of stalling permanently for the rest of the transmission.
- SSTV scan-line sync now tolerates a real receiver's frequency offset and a compressed (shorter-than-nominal) sync pulse width.

### Added

- SSTV transmit: pre-key delay setting (Composer, next to Auto-PTT) — holds PTT before starting audio so the VIS leader tone's start isn't clipped by the rig's PTT/ALC settling time.
- SSTV transmit: a horizontal scanline overlay sweeps down the preview image during playback, and the collapsed-panel summary chip now shows a plain countdown instead of a redundant percentage + countdown pair.

## [0.11.4] - 2026-08-07

### Fixed

- SSTV auto-detect no longer cuts a VIS-confirmed decode short on a mid-transmission fade or quiet gap; only the mode's known expected duration (or full line completion) ends it now.

## [0.11.3] - 2026-08-07

### Fixed

- uSDX BLACK_BRICK firmware (4.02b → 4.02c): fixed an AGC gain ratchet with no ceiling or decay that caused a rising RX noise floor over several minutes on a quiet band.
- Fixed a CAT command buffer off-by-one overflow reachable by any exactly-32-byte command.
- Fixed an out-of-bounds array write in the frequency auto-save path when operating on 160m or 6m.
- Fixed a TX drive integer overflow that could momentarily zero out output on loud audio peaks.
- Reduced EEPROM wear by using update-if-changed semantics instead of unconditional writes.
- Reset AGC and CIC-filter internal state on every TX→RX transition (a separate, still-unresolved "foggy" noise floor appearing right after TX is suspected hardware-side — see firmware README).

## [0.11.2] - 2026-08-06

### Changed

- README/CONTRIBUTING/site metadata cleanup: dropped the "vibe coded" phrasing, corrected CONTRIBUTING.md (still described the project as its original SSTV-only fork, with a `npm run lint` step that doesn't exist), and fixed `robots.txt`/`sitemap.xml` pointing at a stale `sstv-decoder.vercel.app` domain instead of the live `acesso.github.io/Signal-Decoder`.
- Regenerated the social-share preview image (`og-image.png`) — it still said "SSTV DECODER" over an old screenshot; now shows the current multi-mode UI with correct branding.
- Added canonical URL, `og:url`, and JSON-LD `WebApplication` structured data to `index.html`; corrected `author`/removed stale `@smolgroot` Twitter attribution; made `<title>`/description/keywords more specific to what people actually search for.

## [0.11.1] - 2026-08-06

### Changed

- FT8/FT4 decode now starts ~2s before the window boundary instead of waiting for it — both protocols' actual transmission ends well before their nominal window length (FT8: 12.64s of 15s, FT4: 5.04s of 7.5s), so the trailing silence was previously just idle wait time.

## [0.11.0] - 2026-08-05

### Added

- RTTY transmit: compose and send text as Baudot/ASCII FSK audio, with independent carrier shift/baud/bits/parity/stop/sideband settings (seeded from the active decoder session) and a Live mode that transmits each character as you type instead of waiting for Send.
- RTTY squelch, matching CW's: drag the line on the spectrum or use the slider to gate the decoder below a signal-strength threshold, per session.
- RTTY transmit panel shows an estimated TX duration next to the message box and the Send button, and defaults to 170 Hz shift / 45.45 baud (the common amateur RTTY parameters) with Carrier Shift now a preset select instead of free entry.

## [0.10.7] - 2026-08-05

### Fixed

- RTTY's active decoder session permanently garbled its own decode (while other, non-active sessions worked fine) — a SolidJS-port reactivity gap made the active session's config effect re-run on every decoded character instead of only on real config changes, resetting the demodulator's bit-sync on nearly every audio chunk.

## [0.10.6] - 2026-08-01

### Changed

- SSTV auto-detect now uses the mode's known, predictable transmission length (height × scan time, from the VIS-identified mode) as the primary signal that a decode is finished, instead of inferring it from silence/stall heuristics. A VIS or sync-timing lock means the mode — and therefore the exact expected duration — is already known, so auto-detect scanning stays suspended for that whole predictable window; the silence and stall checks remain only as fallbacks for a signal that clearly drops out well before that.

## [0.10.5] - 2026-07-31

### Fixed

- SSTV auto-detect could still get stuck decoding forever (e.g. finishing at 249/256 lines and never re-arming for the next transmission) if the tone/silence heuristic missed real dead air. Added a hard backstop: if a decode makes no line progress for 6 seconds, it now force-completes and re-arms VIS listening regardless of what the silence check thinks.

## [0.10.4] - 2026-07-31

### Fixed

- SSTV auto-detect was still looping on a real (weak, ~-84dBm) over-the-air signal after 0.10.3's fix — the silence-timeout completion path was using raw RMS amplitude, which a weak/noisy real signal can dip under for seconds at a time while still transmitting. Silence detection is now based on in-band SSTV tone energy vs. broadband noise energy (Goertzel), which stays accurate regardless of the signal's absolute level.

## [0.10.3] - 2026-07-31

### Fixed

- SSTV auto-detect was still looping on rapid, mostly-black partial captures after 0.10.2's timing guard — the real fix removes the mid-decode VIS re-check entirely instead of just delaying it. Once auto-detect locks onto a transmission, it now decodes undisturbed to real completion or a silence timeout before ever re-arming VIS listening, instead of racing a second VIS scan against the active decode.

## [0.10.2] - 2026-07-30

### Fixed

- SSTV auto-detect mid-decode VIS re-check was false-triggering almost immediately after a decode started (especially over an echoey self-loopback path), causing a rapid loop of mostly-black partial captures instead of one clean image. Mid-decode VIS hits are now ignored for the first few seconds of a decode, when a legitimate back-to-back transmission couldn't yet have started.

## [0.10.1] - 2026-07-30

### Added

- Google Analytics 4 pageview and custom-event tracking (decoder mode switches, decode starts, QSO confirmations, ADIF export/import, PWA install), enabled only in production builds.

## [0.10.0] - 2026-07-29

### Added

- SSTV QSO Card composer: compose and transmit a QSO card image over SSTV, with drop/upload/paste/URL image sources, draggable multi-line text overlays, and draggable/resizable reply boxes for a recipient to fill in by hand.
- Reply-to-received-image workflow: reply from the decoder's gallery pre-fills an inset of the received image, a timestamp/callsign/RSV text layer, and an automatically estimated RSV (Readability/Strength/Video) signal report.
- Saved QSO cards persist and are fully editable — reload a saved card's image, text, and layout back into the composer, save changes in place, rename, or send immediately.
- Auto-PTT, TX gain (dB), and a live transmit countdown/status chip for the SSTV composer, matching the FT8/4 transmit panel's conventions.
- Automatic mid-stream SSTV mode detection: when the VIS header is missed (tuning in after a transmission already started), the decoder now identifies the mode from sync-pulse timing instead of giving up.

## [0.9.8] - 2026-07-28

### Added

- Configurable pre-key (warm-up) and post-key (cool-down) delays around Auto-PTT, for external PAs/relays that need time to switch.
- Fox/Hound (DXpedition) mode toggle for Suggested Messages — jumps straight to RR73 once Fox reports you instead of the normal R+report round-trip.
- Requeue icon on Sent Log entries to quickly resend a past message.

### Fixed

- Suggested Messages could get stuck proposing a report/RR73 reply based on a station's transmission to a *different* callsign, instead of only advancing on replies actually addressed to us.
- The TX Queue countdown and TX ring flashed a full window remaining for one frame at the exact instant a transmission fired, making it look like TX happened a window early.
- The TX Queue countdown reset to a full window and back when the upcoming window had already been decided as a skip (forced listen window, empty queue, or Auto-CQ not yet due) instead of counting through to the real next opportunity.

## [0.9.7] - 2026-07-27

### Fixed

- Suggested Messages kept proposing "continue this QSO" (re-send report/RR73/73) for a station that had already moved on to work someone else — the state machine only looked at the last message that station ever sent *specifically to us*, ignoring that their most recent transmission overall had gone to a different callsign. It now detects this abandonment (their latest heard transmission is newer than our last message to them, and wasn't addressed to us) and resets to a fresh answer instead of endlessly retrying a QSO the other side already left; the suggestion's thread now also shows their abandoning transmission so it's visible in the UI, not just inferred.

## [0.9.6] - 2026-07-27

No functional change — verifies the release/deploy pipeline (and the new update-available prompt) end-to-end.

## [0.9.5] - 2026-07-27

### Fixed

- A tab left open across a new deploy could keep running stale JS indefinitely: the PWA's auto-injected `registerSW.js` only calls `navigator.serviceWorker.register()` once on load with no update detection, so even though the new service worker installs and activates in the background, the already-loaded page never knew to refresh. Now registered manually with update detection, surfacing a small dismissible "Update available — Reload" prompt instead of silently staying stale or force-reloading mid-decode/mid-QSO.

## [0.9.4] - 2026-07-27

### Fixed

- A station that had directly answered our CQ could silently vanish from Suggested Messages: the "CQ only"/"special"/country/VFO/"latest" filter chips applied to every suggestion equally, so a contact mid-QSO with us could be hidden the moment their most recent heard message no longer matched an active chip (e.g. after they answered, `isCQ` turns false, so "CQ only" would then hide them). Separately, the display cap (top 8) only weighted replied-to contacts, it didn't guarantee them a slot, so a busy band (dozens of contacts) could push a real reply past the cutoff. Replied-to contacts are now exempt from the discovery chips and pinned ahead of the display cap.

## [0.9.3] - 2026-07-27

### Fixed

- Real callsigns (e.g. Z62NS, IS0/IK2YCW, IZ6OUX, BG4UCZ, D2UY, 9A60CBM) were rejected as invalid because the hardcoded ITU prefix table was missing Kosovo entirely and only listed several countries' shortest ITU block (Italy as "I", China as "B") while the validator matched longer, more specific sub-prefixes exactly — added the missing entries and every real 2-char sub-block for Italy, China, the US, UK, and Russia, plus corrected Angola (D2-D3), Tanzania (5H-5I), and Zambia (9I-9J).
- Callsigns whose ITU prefix is itself a letter+digit pair (D2 Angola, 9A Croatia, V2 Antigua, etc.) could still fail validation even after the table fix, because the shape regex's required packing digit and the prefix's own digit are the same character in a short callsign — the parser now prefers the longer, actually-allocated reading instead of always backtracking to an unallocated bare letter.

## [0.9.2] - 2026-07-24

### Fixed

- FT8/FT4's UTC clock skew warning could false-positive on a genuinely fresh page load, reporting an implausible multi-hour skew that a plain reload immediately cleared. A real clock is never off by hours; the check now rejects any first reading over 1 hour of apparent skew and silently retries once before showing the warning, instead of trusting a possibly-broken first-load measurement.
- WebGL spectrogram texture was allocated with no initial data, causing the driver to lazily zero-fill it on the first draw call instead of upfront — this triggered a "Tex image TEXTURE_2D level 0 is incurring lazy initialization" console warning on every load. Fixed by eagerly initializing the texture with a zeroed buffer.

## [0.9.1] - 2026-07-24

### Fixed

- FT8/FT4 (and every other mode's audio capture) was completely broken on the deployed production build with `SyntaxError: missing ) after formal parameters` as soon as decoding started. Cause: the shared AudioWorklet processor file was TypeScript, loaded via `audioWorklet.addModule(new URL('./captureWorklet.ts', import.meta.url))` — Vite has built-in transpile support for that `new URL(...)` pattern with `new Worker(...)`, but not with AudioWorklet's `addModule()`, so the production build inlined the raw, untranspiled TypeScript source as a `data:` URL instead of compiling it to JavaScript first. Fixed by rewriting the processor as plain JavaScript (`captureWorklet.js`), which needs no transpilation and loads identically in dev and production.

## [0.9.0] - 2026-07-23

### Added

- WASM SIMD128 and Relaxed SIMD builds of both FT8/FT4 decoders (ft8mon, ft8_lib), with runtime feature detection (`WebAssembly.validate()` probes) and automatic fallback down to the existing baseline build. FFTW is rebuilt per SIMD tier so the gains reach the FFT hot path, not just wrapper code. Verified against all 31 reference WAVs with zero decode-set regressions: ~4% faster (SIMD128) / ~7% faster (Relaxed SIMD) than baseline at a fixed decode budget.

### Changed

- All audio capture (RX for every decoder mode, plus the FT8/FT4 TX tap) migrated from the deprecated `ScriptProcessorNode` (runs on the main thread, subject to jank from UI work/GC pauses) to `AudioWorkletNode` (runs on the dedicated real-time audio thread). No decode logic changed — only the capture mechanism. The old RAF-polling fallback (for browsers lacking `ScriptProcessorNode`) was removed; AudioWorklet is now assumed always available.

### Fixed

- The AudioWorklet capture helper cached its module-load promise globally instead of per-`AudioContext`, so every context after the first (e.g. clicking "Start Decoding" in FT8, or switching decoder modes) failed with `Unknown AudioWorklet name 'capture-forwarder'`. Fixed by keying the cache per-context.

## [0.8.1] - 2026-07-23

### Fixed

- FT8/FT4 audio resampling to ft8mon's 12kHz decode rate had no anti-aliasing filter before decimation, letting content above the new Nyquist fold back into the decode band and corrupt the LDPC soft-decision metric; added a windowed-sinc low-pass FIR before decimation in both the JS worker and the WASM wrapper. Live A/B against a real off-air WebSDR signal showed ~10% more decodes over the same 5-minute window.
- The WASM decoder regression benchmark (`make test-modules`) was silently broken on current Node — its generated test modules are CommonJS but got a `.js` extension in an ESM-typed project, so dynamic import returned an empty module instead of erroring; renamed to `.cjs`.

## [0.8.0] - 2026-07-21

### Added

- ESP32 CAT bridge firmware (`firmware/esp32-cat-bridge`): Wi-Fi-to-CAT bridge for the radio, replacing the USB-serial cable with a WebSocket relay, built on native ESP-IDF (not Arduino).
- The bridge advertises itself via mDNS (`usdx-bridge.local`), supports multiple simultaneous browser clients, and drives a PCD8544 (Nokia 5110) LCD showing live Wi-Fi signal, radio link status, S-meter, and VFO frequency.
- Bridge status/control HTTP API: firmware version + capability discovery (`GET /info`), live status (`GET /status`), and settings changes for backlight, LCD contrast, Wi-Fi network, and a remote restart — all persisted to flash.
- The web app's Radio CAT panel gained a WebSocket transport option alongside the existing Web Serial connection, plus a Bridge panel exposing the above controls, gated on the connected bridge's reported capabilities.
- CAT connection settings (transport, bridge address, serial port config) now persist across browser sessions.
- Over the bridge transport, frequency/mode/PTT/extension-setting changes are now confirmed against the radio's own reply before the UI trusts them, with automatic retries; a failed PTT-off confirmation raises a persistent on-screen alarm and keeps retrying rather than silently assuming the radio unkeyed.

### Fixed

- The FT auto-CQ audio re-encoded on every single click of the Audio Hz stepper (and every keystroke while typing), causing visible lag; it's now debounced to fire once the value settles.

## [0.7.7] - 2026-07-20

### Fixed

- Radio firmware (4.02b) NR (noise reduction, menu 1.9): the filter's cutoff frequency was collapsing geometrically as the setting increased, so most of the range's audible effect was crammed into the first few steps and the rest sounded nearly identical. It now sweeps linearly across 8 evenly-spaced cutoff steps.

## [0.7.6] - 2026-07-20

### Added

- Radio firmware (4.02a) CAT auto-report: the rig now pushes a setting's value the moment it changes locally, plus throttled S-meter telemetry, instead of waiting to be polled.
- The app discovers this capability once at connect and, when present, stops polling entirely and applies the radio's pushed updates directly; a silence watchdog recovers if the radio ever turns the feature off without the app catching the announcement.
- Older firmware is unaffected: the app falls back to its existing long poll exactly as before.

## [0.7.5] - 2026-07-12

### Fixed

- ADIF RST fields exported the raw decoder SNR float (-8.161644894026992);
  now rounded at capture and at export (covers records already logged).
- ADIF entries for QSOs decoded with no radio connected lost FREQ/BAND
  entirely; such records now keep their audio offset and export folds it
  into the export-time VFO, as the pre-log export did.
- package.json still carried the upstream sstv-decoder fork's identity;
  name, description, keywords, author, repository, homepage, and bugs now
  describe this project.

## [0.7.4] - 2026-07-10

### Fixed

- Auto-reply stopped evaluating busy stations entirely: its change detector
  used message counts, which stay constant once the contact's 60-message
  ring rotates (one old message dropped per new arrival).
- The QSO sequencer could not retry — after our RR73 it went silent forever,
  so a peer repeating their R-report (our RR73 lost to fading) killed the
  exchange; it now re-sends the lost transmission like WSJT-X, answers
  tail-end direct reports with R+report, confirms a received RR73 with 73,
  and never replies to a received 73.
- Auto-reply now acts only when the peer's message is newer than our last
  transmission to them (true tx/rx turn order), and drops superseded queued
  auto-reply steps when the conversation advances past them.

## [0.7.3] - 2026-07-10

### Fixed

- Suggested-messages stats were polluted by OTHER stations' messages: the
  Strongest sort used SNR inherited from whoever called the station, Latest
  kept long-gone stations fresh while others called them, VFO-only compared
  the caller's frequency, and never-heard stations (only seen as someone
  else's addressee) were suggested at all — every stat now derives solely
  from the station's own transmissions.
- The map's VFO-only pin filter had the same flaw and now also uses the
  station's own last transmission frequency.
- The 2D waterfall stayed blank after switching to 3D Terrain and back —
  stale WebGL vertex-attribute state from the terrain mesh made every
  subsequent waterfall draw call fail silently.

## [0.7.2] - 2026-07-10

### Added

- Suggested-messages filter chips: VFO only (same passband rule as the map's
  pin filter), Latest (heard in the last 5 minutes), and ✨ special
  (compound/special-event callsigns).
- Compound-callsign badge tooltips now explain each part — base call with
  home country, host-country prefix, and portable/mobile designator meaning.
- The Audio Analysis marker field is an editable Tx input in kHz with Hz
  precision when a radio is connected (was a read-only MHz display rounded
  to whole kHz).
- The ADIF export tooltip shows the saved QSO log's confirmed/partial
  breakdown.

### Fixed

- Plain two-word answers involving compound/nonstandard callsigns
  (e.g. "W5C/H PU7FTW") were rejected as fragments and never reached the
  contact cards — they are the complete grid-less type-4 message form.
- The hamdb.org operator lookup queried the leading prefix of compound
  callsigns (YS3 for YS3/PY8WW), returning the wrong or no operator.

## [0.7.1] - 2026-07-10

### Fixed

- QRZ profile links for compound callsigns pointed at the leading prefix
  (e.g. 9A for 9A/S55X/P); they now link the operator's base call (S55X).
- ADIF export derived QSOs from live contact messages, which rotate (60 per
  contact) — a busy peer's CQ loop alone could silently flush an exchange
  before export; QSOs are now snapshotted into a persistent log the moment
  they are decoded and export reads that log, so entries survive message
  rotation, contact eviction, and page reloads.
- ADIF imports now enter the persistent QSO log and round-trip through
  later exports.
- The contacts Clear button no longer lets the next decode resurrect the
  cleared contacts; it also empties the saved QSO log.

## [0.7.0] - 2026-07-10

### Added

- NAVTEX / SITOR-B decoding: new CCIR476 character decoder (self-aligning on
  bit phase and polarity, DX/RX error recovery) available as an MFSK encoding
  option, with a ready-made NAVTEX preset.
- MFSK 2-tone utility presets: RTTY 75 Bd / 850 Hz, NAVTEX 100 Bd / 170 Hz,
  and Bell 202 / AFSK 1200 (raw bits).
- MFSK tone-group Center and Spacing controls; shift+drag on a marker moves a
  single tone instead of the whole group.
- FT8/FT4 hashed `<bracket>` message forms for compound and nonstandard
  callsigns, generated and parsed automatically (WSJT-X compatible).
- Directed-CQ tags (DX, POTA, …) and numeric QSY CQs are parsed and kept per
  contact; the contacts panel gained "special calls" and per-CQ-tag filter
  chips.
- QSY requests ("CQ 573") are honored as a per-conversation pinned TX
  frequency — the global Audio Hz setting never moves.

### Fixed

- Queued TX messages now re-encode when Audio Hz or mode changes instead of
  transmitting at the frequency captured when they were queued.
- MFSK per-tone frequency input only committed on blur, making its step
  arrows appear dead; replaced with the shared stepper field.
- Custom TX message input rejected valid structured messages longer than 13
  chars, and unpackable messages would silently truncate to 13-char free
  text on air; both are now caught with a helpful hint.
- Doubly-compound portable callsigns (e.g. 9A/S55X/P) were dropped by the
  contact validator and never reached the contact list or reply suggestions.

### Changed

- Reply suggestions for hashed (compound-call) conversations render with a
  dashed amber border, and QSY/pinned-frequency chips show where each entry
  will transmit.

## [0.6.0] - 2026-07-09

### Added

- Spectrogram color themes — Turbo, Viridis, Inferno, Jet, Grayscale, Green —
  selectable per decoder mode and remembered per browser.
- FT8/FT4 TX audio marker on the Audio Analysis panel is now draggable and
  stays in sync with the transmit panel's Audio Hz field.
- Triangular grab handles on draggable frequency markers, on both the
  spectrum and the 2D waterfall, plus a side handle on the squelch line.
- Auto-CQ on/off state persists across sessions (the interval minutes
  already did).

### Changed

- 2D waterfall now renders on the GPU via WebGL (the CPU canvas remains as
  automatic fallback), freeing the main thread for decoding.
- Frequency ruler moved outside the spectrum/waterfall boxes with denser
  ticks; still shows absolute dial frequency when a radio VFO is connected.
- Marker lines are red instead of blue, which blended into the waterfall's
  quiet floor.

### Fixed

- Radio CAT panel no longer flickers between collapsed/expanded while
  scrolling as decoders append content.
- Hovering the squelch line now shows a vertical-drag cursor instead of the
  marker-drag cursor (CW/MFSK).
- Waterfall history texture no longer contains stale columns beyond the
  terrain mesh width.

## [0.5.0] - 2026-07-09

### Added

- ADIF export can now optionally include partial QSOs (two-way handshake,
  no signal report exchanged yet), via an opt-in checkbox next to the
  existing export button.
- FT contacts map: pin color modes — as-is (colored), age-decay, worked
  status (confirmed/partial/none), and distance-from-me — plus an
  independent VFO-passband filter to hide pins outside the current tuning.
- Small up/down step buttons restored on the FT8/FT4 transmit panel's Audio
  Hz and Auto-CQ interval fields (lost in the SolidJS migration when native
  `<input type="number">` was replaced to fix a Firefox focus-loss bug).
- Filter input on the Decoded Messages panel to search decoded text live.
- Collapsed Transmit summary bar now shows the current Auto-CQ interval
  value on its CQ badge.

### Fixed

- Dev server now binds to port 3000 as configured, instead of falling back to
  Vite's default.
- Decoder worker crash-loop caused by a missing module worker type, and the
  resulting `importScripts` incompatibility in FT8/FT4 decoding.
- RTTY session cards losing focus/resetting mid-keystroke on every edit.
- Numeric inputs across all decoder modes silently dropping keystrokes in
  Firefox (a real Firefox focus-loss bug on reactively-bound number inputs).
- Dev mode no longer caches stale JS/worker/WASM bytes across reloads.
- Favicon reverted to the app's branded icon (a Vite scaffold default had
  overwritten it during the SolidJS migration).

## [0.4.0] - 2026-07-08

### Added

- FT8/FT4 decode confidence gate: OSD-decode marking, grid-vs-callsign geo
  plausibility check, and callsign quarantine before contacts/map admission.
- Hard-filter decoded callsigns by ITU prefix allocation, cutting false
  positives from marginal/garbage decodes (~75 prefix-table entries added).
- FT8 frequency-slice parallel decoding, replacing the time-window worker
  pool for real speedup on multi-core machines.
- Sortable FT message table and a live day/night terminator overlay on the
  FT contacts map.
- Firmware: TX time-out guardrail (TOT/TT), AGC level control (AL), PA bias
  (PM/PX), restart/factory-reset (SR/FD), reference-oscillator calibration
  (XF), and version query (FV) CAT commands, with matching web UI controls
  and a guided calibration wizard.
- FT contacts map: dark/light tile toggle, redesigned pin markers (with a
  distinct marker for the operator's own callsign), curved QSO lines, and a
  fading highlight on newly-added contacts.
- Map view (center/zoom), drag-resized panel sizes, list sort order, and
  spectrogram display preferences now persist across reloads for every
  decoder mode.
- Map centers on the browser's reported location by default (no marker
  added) when no saved view exists yet.

### Fixed

- Firmware CAT SET command parser hardened against dropped-`;` corruption
  on VO/AL/TT/A2/NR/DR/PM/PX/XF.
- Advanced settings panel showing blank TX Timeout / factory defaults under
  React StrictMode's double-invoked load effect.
- LCD S-meter ticking noise and freeze-on-CAT-connect on the uSDX firmware.
- Leaflet map losing sync with its container size after a manual resize,
  causing the day/night terminator to misalign; the terminator now also
  repeats correctly across wrapped world copies at low zoom.

### Changed

- FT8/FT4 workers load each WASM engine lazily on first use instead of
  both up front, halving idle memory per pool worker.
- Auto-CQ now respects a configurable minimum interval between unattended
  transmissions instead of firing on every eligible TX window.
- Firmware TX Timeout moved into advanced settings, queried on-demand.

## [0.3.0] - 2026-07-03

### Added

- **Retroactive audio capture**: Rec button downloads the last 30 s–5 min
  (gear-configurable) of input and TX audio as separate mono 16-bit WAVs —
  see the README's "Audio Ring Buffer (Rec)" section for details.
- Global-settings gear in the top bar (ring duration, fill state, clear).
- Perf testbed `--rec` flag: fake media audio, sparse random Rec clicks, and
  per-window browser memory tracking.

### Fixed

- Cumulative decode-Δ drift under CPU load: capture windows now re-align to
  the wall clock every cycle.
- UI freezes on new decoded messages at high contact counts: batched
  partials, cached parsing, virtualized lists, throttled contacts publish.
- Stale PD120 SSTV constants test (PD is a 4-component dual-luminance format).

### Changed

- `MAX_CONTACTS` raised from 500 to 1200.
- Dev-only `window.__ftInjectWindow` hook for performance tests.

### Known issues

- The FT8 decode CPU budget is a soft limit and can overrun by ~1 s per
  pass on slow machines (see README).

## [0.2.0] - 2026-07-02

### Added

- FT8 decoding engine switched to **ft8mon** (Robert Morris AB1HL, MIT) compiled
  to WebAssembly: full WSJT-X-style pipeline with LDPC belief propagation, OSD
  fallback, a-priori decoding, and multi-pass interference subtraction.
  Benchmark on ft8_lib's reference WAVs vs WSJT-X expected decodes: **310/353
  matched vs 257/353** for the previous engine. FT4 remains on ft8_lib, which
  also serves as automatic FT8 fallback.
- **Live message streaming**: decoded messages appear in the UI one by one as
  the decoder finds them during the window's decode pass; the contacts and
  auto-reply pipeline consumes them incrementally as well.
- **WASM status strip** in the FT8/4 panel: active engine, live decode progress
  bar (elapsed vs CPU budget; turns green when the window reaches the rolling
  average message count, amber when past budget), live decoded-message counter,
  and per-window decode time in the message list separators.
- **Runtime decoder tuning** (Tune button, applied live, persisted in
  localStorage): OSD depth, CPU budget (with data-driven suggested value marked
  on the slider — max observed last-message arrival over recent windows),
  subtraction passes, LDPC iterations, OSD threshold, decode band limits.
- **⟳ WASM reload**: respawns the decode worker and reloads both WASM modules
  without a page refresh.
- WASM telemetry in the bottom debug bar: engine(s), live heap usage
  (malloc'd bytes / reserved linear memory via `mallinfo`), last decode time,
  worker generation counter.
- Reproducible WASM build system: Docker/Emscripten Makefile that
  cross-compiles FFTW 3.3.10 (cached), plus `make test-modules` +
  `lib/wasm_build/testbuild/test_decode.mjs` regression benchmark comparing
  both engines against ft8_lib's reference WAV corpus.

### Changed

- ft8_lib wrapper candidate cap raised from 140 to 300 (matches the old
  TypeScript decoder's default).
- Vendored patched ft8mon at `lib/ft8mon` (Emscripten compatibility patches
  under `#ifdef __EMSCRIPTEN__`; see README).

### Removed

- `@e04/ft8ts` TypeScript FT8/FT4 decode path (superseded by the WASM engines
  in the previous iteration; ft8mon now replaces its decode quality as well).

## [0.1.0] - 2026-06-28

Baseline before the ft8mon engine work: browser-based decoding of RTTY, CW
(incl. dual-channel A/B), 15 SSTV modes, FT8/FT4 (ft8_lib WASM) with QSO
contact tracking / world map / ADIF export / auto-CQ + auto-reply transmit,
MFSK4–128 with FEC, WebGL spectrograms, radio CAT control (Kenwood TS-480
protocol, uSDX), PWA offline support.

[Unreleased]: https://github.com/acesso/Signal-Decoder/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/acesso/Signal-Decoder/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/acesso/Signal-Decoder/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/acesso/Signal-Decoder/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/acesso/Signal-Decoder/releases/tag/v0.1.0
