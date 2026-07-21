// Periodic LCD status task: Wi-Fi link, IP, WebSocket client state, and a
// CAT activity heartbeat, so the bridge is debuggable without a serial
// monitor once it's deployed next to the radio.
#pragma once

// Initializes the PCD8544 and spawns the refresh task, pinned to
// STATUS_DISPLAY_TASK_CORE. Call after lcd wiring is confirmed present —
// this does not fail gracefully if the panel isn't connected (SPI writes
// just go nowhere), so it's safe to call unconditionally.
void status_display_start(void);
