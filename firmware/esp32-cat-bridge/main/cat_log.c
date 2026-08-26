#include "cat_log.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "spi_flash_mmap.h"

#include "bridge_settings.h"

static const char *TAG = "cat_log";

// Fixed-size on-flash record. Deliberately NOT the same struct as
// cat_log_entry_t (the public/RAM-shadow shape) — this one needs a magic
// byte + sequence number for crash-safe boot recovery (see cat_log_init())
// that callers of cat_log_read_recent() have no business seeing.
//
// Padded to exactly 64 bytes (CAT_LOG_RECORD_SIZE) — the fields below only
// add up to 52, but 52 does NOT evenly divide 4096 (the flash erase
// sector size), which matters a lot here: write_record_to_flash() decides
// whether to erase the CURRENT sector purely by checking whether the
// write offset lands exactly on a sector boundary. If records didn't
// divide evenly into a sector, a record could straddle two sectors,
// meaning part of it gets written into flash that hasn't been erased yet
// — silently corrupting that record (flash bits can only flip 1->0; you
// cannot write meaningful data into a not-yet-erased region). 64 divides
// 4096 exactly (64 records/sector, no remainder), so every record either
// fits entirely within the sector the write pointer erased, or IS itself
// the first record of a freshly-erased sector — never split across the
// boundary. The explicit padding bytes make the intent visible in the
// struct definition rather than relying on unstated compiler behavior.
#define CAT_LOG_RECORD_SIZE 64
#define CAT_LOG_MAX_FRAME_LEN 40
#define CAT_LOG_RECORD_MAGIC 0xC7 // arbitrary, just needs to be unlikely in freshly-erased (0xFF) or garbage flash
typedef struct __attribute__((packed)) {
    uint8_t magic;          // CAT_LOG_RECORD_MAGIC if this slot holds a real record, 0xFF if erased/never written
    uint32_t seq;           // monotonically increasing across the WHOLE partition's lifetime — used to find the true head/tail on boot, and to order records within one read
    uint8_t from_radio;     // 0/1, not bool — struct layout must be stable across firmware builds reading old flash content
    uint32_t uptime_ms;
    uint8_t frame_len;      // 0..CAT_LOG_MAX_FRAME_LEN
    char frame[CAT_LOG_MAX_FRAME_LEN];
    uint8_t crc;            // simple additive checksum over the bytes above — just needs to catch a torn/partial write, not cryptographic
    uint8_t reserved[CAT_LOG_RECORD_SIZE - (1 + 4 + 1 + 4 + 1 + CAT_LOG_MAX_FRAME_LEN + 1)]; // pads the struct to CAT_LOG_RECORD_SIZE — see comment above
} cat_log_record_t;

_Static_assert(sizeof(cat_log_record_t) == CAT_LOG_RECORD_SIZE,
    "cat_log_record_t must be exactly CAT_LOG_RECORD_SIZE bytes — adjust `reserved`'s size if a field above changes");
_Static_assert(4096 % CAT_LOG_RECORD_SIZE == 0,
    "CAT_LOG_RECORD_SIZE must evenly divide the flash erase sector size (4096), or records can straddle sector boundaries and get corrupted on write");

#define RECORD_SIZE ((int)sizeof(cat_log_record_t))

static const esp_partition_t *s_partition = NULL;
static uint32_t s_next_seq = 0;      // seq to assign the NEXT record written
static size_t s_write_offset = 0;    // byte offset within s_partition of the next record to write
static SemaphoreHandle_t s_ram_mutex = NULL;

// In-RAM shadow of the most recent CAT_LOG_CAPACITY records, as a ring —
// so cat_log_read_recent() (called from the HTTP handler task on every
// GET /cat-log) never touches flash and can never block on an erase.
// s_ram_head is the index the NEXT record will be written to (i.e. the
// OLDEST live entry once the ring has wrapped at least once).
static cat_log_entry_t *s_ram_ring = NULL;
static size_t s_ram_count = 0; // how many of CAT_LOG_CAPACITY slots hold a real record so far (caps at CAT_LOG_CAPACITY)
static size_t s_ram_head = 0;

