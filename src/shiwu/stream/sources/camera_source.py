"""摄像头插件：两种接入方式都汇入同一条 StreamPipeline。

1. 本地设备（server 端 OpenCV）：uri = "0" / "/dev/video0"。
   - list_cameras() 枚举设备（Linux 读 /sys/class/video4linux；Windows/macOS 逐个探测索引）。
   - 支持 width/height/fps；打不开时区分「不存在」与「被占用/无权限」。
   - 读帧连续失败（拔插、休眠唤醒后句柄失效）会自动重开，最长等待 reconnect_s。
   - 测试/演示：SHIWU_FAKE_CAMERAS=（兼容 SHIWU_FAKE_CAMERAS）"0=assets/videos/a.mp4;1=b.mp4" 把视频文件当作设备
     （仍走 VideoCapture + 实时节拍 + 循环），用于没有 /dev/video* 的环境。
2. 推流（Electron getUserMedia → WebSocket /boss/camera/push → push_frame）：uri = "push://<name>"。
"""
from __future__ import annotations

import logging
import os
from ...envutil import getenv
import platform
import queue
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

import cv2
import numpy as np

from ..base import FrameSource, SourceInfo, SourceState
from ..registry import register_source

logger = logging.getLogger(__name__)

# 本进程内被打开的设备（用于「被本应用占用」提示）
_OPEN_DEVICES: Dict[str, str] = {}
_OPEN_LOCK = threading.Lock()


class CameraBusyError(RuntimeError):
    pass


def fake_cameras() -> Dict[str, str]:
    out = {}
    for part in filter(None, (getenv("SHIWU_FAKE_CAMERAS") or "" or "").split(";")):
        k, _, v = part.partition("=")
        p = Path(v.strip())
        out[k.strip()] = str(p if p.is_absolute() else ROOT / p)
    return out


def _label_real_cameras(cams: List[dict]) -> None:
    real = [c for c in cams if not c.get("fake")]
    if len(real) == 1:
        real[0]["name"] = "本机摄像头"
    elif len(real) > 1:
        for i, c in enumerate(real, 1):
            c["name"] = f"摄像头 {i}"


def list_cameras(probe_max: int = 4) -> List[dict]:
    """枚举可用摄像头：[{id, name, path, busy, fake}]"""
    cams: List[dict] = []
    for k, v in fake_cameras().items():
        cams.append({"id": k, "name": f"模拟摄像头 {k}（{Path(v).name}）", "path": v, "fake": True})
    sysfs = Path("/sys/class/video4linux")
    real: List[dict] = []
    if platform.system() == "Linux":
        if sysfs.exists():
            for d in sorted(sysfs.glob("video*"), key=lambda p: int(p.name[5:] or 0)):
                idx = d.name[5:]
                if any(c["id"] == idx for c in cams):
                    continue
                # 只列出采集节点（index 0），同一设备的元数据节点跳过
                try:
                    if (d / "index").read_text().strip() not in ("0", ""):
                        continue
                except OSError:
                    pass
                name = (d / "name").read_text().strip() if (d / "name").exists() else d.name
                real.append({"id": idx, "name": name, "path": f"/dev/{d.name}", "fake": False})
    else:
        # Windows / macOS：枚举时不得打开设备，否则会点亮摄像头指示灯。
        # 仅列出本进程已打开的设备；未打开时给一个占位项，真正打开发生在用户启动画面源之后。
        _ = probe_max
        seen = {c["id"] for c in cams}
        for sid in list(_OPEN_DEVICES):
            if sid not in seen:
                real.append({"id": sid, "path": sid, "fake": False, "device_name": ""})
                seen.add(sid)
        if not real and "0" not in seen:
            real.append({"id": "0", "path": "0", "fake": False, "device_name": ""})
    _label_real_cameras(real)
    for c in real:
        c.pop("device_name", None)
        cams.append(c)
    for c in cams:
        c["busy"] = _OPEN_DEVICES.get(c["id"])
    return cams


