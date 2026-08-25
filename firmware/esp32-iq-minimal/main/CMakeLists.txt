idf_component_register(
    SRCS
        "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_wifi
        esp_netif
        esp_event
        esp_system
        nvs_flash
        driver
        esp_http_server
        esp_timer
        freertos
        esp_codec_dev
        heap
)
