---
component: ESP32-S3 dev board, DevKitC-1 layout, N16R8, two USB-C ports
image: esp32-s3-devkitc-1-n16r8-pinout.png (seller's pinout drawing), esp32-s3-devkitc-1-n16r8-board.png (seller's product photo)
role: the bridge MCU
status: partly validated (chip, flash, PSRAM, RGB LED and green TX LED measured on the user's board, 2026-10-11)
---

# ESP32-S3 dev board

## Read from the image (header order, top to bottom, USB end at the bottom)
- **Left header:** 3V3, 3V3, RST, 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, 5Vin, GND.
- **Right header:** GND, 43 (U0TXD), 44 (U0RXD), 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0 (BOOT), 45, 48, 47, 21, 20, 19, GND, GND.
- **LEDs:** WS2812 RGB on IO48; red = power, green = TX, blue = RX.
- **Product photo:**
  - The module is an **"XH-S3E" N16R8**, not an Espressif WROOM, with a PCB antenna **and an IPEX (U.FL) connector**.
  - The board silkscreen numbers the right header `… 47, 21, 20, 19, GND, GND`. It has no USB labels.
  - The voltage regulator is an AMS1117-3.3. Both USB-C ports power it.

## Validated on the board (firmware/esp32s3-probe)
- **Chip and memory:** ESP32-S3 rev v0.2, 16 MB XMC XM25QH128A flash (DIO only), 8 MB octal PSRAM.
- **LEDs:**
  - The RGB LED is on GPIO48.
  - The green LED follows GPIO43 (UART0 TX).
  - Red is always on.
  - Blue never lit, consistent with RX.

## Inferred — needs your confirmation
- **Q1, checked against the board photo:** the drawing's `USB_D+`/`USB_D-` labels on GPIO21/20 are shifted by one row. On the ESP32-S3, USB D− is GPIO19 and D+ is GPIO20, and the silkscreen only prints the numbers. 19 and 20 stay unused; 21 is free.
- **Q2:** modules with both a PCB antenna and an IPEX connector usually select one with a 0 Ω resistor or a solder bridge next to the connector. Before fitting the IPEX antenna, check which way yours is set, so the cable is actually used.

## Use in this project (`bridge_config.h`)
- **On the left header:** 4 clock in, 5/6/7 I/Q I2S, 15/16/17/18 audio I2S, 8 DAC mute, 9 PA sense, 10/11 CAT, 12/13 tuner, 14 PA emergency.
- **On the right header:** 1/2 frequency module.
- **Not usable:** 35/36/37 (PSRAM), 19/20 (USB), 43/44 (second USB port), 0/3/45/46 (strapping).