@register_source("camera")
class CameraSource(FrameSource):
    """options: width, height, fps, queue_size(=4, 仅 push 模式), reconnect_s(=10), owner"""

    def __init__(self, uri: str = "0", **options):
        super().__init__(uri, **options)
        self.push_mode = uri.startswith("push://")
        self._q: "queue.Queue[tuple]" = queue.Queue(maxsize=int(options.get("queue_size", 4)))
        self._cap: Optional[cv2.VideoCapture] = None
        self._w = int(options.get("width", 0))
        self._h = int(options.get("height", 0))
        self._fps = float(options.get("fps", 0))
        self.reconnect_s = float(options.get("reconnect_s", 10))
        self.owner = options.get("owner", "识别管道")
        self._dev_id = uri.replace("/dev/video", "") if not self.push_mode else None
        self._fake = fake_cameras().get(self._dev_id or "")
        self._fail_since: Optional[float] = None
        self._next_t = 0.0
        self.reconnects = 0
        self.pushed = 0

    # ---- 推流插件调用入口 ----
    def push_frame(self, image: np.ndarray, pts: Optional[float] = None) -> bool:
        """外部插件推入一帧 BGR 图像。队列满时丢最旧帧（保实时性）。"""
        if self.state != SourceState.RUNNING:
            return False
        item = (image, pts if pts is not None else time.time() - self._t0)
        try:
            self._q.put_nowait(item)
        except queue.Full:
            try:
                self._q.get_nowait()
            except queue.Empty:
                pass
            self._q.put_nowait(item)
        self.pushed += 1
        return True

    def end_of_stream(self) -> None:
        self._q.put(None)

    # ---- 设备 ----
    def _open_device(self) -> None:
        if self._fake:
            self._cap = cv2.VideoCapture(self._fake)
            if not self._cap.isOpened():
                raise RuntimeError(f"模拟摄像头文件无法打开：{self._fake}")
            self._fps = self._fps or self._cap.get(cv2.CAP_PROP_FPS) or 25
            self._w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            self._h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            return
        dev = int(self._dev_id) if (self._dev_id or "").isdigit() else self.uri
        backend = cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_ANY
        self._cap = cv2.VideoCapture(dev, backend)
        if not self._cap.isOpened():
            self._cap.release()
            self._cap = None
            exists = (platform.system() != "Linux") or Path(
                f"/dev/video{self._dev_id}" if (self._dev_id or "").isdigit() else self.uri).exists()
            if exists:
                raise CameraBusyError(f"摄像头 {self.uri} 存在但无法打开：可能正被其他程序（会议软件/浏览器）占用，"
                                      f"或没有摄像头权限（Linux 需在 video 组，macOS 需在 系统设置→隐私→摄像头 授权）")
            raise RuntimeError(f"摄像头 {self.uri} 不存在")
        if self._w:
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._w)
        if self._h:
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._h)
        if self._fps:
            self._cap.set(cv2.CAP_PROP_FPS, self._fps)
        self._w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or self._w
        self._h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or self._h

    def _open(self) -> None:
        if self.push_mode:
            return
        with _OPEN_LOCK:
            if self._dev_id in _OPEN_DEVICES:
                raise CameraBusyError(f"摄像头 {self.uri} 正被本应用的「{_OPEN_DEVICES[self._dev_id]}」使用，请先停止")
            self._open_device()
            _OPEN_DEVICES[self._dev_id] = self.owner

    def _read(self):
        if self.push_mode:
            try:
                item = self._q.get(timeout=0.5)
            except queue.Empty:
                return None
            if item is None:
                self.state = SourceState.EOF
                return None
            return item
        if self._cap is None:
            return self._try_reconnect()
        if self._fake:  # 文件当摄像头：按原帧率实时节拍，循环播放
            now = time.monotonic()
            if now < self._next_t:
                time.sleep(self._next_t - now)
            self._next_t = max(now, self._next_t) + 1.0 / (self._fps or 25)
        ok, img = self._cap.read()
        if not ok and self._fake:
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, img = self._cap.read()
        if not ok:
            return self._try_reconnect()
        self._fail_since = None
        return img, time.time() - self._t0

    def _try_reconnect(self):
        """读帧失败（拔插 / 休眠唤醒）：释放后每秒重开一次，超过 reconnect_s 报错结束。"""
        now = time.time()
        if self._fail_since is None:
            self._fail_since = now
            logger.warning("camera %s read failed, reconnecting", self.uri)
        if now - self._fail_since > self.reconnect_s:
            self.last_error = f"摄像头 {self.uri} 断开超过 {self.reconnect_s:.0f}s"
            self.state = SourceState.ERROR
            return None
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        time.sleep(1.0)
        try:
            self._open_device()
            self.reconnects += 1
            logger.info("camera %s reopened", self.uri)
        except Exception as e:  # noqa: BLE001
            logger.debug("reopen failed: %s", e)
        return None

    def _close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        if not self.push_mode:
            with _OPEN_LOCK:
                _OPEN_DEVICES.pop(self._dev_id, None)

    def info(self) -> SourceInfo:
        return SourceInfo(kind=self.kind, uri=self.uri, width=self._w, height=self._h,
                          fps=self._fps, extra={"push_mode": self.push_mode, "fake": bool(self._fake),
                                                "reconnects": self.reconnects, "pushed": self.pushed})
