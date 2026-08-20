// Diagnostics-only CPU/memory panel for the standalone control page (see
// spiffs_data/) — reports heap usage and per-task CPU% (see
// FREERTOS_GENERATE_RUN_TIME_STATS in sdkconfig.defaults), and lets the
// operator live-pin the CPU frequency (POST /cpu-freq) as a cheap
// experiment for whether digital switching activity is coupling into the
// analog audio input path (a genuinely uncertain, low-confidence
// hypothesis compared to the already-confirmed onboard-mic-bleed and
// still-untested LED hypotheses — see the ADCCONTROL2/led_status_set_enabled
// comments elsewhere in this firmware). Deliberately NOT wired into the
// Signal-Decoder web app's own Bridge panel — this is a bridge-firmware-only
// diagnostic tool, same scope as the ADC input/MIC gain/RX slot/LED
// controls already added there.
//
// esp_pm_configure() is called ONCE at boot (see cpu_monitor_start()) with
// min_freq_mhz == max_freq_mhz — CONFIG_PM_ENABLE is on (see
// sdkconfig.defaults) so the API is available, but pinning both bounds to
// the same value means no ACTUAL dynamic scaling ever happens on its own;
// the pinned frequency only ever changes via an explicit
// cpu_monitor_set_freq_mhz() call.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Real, board-supported values only — esp_pm_configure() silently clamps
// or rejects anything else depending on chip/target, so the HTTP handler
// validates against this same list rather than passing arbitrary ints
// through to the driver.
extern const int CPU_MONITOR_SUPPORTED_FREQS_MHZ[];
extern const int CPU_MONITOR_SUPPORTED_FREQS_COUNT;

// Calls esp_pm_configure() once with min==max==the Kconfig default
// (CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ) — establishes the fixed-frequency
// baseline this whole module assumes. Call once from app_main, any time
// after NVS/Wi-Fi bring-up (no ordering dependency on anything else here).
void cpu_monitor_start(void);

// Live-repins the CPU to exactly mhz (min_freq_mhz = max_freq_mhz = mhz) —
// still no dynamic scaling, just a different fixed point. Returns false if
// mhz isn't one of CPU_MONITOR_SUPPORTED_FREQS_MHZ or the underlying
// esp_pm_configure() call failed.
bool cpu_monitor_set_freq_mhz(int mhz);

// Currently-pinned CPU frequency in MHz, reflecting the last successful
// cpu_monitor_set_freq_mhz() call (or cpu_monitor_start()'s boot value) —
// for GET /status to report.
int cpu_monitor_get_freq_mhz(void);

// Snapshot of heap usage right now, in bytes.
typedef struct {
    uint32_t free_bytes;
    uint32_t min_free_bytes; // lowest free-heap watermark since boot
    uint32_t total_bytes;    // free_bytes + actually-allocated bytes right now (NOT total installed heap)
} cpu_monitor_heap_t;

void cpu_monitor_get_heap(cpu_monitor_heap_t *out);

// Writes a JSON array of per-task stats — [{"name":"...","cpu_pct":12.3,
// "core":0,"stack_free":1234},...] — into buf (NUL-terminated, truncated
// with a trailing "]" if it doesn't fit rather than overflowing). Returns
// the number of bytes written (excluding the NUL), or -1 if buf was too
// small even for an empty "[]".  Percentages are relative to the total
// runtime counted across ALL tasks between now and the last call (i.e.
// "share of CPU time since you last asked", not since boot) — matches
// what an operator actually wants from a live-refreshing panel more than
// a since-boot average that becomes less meaningful the longer the board
// has been up.
int cpu_monitor_write_tasks_json(char *buf, size_t buf_sz);
