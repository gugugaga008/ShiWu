#!/usr/bin/env bash
# AppImage 冒烟：全新 HOME（无数据）在 Xvfb 中启动 → 托管的 boss-server 就绪 → 管理界面加载 → 截图 → 开机自启开关写入 autostart
set -u
cd "$(dirname "$0")/.."
APP=${1:-$(ls apps/desktop/release/*.AppImage | head -1)}
OUT=$PWD/var/out/appimage; mkdir -p "$OUT"
PY=$PWD/.venv/bin/python
D=:78; export DISPLAY=$D
H=$(mktemp -d); export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share
unset DBUS_SESSION_BUS_ADDRESS
Xvfb $D -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 & XV=$!
sleep 1; dbus-run-session -- xfwm4 --compositor=off >/dev/null 2>&1 & WM=$!; sleep 1
APPIMAGE_EXTRACT_AND_RUN=1 "$APP" --no-sandbox > "$OUT/app.log" 2>&1 & A=$!
for i in $(seq 1 120); do grep -q "\[backend\] 就绪" "$OUT/app.log" && break; sleep 1; done
grep -E "\[backend\]" "$OUT/app.log" | head -3
sleep 6
"$PY" -c "from PIL import ImageGrab; ImageGrab.grab(xdisplay='$D').save('$OUT/appimage_first_run.png')"
PORT=$(grep -oE "就绪 http://127.0.0.1:[0-9]+" "$OUT/app.log" | grep -oE "[0-9]+$")
echo "数据目录：$(ls $H/.config/*/ 2>/dev/null | tr '\n' ' ')"
echo "people 文件: $(find $H -name 'settings.json' -o -name 'attendance.db' | tr '\n' ' ')"
kill $A; sleep 3; pkill -f "boss-server --port" ; kill $WM $XV 2>/dev/null
echo "截图 $OUT/appimage_first_run.png"
