// Memory/flash benchmark — see mem_bench.h.
//
// Measures:
//   - PSRAM <-> internal RAM copy throughput and random PSRAM read latency (PSRAM clock,
//     cache workaround);
//   - flash read throughput through the cache, from the running app's own mapped image
//     (flash mode and clock);
//   - how long a task on the other core stalls while a flash sector is erased and written
//     (the audio/CAT glitch risk of OTA, NVS and CAT-log writes).
// The flash write goes to the last sector of the INACTIVE OTA slot, and only if that sector
// is blank (all 0xFF, i.e. past the end of whatever image is stored there); it is erased
// again afterwards, so the stored rollback image is never touched.
#include "mem_bench.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#define COPY_BYTES   (128 * 1024)
#define INT_BYTES    (16 * 1024)
#define SECTOR       4096

static volatile int64_t s_stall_max_us;
static volatile bool s_stall_run;
static int s_mode;  // 5/6: debug splits of the flash-write step

static void stall_task(void *arg)
{
    const uint32_t *buf = arg;
    int64_t last = esp_timer_get_time();
    uint32_t acc = 0;
    while (s_stall_run) {
        for (int i = 0; i < 256; i++) acc += buf[(i * 67) & ((INT_BYTES / 4) - 1)];
        int64_t now = esp_timer_get_time();
        if (now - last > s_stall_max_us) s_stall_max_us = now - last;
        last = now;
    }
    (void)acc;
    vTaskDelete(NULL);
}

static double mbps(size_t bytes, int64_t us) { return us > 0 ? bytes / (double)us : 0; }

// Stall of the other core during one sector erase+write. Negative on failure: -1 write failed,
// -2 no spare OTA slot, -3 no memory, -4 spare slot's last sector not blank, -5 no task.
static int64_t flash_write_stall(const uint32_t *int_buf, int64_t *idle_us, int64_t *write_us)
{
    const esp_partition_t *spare = esp_ota_get_next_update_partition(NULL);
    if (!spare || spare->size < SECTOR) return -2;
    uint32_t off = spare->size - SECTOR;
    uint8_t *sec = heap_caps_malloc(SECTOR, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!sec) return -3;
    bool blank = esp_partition_read(spare, off, sec, SECTOR) == ESP_OK;
    for (int i = 0; blank && i < SECTOR; i++) if (sec[i] != 0xFF) blank = false;
    if (!blank) { heap_caps_free(sec); return -4; }

    s_stall_max_us = 0;
    s_stall_run = true;
    int other = xPortGetCoreID() ? 0 : 1;
    if (s_mode == 5) {  // flash write only, no spinning task
        s_stall_run = false;
        int64_t t = esp_timer_get_time();
        esp_err_t e = esp_partition_erase_range(spare, off, SECTOR);
        if (e == ESP_OK) e = esp_partition_write(spare, off, sec, SECTOR);
        *write_us = esp_timer_get_time() - t;
        esp_partition_erase_range(spare, off, SECTOR);
        heap_caps_free(sec);
        return e == ESP_OK ? 0 : -2;
    }
    if (xTaskCreatePinnedToCore(stall_task, "bench_stall", 4096, (void *)int_buf, 3, NULL, other) != pdPASS) {
        s_stall_run = false; heap_caps_free(sec); return -5;
    }
    vTaskDelay(pdMS_TO_TICKS(60));
    *idle_us = s_stall_max_us;
    if (s_mode == 6) {  // spinning task only, no flash write
        s_stall_run = false;
        vTaskDelay(pdMS_TO_TICKS(30));
        heap_caps_free(sec);
        return 0;
    }
    s_stall_max_us = 0;
    memset(sec, 0xA5, SECTOR);
    int64_t t = esp_timer_get_time();
    esp_err_t e = esp_partition_erase_range(spare, off, SECTOR);
    if (e == ESP_OK) e = esp_partition_write(spare, off, sec, SECTOR);
    *write_us = esp_timer_get_time() - t;
    vTaskDelay(pdMS_TO_TICKS(30));
    int64_t stall = s_stall_max_us;
    s_stall_run = false;
    esp_partition_erase_range(spare, off, SECTOR);  // back to blank
    vTaskDelay(pdMS_TO_TICKS(30));  // let the stall task exit
    heap_caps_free(sec);
    return e == ESP_OK ? stall : -1;
}

