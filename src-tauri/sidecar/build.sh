#!/usr/bin/env bash
# Build sidecar `kdbx-import` và đặt vào src-tauri/binaries/ theo target triple
# mà Tauri externalBin yêu cầu (kdbx-import-<triple>).
# Chạy trước `tauri dev` / `tauri build` khi sidecar thay đổi.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI="$(cd "$HERE/.." && pwd)"
CRATE="$HERE/kdbx-import"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"

echo "Building kdbx-import sidecar for $TRIPLE …"
cargo build --release --manifest-path "$CRATE/Cargo.toml"

EXT=""
[[ "$TRIPLE" == *windows* ]] && EXT=".exe"
mkdir -p "$SRC_TAURI/binaries"
cp "$CRATE/target/release/kdbx-import$EXT" \
   "$SRC_TAURI/binaries/kdbx-import-$TRIPLE$EXT"
echo "→ binaries/kdbx-import-$TRIPLE$EXT"
