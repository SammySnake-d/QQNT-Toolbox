#!/bin/zsh
# 生成/刷新官方纯净镜像到持久目录 (不用 /tmp, 重启不丢)
BASE="$HOME/LiteLoaderQQNT/native_stealth/stock_mirror"
SRC="/Applications/QQ.app/Contents/Resources/app"
mkdir -p "$BASE/app_launcher"
[ -f "$SRC/package.json" ] && cp "$SRC/package.json" "$BASE/package.json"
[ -f "$SRC/app_launcher/adm-zip.js" ] && cp "$SRC/app_launcher/adm-zip.js" "$BASE/app_launcher/adm-zip.js"
[ -f "$SRC/app_launcher/launcher.js" ] && cp "$SRC/app_launcher/launcher.js" "$BASE/app_launcher/launcher.js"
# index.js 用官方纯净内容(不含 LiteLoader require)
printf "require('../major.node').load('internal_index', module);\n" > "$BASE/app_launcher/index.js"
