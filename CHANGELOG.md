# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release automation reads this file: when a branch is merged into `main`, CI
creates a GitHub release for the topmost `## [x.y.z]` section if that tag does
not exist yet. Add new entries under `[Unreleased]` while developing and move
them into a version section when cutting a release.

## [Unreleased]

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
