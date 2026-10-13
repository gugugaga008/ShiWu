#!/usr/bin/env bash
# 桌面端到端：Xvfb + xfwm4 → Electron 托管 Python 服务 → 播放素材 → 识别王总/老板 → 通知 + 遮挡 + 最小化窗口
# 用法：scripts/desktop_e2e.sh [file|cv|push] [video]    截图输出 var/out/desktop/<mode>/
#   file  ：SHIWU_AUTOSTART_VIDEO 直接播放文件
#   cv    ：服务端 OpenCV 摄像头路径（box 无 /dev/video*：SHIWU_FAKE_CAMERAS 把视频当设备 0）
#   push  ：Electron getUserMedia（Chromium 假摄像头读 .y4m）→ WS 推帧 → CameraSource.push_frame
set -u
cd "$(dirname "$0")/.."
ROOT=$PWD
MODE=${1:-file}
VIDEO=${2:-assets/videos/pexels_9652478.mp4}
OUT=$ROOT/var/out/desktop/$MODE; mkdir -p "$OUT"
SETTINGS=$ROOT/var/data/settings.json
[ -f "$SETTINGS" ] && cp "$SETTINGS" /tmp/shiwu_settings.bak
EXTRA_ENV=()
case $MODE in
  file) EXTRA_ENV=(SHIWU_AUTOSTART_VIDEO=$VIDEO); echo '{"auto_monitor": false}' > "$SETTINGS" ;;
  cv)   EXTRA_ENV=(SHIWU_FAKE_CAMERAS="0=$VIDEO")
        echo '{"auto_monitor": true, "default_source": {"kind": "camera", "uri": "0"}}' > "$SETTINGS" ;;
  push) Y4M=/tmp/fakecam.y4m
        [ -f $Y4M ] || ffmpeg -loglevel error -y -i "$VIDEO" -vf scale=640:-2,fps=15 -pix_fmt yuv420p $Y4M
        EXTRA_ENV=(SHIWU_FAKE_WEBCAM=$Y4M)
        echo '{"auto_monitor": true, "default_source": {"kind": "camera", "uri": "push://electron"}}' > "$SETTINGS" ;;
esac
PY=$ROOT/.venv/bin/python
D=:77
export DISPLAY=$D
shot() { "$PY" -c "from PIL import ImageGrab; ImageGrab.grab(xdisplay='$D').save('$OUT/$1')" && echo "截图 $OUT/$1"; }
visible() { xdotool search --onlyvisible --name . 2>/dev/null | while read w; do n=$(xdotool getwindowname $w 2>/dev/null); [ -n "$n" ] && echo "  $w $n"; done; }

Xvfb $D -screen 0 1600x1000x24 -nolisten tcp >/tmp/e2e_xvfb.log 2>&1 & XVFB=$!
sleep 1
dbus-run-session -- xfwm4 --compositor=off >/tmp/e2e_wm.log 2>&1 & WM=$!
sleep 1
# 模拟「正在摸鱼」的窗口
xfce4-terminal --disable-server --title "摸鱼终端" --geometry 90x20+40+560 -x bash -c 'echo 正在刷短视频……; sleep 600' >/dev/null 2>&1 &
TERM1=$!
sleep 2

env SHIWU_START_PATH=/sources SHIWU_TOAST_MS=30000 "${EXTRA_ENV[@]}" \
  ${ELECTRON:-apps/desktop/node_modules/electron/dist/electron apps/desktop} --no-sandbox >"$OUT/electron.log" 2>&1 & EL=$!

# 识别到王总（规则尚在累计确认帧）→ 先截一张「触发前」
for i in $(seq 1 600); do grep -q "\[live\] 识别 .*（boss）" "$OUT/electron.log" && break; sleep 0.1; done
shot 0_recognized_before_trigger.png
# 等动作执行
for i in $(seq 1 120); do grep -q "\[action\] minimize_all" "$OUT/electron.log" && break; sleep 1; done
grep -q "\[action\] cover" "$OUT/electron.log" || { echo "未触发动作"; tail -30 "$OUT/electron.log"; }
sleep 2
echo "触发后可见窗口："; visible
shot 1_triggered_cover_toast.png

# 全局快捷键解除遮挡
xdotool key ctrl+alt+b; sleep 1.5
echo "解除遮挡后可见窗口："; visible
shot 2_unlocked_windows_minimized.png

grep -E "\[action\]|\[backend\] 就绪|\[e2e\]|\[cover\]|\[monitor\]|\[camera\]|\[live\]" "$OUT/electron.log" | head -30
kill $EL; sleep 3; kill $TERM1 $WM $XVFB 2>/dev/null
if [ -f /tmp/shiwu_settings.bak ]; then mv /tmp/shiwu_settings.bak "$SETTINGS"; else rm -f "$SETTINGS"; fi
