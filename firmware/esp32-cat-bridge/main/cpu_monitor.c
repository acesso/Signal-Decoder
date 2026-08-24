#include "cpu_monitor.h"

#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sdkconfig.h"

static const char *TAG = "cpu_monitor";

// Real, board-supported fixed points for the original ESP32 (see
// esp_system/port/soc/esp32/Kconfig.cpu) — 40MHz is FPGA-emulation-only,
// deliberately excluded here since it'd just fail on real hardware.
const int CPU_MONITOR_SUPPORTED_FREQS_MHZ[] = { 80, 160, 240 };
const int CPU_MONITOR_SUPPORTED_FREQS_COUNT = sizeof(CPU_MONITOR_SUPPORTED_FREQS_MHZ) / sizeof(CPU_MONITOR_SUPPORTED_FREQS_MHZ[0]);

static int s_current_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ;

// Snapshot of every task's cumulative runtime counter, taken on the
// previous call to cpu_monitor_write_tasks_json() — the delta between two
// snapshots (not the raw since-boot cumulative counter) is what actually
// answers "how busy has each task been lately," which matters more to an
// operator watching this refresh live than a since-boot average that
// dilutes toward meaninglessness the longer the board runs.
#define MAX_TRACKED_TASKS 24
typedef struct {
    TaskHandle_t handle;
    uint32_t last_runtime;
} task_runtime_snapshot_t;
static task_runtime_snapshot_t s_prev_snapshot[MAX_TRACKED_TASKS];
static int s_prev_snapshot_count = 0;
static uint32_t s_prev_total_runtime = 0;

bool cpu_monitor_set_freq_mhz(int mhz) {
    bool supported = false;
    for (int i = 0; i < CPU_MONITOR_SUPPORTED_FREQS_COUNT; i++) {
        if (CPU_MONITOR_SUPPORTED_FREQS_MHZ[i] == mhz) { supported = true; break; }
    }
    if (!supported) return false;

    // min == max — see the header/sdkconfig.defaults comments for why:
    // this pins a single fixed point rather than opening an actual
    // scaling range for esp_pm's DFS logic to move within on its own.
    esp_pm_config_t cfg = {
        .max_freq_mhz = mhz,
        .min_freq_mhz = mhz,
    };
    esp_err_t err = esp_pm_configure(&cfg);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_pm_configure(%d MHz) failed: %s", mhz, esp_err_to_name(err));
        return false;
    }
    s_current_freq_mhz = mhz;
    ESP_LOGI(TAG, "CPU frequency pinned to %d MHz", mhz);
    return true;
}

int cpu_monitor_get_freq_mhz(void) {
    return s_current_freq_mhz;
}

void cpu_monitor_start(void) {
    // Establishes the fixed-point baseline explicitly (rather than relying
    // on whatever esp_pm's own startup path already did with
    // CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ) so s_current_freq_mhz and the
    // driver's actual state are guaranteed to agree from the first
    // GET /status onward.
    cpu_monitor_set_freq_mhz(CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ);
}

void cpu_monitor_get_heap(cpu_monitor_heap_t *out) {
    multi_heap_info_t info;
    heap_caps_get_info(&info, MALLOC_CAP_INTERNAL);
    out->free_bytes = (uint32_t)info.total_free_bytes;
    out->min_free_bytes = esp_get_minimum_free_heap_size();
    out->total_bytes = (uint32_t)(info.total_free_bytes + info.total_allocated_bytes);
    out->largest_free_block_bytes = (uint32_t)info.largest_free_block;

    multi_heap_info_t dma_info;
    heap_caps_get_info(&dma_info, MALLOC_CAP_DMA);
    out->dma_free_bytes = (uint32_t)dma_info.total_free_bytes;
    out->dma_largest_free_block_bytes = (uint32_t)dma_info.largest_free_block;
}

