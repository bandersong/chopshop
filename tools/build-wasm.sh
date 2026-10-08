#!/bin/sh
# Compile elektron-firmware-tool (MIT, third_party/) plus src/wasm/eft_api.c to one
# self-contained JavaScript file, generated/eft.js (the WebAssembly is embedded as
# base64: SINGLE_FILE), so the page works from file:// and offline.
#
# Needs emscripten (emcc). The project builds it in the build VM:
#   brew install emscripten        (HOMEBREW_NO_AUTO_UPDATE=1)
#   sh web/tools/build-wasm.sh
# The compiler version and the flags are written next to the output
# (generated/eft.build.txt) so a rebuild can be compared.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
EFT="$HERE/third_party/elektron-firmware-tool"
OUT="$HERE/generated"
mkdir -p "$OUT"

# The vendored copy must be the pinned upstream commit plus the one local patch
# (ELE2 padded to 4 bytes, as the stock MK1 / Analog Keys files are).
grep -q "stock pads to 4" "$EFT/container.c" || {
  echo "third_party/elektron-firmware-tool/container.c lacks the ELE2 align-4 patch" >&2
  exit 1
}

FLAGS="-std=c11 -O2 -Wall -Wextra \
 -sMODULARIZE=1 -sEXPORT_NAME=createEFT -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=2147483648 \
 -sSTACK_SIZE=1048576 -sSINGLE_FILE=1 -sENVIRONMENT=web,worker,node \
 -sFORCE_FILESYSTEM=1 \
 -sEXPORTED_FUNCTIONS=_main,_eft_identify,_malloc,_free \
 -sEXPORTED_RUNTIME_METHODS=callMain,FS,UTF8ToString,ccall"

# shellcheck disable=SC2086
emcc $FLAGS -I"$EFT" "$EFT"/aplib.c "$EFT"/container.c "$EFT"/device.c "$EFT"/firmware.c \
  "$EFT"/integrity.c "$EFT"/main.c "$EFT"/report.c "$EFT"/transport.c \
  "$HERE/src/wasm/eft_api.c" -o "$OUT/eft.js"

{
  echo "emcc: $(emcc --version | head -1)"
  echo "flags: $FLAGS" | tr -s ' '
  echo "sources (sha256):"
  for f in "$EFT"/*.c "$EFT"/*.h "$HERE/src/wasm/eft_api.c"; do
    printf '  %s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "${f#"$HERE"/}"
  done
  printf 'output: %s  generated/eft.js\n' "$(shasum -a 256 "$OUT/eft.js" | cut -d' ' -f1)"
} > "$OUT/eft.build.txt"
echo "wrote $OUT/eft.js ($(wc -c < "$OUT/eft.js") B)"
