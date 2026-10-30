// PCD8544 driver — see lcd_pcd8544.h.
#include "lcd_pcd8544.h"

#include "bridge_config.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "lcd";

#define LCD_SPI_HZ   4000000   // the controller's limit
#define BL_TIMER     LEDC_TIMER_1      // LEDC_TIMER_0/CHANNEL_0 belong to led_status on the A1S
#define BL_CHANNEL   LEDC_CHANNEL_1
#define BL_BITS      LEDC_TIMER_10_BIT

// Commands (basic set unless noted).
#define CMD_FUNCTION      0x20  // | 0x01 = extended set
#define CMD_DISPLAY_NORM  0x0C
#define CMD_DISPLAY_INV   0x0D
#define CMD_SET_Y         0x40
#define CMD_SET_X         0x80
#define CMD_EXT_TEMP      0x04  // extended: temperature coefficient
#define CMD_EXT_BIAS      0x10  // extended: bias system
#define CMD_EXT_VOP       0x80  // extended: operating voltage (contrast)

static spi_device_handle_t s_dev;

// No DMA (internal RAM is scarce on this board, and a frame is only 504
// bytes): the CPU feeds the SPI FIFO, LCD_SPI_CHUNK bytes at a time.
#define LCD_SPI_CHUNK 64

static void send(bool data, const uint8_t *buf, size_t len) {
    if (!s_dev || !len) return;
    gpio_set_level(S3_LCD_DC_PIN, data ? 1 : 0);
    for (size_t off = 0; off < len; off += LCD_SPI_CHUNK) {
        size_t n = len - off < LCD_SPI_CHUNK ? len - off : LCD_SPI_CHUNK;
        spi_transaction_t t = { .length = n * 8, .tx_buffer = buf + off };
        spi_device_polling_transmit(s_dev, &t);
    }
}

// One byte per chip-select pulse: clone controllers on these modules may act
// only on the first command of a longer transaction.
static void cmds(const uint8_t *c, size_t n) { for (size_t i = 0; i < n; i++) send(false, c + i, 1); }

void lcd_set_contrast(uint8_t vop, uint8_t bias) {
    const uint8_t c[] = { CMD_FUNCTION | 0x01, CMD_EXT_VOP | (vop & 0x7F), CMD_EXT_TEMP | 0x00,
                          CMD_EXT_BIAS | (bias & 0x07), CMD_FUNCTION };
    cmds(c, sizeof(c));
}

void lcd_set_inverted(bool inverted) {
    const uint8_t c = inverted ? CMD_DISPLAY_INV : CMD_DISPLAY_NORM;
    cmds(&c, 1);
}

void lcd_set_backlight(int pct) {
    pct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL, ((1 << BL_BITS) - 1) * pct / 100);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL);
}

void lcd_send_frame(const uint8_t *frame) {
    const uint8_t home[] = { CMD_SET_Y | 0, CMD_SET_X | 0 };
    cmds(home, sizeof(home));
    send(true, frame, LCD_FRAME_BYTES);  // the address auto-increments across all banks
}

bool lcd_init(uint8_t vop, uint8_t bias) {
    gpio_config_t io = { .pin_bit_mask = (1ULL << S3_LCD_DC_PIN) | (1ULL << S3_LCD_RST_PIN), .mode = GPIO_MODE_OUTPUT };
    gpio_config(&io);

    ledc_timer_config_t tc = { .speed_mode = LEDC_LOW_SPEED_MODE, .timer_num = BL_TIMER, .duty_resolution = BL_BITS,
                               .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK };
    ledc_channel_config_t cc = { .gpio_num = S3_LCD_LED_PIN, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = BL_CHANNEL,
                                 .timer_sel = BL_TIMER, .duty = 0 };
    if (ledc_timer_config(&tc) != ESP_OK || ledc_channel_config(&cc) != ESP_OK) ESP_LOGW(TAG, "backlight PWM unavailable");

    spi_bus_config_t bus = { .mosi_io_num = S3_LCD_DIN_PIN, .miso_io_num = -1, .sclk_io_num = S3_LCD_CLK_PIN,
                             .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = LCD_SPI_CHUNK };
    spi_device_interface_config_t dev = { .clock_speed_hz = LCD_SPI_HZ, .mode = 0, .spics_io_num = S3_LCD_CE_PIN, .queue_size = 1 };
    if (spi_bus_initialize(S3_LCD_SPI_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK ||
        spi_bus_add_device(S3_LCD_SPI_HOST, &dev, &s_dev) != ESP_OK) {
        ESP_LOGE(TAG, "SPI bus setup failed");
        s_dev = NULL;
        return false;
    }

    // Reset: low for at least 100 ns within 30 ms of power-up; a few ms is plenty.
    gpio_set_level(S3_LCD_RST_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(S3_LCD_RST_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    lcd_set_contrast(vop, bias);
    lcd_set_inverted(false);
    ESP_LOGI(TAG, "PCD8544 up (Vop %u, bias %u)", vop, bias);
    return true;
}
