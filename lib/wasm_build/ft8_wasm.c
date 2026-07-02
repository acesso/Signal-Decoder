/**
 * ft8_wasm.c — Emscripten wrapper exposing FT8/FT4 decode to JavaScript.
 *
 * Exported function:
 *   ft8_decode(float* samples, int num_samples, int sample_rate, int is_ft4)
 *     → returns a pointer to a JSON string (null-terminated, owned by WASM heap)
 *       "[{\"freq\":...,\"dt\":...,\"snr\":...,\"msg\":\"...\",\"sync\":...}, ...]"
 *
 * Input samples may be at any rate (browser typically sends 44100 or 48000 Hz).
 * They are downsampled to DECODE_RATE (12000 Hz) before decoding, matching the
 * rate the ft8_lib monitor is designed for.
 *
 * The callsign hash table persists between calls (one module instance per worker).
 */

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <malloc.h>
#include <emscripten/emscripten.h>

#include "ft8/decode.h"
#include "ft8/message.h"
#include "ft8/constants.h"
#include "common/monitor.h"

/* ── tunables ──────────────────────────────────────────────────────────────── */
#define DECODE_RATE     12000   /* ft8_lib works best at 12 kHz */
#define MIN_SCORE       10
#define MAX_CANDIDATES  300
#define LDPC_ITERATIONS 25
#define MAX_DECODED     50
#define HASH_SIZE       256
#define FREQ_OSR        2
#define TIME_OSR        2

/* ── simple linear-interpolation decimator ─────────────────────────────────── */
/*
 * Downsamples `in[in_len]` from `in_rate` to DECODE_RATE using linear
 * interpolation.  Allocates and returns a new buffer; writes length to *out_len.
 * Returns NULL on malloc failure.
 */
static float* resample_to_12k(const float* in, int in_len, int in_rate, int* out_len)
{
    if (in_rate == DECODE_RATE) {
        float* out = (float*)malloc(in_len * sizeof(float));
        if (!out) return NULL;
        memcpy(out, in, in_len * sizeof(float));
        *out_len = in_len;
        return out;
    }

    int n_out = (int)((long long)in_len * DECODE_RATE / in_rate);
    float* out = (float*)malloc(n_out * sizeof(float));
    if (!out) return NULL;

    double step = (double)in_rate / DECODE_RATE;
    for (int i = 0; i < n_out; i++) {
        double pos  = i * step;
        int    idx  = (int)pos;
        double frac = pos - idx;
        float  s0   = in[idx];
        float  s1   = (idx + 1 < in_len) ? in[idx + 1] : s0;
        out[i] = (float)(s0 + frac * (s1 - s0));
    }
    *out_len = n_out;
    return out;
}

/* ── callsign hash table ───────────────────────────────────────────────────── */
static struct {
    char     callsign[12];
    uint32_t hash;
} ht[HASH_SIZE];

static void ht_init(void) {
    memset(ht, 0, sizeof(ht));
}