static uint8_t compute_crc(const cat_log_record_t *rec) {
    const uint8_t *p = (const uint8_t *)rec;
    uint8_t sum = 0;
    // Every byte up to (not including) the crc field itself — NOT
    // `sizeof(*rec) - sizeof(rec->crc)`: crc is followed by `reserved[]`,
    // so that arithmetic silently included the crc byte and most of
    // `reserved[]` while excluding only the last reserved byte. Harmless
    // at write time (crc field is still 0 when this first runs), but
    // wrong on every later recompute (e.g. recover_from_flash() at boot),
    // which is what actually surfaced this — real records on flash were
    // failing their own CRC check and getting silently discarded as
    // "torn/partial write" every single boot.
    for (size_t i = 0; i < offsetof(cat_log_record_t, crc); i++) sum = (uint8_t)(sum + p[i]);
    return sum;
}

// Appends one entry to the in-RAM ring, overwriting the oldest slot once
// full. Caller must hold s_ram_mutex.
static void ram_ring_push_locked(const cat_log_entry_t *entry) {
    s_ram_ring[s_ram_head] = *entry;
    s_ram_head = (s_ram_head + 1) % CAT_LOG_CAPACITY;
    if (s_ram_count < CAT_LOG_CAPACITY) s_ram_count++;
}

// ── Background write task ───────────────────────────────────────────────
// cat_log_append() is called from cat_bridge.c's UART reader task (timing-
// sensitive CAT protocol handling) and from the HTTP-driven client write
// path — neither should block on a flash erase (tens of ms). A small
// queue + dedicated low-priority task decouples the actual flash I/O from
// both callers.
typedef struct {
    bool from_radio;
    uint32_t uptime_ms;
    uint8_t frame_len;
    char frame[CAT_LOG_MAX_FRAME_LEN];
} pending_write_t;

#define WRITE_QUEUE_LEN 32 // generous vs. realistic CAT frame rates (a handful/sec at most) — a full queue just drops the oldest-pending write, not the log itself
static QueueHandle_t s_write_queue = NULL;

// Writes one record at s_write_offset, erasing the containing 4KB sector
// first IF this is the first record landing in that sector since it was
// last erased (tracked implicitly: we only erase when s_write_offset is
// exactly at a sector boundary — see the design comment in cat_log.h/this
// file's header for why records are laid out to make that condition exact).
static void write_record_to_flash(const pending_write_t *pw) {
    if (!s_partition) return;

    cat_log_record_t rec = {0};
    rec.magic = CAT_LOG_RECORD_MAGIC;
    rec.seq = s_next_seq++;
    rec.from_radio = pw->from_radio ? 1 : 0;
    rec.uptime_ms = pw->uptime_ms;
    rec.frame_len = pw->frame_len;
    memcpy(rec.frame, pw->frame, pw->frame_len);
    rec.crc = compute_crc(&rec);

    // Sector-boundary-aligned erase: RECORD_SIZE * records-per-sector must
    // divide evenly for this check to land exactly on boundaries — see
    // cat_log_init()'s startup assertion, which verifies this arithmetic
    // rather than trusting it silently.
    if (s_write_offset % SPI_FLASH_SEC_SIZE == 0) {
        esp_err_t err = esp_partition_erase_range(s_partition, s_write_offset, SPI_FLASH_SEC_SIZE);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "erase at offset %u failed: %s", (unsigned)s_write_offset, esp_err_to_name(err));
            return; // don't advance the write pointer on a failed erase — retry the same slot next time
        }
    }

    esp_err_t err = esp_partition_write(s_partition, s_write_offset, &rec, sizeof(rec));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "write at offset %u failed: %s", (unsigned)s_write_offset, esp_err_to_name(err));
        return;
    }

    s_write_offset += sizeof(rec);
    if (s_write_offset + sizeof(rec) > s_partition->size) s_write_offset = 0; // wrap
}

static void cat_log_task(void *arg) {
    pending_write_t pw;
    for (;;) {
        if (xQueueReceive(s_write_queue, &pw, portMAX_DELAY) == pdTRUE) {
            write_record_to_flash(&pw);
        }
    }
}

