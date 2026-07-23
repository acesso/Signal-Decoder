# WASM builds for the FT8/FT4 decoders using Emscripten
#
# Two modules are produced:
#   ft8.{js,wasm}    — ft8_lib (kgoba): lightweight BP-only decoder, used for FT4
#   ft8mon.{js,wasm} — ft8mon (AB1HL): full LDPC+OSD+multipass-subtraction
#                      decoder, used for FT8 (much higher decode rate)
#
# Run from the project root (Signal-Decoder/):
#
#   docker run --rm \
#     -v "$(pwd):/src" \
#     -w /src/lib/wasm_build \
#     -u "$(id -u):$(id -g)" \
#     emscripten/emsdk \
#     make
#
# The first build downloads and cross-compiles FFTW 3.3.10 (needed by ft8mon);
# the result is cached under fftw-build/ so later builds are fast.

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
    -s EXPORTED_FUNCTIONS='["_ft8_decode","_ft8_free_result","_ft8_init","_ft8_heap_used","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPF32","HEAP8","HEAPU8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s ENVIRONMENT='web,worker' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='createFT8Module' \
    -s SINGLE_FILE=0 \
    --no-entry \
    -lm

# ── ft8mon (FT8: LDPC + OSD + multi-pass subtraction) ─────────────────────

FT8MON = ../ft8mon

FT8MON_SRC = \
    $(FT8MON)/ft8.cc \
    $(FT8MON)/unpack.cc \
    $(FT8MON)/osd.cc \
    $(FT8MON)/util.cc \
    $(FT8MON)/fft.cc \
    $(FT8MON)/libldpc.c

FT8MON_WRAPPER = ft8mon_wasm.cc

OUT_MON_JS   = $(OUT_DIR)/ft8mon.js
OUT_MON_WASM = $(OUT_DIR)/ft8mon.wasm

FFTW_VERSION = 3.3.10
FFTW_TARBALL = fftw-$(FFTW_VERSION).tar.gz
FFTW_URL     = https://www.fftw.org/$(FFTW_TARBALL)
FFTW_DIR     = fftw-build/fftw-$(FFTW_VERSION)
FFTW_LIB     = $(FFTW_DIR)/.libs/libfftw3.a

EMMON_FLAGS = \
    -O3 \
    -std=c++17 \
    -I$(FFTW_DIR)/api \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_ftm_decode","_ftm_set","_ftm_init","_ftm_heap_used","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPF32","HEAP8","HEAPU8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=67108864 \
    -s STACK_SIZE=8388608 \
    -s ENVIRONMENT='web,worker' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='createFT8MonModule' \
    -s SINGLE_FILE=0 \
    --no-entry \
    -lm

.PHONY: all clean clean-fftw

all: $(OUT_JS) $(OUT_MON_JS)

$(OUT_JS): $(FT8_SRC) $(WRAPPER)
	mkdir -p $(OUT_DIR)
	emcc $(EMCC_FLAGS) $(FT8_SRC) $(WRAPPER) -o $(OUT_JS)
	@echo "WASM build complete: $(OUT_JS) + $(OUT_WASM)"

fftw-build/$(FFTW_TARBALL):
	mkdir -p fftw-build
	curl -fsSL -o $@ $(FFTW_URL) || wget -q -O $@ $(FFTW_URL)

$(FFTW_DIR)/Makefile: fftw-build/$(FFTW_TARBALL)
	tar xzf $< -C fftw-build
	cd $(FFTW_DIR) && emconfigure ./configure \
	    --host=none-none-none \
	    --disable-fortran --disable-doc --disable-shared --enable-static \
	    CFLAGS="-O3"

$(FFTW_LIB): $(FFTW_DIR)/Makefile
	cd $(FFTW_DIR) && emmake make -j$$(nproc)

$(OUT_MON_JS): $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_LIB)
	mkdir -p $(OUT_DIR)
	em++ $(EMMON_FLAGS) $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_LIB) -o $(OUT_MON_JS)
	@echo "WASM build complete: $(OUT_MON_JS) + $(OUT_MON_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM) $(OUT_MON_JS) $(OUT_MON_WASM)

clean-fftw:
	rm -rf fftw-build

# ── Node-target builds for the regression benchmark ───────────────────────
# Usage (from project root, then): node lib/wasm_build/testbuild/test_decode.mjs
.PHONY: test-modules

# .cjs, not .js: Emscripten's MODULARIZE glue is UMD-style (module.exports =
# ...) with no ESM export statements. The project root's package.json sets
# "type": "module", so a plain .js file here is loaded via Node's ESM loader,
# which treats a script with no export statements as a module with an empty
# namespace instead of erroring — dynamic import() "succeeds" with .default
# silently undefined. A .cjs extension forces CommonJS interpretation
# regardless of the package's module type.
# Later -s flags override earlier ones, so ENVIRONMENT/SINGLE_FILE are re-set here.
test-modules: $(FFTW_LIB)
	mkdir -p testbuild
	em++ $(EMMON_FLAGS) -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_LIB) -o testbuild/ft8mon-node.cjs
	emcc $(EMCC_FLAGS) -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    -s EXPORT_NAME='createFT8LibModule' \
	    $(FT8_SRC) $(WRAPPER) -o testbuild/ft8lib-node.cjs
	@echo "Node test modules built in testbuild/"
