<h1 align="center">
    📡 Signal Decoder
</h1>
<p align="center">
   <strong>Decode radio signals in your browser!</strong> Free, open-source web application for real-time decoding of RTTY (Radio Teletype / Baudot), CW (Morse code), and SSTV (Slow Scan Television) signals from microphone input. Works offline as a PWA. Forked from <a href="https://github.com/smolgroot/sstv-decoder">smolgroot/sstv-decoder</a>.
</p>
<br />

<p align="center">
    <a href="https://github.com/acesso/rtty-decoder/stargazers">
        <img src="https://img.shields.io/github/stars/acesso/rtty-decoder?style=social" alt="GitHub stars" />
    </a>
    <a href="https://github.com/acesso/rtty-decoder/issues">
        <img src="https://img.shields.io/github/issues/acesso/rtty-decoder" alt="GitHub Issues" />
    </a>
    <a href="https://github.com/acesso/rtty-decoder/blob/main/LICENSE">
        <img src="https://img.shields.io/badge/license-0BSD-blue" alt="License: 0BSD" />
    </a>
    <img src="https://img.shields.io/badge/PWA-Offline%20Ready-success" alt="PWA Offline Ready" />
    <a href="https://acesso.github.io/rtty-decoder">
        <img src="https://img.shields.io/badge/demo-live-brightgreen" alt="Live Demo" />
    </a>
</p>

<hr>

<p align="center">
   <a href="https://acesso.github.io/rtty-decoder"><b>🚀 Try the Live Demo - No Installation Required!</b></a>
</p>

<p align="center">
   <em>Works on Desktop • Mobile • Tablet | Chrome • Firefox • Safari • Edge</em>
</p>

## Quick Start

