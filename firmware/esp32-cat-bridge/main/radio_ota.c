#include "radio_ota.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "audio_monitor.h"
#include "bridge_settings.h"
#include "bridge_state.h"
#include "cat_bridge.h"

static const char *TAG = "radio_ota";

// Optiboot 8 build for this radio: 20 MHz, 38400 baud (bootloader/README.md) — the CAT rate, the one
// this radio->bridge RX line is proven at; 57600 replies arrived corrupted (slow rising edges).
#define BOOT_BAUD        38400
#define PAGE_BYTES       128    // ATmega328P SPM page
// STK500v1 subset Optiboot implements.
#define STK_OK           0x10
#define STK_INSYNC       0x14
#define CRC_EOP          0x20
#define STK_GET_SYNC     0x30
#define STK_ENTER_PROG   0x50
#define STK_LEAVE_PROG   0x51
#define STK_LOAD_ADDRESS 0x55
#define STK_PROG_PAGE    0x64
#define STK_READ_PAGE    0x74
#define STK_READ_SIGN    0x75
static const uint8_t SIG_ATMEGA328P[3] = { 0x1E, 0x95, 0x0F };

static SemaphoreHandle_t s_lock;
static radio_ota_status_t s_status;
static uint8_t *s_image;
static size_t s_image_len;

static void set_state(radio_ota_state_t st) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_status.state = st;
    xSemaphoreGive(s_lock);
    ESP_LOGW(TAG, "-> %s", radio_ota_state_name(st));
}

static void set_pages(uint16_t done) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_status.pages_done = done;
    xSemaphoreGive(s_lock);
}

static void fail(const char *msg) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    snprintf(s_status.error, sizeof(s_status.error), "%s", msg);
    s_status.state = RADIO_OTA_FAILED;
    xSemaphoreGive(s_lock);
    ESP_LOGE(TAG, "FAILED: %s", msg);
}

// Reads exactly `len` bytes or fails (each byte within timeout_ms).
static bool read_exact(uint8_t *buf, size_t len, int timeout_ms) {
    size_t got = 0;
    while (got < len) {
        int n = cat_bridge_raw_read(buf + got, len - got, timeout_ms);
        if (n <= 0) return false;
        got += (size_t)n;
    }
    return true;
}

// Sends a command (already ending in CRC_EOP) and expects INSYNC, `reply_len`
// payload bytes into `reply` (may be 0), then OK.
static bool stk_cmd(const uint8_t *cmd, size_t cmd_len, uint8_t *reply, size_t reply_len, int timeout_ms) {
    if (cat_bridge_raw_write(cmd, cmd_len) != (int)cmd_len) return false;
    uint8_t b;
    if (!read_exact(&b, 1, timeout_ms) || b != STK_INSYNC) return false;
    if (reply_len && !read_exact(reply, reply_len, timeout_ms)) return false;
    if (!read_exact(&b, 1, timeout_ms) || b != STK_OK) return false;
    return true;
}

static bool stk_load_address(uint32_t byte_addr) {
    uint16_t word = (uint16_t)(byte_addr >> 1);
    const uint8_t cmd[] = { STK_LOAD_ADDRESS, (uint8_t)(word & 0xFF), (uint8_t)(word >> 8), CRC_EOP };
    return stk_cmd(cmd, sizeof(cmd), NULL, 0, 300);
}

// Waits for a CAT reply frame starting with `prefix` (e.g. "UG", "FV") while
// other frames (pushed S-meter etc.) may arrive around it; copies the frame.
static bool wait_cat_frame(const char *prefix, char *frame, size_t frame_cap, int total_ms) {
    char acc[96];
    size_t n = 0;
    int waited = 0;
    while (waited < total_ms) {
        uint8_t b;
        int got = cat_bridge_raw_read(&b, 1, 20);
        if (got <= 0) { waited += 20; continue; }
        if (n < sizeof(acc) - 1) acc[n++] = (char)b;
        if (b == ';') {
            acc[n] = '\0';
            if (strncmp(acc, prefix, strlen(prefix)) == 0 || strcmp(acc, "?;") == 0) {
                snprintf(frame, frame_cap, "%s", acc);
                return true;
            }
            n = 0;  // some other frame — keep waiting
        }
    }
    return false;
}

