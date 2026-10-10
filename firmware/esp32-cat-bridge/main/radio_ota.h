// Radio (uSDX BLACK_BRICK, ATmega328P) firmware update over the CAT UART.
//
// The radio carries a stock Optiboot 8 bootloader (firmware/usdxBLACKBRICK/
// bootloader/). Its app answers CAT `UG;` by jumping into that bootloader;
// this module then borrows the CAT UART exclusively (cat_bridge.h), talks the
// STK500v1 subset Optiboot implements at 38400 baud, writes the app image page
// by page, reads every page back to verify, leaves programming mode (Optiboot
// restarts the app through its watchdog) and confirms the app answers `FV;`
// at the CAT baud again. EEPROM is never touched, so the radio's settings
// survive an update.
//
// Refused while: another update runs, a TX slot is playing, the external PA
// reports energized (pa_sense), or the radio does not answer UG1; (keyed, or
// firmware without UG). Recovery from an update that dies mid-write is ISP.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RADIO_OTA_APP_MAX_BYTES 32256u  // 32 KiB minus the 512-byte boot section

typedef enum {
    RADIO_OTA_IDLE = 0,
    RADIO_OTA_ENTERING,    // UG; sent, waiting for UG1;
    RADIO_OTA_SYNCING,     // STK500 sync + signature
    RADIO_OTA_WRITING,
    RADIO_OTA_VERIFYING,
    RADIO_OTA_RESTARTING,  // left programming mode, waiting for FV; from the new app
    RADIO_OTA_DONE,
    RADIO_OTA_FAILED,
} radio_ota_state_t;

typedef struct {
    radio_ota_state_t state;
    uint16_t pages_total;
    uint16_t pages_done;     // written (WRITING) or verified (VERIFYING)
    uint32_t image_bytes;
    char error[96];          // set when FAILED
    char version[16];        // FV reply after restart, e.g. "4.02c"
} radio_ota_status_t;

// Takes ownership of `image` (heap/PSRAM, freed by the module) and starts the
// update task. Returns NULL on start, or a static reason string if refused.
const char *radio_ota_start(uint8_t *image, size_t len);
void radio_ota_get_status(radio_ota_status_t *out);
const char *radio_ota_state_name(radio_ota_state_t s);
