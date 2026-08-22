#!/bin/zsh
# 注意: 绝不能用 nohup —— nohup 是 SIP 系统二进制, exec 前会 strip 掉 DYLD_* 环境变量,
# 导致 libnative_stealth.dylib 根本不会被注入。必须直接后台启动 + disown。
/tmp/ensure_stock_mirror.sh 2>/dev/null || true
export DYLD_INSERT_LIBRARIES="/Users/snakesammy/LiteLoaderQQNT/native_stealth/libnative_stealth.dylib"
/Applications/QQ.app/Contents/MacOS/QQ "$@" >/dev/null 2>&1 &
disown 2>/dev/null || true
