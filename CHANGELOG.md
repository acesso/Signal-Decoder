# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release automation reads this file: when a branch is merged into `main`, CI
creates a GitHub release for the topmost `## [x.y.z]` section if that tag does
not exist yet. Add new entries under `[Unreleased]` while developing and move
them into a version section when cutting a release.

## [Unreleased]

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
