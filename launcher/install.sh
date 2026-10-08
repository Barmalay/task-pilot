#!/bin/sh
# Собирает приложение Task Pilot для Dock: ~/Applications/Task Pilot.app, другой путь к .app можно передать
# аргументом. Иконка рисуется из launcher/icon.svg через headless Chrome, приложение - программа на Swift из
# launcher/TaskPilot.swift со своим окном интерфейса, она вызывает apps/server/src/launcher.ts. Компилятор Swift
# берется из Command Line Tools. Пути к node и к проекту вшиваются при сборке, поэтому после переноса проекта или
# установки node в другую папку приложение нужно собрать заново.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${1:-"$HOME/Applications/Task Pilot.app"}
ID=local.task-pilot
UI="http://127.0.0.1:${TASK_PILOT_WEB_PORT:-5177}/"
UI_LOCALHOST="http://localhost:${TASK_PILOT_WEB_PORT:-5177}/"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

fail() {
  echo "$*" >&2
  exit 1
}

case $APP in
  *.app) ;;
  *) fail "Путь к приложению должен оканчиваться на .app: $APP" ;;
esac
# Заменяется только прежняя сборка этого приложения, а не любая папка по этому пути.
if [ -e "$APP" ] && [ "$(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist" 2>/dev/null)" != "$ID" ]; then
  fail "$APP уже есть, и это не приложение Task Pilot"
fi
NODE=$(command -v node) || fail "node не найден в PATH"
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' || fail "Нужен Node 26, а найден $("$NODE" --version)"
[ -x "$CHROME" ] || fail "Нужен Google Chrome: им иконка рисуется из SVG"
xcrun --find swiftc >/dev/null 2>&1 || fail "Нужен компилятор Swift: поставьте Command Line Tools командой xcode-select --install"

WORK=$(mktemp -d)
trap 'pkill -f "user-data-dir=$WORK/chrome" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# Иконка 1024x1024 с прозрачным фоном. Headless Chrome после снимка может не завершиться сам,
# поэтому скрипт ждет файл и завершает Chrome.
cp "$ROOT/launcher/icon.svg" "$WORK/icon.svg"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/chrome" --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$WORK/icon.png" "file://$WORK/icon.svg" >/dev/null 2>&1 &
i=0
while [ ! -s "$WORK/icon.png" ]; do
  i=$((i + 1))
  [ "$i" -le 100 ] || fail "Chrome не нарисовал иконку за 30 секунд"
  sleep 0.3
done
sleep 1
pkill -f "user-data-dir=$WORK/chrome" 2>/dev/null || true

ICONSET="$WORK/TaskPilot.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/TaskPilot.icns"

# Программа приложения: пути к node и launcher.ts и адреса интерфейса вшиваются в исходник до компиляции.
sed -e "s|__NODE__|$NODE|g" -e "s|__LAUNCHER__|$ROOT/apps/server/src/launcher.ts|g" -e "s|__UI_LOCALHOST__|$UI_LOCALHOST|g" -e "s|__UI__|$UI|g" \
  "$ROOT/launcher/TaskPilot.swift" >"$WORK/main.swift"
echo "Компилирую приложение, это около минуты"
# Через xcrun: он передает компилятору SDK macOS, без него swiftc не найдет стандартную библиотеку.
xcrun swiftc -swift-version 5 -O -o "$WORK/TaskPilot" "$WORK/main.swift" -framework Cocoa -framework WebKit -framework UserNotifications

# Работающее приложение не заменить на ходу: его процесс снимается SIGKILL, без обработчика выхода, поэтому
# сервер Task Pilot продолжает работать, а новое приложение при запуске подхватывает его. Прежняя сборка
# могла быть апплетом AppleScript, поэтому ищется любая программа внутри приложения.
RELAUNCH=
if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
  pkill -KILL -f "$APP/Contents/MacOS/" || true
  RELAUNCH=1
  sleep 1
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/TaskPilot" "$APP/Contents/MacOS/TaskPilot"
cp "$WORK/TaskPilot.icns" "$APP/Contents/Resources/TaskPilot.icns"
# NSAllowsLocalNetworking: окно открывает интерфейс по http на 127.0.0.1, остальные адреса уходят в браузер.
cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleName</key><string>Task Pilot</string>
  <key>CFBundleDisplayName</key><string>Task Pilot</string>
  <key>CFBundleExecutable</key><string>TaskPilot</string>
  <key>CFBundleIconFile</key><string>TaskPilot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null || fail "Info.plist приложения не собрался"
codesign --force --sign - "$APP" 2>/dev/null
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Готово: $APP"
if [ -n "$RELAUNCH" ]; then open "$APP"; fi