void cat_log_append(bool from_radio, const char *frame, size_t frame_len) {
    if (!s_partition || !s_write_queue) return; // init failed/never ran — logging is a no-op, not a crash

    pending_write_t pw = {0};
    pw.from_radio = from_radio;
    pw.uptime_ms = (uint32_t)(esp_timer_get_time() / 1000);
    pw.frame_len = (uint8_t)(frame_len > CAT_LOG_MAX_FRAME_LEN ? CAT_LOG_MAX_FRAME_LEN : frame_len);
    memcpy(pw.frame, frame, pw.frame_len);

    // Update the RAM shadow immediately (so a GET /cat-log right after this
    // call sees it even before the background task has actually flushed it
    // to flash) — the two copies (RAM shadow, flash) are allowed to be
    // briefly inconsistent; RAM is the one callers read from, flash is
    // purely for surviving a reboot.
    cat_log_entry_t entry = {
        .from_radio = from_radio,
        .uptime_ms_at_log = pw.uptime_ms,
    };
    memcpy(entry.frame, pw.frame, pw.frame_len);
    entry.frame[pw.frame_len] = '\0';

    xSemaphoreTake(s_ram_mutex, portMAX_DELAY);
    ram_ring_push_locked(&entry);
    xSemaphoreGive(s_ram_mutex);

    // Non-blocking send — if the queue is somehow full (background task
    // wedged, or a genuinely pathological CAT frame rate), drop this ONE
    // flash write rather than block the caller. The RAM shadow above still
    // has it for the current session; only cross-reboot persistence of
    // this one entry is lost.
    if (xQueueSend(s_write_queue, &pw, 0) != pdTRUE) {
        ESP_LOGW(TAG, "write queue full — dropping one flash write (RAM log unaffected)");
    }
}

size_t cat_log_read_recent(cat_log_entry_t *out, size_t max_entries) {
    if (!s_ram_mutex) return 0;
    xSemaphoreTake(s_ram_mutex, portMAX_DELAY);
    size_t n = s_ram_count < max_entries ? s_ram_count : max_entries;
    // Oldest-first: if the ring hasn't wrapped yet (s_ram_count <
    // CAT_LOG_CAPACITY), the oldest entry is simply index 0. Once wrapped,
    // the oldest live entry is at s_ram_head (the slot about to be
    // overwritten next).
    size_t start = (s_ram_count < CAT_LOG_CAPACITY) ? 0 : s_ram_head;
    for (size_t i = 0; i < n; i++) {
        out[i] = s_ram_ring[(start + i) % CAT_LOG_CAPACITY];
    }
    xSemaphoreGive(s_ram_mutex);
    return n;
}

bool cat_log_clear(void) {
    if (!s_partition) return false;
    esp_err_t err = esp_partition_erase_range(s_partition, 0, s_partition->size);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "clear (erase whole partition) failed: %s", esp_err_to_name(err));
        return false;
    }
    s_write_offset = 0;
    // Deliberately does NOT reset s_next_seq to 0 — sequence numbers stay
    // monotonic across the partition's whole lifetime (including through a
    // clear), so a stale record ever misread after a future wrap can't be
    // confused with a genuinely newer one just because both happened to
    // read as "seq 0" after two different clears.
    if (s_ram_mutex) {
        xSemaphoreTake(s_ram_mutex, portMAX_DELAY);
        s_ram_count = 0;
        s_ram_head = 0;
        xSemaphoreGive(s_ram_mutex);
    }
    ESP_LOGI(TAG, "cleared persisted CAT log");
    return true;
}