1. **Visit** → [acesso.github.io/rtty-decoder](https://acesso.github.io/rtty-decoder)
2. **Allow** microphone access when prompted
3. **Play** an RTTY, CW, or SSTV signal near your microphone
4. **Watch** the text or image decode in real-time!

No installation, no downloads, no setup - just open and decode!

## Features

- **RTTY Decoding**: Real-time Baudot/ITA2 radioteletype decoding from audio input
- **CW Decoding**: Morse code decoder with automatic speed detection
- **SSTV Decoding**: 15 modes — Robot36/72, Scottie S1/S2/DX, Martin M1/M2, PD50/90/120/160/180/240/290, Wraase SC2-180
- **Mode Auto-Detection**: Automatically identifies the incoming signal type
- **Session Gallery**: Review and save decoded sessions
- **Real-time Audio Processing**: Captures microphone input using Web Audio API (auto-detects 44.1 kHz or 48 kHz)
- **Professional DSP Chain**:
  - FM demodulation with complex baseband conversion
  - Kaiser-windowed FIR lowpass filtering
  - Schmitt trigger sync detection
  - Bidirectional exponential moving average filtering
- **Live Display**: Progressive rendering with real-time spectrum visualization
- **Save Output**: Export decoded images as PNG or text sessions
- **Signal Analysis**: Real-time spectrum analyzer and signal strength indicator
- **Mobile-Responsive**: Optimized for both desktop and mobile devices

## Supported SSTV Modes

All 15 modes are fully implemented with VIS code auto-detection.

| Mode | Resolution | Sync | Line Time | Total Time | VIS |
|------|------------|------|-----------|------------|-----|
| **Robot36** | 320×240 | 9ms | ~150ms | ~36s | 8 |
| **Robot72** | 320×240 | 9ms | ~300ms | ~1m 12s | 12 |
| **Scottie S2** | 320×256 | 9ms | ~278ms | ~1m 11s | 56 |
| **Martin M2** | 320×256 | 5ms | ~226ms | ~58s | 40 |
| **PD50** | 320×256 | 20ms | ~406ms | ~1m 44s | 93 |
| **Scottie S1** | 320×256 | 9ms | ~428ms | ~1m 50s | 60 |
| **Martin M1** | 320×256 | 5ms | ~446ms | ~1m 54s | 44 |
| **PD120** | 640×496 | 20ms | ~508ms | ~2m 6s | 95 |
| **PD160** | 512×400 | 20ms | ~804ms | ~2m 41s | 98 |
| **PD180** | 640×496 | 20ms | ~752ms | ~3m 6s | 96 |
| **PD90** | 320×256 | 20ms | ~754ms | ~3m 13s | 99 |
| **Wraase SC2-180** | 320×256 | 5ms | ~734ms | ~3m 8s | 55 |
| **Scottie DX** | 320×256 | 9ms | ~1069ms | ~4m 34s | 76 |
| **PD240** | 640×496 | 20ms | ~1018ms | ~4m 13s | 97 |
| **PD290** | 800×616 | 20ms | ~954ms | ~4m 54s | 94 |

### Color Encoding Overview

| Family | Color Format | Notes |
|--------|-------------|-------|
| Robot36/72 | Interlaced YUV | Standard for QSOs and ISS-style events |
| Scottie S1/S2/DX, Martin M1/M2 | Sequential RGB/GBR | Clean colors, HF classic |
| Wraase SC2-180 | Sequential RGB | High fidelity RGB |
| PD50/90/120/160/180/240/290 | Dual-luma YUV | High resolution, ISS SSTV standard |

## RTTY Decoder

Real-time RTTY (Radio Teletype) decoding using Baudot/ITA2 encoding (5-bit characters).

### RTTY Parameters

| Parameter | Default | Range |
|-----------|---------|-------|
| **Center Frequency** | 500 Hz | configurable |
| **Carrier Shift** | 450 Hz | 170 / 450 / 850 Hz typical |
| **Baud Rate** | 50 baud | 45 / 50 / 75 / 100 / 110 |
| **Stop Bits** | 1.5 | 1 / 1.5 / 2 |
| **Parity** | None | none / even / odd |
| **Reverse Shift** | Off | for LSB/inverted signals |

### RTTY Signal Processing

- **Mark/Space detection**: Dual Goertzel correlators with IIR lowpass smoothing
- **Baud clock**: Edge-triggered (re-syncs on every mark→space or space→mark transition)
- **Character framing**: Start bit → 5 data bits → optional parity → stop bit(s)
- **Shift state**: Full LTRS/FIGS handling per ITA2 standard
- **Sessions**: Each decoded transmission is stored as a named session

## CW Decoder

Real-time CW (Morse code) decoder with a per-sample IIR pipeline, live Morse element visualisation, and dual-channel A/B decoding mode.

### CW Parameters

| Parameter | Default | Range | Notes |
| --------- | ------- | ----- | ----- |
| **Center Frequency** | 700 Hz | 100 – 1500 Hz | Quick-set input + spectrum drag |
| **Bandwidth** | 90 Hz | 30 – 500 Hz | Filter width; Q computed as `freq / bw` |
| **Speed** | 20 WPM | 3 – 70 WPM | Manual or adaptive (see below) |
| **Squelch** | Adjustable | 0 – 100 % | Compared directly to FFT tone-bin level |
| **A/B Mode** | Off | — | Two independent decoders on separate frequencies |

### CW Signal Processing Pipeline

```text
microphone → biquad bandpass (adjustable Q = center / bandwidth)
           → envelope detector  (fast attack ~3 ms, moderate release ~5 ms)
           → peak follower       (fast rise ~10 ms, slow fall ~300 ms)
           → 50 % / 25 % hysteresis vs peak → mark / space FSM
           → symbol buffer (max 6 elements — hard cap, overflow emits '?')
           → Morse table lookup → character / prosign output
```

- **Bandpass filter**: Standard biquad, Q computed per-render so `bandwidth_Hz` stays constant as the center frequency is dragged
- **Squelch**: Applied per audio buffer by comparing the FFT magnitude at the tone bin against the user's visual threshold — the squelch line on the spectrum canvas is the exact gate the decoder uses
- **Adaptive speed tracker**: Always runs in the background regardless of manual/adaptive mode; the estimated WPM is shown as a live suggestion even when manual mode is active
- **Manual WPM override**: When adaptive mode is off, the user sets a fixed WPM; toggling adaptive off pre-fills the input with the last detected speed
- **6-element cap**: No valid Morse character exceeds 6 elements (the longest prosigns, e.g. `<SK>` = `...-.-`, are exactly 6); any sequence longer than this is flushed immediately as `?` to prevent noise from stalling the decoder
- **SNR display**: Noise floor tracked via a separate slow-fall IIR; real-time dB readout colour-coded (green ≥ 15 dB, amber 6–15 dB, red < 6 dB)

### Morse Display (live visualiser)

A real-time Morse element display sits inside the Audio Analysis panel and reflects the decoder's internal symbol buffer directly:

- **Dots** (blue circles) and **dashes** (green pills) appear with a spring-bounce animation as each element is received
- **Receiving indicator**: An amber pulsing dot shows while a tone is actively being measured (before dot vs dash is determined)
- **Character flash**: When the decoder resolves a complete symbol, the decoded character blooms large in the centre, holds for ~1.4 s, then fades — colour and glow match the channel (blue for Ch A, orange for Ch B)
- **Recent strip**: The last 10 decoded characters are shown in a fading history row with their Morse pattern underneath
- Element display is driven by `stats.partialSymbol` (decoder source of truth) to avoid React render-batch ordering bugs

### A/B Mode (dual-channel)

Enable **A/B Mode** to run two independent CW decoders simultaneously on different frequencies — useful for monitoring both sides of a QSO or two nearby stations.

- Each channel (A = blue, B = orange) has its own center frequency, squelch gate, and Morse visualiser
- Decoded text from both channels is interleaved in the output panel with distinct colours
- Channel B can be enabled/disabled mid-session without restarting audio capture
- The spectrum shows labelled `A` and `B` markers; both can be dragged independently
- The spectrogram overlay highlights both filter bands simultaneously

### CW How to Use

1. Click **Start Decoding** and allow microphone access
2. Drag the **CF** (or **A**) marker on the spectrum to the CW tone peak, or type the frequency in the **Center** input
3. Adjust **Bandwidth** — narrow (50–80 Hz) for clean signals, wider (150–300 Hz) for drifting or noisy ones
4. Drag the **SQL** line just above the noise floor to gate noise from decoding
5. Set **speed**: leave adaptive off and type the known WPM, or enable **Adaptive WPM** to let the decoder track the sender automatically — the live detected WPM is always visible as a suggestion even in manual mode
6. For a two-station QSO, enable **A/B Mode** and drag the **B** marker to the second tone

## Technology Stack

- **Next.js 15**: React framework with App Router
- **TypeScript**: Type-safe development
- **Web Audio API**: Real-time audio capture and processing
  - ScriptProcessorNode (Chrome, Firefox, Edge)
  - requestAnimationFrame polling (Safari, iOS)
- **Canvas API**: Progressive image rendering
- **Tailwind CSS**: Utility-first styling

## Testing

The project includes comprehensive unit tests for the core SSTV decoding algorithms.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### Test Framework

- **Jest** - Test runner with TypeScript support
- **@testing-library/react** - React component testing utilities
- **jsdom** - DOM environment for tests

## Getting Started

### Prerequisites

- Node.js 18+ installed
- A modern web browser with microphone access

### Installation

1. Clone the repository:
```bash
git clone https://github.com/acesso/rtty-decoder.git
cd rtty-decoder
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

### Building for Production

```bash
npm run build
npm start
```

## How to Use

Select a mode from the top tab bar (RTTY / CW / SSTV), then click **Start** and allow microphone access when prompted.

### RTTY

1. **Configure**: Set center frequency, carrier shift, and baud rate to match the incoming signal (defaults work for most HF RTTY: 50 baud / 450 Hz shift / 500 Hz center)
2. **Start**: Click "Start" — the decoder locks on to the first valid start bit it finds
3. **Read text**: Decoded characters appear in the session panel in real-time
4. **Sessions**: Each received text block is saved as a named session; switch between them in the session list
5. **Reverse shift**: Toggle "Rev" if the mark/space tones appear inverted (common when receiving on LSB)

### CW

1. **Tune**: Adjust the tone frequency slider to match the CW note you want to decode (700 Hz is a common CW sidetone)
2. **Squelch**: Raise the squelch threshold until background noise stops producing output, then lower it until the signal decodes cleanly
3. **Start**: Click "Start" — decoded characters appear as the decoder tracks speed automatically
4. **Speed**: WPM is calculated adaptively; no manual entry needed

### SSTV

1. **Mode**: Leave mode on **Auto** to let VIS code detection select the mode automatically, or pick a specific mode from the selector
2. **Start**: Click "Start Decoding" to begin capturing from the microphone
3. **Receive**: Play or tune to an SSTV signal — the image builds progressively on the canvas
4. **Monitor**: Use the spectrum analyzer and SNR indicator to optimise audio levels
5. **Save**: Click "Save Image" to download the decoded image as a PNG
   - Filename: `sstv-{mode}-{timestamp}.png`
6. **Gallery**: Previously decoded images are kept in the gallery below the canvas
7. **Reset**: Click "Reset" to clear the canvas and start a new decode

## Technical Details

### Signal Processing Chain

1. **Baseband Conversion**: Complex multiplication at center frequency (1900 Hz)
2. **Baseband Lowpass Filter**: Kaiser-windowed FIR filter (2ms length, 900 Hz cutoff)
3. **FM Demodulation**: Phase difference detection with scale factor (sampleRate / (bandwidth × π))
4. **Sync Detection**: Schmitt trigger detecting frequency drops to 1200 Hz
5. **Line Decoding**: Bidirectional exponential moving average filtering for horizontal resolution

### Audio Parameters

- **Sample Rate**: Auto-detected (44.1 kHz or 48 kHz, matches browser/hardware)
- **Center Frequency**: 1900 Hz (midpoint of 1000-2800 Hz range)
- **Bandwidth**: 800 Hz (white-black range: 2300-1500 Hz)
- **Sync Frequency**: 1200 Hz (normalized to -1.750)
- **Schmitt Trigger**: Low threshold = -1.563 (1275 Hz), High threshold = -1.375 (1350 Hz)

### Robot36 Color Mode Specifications

- **Resolution**: 320×240 pixels
- **Color Format**: Interlaced YUV (even lines: Y + R-Y, odd lines: Y + B-Y)
- **Line Duration**: ~150ms per scan line
- **Sync Pulse**: 9ms at 1200 Hz
- **Sync Porch**: 3ms at 1500 Hz
- **Luminance (Y)**: 88ms
- **Separator**: 4.5ms (frequency indicates even/odd line)
- **Porch**: 1.5ms
- **Chrominance (R-Y or B-Y)**: 44ms
- **Total Lines**: 240 (produces 240 pixel rows, 120 even + 120 odd pairs)
- **Encoding**: 1 row per scan line (interlaced chroma pairing)

### PD120 Mode Specifications

- **Resolution**: 640×496 pixels
- **Color Format**: Dual-luminance YUV (Y-even + V-avg + U-avg + Y-odd)
- **Scan Line Duration**: ~508ms per scan line
- **Sync Pulse**: 20ms at 1200 Hz
- **Sync Porch**: 2.08ms at 1500 Hz
- **Y-even Channel**: 121.6ms (luminance for even row)
- **V-avg Channel**: 121.6ms (R-Y chroma, shared)
- **U-avg Channel**: 121.6ms (B-Y chroma, shared)
- **Y-odd Channel**: 121.6ms (luminance for odd row)
- **Pixel Dwell Time**: 190µs per pixel
- **Total Scan Lines**: 248 (produces 496 pixel rows, 248 × 2)
- **Encoding**: 2 rows per scan line (shared chroma between rows)

### PD160 Mode Specifications

- **Resolution**: 512×400 pixels
- **Color Format**: Dual-luminance YUV (Y-even + V-avg + U-avg + Y-odd)
- **Scan Line Duration**: ~804ms per scan line
- **Sync Pulse**: 20ms at 1200 Hz
- **Sync Porch**: 2.08ms at 1500 Hz
- **Y-even Channel**: 195.584ms (luminance for even row)
- **V-avg Channel**: 195.584ms (R-Y chroma, shared)
- **U-avg Channel**: 195.584ms (B-Y chroma, shared)
- **Y-odd Channel**: 195.584ms (luminance for odd row)
- **Pixel Dwell Time**: 382µs per pixel (2× longer than PD120)
- **SNR Improvement**: ~3.0 dB better than PD120
- **Total Scan Lines**: 200 (produces 400 pixel rows, 200 × 2)
- **Encoding**: 2 rows per scan line (shared chroma between rows)

### PD180 Mode Specifications

- **Resolution**: 640×496 pixels
- **Color Format**: Dual-luminance YUV (Y-even + V-avg + U-avg + Y-odd)
- **Scan Line Duration**: ~752ms per scan line
- **Sync Pulse**: 20ms at 1200 Hz
- **Sync Porch**: 2.08ms at 1500 Hz
- **Y-even Channel**: 182.4ms (luminance for even row)
- **V-avg Channel**: 182.4ms (R-Y chroma, shared)
- **U-avg Channel**: 182.4ms (B-Y chroma, shared)
- **Y-odd Channel**: 182.4ms (luminance for odd row)
- **Pixel Dwell Time**: 286µs per pixel (50% longer than PD120)
- **SNR Improvement**: ~1.8 dB better than PD120
- **Total Scan Lines**: 248 (produces 496 pixel rows, 248 × 2)
- **Encoding**: 2 rows per scan line (shared chroma between rows)

### Sync Detection

- **9ms Pulses**: Robot36/Scottie scan line sync
- **20ms Pulses**: PD mode scan line sync
- **5ms Pulses**: Martin mode sync / VIS calibration headers
- **Frequency Tolerance**: ±0.125 normalized units (~50 Hz at 1900 Hz center)
- All timing automatically adapts to detected sample rate (44.1 kHz or 48 kHz)
- Mode-specific pulse width detection ensures correct decoder selection

### Image Export

- Format: PNG (lossless compression)
- Resolution: Matches selected SSTV mode
- Filename: Includes mode and timestamp for easy identification
- Method: Canvas.toBlob() API for efficient conversion

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout with metadata
│   ├── page.tsx                # Home page with mode state management
│   └── globals.css             # Global Tailwind styles
├── components/
│   ├── RTTYDecoder.tsx         # RTTY (Baudot) decoder UI
│   ├── CWDecoder.tsx           # CW (Morse) decoder UI
│   ├── SSTVDecoder.tsx         # SSTV image decoder UI
│   ├── SessionCard.tsx         # Decoded session display card
│   ├── SettingsPanel.tsx       # Mode selection settings panel
│   └── PWAInstallPrompt.tsx    # PWA install prompt
├── hooks/
│   └── useAudioProcessor.ts    # Web Audio API integration (mode-aware)
└── lib/
    ├── rtty/
    │   ├── decoder.ts          # RTTY Baudot/ITA2 decoder
    │   ├── baudot.ts           # Baudot character tables
    │   └── sessions.ts         # Session management
    ├── cw/
    │   ├── decoder.ts          # CW Morse code decoder
    │   └── morse-table.ts      # Morse code lookup table
    └── sstv/
        ├── constants.ts             # SSTV mode specifications
        ├── decoder.ts               # Main decoder orchestration (multi-mode)
        ├── sync-detector.ts         # Sync pulse detection (9ms/20ms)
        ├── robot36-line-decoder.ts  # Robot36 interlaced YUV decoder
        ├── robot72-line-decoder.ts  # Robot72 sequential YUV decoder
        ├── scottie-s1-line-decoder.ts # Scottie S1 RGB sequential decoder
        ├── scottie-s2-line-decoder.ts # Scottie S2 RGB sequential decoder
        ├── pd120-line-decoder.ts    # PD120 dual-luminance decoder
        ├── pd160-line-decoder.ts    # PD160 dual-luminance decoder
        ├── pd180-line-decoder.ts    # PD180 dual-luminance decoder
        └── fm-demodulator.ts        # DSP primitives (FM demod, filters, EMA)

doc/
├── ROBOT36.md                  # Robot36 technical specification
├── ROBOT72.md                  # Robot72 technical specification
├── SCOTTIE_S1.md               # Scottie S1 technical specification
├── SCOTTIE_S2.md               # Scottie S2 technical specification
├── PD120.md                    # PD120 technical specification
├── PD160.md                    # PD160 technical specification
├── PD180.md                    # PD180 technical specification
└── ARCHITECTURE.md             # Overall system architecture
```

### Known Issues

- Occasional false sync detections from noise/interference
- Stack overflow on very long lines (>6 seconds) - indicates lost sync
- Best results with clean, strong signals from radio or audio playback
- Safari iOS may have slightly higher latency (~34ms) due to polling approach

## Future Improvements

### High Priority
- [x] **VIS Code Detection**: Automatic mode selection based on VIS header detection
- [x] **Additional PD Modes**: PD50, PD90, PD240, PD290
- [ ] **Audio File Upload**: Decode from WAV/MP3 files for offline processing

### Medium Priority
- [x] **Scottie DX Mode**: DX variant with 4m 34s transmission time (RGB sequential encoding)
- [x] **Martin Modes**: M1, M2 (GBR sequential encoding)
- [x] **Wraase SC2-180**: High-quality RGB mode
- [ ] **Improved Noise Reduction**: Advanced filtering for weak signals
- [x] **Signal Quality Metrics**: SNR calculation and display

### Low Priority
- [ ] **Waterfall Display**: Full spectrogram history
- [x] **Multi-image Gallery**: Store and compare multiple decoded images
- [ ] **Export Metadata**: Include signal quality in saved filenames

## Contributing

I welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on:

- Setting up your development environment
- Creating feature branches
- Writing and running tests
- Code quality standards
- Submitting pull requests
- Adding new SSTV modes

## License

This project is licensed under the 0BSD license (Zero-Clause BSD).

## Acknowledgments

- **smolgroot**: Upstream [sstv-decoder](https://github.com/smolgroot/sstv-decoder) web application this project is forked from
- **Ahmet Inan (xdsopl)**: Original [Robot36 Android app](https://github.com/xdsopl/robot36) DSP algorithms that informed the SSTV implementation
- **Amateur Radio Community**: Protocol specifications and documentation for RTTY, CW, and SSTV
