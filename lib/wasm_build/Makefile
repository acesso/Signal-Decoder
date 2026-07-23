# WASM builds for the FT8/FT4 decoders using Emscripten
#
# Two engines, each built in THREE SIMD tiers (baseline/simd128/relaxed-simd —
# see below):
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
# The first build downloads and cross-compiles FFTW 3.3.10 (needed by ft8mon)
# THREE times, once per SIMD tier (each tier needs its own FFTW build — FFTW
# hand-tunes FFT inner loops per-ISA via its own codelets, so simply passing
# -msimd128 to the C++ wrapper does nothing for the FFT calls unless FFTW
# itself was configured with a matching --enable-generic-simd128 codelet
# set); results are cached under fftw-build-<tier>/ so later builds are fast.
#
# ── SIMD tiers ───────────────────────────────────────────────────────────
# baseline     — no SIMD flags (current behavior, safety net for engines
#                that support neither tier below; also FT8/FT4's fallback
#                path if feature detection can't confirm anything more).
# simd128      — WASM fixed-width 128-bit SIMD (-msimd128). Broadly
#                supported since 2021 (Chrome 91+, Firefox 89+, Safari 16.4+).
#                FFTW built with --enable-generic-simd128 (portable, compiler-
#                vector-extension codelets — not x86 SSE asm — so this
#                lowers correctly through Clang to real WASM SIMD128 opcodes).
# relaxed-simd — WASM Relaxed SIMD (-mrelaxed-simd, a superset of simd128:
#                adds hardware-mapped ops like fused multiply-add that trade
#                strict IEEE determinism for speed). Newer (Chrome 114+,
#                Firefox 120+, Safari 18.4+) — runtime-feature-detected by
#                the JS loader, NOT assumed. FFTW has no separate "relaxed"
#                codelet set (that's a WASM-only ISA extension FFTW's own
#                build system doesn't model) — it reuses the same
#                --enable-generic-simd128 codelets; the relaxed-simd gain
#                here comes entirely from ft8mon/ft8_lib's OWN hand-written
#                C/C++ hot loops and Clang's auto-vectorizer being able to
#                emit relaxed ops where profitable.

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

# Per-tier compiler flags — appended to EMCC_FLAGS/EMMON_FLAGS below. baseline
# is intentionally empty (no SIMD flags at all — current behavior, and the
# universal fallback the JS loader uses when neither feature-detect check
# passes).
SIMD_FLAGS_baseline     =
SIMD_FLAGS_simd128      = -msimd128
SIMD_FLAGS_relaxed-simd = -mrelaxed-simd

# ft8_lib output naming: baseline keeps the original bare ft8.js/.wasm names
# (nothing else in the tree references a "-baseline" suffix); simd128/
# relaxed-simd get a tier suffix.
OUT_JS_baseline     = $(OUT_DIR)/ft8.js
OUT_JS_simd128      = $(OUT_DIR)/ft8-simd128.js
OUT_JS_relaxed-simd = $(OUT_DIR)/ft8-relaxed-simd.js

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

OUT_MON_JS_baseline     = $(OUT_DIR)/ft8mon.js
OUT_MON_JS_simd128      = $(OUT_DIR)/ft8mon-simd128.js
OUT_MON_JS_relaxed-simd = $(OUT_DIR)/ft8mon-relaxed-simd.js

FFTW_VERSION = 3.3.10
FFTW_TARBALL = fftw-$(FFTW_VERSION).tar.gz
FFTW_URL     = https://www.fftw.org/$(FFTW_TARBALL)

# Each tier gets its OWN FFTW build directory/cache — FFTW hand-tunes FFT
# inner loops via per-ISA "codelets" selected at ./configure time, so a
# baseline (scalar-codelet) FFTW build linked into a -msimd128-compiled
# ft8mon_wasm.cc would leave the actual FFT calls (ft8mon's hottest code
# path — see one_fft/one_strength in ft8.cc) running scalar regardless of
# what flags the wrapper itself was compiled with.
FFTW_DIR_baseline     = fftw-build-baseline/fftw-$(FFTW_VERSION)
FFTW_DIR_simd128      = fftw-build-simd128/fftw-$(FFTW_VERSION)
# Relaxed SIMD is a WASM-only ISA extension with no dedicated FFTW codelet
# set (FFTW's configure only knows about real hardware ISAs + the portable
# generic-simd128/256 codelets) — reuse the simd128 FFTW build. Any
# relaxed-simd speedup comes entirely from ft8mon_wasm.cc's own code and
# Clang's auto-vectorizer, not from FFTW.
FFTW_DIR_relaxed-simd = $(FFTW_DIR_simd128)