// Scans the ENTIRE partition once at boot to recover: (a) the true next-
// write offset, (b) the true next sequence number, and (c) reconstructs
// the RAM shadow from whatever was already on flash — so a reboot doesn't
// present an empty log even though the whole point of this feature is
// surviving reboots. Deliberately does not trust a separately-stored
// "here's the write pointer" value (there isn't one) — scanning for the
// highest seq is crash-safe in a way a cached pointer wouldn't be if the
// device lost power mid-write.
static void recover_from_flash(void) {
    size_t n_records = s_partition->size / sizeof(cat_log_record_t);
    cat_log_record_t rec;
    uint32_t best_seq = 0;
    size_t best_offset = 0; // offset of the record with the highest seq, i.e. the most recently written one
    bool found_any = false;

    // Records temporarily collected here (in seq order via a two-pass scan
    // below) so the RAM ring ends up correctly ordered oldest-first,
    // matching cat_log_read_recent()'s contract — a single left-to-right
    // pass over the raw partition bytes is NOT in chronological order once
    // the ring has wrapped (the physically-first record in the partition
    // could be either the oldest or the newest, depending on where the
    // write pointer currently sits).
    for (size_t i = 0; i < n_records; i++) {
        // Real hardware bug, caught after the RAM ring filled up during
        // extended testing: this scan (n_records is in the low thousands
        // — 8192 at this partition/record size) has no yield point at
        // all, so esp_partition_read()'s real SPI flash transactions,
        // back-to-back with nothing else running, starved the IDLE0 task's
        // watchdog long enough to trip CONFIG_ESP_TASK_WDT_PANIC and
        // reboot before boot ever finished — a genuine crash-loop
        // reproduced 100% of the time once the log had enough records to
        // push this scan close enough to the 5s watchdog timeout.
        if ((i & 0xFF) == 0) vTaskDelay(1);
        size_t offset = i * sizeof(cat_log_record_t);
        if (esp_partition_read(s_partition, offset, &rec, sizeof(rec)) != ESP_OK) continue;
        if (rec.magic != CAT_LOG_RECORD_MAGIC) continue;
        if (compute_crc(&rec) != rec.crc) continue; // torn/partial write from a crash mid-record — skip it
        // Unsigned-subtraction comparison that tolerates ONE wraparound of
        // the uint32_t seq counter (won't happen in practice at any
        // realistic CAT frame rate within a device's service life, but
        // cheap to guard anyway): (rec.seq - best_seq), interpreted as
        // unsigned, is small/positive if rec.seq is "ahead" of best_seq
        // (even across a wrap) and huge/near-UINT32_MAX if rec.seq is
        // "behind" it.
        if (!found_any || (uint32_t)(rec.seq - best_seq) < 0x80000000u) {
            best_seq = rec.seq;
            best_offset = offset;
        }
        found_any = true;
    }

    if (!found_any) {
        ESP_LOGI(TAG, "no existing CAT log found on flash (first boot, or partition was cleared)");
        s_next_seq = 0;
        s_write_offset = 0;
        return;
    }

    s_next_seq = best_seq + 1;
    s_write_offset = best_offset + sizeof(cat_log_record_t);
    if (s_write_offset + sizeof(cat_log_record_t) > s_partition->size) s_write_offset = 0;

    // Second pass: collect valid records into a fixed CAT_LOG_CAPACITY-
    // sized window, kept sorted ascending by seq (oldest first) at all
    // times, and pushed into the RAM ring at the end. NOT sized to
    // n_records — the partition is deliberately oversized relative to the
    // live data it needs to hold (see this file's header comment on flash
    // wear), so n_records (in the low thousands) massively overshoots what
    // the RAM shadow actually keeps (CAT_LOG_CAPACITY — see cat_log.h for
    // its current value and the real-hardware memory-pressure incident
    // that sized it down from 1000) — allocating n_records here was the
    // previous bug: it tried to malloc the entire partition's worth of
    // records (512KB) on top of the already-allocated RAM ring, which
    // reliably failed. Once the window is full, a new
    // record only displaces the current OLDEST kept record if the new one
    // is actually newer (per the same wraparound-tolerant seq comparison
    // used above) — otherwise it's discarded, since it's older than
    // everything already being kept.
    // PSRAM: one-time boot-time scratch, freed immediately after this scan
    // — this exact allocation is the one that historically collided with
    // MALLOC_CAP_DMA availability for 96kHz I/Q mode (see cat_log.h and
    // the README's Known Limitations entry); moving it off internal RAM
    // removes that collision at its actual source, no runtime task ever
    // touches this buffer, and a one-time few-KB-per-access PSRAM latency
    // cost during a boot-time scan is immaterial.
    cat_log_record_t *valid = heap_caps_malloc(CAT_LOG_CAPACITY * sizeof(cat_log_record_t), MALLOC_CAP_SPIRAM);
    if (!valid) {
        ESP_LOGW(TAG, "recover_from_flash: malloc failed, RAM log will start empty this boot (flash content is unaffected)");
        return;
    }
    size_t valid_count = 0;
    for (size_t i = 0; i < n_records; i++) {
        if ((i & 0xFF) == 0) vTaskDelay(1); // see the identical yield in the first pass above — same watchdog-starvation reasoning
        size_t offset = i * sizeof(cat_log_record_t);
        if (esp_partition_read(s_partition, offset, &rec, sizeof(rec)) != ESP_OK) continue;
        if (rec.magic != CAT_LOG_RECORD_MAGIC) continue;
        if (compute_crc(&rec) != rec.crc) continue;

        if (valid_count < CAT_LOG_CAPACITY) {
            // Insert into the sorted window (ascending by seq).
            size_t j = valid_count++;
            while (j > 0 && valid[j - 1].seq > rec.seq) {
                valid[j] = valid[j - 1];
                j--;
            }
            valid[j] = rec;
        } else if ((uint32_t)(rec.seq - valid[0].seq) < 0x80000000u) {
            // Newer than the current oldest kept record — evict index 0
            // (shift left) and insert rec in its sorted position.
            size_t j = 0;
            while (j + 1 < CAT_LOG_CAPACITY && valid[j + 1].seq < rec.seq) {
                valid[j] = valid[j + 1];
                j++;
            }
            valid[j] = rec;
        }
        // else: older than everything already kept — discard.
    }

    xSemaphoreTake(s_ram_mutex, portMAX_DELAY);
    for (size_t i = 0; i < valid_count; i++) {
        cat_log_entry_t entry = {
            .from_radio = valid[i].from_radio != 0,
            .uptime_ms_at_log = valid[i].uptime_ms,
        };
        size_t len = valid[i].frame_len;
        if (len > sizeof(entry.frame) - 1) len = sizeof(entry.frame) - 1;
        memcpy(entry.frame, valid[i].frame, len);
        entry.frame[len] = '\0';
        ram_ring_push_locked(&entry);
    }
    xSemaphoreGive(s_ram_mutex);
    free(valid);

    ESP_LOGI(TAG, "recovered %u CAT log record(s) from flash (next seq=%u, next write offset=%u)",
             (unsigned)valid_count, (unsigned)s_next_seq, (unsigned)s_write_offset);
}

