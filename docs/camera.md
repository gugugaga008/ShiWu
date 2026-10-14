# 摄像头采集

采集链路是：Electron 的采集窗口 `getUserMedia` → canvas → JPEG → WebSocket → Python 管道。
管道、接口与模型见 [`architecture.md`](architecture.md)，本文只讲采集本身和它在 macOS 上的坑。

## macOS 权限：责任进程会被继承

macOS 的 TCC 按「责任进程」判定相机权限，这里有两个坑。

**坑一：责任进程会被继承。**
如果从某个没有 `com.apple.security.device.camera` entitlement 的 hardened runtime 应用里
启动识务（比如从某个 IDE 或 GUI 工具的终端里 `pnpm start`），TCC 会把**那个应用**当成责任人，
直接拒绝，而且**连授权弹窗都不弹**。日志里长这样：

```
service: kTCCServiceCamera requires entitlement com.apple.security.device.camera
but it is missing for responsible={...某应用...}; Policy disallows prompt; denied
```

自己跑起来验证时用 `open` 绕开继承关系：

```bash
open -n apps/desktop/node_modules/.pnpm/electron@*/node_modules/electron/dist/Electron.app \
  --args "$PWD/apps/desktop"
```

正式交付的 `.app` 已经带 `com.apple.security.device.camera`
（`apps/desktop/build/entitlements.mac.plist`），从访达双击启动不会遇到这个问题。

**坑二：授权只对当前 `.app` 生效。**
换一个启动路径（比如从 Electron 源码目录启动）就等于换了一个应用，系统会重新问一次。

## 采集窗口的四种模式

采集在 Electron 的一个独立窗口里跑（`apps/desktop/src/windows/camera.html`）。
`SHIWU_CAMERA_MODE` 决定这个窗口怎么表现，四种模式实测都能采到帧：

| 模式 | 表现 | 实测 |
| --- | --- | --- |
| `invisible`（默认） | 完全看不见（`setOpacity(0)`），窗口仍处于已显示状态 | 74 / 79 帧 |
| `visible` | 360×240 诊断小浮窗，出现但不抢焦点；只显示采集状态，不显示摄像头画面 | 76 / 79 帧（隐藏视频前的历史采集实测） |
| `offscreen` | 挪到屏幕外，保持已显示状态 | 73 帧 |
| `hidden` | `show: false` 且从不显示，连窗口都不占 | 73 / 79 / 79 帧 |

默认选 `invisible` 而不是 `hidden`：`invisible` 的窗口在 Chromium 眼里确实是已显示状态
（`isVisible=true`），合成器必然分配，是构造上就成立的路径；`hidden` 虽然实测也通过，
但依赖「隐藏窗口仍能解码视频」这一没完全查清的行为。

## 实时画面只在手机查看

在「设置 → 基础 → 画面源」添加并启动后会弹出该路二维码；之后也可从同一菜单或「设置 → 监控与隐私 → 手机扫码预览」打开。手机与电脑连接同一可信 Wi-Fi 后扫码。真实摄像头、桌面端推流、网络流和视频文件统一使用此入口；Electron 采集窗口的视频元素保持解码，但透明显示，不作为桌面预览。桌面端摄像头列表只显示「本机摄像头」，避免与 OpenCV 索引重复。macOS/Windows 枚举列表时不打开设备，因此打开软件或进入人员页不会点亮指示灯。暂停监控会停止管道并 `track.stop()`，摄像头指示灯应熄灭。

关闭二维码弹窗、关闭设置或切换管理页面不会断开手机访问。重开弹窗或刷新管理页可恢复原二维码，不会续期；链接时长可在 5 / 10 / 30 分钟中选择，点「刷新二维码」会重置。点击「断开手机预览」、停止或替换该路画面源、退出服务才提前使会话失效。临时局域网预览与管理服务隔离，详见 [`architecture.md`](architecture.md)。上述历史帧数不是本次透明视频修改的真机验收结果；仍需在目标主机检查采集持续产帧与手机扫码连接。

## 采集失败怎么查

采集循环的第一道闸是 `if (v.videoWidth)`，不成立就静默跳过这一帧——
**没有帧时不会有任何报错**。所以 `camera.html` 会在连续 8 秒零帧时主动打印一条诊断：

```
[camera] 诊断 8 秒零帧：videoWidth=0 readyState=0 paused=true wsState=1 idle=false
```

按这几个值定位：

- `videoWidth=0` + `paused=true` → 视频根本没开始播（Chromium 层面没解码）
- `videoWidth=0` + `paused=false` → 解码了但拿不到尺寸
- `wsState=3` → WebSocket 没连上
- `idle=true` → 服务端没有在监控（正常，会被自适应抽帧降频）

再往下挖，给 Electron 加 `--remote-debugging-port=9333 --enable-logging --log-file=/tmp/chromium.log`，
在 Chromium 日志里看 `VideoCaptureManager` 到没到 `VIDEO_CAPTURE_STATE_STARTED`。

没有摄像头的主机上想跑通管道，用 `SHIWU_FAKE_CAMERAS` 或 `SHIWU_FAKE_WEBCAM` 喂视频文件，
见 `scripts/desktop_e2e.sh` 的 `cv` / `push` 两个模式。
