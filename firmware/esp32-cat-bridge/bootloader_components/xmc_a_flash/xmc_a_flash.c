// The board's 16 MB flash is an XMC XM25QH128A (JEDEC ID 20 70 18). ESP-IDF
// 5.3.2's bootloader runs XMC's start-up flow on every XMC chip and then only
// accepts the IDs on its own list (the C series), so this A-series part makes
// it refuse to boot ("XMC flash startup fail"), although the chip reads and
// writes normally. Exactly this ID skips the flow; every other chip keeps
// ESP-IDF's own handling.
#include <stdint.h>
#include "esp_err.h"
#include "esp_log.h"
#include "esp_rom_spiflash.h"

#define XM25QH128A_ID 0x207018u

static const char *TAG = "xmc_a";

esp_err_t __real_bootloader_flash_xmc_startup(void);

esp_err_t __wrap_bootloader_flash_xmc_startup(void)
{
    if (g_rom_flashchip.device_id == XM25QH128A_ID) {
        ESP_EARLY_LOGI(TAG, "XM25QH128A (%06x): skipping the XMC C-series start-up flow", (unsigned)XM25QH128A_ID);
        return ESP_OK;
    }
    return __real_bootloader_flash_xmc_startup();
}
