// Persisted, user-changeable settings — stored in NVS, distinct from the
// compile-time defaults in bridge_config.h/Kconfig. The Kconfig values are
// the first-boot fallback; once a setting is saved here, it wins over
// Kconfig on every subsequent boot. This is what lets the web app's bridge
// panel change Wi-Fi credentials or backlight level without a reflash.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Call once from app_main, before wifi_net_start()/status_display_start()
// read anything through the getters below.
void bridge_settings_init(void);

// Wi-Fi SSID/password — falls back to CONFIG_BRIDGE_WIFI_SSID/PASSWORD
// (Kconfig) if nothing has been saved yet. out_sz is the caller's buffer
// size including room for the NUL terminator.
void bridge_settings_get_wifi(char *ssid_out, size_t ssid_sz, char *pass_out, size_t pass_sz);

// Persists new Wi-Fi credentials to NVS. Does NOT apply them or reboot —
// the caller (http_control's /wifi-config handler) is responsible for
// triggering a reboot afterward, same pattern as most consumer Wi-Fi
// devices: save, then restart to reconnect with the new network.
bool bridge_settings_set_wifi(const char *ssid, const char *password);

// LCD backlight PWM duty, 0..LCD_BACKLIGHT_MAX_DUTY. Falls back to
// LCD_BACKLIGHT_DEFAULT_DUTY if nothing has been saved yet.
uint8_t bridge_settings_get_backlight(void);

// Persists a new backlight duty to NVS AND applies it immediately (unlike
// Wi-Fi, this needs no reboot — lcd_pcd8544_set_backlight() takes effect on
// the next PWM cycle).
bool bridge_settings_set_backlight(uint8_t duty);

// PCD8544 contrast (Vop), 0..LCD_CONTRAST_MAX. Falls back to
// LCD_CONTRAST_DEFAULT_VOP if nothing has been saved yet.
uint8_t bridge_settings_get_contrast(void);

// Persists a new contrast value to NVS AND applies it immediately, same
// pattern as backlight — no reboot needed.
bool bridge_settings_set_contrast(uint8_t vop);
