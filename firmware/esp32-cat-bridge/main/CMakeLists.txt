idf_component_register(
    SRCS
        "app_main.c"
        "bridge_state.c"
        "bridge_settings.c"
        "wifi_net.c"
        "cat_bridge.c"
        "ws_server.c"
        "http_control.c"
        "control_page.c"
        "led_status.c"
        "audio_monitor.c"
        "audio_ws.c"
        "pa_watchdog.c"
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
        esp_codec_dev
)

# Bakes spiffs_data/ (the standalone control page's HTML/CSS/JS) into a
# SPIFFS image fitted to the "storage" partition in partitions.csv, flashed
# alongside the app under `idf.py flash`. See main/control_page.c.
spiffs_create_partition_image(storage ../spiffs_data FLASH_IN_PROJECT)