int cpu_monitor_write_tasks_json(char *buf, size_t buf_sz) {
    if (buf_sz < 3) return -1; // not even room for "[]"

    UBaseType_t task_count = uxTaskGetNumberOfTasks();
    // PSRAM: per-request scratch for a diagnostics-only endpoint
    // (GET /system-stats), never touched outside this httpd worker call.
    TaskStatus_t *statuses = heap_caps_malloc(task_count * sizeof(TaskStatus_t), MALLOC_CAP_SPIRAM);
    if (!statuses) {
        // Fall back to an empty array rather than failing the whole
        // /status response — a missing task list is a lot less bad than
        // no status at all.
        strncpy(buf, "[]", buf_sz);
        return 2;
    }

    uint32_t total_runtime = 0;
    UBaseType_t actual_count = uxTaskGetSystemState(statuses, task_count, &total_runtime);

    // Delta since the last snapshot — see s_prev_snapshot's comment. Falls
    // back to the raw since-boot share on the very first call (nothing to
    // diff against yet) or if the runtime counter wrapped (total went
    // backwards, e.g. after ~4295s uptime on the 32-bit counter — rare on
    // a device that gets rebooted this often during active development,
    // but cheap to guard against regardless).
    uint32_t total_delta = total_runtime > s_prev_total_runtime ? total_runtime - s_prev_total_runtime : total_runtime;

    size_t o = 0;
    int n = snprintf(buf + o, buf_sz - o, "[");
    if (n < 0 || (size_t)n >= buf_sz - o) { free(statuses); strncpy(buf, "[]", buf_sz); return 2; }
    o += (size_t)n;

    task_runtime_snapshot_t next_snapshot[MAX_TRACKED_TASKS];
    int next_snapshot_count = 0;

    for (UBaseType_t i = 0; i < actual_count && next_snapshot_count < MAX_TRACKED_TASKS; i++) {
        TaskStatus_t *t = &statuses[i];

        uint32_t prev_runtime = 0;
        for (int j = 0; j < s_prev_snapshot_count; j++) {
            if (s_prev_snapshot[j].handle == t->xHandle) { prev_runtime = s_prev_snapshot[j].last_runtime; break; }
        }
        uint32_t task_delta = t->ulRunTimeCounter > prev_runtime ? t->ulRunTimeCounter - prev_runtime : 0;
        float cpu_pct = total_delta > 0 ? (100.0f * (float)task_delta / (float)total_delta) : 0.0f;

        next_snapshot[next_snapshot_count].handle = t->xHandle;
        next_snapshot[next_snapshot_count].last_runtime = t->ulRunTimeCounter;
        next_snapshot_count++;

        int core = -1;
#if CONFIG_FREERTOS_VTASKLIST_INCLUDE_COREID
        core = (int)t->xCoreID;
        if (core == (int)tskNO_AFFINITY) core = -1;
#endif

        // usStackHighWaterMark is in StackType_t words (4 bytes each on
        // Xtensa), not bytes — scaled here so the browser can display a
        // plain byte count without needing to know that unit itself.
        n = snprintf(buf + o, buf_sz - o, "%s{\"name\":\"%s\",\"cpu_pct\":%.1f,\"core\":%d,\"stack_free\":%u}",
            i == 0 ? "" : ",", t->pcTaskName, (double)cpu_pct, core, (unsigned)(t->usStackHighWaterMark * sizeof(StackType_t)));
        if (n < 0 || (size_t)n >= buf_sz - o) {
            // Ran out of room mid-array — close what we have rather than
            // emitting truncated/invalid JSON. A dropped tail task is a
            // fine tradeoff for "the response is always valid JSON."
            break;
        }
        o += (size_t)n;
    }

    n = snprintf(buf + o, buf_sz - o, "]");
    if (n < 0 || (size_t)n >= buf_sz - o) {
        // Shouldn't happen given the >=3 check up front, but fail safe
        // rather than return a buffer missing its closing bracket.
        free(statuses);
        strncpy(buf, "[]", buf_sz);
        return 2;
    }
    o += (size_t)n;

    memcpy(s_prev_snapshot, next_snapshot, sizeof(task_runtime_snapshot_t) * (size_t)next_snapshot_count);
    s_prev_snapshot_count = next_snapshot_count;
    s_prev_total_runtime = total_runtime;

    free(statuses);
    return (int)o;
}
