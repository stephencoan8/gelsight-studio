#!/bin/sh
# Rebuild the freestanding kernels. The committed .wasm files are what the app loads;
# this script is the reproducible build (needs emscripten or clang+wasm-ld).
set -e
cd "$(dirname "$0")"
if command -v emcc >/dev/null 2>&1; then
  emcc -O3 -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -Wl,--no-entry -o solve.wasm solve.c
  emcc -O3 -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -Wl,--no-entry -o poisson.wasm poisson.c
else
  clang --target=wasm32-unknown-unknown -O3 -nostdlib -Wl,--no-entry \
    -Wl,--export=solve -Wl,--export=alloc -Wl,--export=reset -o solve.wasm solve.c
  clang --target=wasm32-unknown-unknown -O3 -nostdlib -Wl,--no-entry \
    -Wl,--export=poisson -Wl,--export=alloc -Wl,--export=preset \
    -Wl,--export=dct_rows -Wl,--export=transpose -Wl,--export=eigendiv -o poisson.wasm poisson.c
fi
echo "built $(wc -c < solve.wasm) $(wc -c < poisson.wasm)"