FFTW_CONFIGURE_FLAGS_baseline = CFLAGS="-O3"
FFTW_CONFIGURE_FLAGS_simd128  = --enable-generic-simd128 CFLAGS="-O3 -msimd128"

EMMON_FLAGS = \
    -O3 \
    -std=c++17 \
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

TIERS = baseline simd128 relaxed-simd

.PHONY: all clean clean-fftw $(foreach t,$(TIERS),ft8lib-$(t) ft8mon-$(t))

all: $(foreach t,$(TIERS),ft8lib-$(t) ft8mon-$(t))

ft8lib-baseline:     $(OUT_JS_baseline)
ft8lib-simd128:      $(OUT_JS_simd128)
ft8lib-relaxed-simd: $(OUT_JS_relaxed-simd)

$(OUT_JS_baseline): $(FT8_SRC) $(WRAPPER)
	mkdir -p $(OUT_DIR)
	emcc $(EMCC_FLAGS) $(SIMD_FLAGS_baseline) $(FT8_SRC) $(WRAPPER) -o $(OUT_JS_baseline)
	@echo "WASM build complete: $(OUT_JS_baseline)"

$(OUT_JS_simd128): $(FT8_SRC) $(WRAPPER)
	mkdir -p $(OUT_DIR)
	emcc $(EMCC_FLAGS) $(SIMD_FLAGS_simd128) $(FT8_SRC) $(WRAPPER) -o $(OUT_JS_simd128)
	@echo "WASM build complete: $(OUT_JS_simd128)"

$(OUT_JS_relaxed-simd): $(FT8_SRC) $(WRAPPER)
	mkdir -p $(OUT_DIR)
	emcc $(EMCC_FLAGS) $(SIMD_FLAGS_relaxed-simd) $(FT8_SRC) $(WRAPPER) -o $(OUT_JS_relaxed-simd)
	@echo "WASM build complete: $(OUT_JS_relaxed-simd)"

# ── FFTW (per-tier) ────────────────────────────────────────────────────────

fftw-build-baseline/$(FFTW_TARBALL) fftw-build-simd128/$(FFTW_TARBALL):
	mkdir -p $(dir $@)
	curl -fsSL -o $@ $(FFTW_URL) || wget -q -O $@ $(FFTW_URL)

$(FFTW_DIR_baseline)/Makefile: fftw-build-baseline/$(FFTW_TARBALL)
	tar xzf $< -C fftw-build-baseline
	cd $(FFTW_DIR_baseline) && emconfigure ./configure \
	    --host=none-none-none \
	    --disable-fortran --disable-doc --disable-shared --enable-static \
	    $(FFTW_CONFIGURE_FLAGS_baseline)

$(FFTW_DIR_simd128)/Makefile: fftw-build-simd128/$(FFTW_TARBALL)
	tar xzf $< -C fftw-build-simd128
	cd $(FFTW_DIR_simd128) && emconfigure ./configure \
	    --host=none-none-none \
	    --disable-fortran --disable-doc --disable-shared --enable-static \
	    $(FFTW_CONFIGURE_FLAGS_simd128)

$(FFTW_DIR_baseline)/.libs/libfftw3.a: $(FFTW_DIR_baseline)/Makefile
	cd $(FFTW_DIR_baseline) && emmake make -j$$(nproc)

$(FFTW_DIR_simd128)/.libs/libfftw3.a: $(FFTW_DIR_simd128)/Makefile
	cd $(FFTW_DIR_simd128) && emmake make -j$$(nproc)

# ── ft8mon (per-tier) ──────────────────────────────────────────────────────

ft8mon-baseline:     $(OUT_MON_JS_baseline)
ft8mon-simd128:      $(OUT_MON_JS_simd128)
ft8mon-relaxed-simd: $(OUT_MON_JS_relaxed-simd)

$(OUT_MON_JS_baseline): $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_baseline)/.libs/libfftw3.a
	mkdir -p $(OUT_DIR)
	em++ $(EMMON_FLAGS) $(SIMD_FLAGS_baseline) -I$(FFTW_DIR_baseline)/api \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_baseline)/.libs/libfftw3.a -o $(OUT_MON_JS_baseline)
	@echo "WASM build complete: $(OUT_MON_JS_baseline)"

