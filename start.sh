#!/bin/sh
# Запуск в Termux: sh start.sh
cd "$(dirname "$0")"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
exec node server.js
