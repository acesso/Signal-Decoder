# Lets the bootloader start on the S3 board's XMC XM25QH128A flash (see
# xmc_a_flash.c). Built only for the S3: the A1S bootloader has ~0.2 KB to spare
# and no XMC flash.
if(IDF_TARGET STREQUAL "esp32s3")
    idf_component_register(SRCS "xmc_a_flash.c" REQUIRES bootloader_support esp_rom)
    target_link_libraries(${COMPONENT_LIB} INTERFACE
        "-Wl,--wrap=bootloader_flash_xmc_startup" "-u __wrap_bootloader_flash_xmc_startup")
else()
    idf_component_register()
endif()
