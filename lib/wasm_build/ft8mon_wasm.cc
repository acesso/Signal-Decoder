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
 *       "[{\"freq\":...,\"dt\":...,\"snr\":...,\"msg\":\"...\",\"sync\":...,\"pass\":...},...]"
 *     `sync` carries ft8mon's correct_bits (LDPC parity bits correct before
 *     decode) so the UI's existing sync column stays meaningful.
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

/* ── linear-interpolation resampler (float in → double out) ─────────────── */
static std::vector<double> resample_to_12k(const float* in, int in_len, int in_rate)
{
    if (in_rate == DECODE_RATE) {
        return std::vector<double>(in, in + in_len);
    }
    long long n_out = (long long)in_len * DECODE_RATE / in_rate;
    std::vector<double> out(n_out);
    double step = (double)in_rate / DECODE_RATE;
    for (long long i = 0; i < n_out; i++) {
        double pos  = i * step;
        int    idx  = (int)pos;
        double frac = pos - idx;
        double s0   = in[idx];
        double s1   = (idx + 1 < in_len) ? in[idx + 1] : s0;
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
    std::string msg;
};

static std::vector<Result>  results;
static std::set<std::string> seen;

/* entry() runs synchronously under __EMSCRIPTEN__ (see ft8.cc patch), so a
   plain callback with globals is safe — no other thread touches these. */
static int decode_cb(int* a91, double hz0, double hz1, double off,
                     const char* comment, double snr, int pass,
                     int correct_bits)
{
    (void)hz1; (void)comment;
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
    r.msg          = msg;
    results.push_back(r);

    // Live progress: hand the full decoded message to JS (worker scope) so it
    // can stream into the UI immediately. postMessage from a worker delivers
    // even while the WASM call is blocking.
    EM_ASM({
        if (typeof self !== 'undefined' && typeof self.__ftmProgress === 'function') {
            self.__ftmProgress($0, $1, $2, $3, $4, $5, UTF8ToString($6));
        }
    }, (int)results.size(), r.hz, r.dt, r.snr, r.correct_bits, r.pass, r.msg.c_str());

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
        char buf[128];
        snprintf(buf, sizeof(buf),
                 "{\"freq\":%.2f,\"dt\":%.2f,\"snr\":%.1f,\"sync\":%d,\"pass\":%d,\"msg\":",
                 r.hz, r.dt, r.snr, r.correct_bits, r.pass);
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