static void ota_task(void *arg) {
    const int cat_baud = bridge_settings_get_cat_baud();
    bool any_page_written = false;
    char frame[48];

    if (!cat_bridge_acquire_exclusive()) {
        fail("could not take the CAT UART");
        goto out_free;
    }

    // 1. Ask the running app to jump into the bootloader.
    set_state(RADIO_OTA_ENTERING);
    const uint8_t ug[] = "UG;";
    cat_bridge_raw_write(ug, 3);
    if (!wait_cat_frame("UG", frame, sizeof(frame), 1000)) {
        fail("radio did not answer UG; (radio off, or CAT link down)");
        goto out_release;
    }
    if (strcmp(frame, "UG1;") != 0) {
        fail(strcmp(frame, "UG0;") == 0 ? "radio refused UG; (it is keyed) — un-key and retry"
                                         : "radio firmware has no UG; (needs the bootloader-capable build, flashed once over ISP)");
        goto out_release;
    }

    // 2. Bootloader sync at its own baud, then confirm the chip.
    set_state(RADIO_OTA_SYNCING);
    vTaskDelay(pdMS_TO_TICKS(30));  // UG1; is flushed before the jump; give the bootloader time to set up its UART
    cat_bridge_raw_set_baud(BOOT_BAUD);
    bool synced = false;
    char seen[40] = "";  // raw bytes seen during failed sync attempts (diagnostics)
    size_t seen_n = 0;
    for (int i = 0; i < 10 && !synced; i++) {
        const uint8_t sync[] = { STK_GET_SYNC, CRC_EOP };
        cat_bridge_raw_write(sync, sizeof(sync));
        uint8_t r[8];
        int n = cat_bridge_raw_read(r, 2, 100);
        if (n == 2 && r[0] == STK_INSYNC && r[1] == STK_OK) { synced = true; break; }
        for (int k = 0; k < n && seen_n + 3 < sizeof(seen); k++) seen_n += (size_t)snprintf(seen + seen_n, sizeof(seen) - seen_n, "%02X ", r[k]);
        n = cat_bridge_raw_read(r, sizeof(r), 20);  // drain stragglers
        for (int k = 0; k < n && seen_n + 3 < sizeof(seen); k++) seen_n += (size_t)snprintf(seen + seen_n, sizeof(seen) - seen_n, "%02X ", r[k]);
    }
    if (!synced) {
        char m[96];
        snprintf(m, sizeof(m), "no bootloader sync at 38400 (rx: %s) — app unchanged", seen_n ? seen : "nothing");
        fail(m);
        goto out_restore;
    }
    uint8_t sig[3];
    const uint8_t rsig[] = { STK_READ_SIGN, CRC_EOP };
    if (!stk_cmd(rsig, sizeof(rsig), sig, 3, 300) || memcmp(sig, SIG_ATMEGA328P, 3) != 0) {
        fail("unexpected chip signature — not an ATmega328P, nothing written");
        goto out_leave;
    }
    const uint8_t enter[] = { STK_ENTER_PROG, CRC_EOP };
    if (!stk_cmd(enter, sizeof(enter), NULL, 0, 300)) { fail("bootloader did not enter programming mode — nothing written"); goto out_leave; }

    // 3. Write every page (the last one padded with 0xFF, as erased flash reads).
    set_state(RADIO_OTA_WRITING);
    const uint16_t pages = (uint16_t)((s_image_len + PAGE_BYTES - 1) / PAGE_BYTES);
    uint8_t page[PAGE_BYTES];
    for (uint16_t p = 0; p < pages; p++) {
        uint32_t addr = (uint32_t)p * PAGE_BYTES;
        size_t n = s_image_len - addr < PAGE_BYTES ? s_image_len - addr : PAGE_BYTES;
        memset(page, 0xFF, sizeof(page));
        memcpy(page, s_image + addr, n);
        uint8_t cmd[4 + PAGE_BYTES + 1];
        cmd[0] = STK_PROG_PAGE; cmd[1] = 0; cmd[2] = PAGE_BYTES; cmd[3] = 'F';
        memcpy(cmd + 4, page, PAGE_BYTES);
        cmd[4 + PAGE_BYTES] = CRC_EOP;
        if (!stk_load_address(addr) || !stk_cmd(cmd, sizeof(cmd), NULL, 0, 500)) {
            char m[96];
            snprintf(m, sizeof(m), "write failed at page %u/%u — APP IS INCOMPLETE, recover over ISP", p + 1, pages);
            fail(m);
            goto out_leave;
        }
        any_page_written = true;
        set_pages(p + 1);
    }

    // 4. Read every page back and compare.
    set_state(RADIO_OTA_VERIFYING);
    set_pages(0);
    for (uint16_t p = 0; p < pages; p++) {
        uint32_t addr = (uint32_t)p * PAGE_BYTES;
        size_t n = s_image_len - addr < PAGE_BYTES ? s_image_len - addr : PAGE_BYTES;
        uint8_t back[PAGE_BYTES];
        const uint8_t rd[] = { STK_READ_PAGE, 0, PAGE_BYTES, 'F', CRC_EOP };
        if (!stk_load_address(addr) || !stk_cmd(rd, sizeof(rd), back, PAGE_BYTES, 500)) {
            fail("read-back failed during verify — app state unknown, recover over ISP if it does not start");
            goto out_leave;
        }
        if (memcmp(back, s_image + addr, n) != 0) {
            char m[96];
            snprintf(m, sizeof(m), "verify mismatch at page %u/%u — APP IS CORRUPT, recover over ISP", p + 1, pages);
            fail(m);
            goto out_leave;
        }
        set_pages(p + 1);
    }

    // 5. Leave programming mode: Optiboot arms a 16 ms watchdog and the new app starts.
    set_state(RADIO_OTA_RESTARTING);
out_leave: {
        const uint8_t leave[] = { STK_LEAVE_PROG, CRC_EOP };
        stk_cmd(leave, sizeof(leave), NULL, 0, 300);  // best effort on the failure paths too
    }
out_restore:
    cat_bridge_raw_set_baud(cat_baud);
    if (s_status.state == RADIO_OTA_RESTARTING || (s_status.state == RADIO_OTA_FAILED && !any_page_written)) {
        // Confirm the app is running again (new or untouched old one).
        bool alive = false;
        vTaskDelay(pdMS_TO_TICKS(800));  // app setup: LCD, Si5351, EEPROM load
        for (int i = 0; i < 16 && !alive; i++) {
            const uint8_t fv[] = "FV;";
            cat_bridge_raw_write(fv, 3);
            alive = wait_cat_frame("FV", frame, sizeof(frame), 500) && strncmp(frame, "FV", 2) == 0;
        }
        if (s_status.state == RADIO_OTA_RESTARTING) {
            if (alive) {
                xSemaphoreTake(s_lock, portMAX_DELAY);
                size_t L = strlen(frame);
                snprintf(s_status.version, sizeof(s_status.version), "%.*s", (int)(L > 3 ? L - 3 : 0), frame + 2);
                xSemaphoreGive(s_lock);
                set_state(RADIO_OTA_DONE);
            } else {
                fail("written and verified, but the radio did not answer FV; afterwards — power-cycle it");
            }
        }
    }
out_release:
    cat_bridge_release_exclusive();
out_free:
    free(s_image);
    s_image = NULL;
    vTaskDelete(NULL);
}

