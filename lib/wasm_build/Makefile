# WASM build for ft8_lib using Emscripten
#
# Run from the project root (Signal-Decoder/):
#
#   docker run --rm \
#     -v "$(pwd):/src" \
#     -w /src/lib/wasm_build \
#     emscripten/emsdk \
#     make
#
# Output lands in public/wasm/ft8.{js,wasm}.

FT8_LIB = ../ft8_lib

FT8_SRC = \
    $(FT8_LIB)/ft8/decode.c \
    $(FT8_LIB)/ft8/encode.c \
    $(FT8_LIB)/ft8/ldpc.c \
    $(FT8_LIB)/ft8/crc.c \
    $(FT8_LIB)/ft8/message.c \
    $(FT8_LIB)/ft8/text.c \
    $(FT8_LIB)/ft8/constants.c \
    $(FT8_LIB)/common/monitor.c \
    $(FT8_LIB)/fft/kiss_fft.c \
    $(FT8_LIB)/fft/kiss_fftr.c

WRAPPER = ft8_wasm.c

OUT_DIR  = ../../public/wasm
OUT_JS   = $(OUT_DIR)/ft8.js
OUT_WASM = $(OUT_DIR)/ft8.wasm

EMCC_FLAGS = \
    -O3 \
    -DHAVE_STPCPY \
    -I$(FT8_LIB) \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_ft8_decode","_ft8_free_result","_ft8_init","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPF32","HEAP8","HEAPU8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s ENVIRONMENT='web,worker' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='createFT8Module' \
    -s SINGLE_FILE=0 \
    --no-entry \
    -lm

.PHONY: all clean

all: $(OUT_JS)

$(OUT_JS): $(FT8_SRC) $(WRAPPER)
	mkdir -p $(OUT_DIR)
	emcc $(EMCC_FLAGS) $(FT8_SRC) $(WRAPPER) -o $(OUT_JS)
	@echo "WASM build complete: $(OUT_JS) + $(OUT_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM)
