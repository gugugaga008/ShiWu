#!/usr/bin/env bash
# v1.1 桌面端到端：老板入镜 → 遮挡 + 最小化（记录窗口）→ 离开 N 秒 → 自动解除遮挡并恢复窗口
# Xvfb + xfwm4 + 真实 Electron + 独立临时数据的 shiwu（示例人员由 seed_demo.py 采集登记）
set -u
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=$ROOT/var/out/desktop/leave; mkdir -p "$OUT"
PY=$ROOT/.venv/bin/python
TMP=$(mktemp -d); PORT=7412; TOKEN=e2e-leave-token
D=:79; export DISPLAY=$D
shot() { "$PY" -c "from PIL import ImageGrab; ImageGrab.grab(xdisplay='$D').save('$OUT/$1')" && echo "截图 $OUT/$1"; }
visible() { xdotool search --onlyvisible --name "$1" 2>/dev/null | head -1; }
api() { curl -s -H "X-Shiwu-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }

env SHIWU_API_TOKEN=$TOKEN SHIWU_DATA_DIR=$TMP/boss SHIWU_GALLERY_DIR=$TMP/facenox \
  "$PY" -m shiwu --port $PORT > "$OUT/server.log" 2>&1 & SRV=$!
for i in $(seq 1 60); do api http://127.0.0.1:$PORT/boss/monitor >/dev/null 2>&1 && break; sleep 0.5; done
"$PY" scripts/seed_demo.py --url http://127.0.0.1:$PORT --token $TOKEN | tail -2
api -X PUT http://127.0.0.1:$PORT/boss/settings -d '{"auto_monitor": false}' >/dev/null
api -X PUT http://127.0.0.1:$PORT/boss/rules -d '[{"id":"boss","role":"boss","min_frames":2,"cooldown_s":600,
  "restore_on_leave":true,"leave_after_s":4,"actions":[{"type":"notify"},{"type":"cover"},{"type":"minimize_all"}]}]' >/dev/null

Xvfb $D -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 & XVFB=$!
sleep 1
dbus-run-session -- xfwm4 --compositor=off >/dev/null 2>&1 & WM=$!
sleep 1
xfce4-terminal --disable-server --title "摸鱼终端" --geometry 90x20+60+520 -x bash -c 'echo 正在刷短视频……; sleep 600' >/dev/null 2>&1 & T1=$!
xfce4-terminal --disable-server --title "股票行情" --geometry 70x14+900+120 -x bash -c 'echo 大盘 +2.3%; sleep 600' >/dev/null 2>&1 & T2=$!
sleep 2
env SHIWU_BACKEND_URL=http://127.0.0.1:$PORT SHIWU_TOKEN=$TOKEN SHIWU_TOAST_MS=20000 \
  ${ELECTRON:-apps/desktop/node_modules/electron/dist/electron apps/desktop} --no-sandbox > "$OUT/electron.log" 2>&1 & EL=$!
for i in $(seq 1 100); do grep -q "\[live\] 已连接" "$OUT/electron.log" && break; sleep 0.2; done
echo "开始前可见：摸鱼终端=$(visible 摸鱼终端) 股票行情=$(visible 股票行情)"
shot 0_before.png
api -X POST http://127.0.0.1:$PORT/boss/pipeline/start -d "{\"kind\":\"file\",\"uri\":\"$ROOT/assets/videos/pexels_9652478.mp4\",\"loop\":false,\"name\":\"门口\"}" >/dev/null
for i in $(seq 1 60); do grep -q "\[action\] minimize_all" "$OUT/electron.log" && break; sleep 1; done
sleep 2
M1=$(visible 摸鱼终端); M2=$(visible 股票行情)
echo "触发后可见：摸鱼终端=${M1:-无} 股票行情=${M2:-无}"
shot 1_triggered_cover_minimized.png
for i in $(seq 1 60); do grep -q "\[leave\].*恢复" "$OUT/electron.log" && break; sleep 1; done
sleep 3
R1=$(visible 摸鱼终端); R2=$(visible 股票行情)
COVER=$(xdotool search --onlyvisible --name "2026年Q4预算" 2>/dev/null | head -1)
echo "离开后可见：摸鱼终端=${R1:-无} 股票行情=${R2:-无} 遮挡层=${COVER:-无}"
shot 2_left_restored.png
grep -E "\[action\]|\[leave\]|\[cover\]" "$OUT/electron.log" | head -12
api "http://127.0.0.1:$PORT/boss/eventlog?kind=left,action_result&limit=5" | "$PY" -c "import json,sys;[print(' ',e['kind'],e['name'] or '',json.dumps(e['detail'],ensure_ascii=False)[:160]) for e in json.load(sys.stdin)]"
if [ -z "$M1" ] && [ -z "$M2" ] && [ -n "$R1" ] && [ -n "$R2" ] && [ -z "$COVER" ]; then echo "E2E-LEAVE: PASS"; else echo "E2E-LEAVE: FAIL"; fi
kill $EL; sleep 2; kill $T1 $T2 $WM $XVFB $SRV 2>/dev/null; rm -rf "$TMP"