size_t mem_bench_run_json(int steps, char *out, size_t out_len)
{
    esp_chip_info_t ci;
    esp_chip_info(&ci);
    uint8_t *p1 = heap_caps_malloc(COPY_BYTES, MALLOC_CAP_SPIRAM);
    uint8_t *p2 = heap_caps_malloc(COPY_BYTES, MALLOC_CAP_SPIRAM);
    uint8_t *in = heap_caps_malloc(INT_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    double pp = 0, pi = 0, ip = 0, ii = 0, rnd_ns = 0, fl_mbps = 0;
    int64_t stall = -1, idle = 0, wr = 0;
    if (steps >= 1 && p1 && p2 && in) {
        memset(p1, 0x5A, COPY_BYTES);
        int64_t t = esp_timer_get_time();
        for (int k = 0; k < 8; k++) memcpy(p2, p1, COPY_BYTES);
        pp = mbps(8 * COPY_BYTES, esp_timer_get_time() - t);
        t = esp_timer_get_time();
        for (int k = 0; k < 64; k++) memcpy(in, p1 + (k & 7) * INT_BYTES, INT_BYTES);
        pi = mbps(64 * INT_BYTES, esp_timer_get_time() - t);
        t = esp_timer_get_time();
        for (int k = 0; k < 64; k++) memcpy(p2 + (k & 7) * INT_BYTES, in, INT_BYTES);
        ip = mbps(64 * INT_BYTES, esp_timer_get_time() - t);
        uint8_t *in2 = heap_caps_malloc(INT_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (in2) {
            t = esp_timer_get_time();
            for (int k = 0; k < 64; k++) memcpy(in2, in, INT_BYTES);
            ii = mbps(64 * INT_BYTES, esp_timer_get_time() - t);
            heap_caps_free(in2);
        }
    }
    if (steps >= 2 && p1 && p2) {
        const uint32_t *w = (const uint32_t *)p1;
        int64_t t;
        uint32_t acc = 0, seed = esp_random();
        const int reads = 50000;
        t = esp_timer_get_time();
        for (int k = 0; k < reads; k++) { seed = seed * 1664525u + 1013904223u; acc += w[(seed >> 8) & ((COPY_BYTES / 4) - 1)]; }
        rnd_ns = (esp_timer_get_time() - t) * 1000.0 / reads;
        p2[0] = (uint8_t)acc;
    }
    if (steps >= 3 && p2) {
        int64_t t;
        // Flash read through the cache: the running image, mapped. 256 KB is far more than the
        // cache, so nearly every line is a miss.
        const esp_partition_t *run = esp_ota_get_running_partition();
        const void *map = NULL;
        esp_partition_mmap_handle_t mh;
        size_t len = 256 * 1024;
        if (run && run->size >= len &&
            esp_partition_mmap(run, 0, len, ESP_PARTITION_MMAP_DATA, &map, &mh) == ESP_OK) {
            const volatile uint32_t *f = map;
            uint32_t sum = 0;
            t = esp_timer_get_time();
            for (size_t i = 0; i < len / 4; i += 8) sum += f[i];  // one read per 32-byte cache line
            fl_mbps = mbps(len, esp_timer_get_time() - t);
            esp_partition_munmap(mh);
            p2[1] = (uint8_t)sum;
        }
    }
    s_mode = steps;
    if (steps >= 4 && in) stall = flash_write_stall((const uint32_t *)in, &idle, &wr);
    heap_caps_free(p1); heap_caps_free(p2); heap_caps_free(in);

    int n = snprintf(out, out_len,
        "{\"steps\":%d,\"last_reset_reason\":%d,\"chip_rev\":%d,\"cores\":%d,\"cpu_mhz\":%d,"
        "\"flash_mode\":\"%s\",\"flash_mhz\":\"%s\",\"psram_mhz\":%d,\"psram_cache_workaround\":%s,"
        "\"i2s_isr_iram\":%s,\"uart_isr_iram\":%s,"
        "\"psram_to_psram_mbps\":%.1f,\"psram_to_internal_mbps\":%.1f,\"internal_to_psram_mbps\":%.1f,"
        "\"internal_to_internal_mbps\":%.1f,\"psram_random_read_ns\":%.0f,\"flash_cached_read_mbps\":%.1f,"
        "\"flash_write_ms\":%.1f,\"other_core_stall_us\":%" PRId64 ",\"other_core_idle_gap_us\":%" PRId64 ","
        "\"free_internal_kb\":%u,\"free_psram_kb\":%u}",
        steps, (int)esp_reset_reason(), ci.revision, ci.cores, CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ,
#if CONFIG_ESPTOOLPY_FLASHMODE_QIO
        "qio",
#elif CONFIG_ESPTOOLPY_FLASHMODE_QOUT
        "qout",
#else
        CONFIG_ESPTOOLPY_FLASHMODE,  // header value; QIO/QOUT builds store "dio" here and switch in the bootloader
#endif
        CONFIG_ESPTOOLPY_FLASHFREQ, CONFIG_SPIRAM_SPEED,
#if CONFIG_SPIRAM_CACHE_WORKAROUND
        "true",
#else
        "false",
#endif
#if CONFIG_I2S_ISR_IRAM_SAFE
        "true",
#else
        "false",
#endif
#if CONFIG_UART_ISR_IN_IRAM
        "true",
#else
        "false",
#endif
        pp, pi, ip, ii, rnd_ns, fl_mbps, wr / 1000.0, stall, idle,
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) >> 10),
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) >> 10));
    return (n > 0 && (size_t)n < out_len) ? (size_t)n : 0;
}
