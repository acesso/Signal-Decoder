// Generic serial lines (S3 board only): the antenna tuner and the
// frequency-sensing module (S3_PORT_PLAN.md, phase 8). Each line is a plain
// byte pipe, like /cat but with no protocol knowledge: the devices are not
// known yet, so every line runs 9600 8N1 until its baud is changed.
//
//   ws://<bridge>/serial?line=tuner|freq   bytes from the device -> BINARY frames to
//                                          every client; a client's frame -> device
//   GET  /serial-status                    {"lines":[{name,port,tx_pin,rx_pin,baud,loopback,
//                                          clients,rx_bytes,tx_bytes}, ...]}
//   POST /serial-config                    {"line":"tuner","baud":9600,"loopback":false}
//                                          baud is saved in NVS; loopback is a live
//                                          self-test (UART internal loopback, not saved)
//
// Both lines share the same controls so a later UI is written once.
#pragma once
#include <stdbool.h>
#include "esp_http_server.h"

#define AUX_SERIAL_MAX_CLIENTS 2   // per line

// Opens the UARTs and registers the three routes on the shared httpd.
// Call after ws_server_start().
void aux_serial_start(httpd_handle_t server);

// Forwarded from ws_server's close hook so a closed socket stops receiving frames.
void aux_serial_on_client_close(int sockfd);
