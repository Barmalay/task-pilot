#!/bin/sh
# Запуск отдельного Chrome с удаленной отладкой для QA-прогона. Профиль чистый и временный.
# Использование: chrome_start.sh [port=9333] [profile=/tmp/claude-qa-profile] [--headless]
PORT=${1:-9333}; PROFILE=${2:-/tmp/claude-qa-profile}; MODE=${3:-}
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
rm -rf "$PROFILE"
if [ "$MODE" = "--headless" ]; then EXTRA="--headless=new --disable-gpu --hide-scrollbars"; else EXTRA=""; fi
"$CHROME" $EXTRA --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --window-size=1280,900 about:blank >/dev/null 2>&1 &
sleep 3
curl -s "http://127.0.0.1:$PORT/json/version" | head -2
