# Bootloader: Optiboot 8.0 for the uSDX BLACK_BRICK

`optiboot8_atmega328p_20MHz_38400.hex` is stock Optiboot 8.0, unmodified source,
built for this radio's 20 MHz crystal. Burned once over ISP; after that the app is
updated over the CAT UART (through the ESP32 bridge) without touching EEPROM.

- Source: https://github.com/Optiboot/optiboot, tag `v8.0` (commit f3308fc)
- Build: `make atmega328 AVR_FREQ=20000000L BAUD_RATE=38400 LED_START_FLASHES=0`
  (avr-gcc 15.2.0) → 472 bytes at 0x7E00, inside the 512-byte boot section.
- Baud: 38400 requested, 38461 real (UBRR 64, U2X), +0.16 % — the radio's CAT rate.
  57600 was tried first: the bootloader understood every command, but its replies
  reached the bridge as `00 F8` instead of `14 10` — the radio->bridge RX line's
  slow rising edges (weak pull-up behind the level shifter, see the bridge README)
  can't carry 17 µs bits. 38400 is what that line already carries all day.
- `LED_START_FLASHES=0`: stock Optiboot blinks an LED on PB5, which on the uSDX is
  the DIT/PTT input. With all LED options off the bootloader never touches port B
  (checked in the listing: no DDRB/PORTB/PINB access), so KEY_OUT, NTX and the RX
  relay keep whatever state the app left them in when it jumps here.
- Entry: Optiboot 8 runs the bootloader when MCUSR is 0 (an application request:
  the app clears MCUSR and jumps to 0x7E00) or on an external reset. Power-on,
  brown-out and watchdog resets start the app directly, so normal boots are not
  delayed. Timeout: 1 s between bytes (stock, no build option in v8.0).
- Recovery from a failed update: ISP only (decided 2026-10-10).