$(OUT_MON_JS_simd128): $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_simd128)/.libs/libfftw3.a
	mkdir -p $(OUT_DIR)
	em++ $(EMMON_FLAGS) $(SIMD_FLAGS_simd128) -I$(FFTW_DIR_simd128)/api \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_simd128)/.libs/libfftw3.a -o $(OUT_MON_JS_simd128)
	@echo "WASM build complete: $(OUT_MON_JS_simd128)"

$(OUT_MON_JS_relaxed-simd): $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_relaxed-simd)/.libs/libfftw3.a
	mkdir -p $(OUT_DIR)
	em++ $(EMMON_FLAGS) $(SIMD_FLAGS_relaxed-simd) -I$(FFTW_DIR_relaxed-simd)/api \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_relaxed-simd)/.libs/libfftw3.a -o $(OUT_MON_JS_relaxed-simd)
	@echo "WASM build complete: $(OUT_MON_JS_relaxed-simd)"

clean:
	rm -f $(OUT_DIR)/ft8.js $(OUT_DIR)/ft8.wasm \
	      $(OUT_DIR)/ft8-simd128.js $(OUT_DIR)/ft8-simd128.wasm \
	      $(OUT_DIR)/ft8-relaxed-simd.js $(OUT_DIR)/ft8-relaxed-simd.wasm \
	      $(OUT_DIR)/ft8mon.js $(OUT_DIR)/ft8mon.wasm \
	      $(OUT_DIR)/ft8mon-simd128.js $(OUT_DIR)/ft8mon-simd128.wasm \
	      $(OUT_DIR)/ft8mon-relaxed-simd.js $(OUT_DIR)/ft8mon-relaxed-simd.wasm

clean-fftw:
	rm -rf fftw-build-baseline fftw-build-simd128

# ── Node-target builds for the regression benchmark ───────────────────────
# Usage (from project root, then): node lib/wasm_build/testbuild/test_decode.mjs [osd_depth] [tier]
.PHONY: test-modules

# .cjs, not .js: Emscripten's MODULARIZE glue is UMD-style (module.exports =
# ...) with no ESM export statements. The project root's package.json sets
# "type": "module", so a plain .js file here is loaded via Node's ESM loader,
# which treats a script with no export statements as a module with an empty
# namespace instead of erroring — dynamic import() "succeeds" with .default
# silently undefined. A .cjs extension forces CommonJS interpretation
# regardless of the package's module type.
# Later -s flags override earlier ones, so ENVIRONMENT/SINGLE_FILE are re-set here.
# Builds all three SIMD tiers so the benchmark can compare them directly —
# see scripts/ft8-simd-benchmark output or test_decode.mjs's tier argument.
test-modules: $(FFTW_DIR_baseline)/.libs/libfftw3.a $(FFTW_DIR_simd128)/.libs/libfftw3.a
	mkdir -p testbuild
	em++ $(EMMON_FLAGS) $(SIMD_FLAGS_baseline) -I$(FFTW_DIR_baseline)/api -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_baseline)/.libs/libfftw3.a -o testbuild/ft8mon-node-baseline.cjs
	em++ $(EMMON_FLAGS) $(SIMD_FLAGS_simd128) -I$(FFTW_DIR_simd128)/api -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_simd128)/.libs/libfftw3.a -o testbuild/ft8mon-node-simd128.cjs
	em++ $(EMMON_FLAGS) $(SIMD_FLAGS_relaxed-simd) -I$(FFTW_DIR_relaxed-simd)/api -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    $(FT8MON_SRC) $(FT8MON_WRAPPER) $(FFTW_DIR_relaxed-simd)/.libs/libfftw3.a -o testbuild/ft8mon-node-relaxed-simd.cjs
	emcc $(EMCC_FLAGS) -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    -s EXPORT_NAME='createFT8LibModule' \
	    $(FT8_SRC) $(WRAPPER) -o testbuild/ft8lib-node.cjs
	emcc $(EMCC_FLAGS) $(SIMD_FLAGS_simd128) -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    -s EXPORT_NAME='createFT8LibModule' \
	    $(FT8_SRC) $(WRAPPER) -o testbuild/ft8lib-node-simd128.cjs
	emcc $(EMCC_FLAGS) $(SIMD_FLAGS_relaxed-simd) -s SINGLE_FILE=1 -s ENVIRONMENT='node' \
	    -s EXPORT_NAME='createFT8LibModule' \
	    $(FT8_SRC) $(WRAPPER) -o testbuild/ft8lib-node-relaxed-simd.cjs
	@echo "Node test modules built in testbuild/ (baseline/simd128/relaxed-simd for ft8mon; baseline/simd128/relaxed-simd for ft8lib)"