const char *radio_ota_start(uint8_t *image, size_t len) {
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    radio_ota_status_t st;
    radio_ota_get_status(&st);
    if (st.state != RADIO_OTA_IDLE && st.state != RADIO_OTA_DONE && st.state != RADIO_OTA_FAILED) { free(image); return "a radio update is already running"; }
    if (len == 0 || len > RADIO_OTA_APP_MAX_BYTES) { free(image); return "image size out of range (1..32256 bytes)"; }
    // AVR reset vector must be a JMP (0x940C, little-endian 0C 94) — cheap guard against a wrong file.
    if (len < 4 || image[0] != 0x0C || image[1] != 0x94) { free(image); return "not an ATmega328P app image (reset vector is not a JMP)"; }
    audio_monitor_tx_status_t tx;
    audio_monitor_tx_get_status(&tx);
    if (tx.playing) { free(image); return "a TX slot is playing — stop it first"; }
    bridge_state_t bs;
    bridge_state_get(&bs);
    if (bs.pa_sense) { free(image); return "the external PA reports energized (pa_sense) — power it off / un-key first"; }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    memset(&s_status, 0, sizeof(s_status));
    s_status.state = RADIO_OTA_ENTERING;
    s_status.image_bytes = (uint32_t)len;
    s_status.pages_total = (uint16_t)((len + PAGE_BYTES - 1) / PAGE_BYTES);
    xSemaphoreGive(s_lock);
    s_image = image;
    s_image_len = len;
    if (xTaskCreate(ota_task, "radio_ota", 4096, NULL, 5, NULL) != pdPASS) {
        free(image);
        s_image = NULL;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_status.state = RADIO_OTA_IDLE;
        xSemaphoreGive(s_lock);
        return "could not start the update task";
    }
    return NULL;
}

void radio_ota_get_status(radio_ota_status_t *out) {
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_status;
    xSemaphoreGive(s_lock);
}

const char *radio_ota_state_name(radio_ota_state_t s) {
    switch (s) {
    case RADIO_OTA_IDLE: return "idle";
    case RADIO_OTA_ENTERING: return "entering";
    case RADIO_OTA_SYNCING: return "syncing";
    case RADIO_OTA_WRITING: return "writing";
    case RADIO_OTA_VERIFYING: return "verifying";
    case RADIO_OTA_RESTARTING: return "restarting";
    case RADIO_OTA_DONE: return "done";
    case RADIO_OTA_FAILED: return "failed";
    }
    return "?";
}