void cat_log_init(void) {
    // Debug feature, defaults OFF — see bridge_settings_get_cat_log_enabled()'s
    // doc comment for why (this scan's own growth caused a real boot
    // crash-loop once the log had enough records). s_partition stays NULL,
    // so every other cat_log_* call is already a safe no-op via their own
    // existing "!s_partition" guards — no separate enabled flag needed
    // elsewhere in this file.
    if (!bridge_settings_get_cat_log_enabled()) {
        ESP_LOGI(TAG, "persistent CAT log disabled (see POST /cat-log-enable to turn it on)");
        return;
    }

    s_partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "catlog");
    if (!s_partition) {
        ESP_LOGW(TAG, "catlog partition not found — persistent CAT log disabled (check partitions.csv)");
        return;
    }
    if (s_partition->size % SPI_FLASH_SEC_SIZE != 0) {
        ESP_LOGW(TAG, "catlog partition size (%u) isn't sector-aligned — persistent CAT log disabled",
                 (unsigned)s_partition->size);
        s_partition = NULL;
        return;
    }

    s_ram_mutex = xSemaphoreCreateMutex();
    // PSRAM, not internal RAM — this is a one-shot ~13KB boot-time
    // allocation (CAT_LOG_CAPACITY * sizeof(cat_log_entry_t)), touched at
    // most once per CAT frame (tens of ms apart, nowhere near the audio
    // pipeline's real-time budget) and bulk-read only on the rare, operator-
    // triggered GET /cat-log. Internal RAM is the genuinely scarce resource
    // on this board (lwIP's per-connection TCP buffers alone are a fixed,
    // non-relocatable cost — see bridge_config.h's WS_MAX_CLIENTS/
    // AUDIO_WS_MAX_CLIENTS comments), so anything without a tight real-time
    // access pattern should free up that headroom rather than compete for
    // it. NOT the same tradeoff as audio_monitor.c's upsample scratch
    // buffer (see that file's own comment) — that one is reallocated fresh
    // every ~50ms inside a real-time audio path, where PSRAM's added
    // per-access latency was confirmed to make things worse; this ring is
    // allocated once and never touched at anything close to that rate.
    s_ram_ring = heap_caps_malloc(sizeof(cat_log_entry_t) * CAT_LOG_CAPACITY, MALLOC_CAP_SPIRAM);
    if (!s_ram_ring) {
        ESP_LOGE(TAG, "malloc for RAM log shadow failed — persistent CAT log disabled");
        s_partition = NULL;
        return;
    }

    recover_from_flash();

    s_write_queue = xQueueCreate(WRITE_QUEUE_LEN, sizeof(pending_write_t));
    // Low priority + small stack: this task only ever does
    // esp_partition_erase_range()/esp_partition_write() calls, which block
    // internally on the SPI flash driver anyway — no benefit to running it
    // at a priority that could contend with CAT/audio timing.
    xTaskCreate(cat_log_task, "cat_log", 3072, NULL, tskIDLE_PRIORITY + 1, NULL);

    ESP_LOGI(TAG, "persistent CAT log ready (partition size %u KB, %d records/sector, ~%u records total capacity)",
             (unsigned)(s_partition->size / 1024), (int)(SPI_FLASH_SEC_SIZE / sizeof(cat_log_record_t)),
             (unsigned)(s_partition->size / sizeof(cat_log_record_t)));
}
