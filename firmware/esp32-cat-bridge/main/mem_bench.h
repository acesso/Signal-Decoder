// Memory/flash benchmark (experimental branch exp/a1s-memory-tuning): measures what the
// flash, PSRAM and cache settings in sdkconfig actually deliver on this board, so each
// setting change can be compared over OTA. Served as JSON by GET /bench.
#pragma once
#include <stddef.h>

// Runs the benchmark (about 1–2 s) and writes one JSON object into out. `steps` limits how
// far it goes, to isolate a misbehaving part: 0 = settings and last reset reason only,
// 1 = + RAM copies, 2 = + random PSRAM reads, 3 = + cached flash reads, 4 = + flash write stall.
// Returns the JSON length, or 0 if out was too small.
size_t mem_bench_run_json(int steps, char *out, size_t out_len);
