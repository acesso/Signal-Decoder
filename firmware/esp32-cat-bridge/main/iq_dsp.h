// Bridge-side I/Q processing (S3 board; S3_PORT_PLAN.md phase 6).
//
// Raw I/Q at 96 kHz is ~375 KB/s per listener, too much to stream reliably
// over Wi-Fi. This module turns it into two light streams; the web app keeps
// demodulation, noise reduction and the decoders.
//
//   ws://<bridge>/iq-spectrum   one row per frame (~10 rows/s):
//     header (20 bytes, little-endian)
//       char[4]  "IQS1"
//       uint32   seq          row counter
//       uint32   fs           input sample rate (Hz); the row spans -fs/2..+fs/2
//       uint16   bins         row length
//       int16    db_floor     dB value of byte 0
//       uint16   db_span      dB covered by bytes 0..255
//       uint16   reserved
//     then `bins` bytes, lowest frequency first (-fs/2 .. +fs/2 - fs/bins);
//     byte = clamp((dBFS - db_floor) * 255 / db_span). A full-scale complex
//     tone reads 0 dBFS.
//
//   ws://<bridge>/iq-passband   the passband, shifted to 0 Hz and decimated,
//     one frame per ~50 ms:
//     header (16 bytes, little-endian)
//       char[4]  "IQP1"
//       uint32   seq          frame counter (gaps = dropped frames)
//       uint32   fs           output sample rate (Hz)
//       int32    center_hz    the input frequency now at 0 Hz
//     then int16 I, Q interleaved (full scale = 32767).
//
//   GET  /iq-config   current settings + load figures
//   POST /iq-config   any subset of:
//     {"source":"wm8782"|"pcm1808"|"test"|"none", "center_hz":N, "pb_rate":6000|12000|24000,
//      "fft_size":1024|2048|4096, "rows_per_s":1..30, "db_floor":-160..0, "db_span":20..160,
//      "iq_correction":"none"|"swap"|"negateI"|"negateQ", "dc_removal":true|false}
//     The corrections act on the wideband I/Q before both streams, with the
//     same meaning as the web app's own (useIQBridge.ts).
//
// Input: iq_dsp_feed() with I/Q frames as int32 pairs (24-bit samples
// left-justified in 32-bit I2S slots). "source" picks which ADC feeds the
// streams, so the two can be compared on the same signal:
//   wm8782   (default) the I/Q ADC at whatever rate its DIP switch sets (48,
//            96 or 192 kHz, detected from the samples): a spectrum that wide
//   pcm1808  the audio ADC, 48 kHz (I/Q cable in the RX/loop jack: tip = I)
//   test     a synthetic 96 kHz signal: tones at +5000 Hz (-20 dBFS),
//            -12000 Hz (-40 dBFS) and +20300 Hz (-60 dBFS) over -100 dBFS noise
//   none     nothing
// Switching restarts the processing; "fs" in GET /iq-config and in every
// spectrum row follows the source.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_http_server.h"

#define IQ_DSP_FS_HZ 96000       // the test source, and the WM8782 until its rate is measured
#define IQ_DSP_FS_MAX_HZ 192000  // sizes the input buffer

typedef enum { IQ_DSP_SRC_NONE = 0, IQ_DSP_SRC_TEST, IQ_DSP_SRC_WM8782, IQ_DSP_SRC_PCM1808 } iq_dsp_source_t;

void iq_dsp_start(httpd_handle_t server);
// Pushes interleaved I,Q int32 frames from `src` (non-blocking; ignored unless
// `src` is the selected source; frames that don't fit are dropped and counted).
void iq_dsp_feed(iq_dsp_source_t src, const int32_t *iq, size_t frames);

// The selected source, by enum or by name ("wm8782", "pcm1808", "test",
// "none"). set saves it (it survives reboots) and restarts the processing.
iq_dsp_source_t iq_dsp_get_source(void);
const char *iq_dsp_source_name(iq_dsp_source_t src);
bool iq_dsp_parse_source(const char *name, iq_dsp_source_t *out);
bool iq_dsp_set_source(iq_dsp_source_t src);
// Input rate of a source (the WM8782's as last measured; the PCM1808's 48000).
int iq_dsp_source_rate_hz(iq_dsp_source_t src);
// The WM8782 reader reports a measured rate change; the processing restarts at it.
void iq_dsp_set_wm8782_rate(int hz);
void iq_dsp_on_client_close(int sockfd);

// A coarse copy of the latest spectrum row for the status display: `cols`
// columns across -fs/2..+fs/2 (the VFO in the middle), each the strongest bin
// it covers, in dBFS. Updated with every row, whether or not anyone streams.
// Returns the row's input rate (0 if no row yet, or none in the last 2 s);
// *center_hz gets the passband center.
int iq_dsp_overview(float *db, int cols, int32_t *center_hz);
