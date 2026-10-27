# Network bandwidth, both bridges (2026-10-26)

**What was measured:** synthetic tests over Wi-Fi from a PC on the same network.
- **Each stream:** received for 8–10 s.
- **Throughput:** WebSocket payload, in KB/s.
- **Frames/s.**
- **Max gap:** the longest pause between two frames.
- **Lost:** frames missing, counted from the sequence numbers that the I/Q spectrum and passband frames carry. `/audio` and `/iq-data` have none.

**Conditions:**
- Firmware 0.11.0.
- S3 at −71 dBm (IPEX antenna); A1S at −65 dBm.
- One client per stream.

## S3 (WM8782 + PCM1808, bridge DSP)

### One stream at a time

| Stream | Setting | KB/s | Frames/s | Max gap | Lost |
|---|---|---|---|---|---|
| `/iq-passband` | WM8782, 6 kHz | 23.9 | 20.0 | 71 ms | 0 |
| | WM8782, 12 kHz (app default ≤ 9.6 kHz bandwidth) | 46.9 | 19.7 | 99 ms | 0 |
| | WM8782, 24 kHz | 91.5 | 19.3 | 101 ms | 0 |
| | PCM1808, 6 / 12 / 24 kHz | 23.9 / 46.4 / 90.3 | 20.0 / 19.5 / 19.1 | ≤ 105 ms | 0 |
| `/iq-spectrum` | FFT 1024, 10 / 30 rows/s | 10.9 / 32.0 | 10.6 / 31.2 | 203 / 51 ms | 0 |
| | FFT 2048, 10 / 30 rows/s | 18.2 / 42.6 | 8.9 / 21.0 | 271 / 97 ms | 0 |
| | FFT 4096, 10 / 30 rows/s (app default 10) | 47.7 / 94.8 | 11.7 / 23.5 | 102 / 66 ms | 0 |
| `/audio` | from PCM1808 / from WM8782 | 94.4 / 93.9 | 20.0 / 19.9 | 96 / 98 ms | — |

**Row rate:** it can't exceed the FFT rate, which is the sample rate divided by the FFT size: 23.4 per second for 4096 points at 96 kHz, so 30 rows/s gives 23.5. Below that, rows/s is rounded to a whole number of FFTs averaged per row.

### Combined

| Streams | Total KB/s | Result |
|---|---|---|
| Spectrum 4096 × 10 + passband 12 kHz (the app's default) | 94 | clean |
| The same + `/audio` | 188 | clean |
| Spectrum 4096 × 10 + passband 24 kHz + `/audio` | 233 | clean in 3 of 4 runs; once 2–3 frames lost per stream, gaps to 0.4 s |
| Spectrum 4096 × 30 + passband 12 kHz + `/audio` | 236 | clean |
| Spectrum 4096 × 30 + passband 24 kHz + `/audio` (everything at maximum) | 270 | about 1 frame/s lost per stream, gaps up to 0.7 s |

**Reading:**
- About 230 KB/s (1.9 Mbit/s) runs clean at −71 dBm.
- The occasional losses below that are brief radio stalls rather than a load limit. A lighter mix (passband 24 kHz + audio, 180 KB/s) once showed one too, and the same heavy mix ran clean three times in a row.
- At 270 KB/s the losses become steady.
- A better antenna position or a stronger signal raises the margin.
- DSP load at full settings: 37%, with no input dropped.

**TX slot upload** (15 s FT8-sized message, 480 KB): 1.17 s, about 400 KB/s.

## A1S (ES8388, no bridge DSP)

| Stream | Setting | KB/s | Frames/s | Max gap |
|---|---|---|---|---|
| `/iq-data` (raw I/Q) | 48 kHz | 188.6 | 20.0 | 118 ms |
| | 96 kHz | 376.3 | 20.0 | 92 ms |
| `/audio` | 48 kHz | 94.4 | 20.0 | 116 ms |

**Reading:**
- All clean.
- Raw 96 kHz I/Q, about 3 Mbit/s, is the heaviest stream either bridge sends. It's why the S3 decimates on the bridge: its default I/Q load is 94 KB/s instead of 376.

**TX slot upload** (480 KB): 0.91 s, about 515 KB/s.

## What the app uses

| Bridge | Default streams | KB/s |
|---|---|---|
| S3, I/Q | spectrum 4096 × 10 + passband 12 kHz | ~94 |
| S3, I/Q + bridge audio | the same + `/audio` | ~188 |
| A1S, I/Q | `/iq-data` 48 kHz | ~189 |
| A1S, audio | `/audio` 48 kHz | ~94 |

The passband steps up to 24 kHz only for demodulator bandwidths above 9.6 kHz, which none of the digital modes need.
