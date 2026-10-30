// Stand-in for ESP-IDF's header, so lcd_gfx.c builds on the host.
#pragma once
#include <stdlib.h>
#define MALLOC_CAP_SPIRAM 0
static inline void *heap_caps_calloc(size_t n, size_t size, int caps) { (void)caps; return calloc(n, size); }
