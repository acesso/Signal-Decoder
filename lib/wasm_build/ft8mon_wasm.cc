/**
 * ft8mon_wasm.cc — Emscripten wrapper exposing ft8mon's FT8 decoder to JavaScript.
 *
 * ft8mon (Robert Morris, AB1HL — MIT license) implements the full WSJT-X-style
 * decode pipeline: LDPC belief propagation + OSD fallback + multi-pass
 * interference subtraction. FT8 only; FT4 stays on the ft8_lib module (ft8.wasm).
 *
 * Exports:
 *   ftm_decode(float* samples, int num_samples, int sample_rate,
 *              float min_hz, float max_hz, float budget_sec)
 *     → pointer to a null-terminated JSON string:
 *       "[{\"freq\":...,\"dt\":...,\"snr\":...,\"msg\":\"...\",\"sync\":...,\"pass\":...,\"osd\":...},...]"
 *     `sync` carries ft8mon's correct_bits (LDPC parity bits correct before
 *     decode) so the UI's existing sync column stays meaningful.
 *     `osd` is -1 for a clean LDPC decode, or the OSD search depth (>=0) when
 *     the decode came from the ordered-statistics fallback — those are the
 *     "best guess" decodes prone to false positives.
 *
 *   ftm_set(const char* param, const char* val) → double
 *     Runtime tuning via ft8mon's own set() table (osd_depth, ldpc_iters,
 *     npasses_one, osd_ldpc_thresh, ...). Pass val="" to read without writing.
 *     Returns NaN for unknown params.
 *
 * Input samples at any rate; resampled here to 12 kHz. The window must be
 * cycle-aligned (the app already aligns to UTC 15s slots); nominal signal
 * start is 0.5 s into the window, matching ft8mon's convention.
 *
 * Callsign hash tables (unpack.cc) persist for the module instance lifetime.
 */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <malloc.h>
#include <string>
#include <vector>
#include <set>
#include <emscripten/emscripten.h>

#include "../ft8mon/ft8.h"
#include "../ft8mon/unpack.h"

#define DECODE_RATE 12000

/* Anti-alias low-pass applied before decimation. Without this, any input
 * content above the new Nyquist (DECODE_RATE/2) folds back down into the
 * passband under plain linear-interpolation resampling and corrupts exactly
 * the FFT bins the LLR computation reads. Windowed-sinc FIR, cutoff set a
 * bit inside the new Nyquist (0.45x, not 0.5x) so the filter's own
 * finite-length transition band doesn't let aliasing content leak past the
 * edge; Hamming window for a well-behaved (no ringing) stopband. Mirrors
 * decoder.worker.ts's designLowPassFir()/applyFir() exactly (same cutoff
 * fraction, same tap count, same formula). */
#define ANTIALIAS_CUTOFF_FRACTION 0.45 /* of the OUTPUT sample rate */
#define ANTIALIAS_TAPS 63              /* odd length, symmetric FIR */

static std::vector<double> design_lowpass_fir(double cutoff_hz, double sample_rate_hz, int num_taps)
{
    std::vector<double> taps(num_taps);
    double mid = (num_taps - 1) / 2.0;
    double fc  = cutoff_hz / sample_rate_hz; /* normalized cutoff (0..0.5) */
    double sum = 0;
    for (int i = 0; i < num_taps; i++) {
        double x = i - mid;
        double sinc = (x == 0) ? 2 * fc : sin(2 * M_PI * fc * x) / (M_PI * x);
        double hamming = 0.54 - 0.46 * cos((2 * M_PI * i) / (num_taps - 1));
        double w = sinc * hamming;
        taps[i] = w;
        sum += w;
    }
    for (int i = 0; i < num_taps; i++) taps[i] /= sum; /* unity gain at DC */
    return taps;
}

static std::vector<double> apply_fir(const float* in, int in_len, const std::vector<double>& taps)
{
    int num_taps = (int)taps.size();
    double half = (num_taps - 1) / 2.0;
    std::vector<double> out(in_len);
    for (int i = 0; i < in_len; i++) {
        double acc = 0;
        for (int k = 0; k < num_taps; k++) {
            int idx = (int)(i + k - half);
            if (idx >= 0 && idx < in_len) acc += taps[k] * in[idx];
        }
        out[i] = acc;
    }
    return out;
}

/* ── anti-aliased resampler (float in → double out) ──────────────────────── */
static std::vector<double> resample_to_12k(const float* in, int in_len, int in_rate)
{
    if (in_rate == DECODE_RATE) {
        return std::vector<double>(in, in + in_len);
    }

    /* Anti-alias filter only matters when decimating (output rate < input
     * rate) — an upsample has no aliasing to guard against. */
    std::vector<double> filtered = (in_rate > DECODE_RATE)
        ? apply_fir(in, in_len, design_lowpass_fir(ANTIALIAS_CUTOFF_FRACTION * DECODE_RATE, in_rate, ANTIALIAS_TAPS))
        : std::vector<double>(in, in + in_len);

    long long n_out = (long long)in_len * DECODE_RATE / in_rate;
    std::vector<double> out(n_out);
    double step = (double)in_rate / DECODE_RATE;
    for (long long i = 0; i < n_out; i++) {
        double pos  = i * step;
        int    idx  = (int)pos;
        double frac = pos - idx;
        double s0   = filtered[idx];
        double s1   = (idx + 1 < in_len) ? filtered[idx + 1] : s0;
        out[i] = s0 + frac * (s1 - s0);
    }
    return out;
}

