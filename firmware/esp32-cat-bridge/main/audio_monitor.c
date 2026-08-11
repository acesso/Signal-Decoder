#include "audio_monitor.h"

#include <math.h>
#include <stdatomic.h>
#include <string.h>

#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bridge_config.h"
#include "led_status.h"

static const char *TAG = "audio_monitor";

// Read in ~50ms windows — fine RMS resolution for a status LED (not audio
// quality), matches led_status's own 50ms tick so every read produces a
// fresh brightness update with no wasted work.
#define READ_SAMPLES 800 // 16000 Hz * 0.05s

static esp_codec_dev_handle_t s_codec_dev = NULL;

// Last computed "in" LED level, shared between audio_task (the sole
// writer) and audio_monitor_report_out_samples() (a reader, so it can push
// a combined {in, out} pair to led_status_set_audio_levels() without
// clobbering whatever audio_task last measured for "in"). Plain atomic,
// not a lock — a one-tick-stale read here is invisible on a status LED.
static _Atomic uint8_t s_last_in_level = 0;

// Maps a 16-bit PCM RMS value to an LED brightness curve. Linear RMS->duty
// would make the LED look "always half-on" for typical speech/audio levels
// (most real audio sits well below full-scale) — sqrt compresses the low
// end so quiet-but-present signals are still visibly brighter than silence,
// same idea as a VU meter's non-linear scale.
static uint8_t rms_to_led_level(float rms) {
    float normalized = rms / 32768.0f;
    if (normalized > 1.0f) normalized = 1.0f;
    float compressed = sqrtf(normalized);
    return (uint8_t)(compressed * 255.0f);
}

static float compute_rms(const int16_t *samples, size_t count) {
    if (count == 0) return 0.0f;
    double sum_sq = 0.0;
    for (size_t i = 0; i < count; i++) {
        sum_sq += (double)samples[i] * (double)samples[i];
    }
    return (float)sqrt(sum_sq / (double)count);
}

void audio_monitor_report_out_samples(const int16_t *samples, size_t count) {
    float rms = compute_rms(samples, count);
    led_status_set_audio_levels(atomic_load(&s_last_in_level), rms_to_led_level(rms));
}

static void audio_task(void *arg) {
    int16_t *buf = malloc(READ_SAMPLES * sizeof(int16_t));
    if (!buf) {
        ESP_LOGE(TAG, "failed to allocate read buffer, audio monitor disabled");
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        int ret = esp_codec_dev_read(s_codec_dev, buf, READ_SAMPLES * sizeof(int16_t));
        if (ret != ESP_CODEC_DEV_OK) {
            ESP_LOGW(TAG, "codec read failed (%d), retrying", ret);
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        float rms = compute_rms(buf, READ_SAMPLES);
        uint8_t level = rms_to_led_level(rms);
        atomic_store(&s_last_in_level, level);
        // "out" is fed exclusively by audio_monitor_report_out_samples()
        // (nothing calls it yet — see audio_monitor.h) — reads back 0 here
        // until that exists, so the out LED just stays off, which is
        // correct: there's genuinely no audio-out signal to show yet.
        led_status_set_audio_levels(level, 0);
    }
}

void audio_monitor_start(void) {
    i2c_master_bus_config_t i2c_bus_cfg = {
        .i2c_port = ES8388_I2C_PORT,
        .sda_io_num = ES8388_I2C_SDA_PIN,
        .scl_io_num = ES8388_I2C_SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus;
    esp_err_t err = i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_new_master_bus failed: %s — audio monitor disabled", esp_err_to_name(err));
        return;
    }

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(ES8388_I2S_PORT,
        ES8388_MASTER_MODE ? I2S_ROLE_MASTER : I2S_ROLE_SLAVE);
    i2s_chan_handle_t tx_handle, rx_handle;
    err = i2s_new_channel(&chan_cfg, &tx_handle, &rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel failed: %s — audio monitor disabled", esp_err_to_name(err));
        return;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(ES8388_SAMPLE_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = ES8388_I2S_MCLK_PIN,
            .bclk = ES8388_I2S_BCLK_PIN,
            .ws = ES8388_I2S_WS_PIN,
            .dout = ES8388_I2S_DOUT_PIN,
            .din = ES8388_I2S_DIN_PIN,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx_handle, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    ESP_ERROR_CHECK(i2s_channel_enable(rx_handle));

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = ES8388_I2C_PORT,
        .addr = ES8388_I2C_ADDR,
        .bus_handle = i2c_bus,
    };
    const audio_codec_ctrl_if_t *ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);

    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = ES8388_I2S_PORT,
        .rx_handle = rx_handle,
        .tx_handle = tx_handle,
    };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();

    es8388_codec_cfg_t es8388_cfg = {
        .ctrl_if = ctrl_if,
        .gpio_if = gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH,
        .master_mode = ES8388_MASTER_MODE,
        .pa_pin = ES8388_PA_ENABLE_PIN,
        .pa_reverted = ES8388_PA_REVERTED,
    };
    const audio_codec_if_t *codec_if = es8388_codec_new(&es8388_cfg);
    if (!codec_if) {
        ESP_LOGE(TAG, "es8388_codec_new failed — check I2C wiring/address, audio monitor disabled");
        return;
    }

    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT,
        .codec_if = codec_if,
        .data_if = data_if,
    };
    s_codec_dev = esp_codec_dev_new(&dev_cfg);
    if (!s_codec_dev) {
        ESP_LOGE(TAG, "esp_codec_dev_new failed — audio monitor disabled");
        return;
    }

    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = 16,
        .channel = 1,
        .sample_rate = ES8388_SAMPLE_RATE_HZ,
    };
    int ret = esp_codec_dev_open(s_codec_dev, &fs);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "esp_codec_dev_open failed (%d) — audio monitor disabled", ret);
        return;
    }

    xTaskCreate(audio_task, "audio_monitor", 4096, NULL, tskIDLE_PRIORITY + 3, NULL);
    ESP_LOGI(TAG, "ES8388 audio monitor started (in=ADC, out=idle until a playback feature feeds it)");
}