static void ht_add(const char* cs, uint32_t hash) {
    uint16_t h10 = (hash >> 12) & 0x3FF;
    int idx = (h10 * 23) % HASH_SIZE;
    while (ht[idx].callsign[0] != '\0') {
        if (((ht[idx].hash & 0x3FFFFF) == hash) && (strcmp(ht[idx].callsign, cs) == 0)) {
            ht[idx].hash &= 0x3FFFFF;
            return;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    strncpy(ht[idx].callsign, cs, 11);
    ht[idx].callsign[11] = '\0';
    ht[idx].hash = hash;
}

static bool ht_lookup(ftx_callsign_hash_type_t type, uint32_t hash, char* cs) {
    uint8_t  shift = (type == FTX_CALLSIGN_HASH_10_BITS) ? 12
                   : (type == FTX_CALLSIGN_HASH_12_BITS) ? 10 : 0;
    uint16_t h10   = (hash >> (12 - shift)) & 0x3FF;
    int idx = (h10 * 23) % HASH_SIZE;
    while (ht[idx].callsign[0] != '\0') {
        if (((ht[idx].hash & 0x3FFFFF) >> shift) == hash) {
            strcpy(cs, ht[idx].callsign);
            return true;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    cs[0] = '\0';
    return false;
}

static ftx_callsign_hash_interface_t hash_if = {
    .lookup_hash = ht_lookup,
    .save_hash   = ht_add,
};

/* ── dynamic string buffer ─────────────────────────────────────────────────── */
typedef struct { char* buf; int len; int cap; } Buf;

static void buf_ensure(Buf* b, int extra) {
    if (b->len + extra + 1 > b->cap) {
        b->cap = (b->len + extra + 1) * 2 + 256;
        b->buf = (char*)realloc(b->buf, b->cap);
    }
}

static void buf_cat(Buf* b, const char* s) {
    int n = (int)strlen(s);
    buf_ensure(b, n);
    memcpy(b->buf + b->len, s, n);
    b->len += n;
    b->buf[b->len] = '\0';
}

static void buf_catf(Buf* b, const char* fmt, ...) {
    char tmp[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    buf_cat(b, tmp);
}

static void json_escape_cat(Buf* b, const char* s) {
    buf_ensure(b, (int)strlen(s) * 2 + 3);
    b->buf[b->len++] = '"';
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') b->buf[b->len++] = '\\';
        b->buf[b->len++] = *s;
    }
    b->buf[b->len++] = '"';
    b->buf[b->len] = '\0';
}

/* ── persistent result buffer ──────────────────────────────────────────────── */
static char* json_result = NULL;

/* ── exported functions ────────────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
char* ft8_decode(float* samples, int num_samples, int sample_rate, int is_ft4) {
    /* Resample to DECODE_RATE */
    int    work_len = 0;
    float* work     = resample_to_12k(samples, num_samples, sample_rate, &work_len);
    if (!work) {
        if (json_result) free(json_result);
        json_result = (char*)malloc(3);
        if (json_result) { json_result[0] = '['; json_result[1] = ']'; json_result[2] = '\0'; }
        return json_result;
    }

    ftx_protocol_t protocol = is_ft4 ? FTX_PROTOCOL_FT4 : FTX_PROTOCOL_FT8;

    monitor_config_t cfg = {
        .f_min       = 200,
        .f_max       = 3000,
        .sample_rate = DECODE_RATE,
        .time_osr    = TIME_OSR,
        .freq_osr    = FREQ_OSR,
        .protocol    = protocol,
    };
    monitor_t mon;
    monitor_init(&mon, &cfg);

    for (int pos = 0; pos + mon.block_size <= work_len; pos += mon.block_size)
        monitor_process(&mon, work + pos);

    free(work);

    ftx_candidate_t candidates[MAX_CANDIDATES];
    int num_cands = ftx_find_candidates(&mon.wf, MAX_CANDIDATES, candidates, MIN_SCORE);

    ftx_message_t  decoded[MAX_DECODED];
    ftx_message_t* dedup[MAX_DECODED];
    for (int i = 0; i < MAX_DECODED; i++) dedup[i] = NULL;

    Buf out = { NULL, 0, 0 };
    buf_cat(&out, "[");
    int first = 1;

    for (int i = 0; i < num_cands; i++) {
        const ftx_candidate_t* cand = &candidates[i];
        ftx_message_t       msg;
        ftx_decode_status_t status;
        if (!ftx_decode_candidate(&mon.wf, cand, LDPC_ITERATIONS, &msg, &status)) continue;

        /* Dedup */
        int  slot  = msg.hash % MAX_DECODED;
        bool dup   = false;
        bool empty = false;
        while (!dup && !empty) {
            if      (dedup[slot] == NULL) { empty = true; }
            else if (dedup[slot]->hash == msg.hash &&
                     memcmp(dedup[slot]->payload, msg.payload, sizeof(msg.payload)) == 0) { dup = true; }
            else    { slot = (slot + 1) % MAX_DECODED; }
        }
        if (dup) continue;
        memcpy(&decoded[slot], &msg, sizeof(msg));
        dedup[slot] = &decoded[slot];

        /* Unpack text */
        char text[FTX_MAX_MESSAGE_LENGTH + 4];
        ftx_message_offsets_t offsets;
        ftx_message_rc_t rc = ftx_message_decode(&msg, &hash_if, text, &offsets);
        if (rc != FTX_MESSAGE_RC_OK) snprintf(text, sizeof(text), "?");

        float freq = (mon.min_bin + cand->freq_offset + (float)cand->freq_sub / mon.wf.freq_osr)
                     / mon.symbol_period;
        /* dt is raw seconds from window start; subtract 0.5 to match WSJT-X/ft8ts
           convention where 0 = signal arrived exactly on time. */
        float dt   = (cand->time_offset + (float)cand->time_sub / mon.wf.time_osr)
                     * mon.symbol_period - 0.5f;
        float snr  = cand->score * 0.5f;

        if (!first) buf_cat(&out, ",");
        first = 0;
        buf_cat(&out, "{\"freq\":");
        buf_catf(&out, "%.2f", freq);
        buf_cat(&out, ",\"dt\":");
        buf_catf(&out, "%.2f", dt);
        buf_cat(&out, ",\"snr\":");
        buf_catf(&out, "%.1f", snr);
        buf_cat(&out, ",\"sync\":");
        buf_catf(&out, "%d", (int)cand->score);
        buf_cat(&out, ",\"msg\":");
        json_escape_cat(&out, text);
        buf_cat(&out, "}");
    }
    buf_cat(&out, "]");

    monitor_free(&mon);

    if (json_result) free(json_result);
    json_result = out.buf;
    return json_result;
}

EMSCRIPTEN_KEEPALIVE
void ft8_free_result(char* ptr) {
    (void)ptr;
}

EMSCRIPTEN_KEEPALIVE
void ft8_init(void) {
    ht_init();
}

EMSCRIPTEN_KEEPALIVE
int ft8_heap_used(void) {
    return (int)mallinfo().uordblks;
}