/* ── per-decode result accumulation ─────────────────────────────────────── */
struct Result {
    double hz;
    double dt;
    double snr;
    int    pass;
    int    correct_bits;
    int    osd_depth;   // -1 = clean LDPC decode; >=0 = OSD fallback at this depth
    std::string msg;
};

/* ft8.cc stamps "OSD-<depth>-<ldpc_ok>" into the callback comment when the
   decode came from the ordered-statistics fallback instead of a clean LDPC
   convergence. Clean decodes leave the comment empty (or "hint1"/"hint2"). */
static int parse_osd_depth(const char* comment)
{
    if (!comment) return -1;
    const char* p = strstr(comment, "OSD-");
    if (!p) return -1;
    return atoi(p + 4);
}

static std::vector<Result>  results;
static std::set<std::string> seen;

/* entry() runs synchronously under __EMSCRIPTEN__ (see ft8.cc patch), so a
   plain callback with globals is safe — no other thread touches these. */
static int decode_cb(int* a91, double hz0, double hz1, double off,
                     const char* comment, double snr, int pass,
                     int correct_bits)
{
    (void)hz1;
    std::string msg = unpack(a91);
    if (seen.count(msg))
        return 1; // duplicate: keep, but don't re-subtract
    seen.insert(msg);

    Result r;
    r.hz           = hz0;
    r.dt           = off - 0.5; // WSJT-X convention: 0 = exactly on time
    r.snr          = snr;
    r.pass         = pass;
    r.correct_bits = correct_bits;
    r.osd_depth    = parse_osd_depth(comment);
    r.msg          = msg;
    results.push_back(r);

    // Live progress: hand the full decoded message to JS (worker scope) so it
    // can stream into the UI immediately. postMessage from a worker delivers
    // even while the WASM call is blocking.
    EM_ASM({
        if (typeof self !== 'undefined' && typeof self.__ftmProgress === 'function') {
            self.__ftmProgress($0, $1, $2, $3, $4, $5, UTF8ToString($6), $7);
        }
    }, (int)results.size(), r.hz, r.dt, r.snr, r.correct_bits, r.pass, r.msg.c_str(),
       r.osd_depth);

    return 2; // new decode: subtract from residual for later passes
}

static void json_escape(std::string& out, const std::string& s)
{
    out += '"';
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    out += '"';
}

static std::string json_result;

extern "C" {

EMSCRIPTEN_KEEPALIVE
const char* ftm_decode(float* samples, int num_samples, int sample_rate,
                       float min_hz, float max_hz, float budget_sec)
{
    results.clear();
    seen.clear();

    std::vector<double> work = resample_to_12k(samples, num_samples, sample_rate);
    // exact 15 s buffer makes ft8mon's FFT plan cache effective
    work.resize(15 * DECODE_RATE, 0.0);

    int hints[2] = { 2, 0 }; // "first field may be CQ"
    entry(work.data(), (int)work.size(), (int)(0.5 * DECODE_RATE), DECODE_RATE,
          min_hz, max_hz, hints, hints,
          budget_sec, budget_sec, decode_cb,
          0, (struct cdecode*)0);

    json_result = "[";
    for (size_t i = 0; i < results.size(); i++) {
        const Result& r = results[i];
        if (i) json_result += ',';
        char buf[160];
        snprintf(buf, sizeof(buf),
                 "{\"freq\":%.2f,\"dt\":%.2f,\"snr\":%.1f,\"sync\":%d,\"pass\":%d,\"osd\":%d,\"msg\":",
                 r.hz, r.dt, r.snr, r.correct_bits, r.pass, r.osd_depth);
        json_result += buf;
        json_escape(json_result, r.msg);
        json_result += '}';
    }
    json_result += ']';
    return json_result.c_str();
}

EMSCRIPTEN_KEEPALIVE
double ftm_set(const char* param, const char* val)
{
    // ft8mon's set() takes non-const char*; it never mutates them.
    return set((char*)param, (char*)val);
}

EMSCRIPTEN_KEEPALIVE
void ftm_init(void)
{
    // Single-threaded decode inside a worker; band-splitting threads disabled.
    set((char*)"nthreads", (char*)"1");
}

EMSCRIPTEN_KEEPALIVE
int ftm_heap_used(void)
{
    // Live malloc'd bytes (persistent hash tables, cached FFTW plans, ...).
    // HEAPU8.length on the JS side is only the reserved linear memory.
    return (int)mallinfo().uordblks;
}

} // extern "C"
