# Board-specific sources and components: the A1S drives its ES8388 through
# esp_codec_dev; the S3 board has discrete converters and an RGB status LED
# (led_strip). Keyed on IDF_TARGET, not CONFIG_BRIDGE_BOARD_*: ESP-IDF resolves
# component requirements before sdkconfig exists, and the board follows the
# target one-to-one (main/Kconfig.projbuild).
if(IDF_TARGET STREQUAL "esp32s3")
    set(board_srcs "audio_monitor_s3.c" "iq_dsp.c" "ws_fanout.c" "lcd_pcd8544.c" "lcd_gfx.c" "status_display.c")
    set(board_requires led_strip esp-dsp)
else()
    set(board_srcs "audio_monitor.c")
    set(board_requires esp_codec_dev)
endif()

idf_component_register(
    SRCS
        ${board_srcs}
        "app_main.c"
        "bridge_state.c"
        "bridge_settings.c"
        "wifi_net.c"
        "cat_bridge.c"
        "ws_server.c"
        "http_control.c"
        "io_routing.c"
        "control_page.c"
        "led_status.c"
        "audio_ws.c"
        "audio_sniff.c"
        "audio_iq.c"
        "pa_watchdog.c"
        "cpu_monitor.c"
        "cat_log.c"
        "radio_ota.c"
        "mem_bench.c"
        "aux_serial.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_wifi
        esp_netif
        esp_event
        esp_system
        nvs_flash
        driver
        mdns
        esp_http_server
        esp_timer
        freertos
        spiffs
        ${board_requires}
        esp_pm
        heap
        esp_partition
        app_update
)

# Bakes spiffs_data/ (the standalone control page's HTML/CSS/JS) into a
# SPIFFS image fitted to the "storage" partition in partitions.csv, flashed
# alongside the app under `idf.py flash`. See main/control_page.c.
spiffs_create_partition_image(storage ../spiffs_data FLASH_IN_PROJECT)
