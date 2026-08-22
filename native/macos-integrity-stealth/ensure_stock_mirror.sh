#!/bin/bash
mkdir -p /tmp/qq_stock_mirror/app_launcher
if [ -f /Applications/QQ.app/Contents/Resources/app/package.json ]; then
    cp /Applications/QQ.app/Contents/Resources/app/package.json /tmp/qq_stock_mirror/package.json
fi
if [ -f /Applications/QQ.app/Contents/Resources/app/app_launcher/adm-zip.js ]; then
    cp /Applications/QQ.app/Contents/Resources/app/app_launcher/adm-zip.js /tmp/qq_stock_mirror/app_launcher/adm-zip.js
fi
if [ -f /Applications/QQ.app/Contents/Resources/app/app_launcher/launcher.js ]; then
    cp /Applications/QQ.app/Contents/Resources/app/app_launcher/launcher.js /tmp/qq_stock_mirror/app_launcher/launcher.js
fi
printf "require('../major.node').load('internal_index', module);\n" > /tmp/qq_stock_mirror/app_launcher/index.js
