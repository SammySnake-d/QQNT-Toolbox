#!/bin/zsh
# 编译 macOS 完整性感知隔离层 (universal: arm64 + x86_64)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
clang -shared -fPIC -O2 \
  -arch arm64 -arch x86_64 \
  -framework CoreFoundation -framework Security \
  "$DIR/interpose.c" \
  -o "$DIR/libnative_stealth.dylib"
echo "built: $DIR/libnative_stealth.dylib"
