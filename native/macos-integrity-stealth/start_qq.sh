#!/bin/zsh
# 绝不能用 nohup —— 它会 strip DYLD_* 环境变量导致注入失效。直接后台 + disown。
BASE="$HOME/LiteLoaderQQNT/native_stealth"
"$BASE/ensure_stock_mirror.sh" 2>/dev/null || true
export DYLD_INSERT_LIBRARIES="$BASE/libnative_stealth.dylib"
/Applications/QQ.app/Contents/MacOS/QQ "$@" >/dev/null 2>&1 &
disown 2>/dev/null || true
