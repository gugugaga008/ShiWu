"""本地视频文件源：支持循环播放、按目标帧率节流（realtime）或尽快读取。"""
from __future__ import annotations

import os
import time
from typing import Optional

import cv2

from ..base import FrameSource, SourceInfo, SourceState
from ..registry import register_source


@register_source("file")
class FileVideoSource(FrameSource):
    """options:
        loop (bool=False)       到结尾后从头播放
        fps (float|None)        输出帧率上限；None 时 realtime 用源帧率
        realtime (bool=True)    按帧率节流，模拟实时摄像头；False 则尽快读
        max_loops (int|None)    循环次数上限
    """

    def __init__(self, uri: str, **options):
        super().__init__(uri, **options)
        self.loop = bool(options.get("loop", False))
        self.realtime = bool(options.get("realtime", True))
        self.target_fps: Optional[float] = options.get("fps")
        self.max_loops: Optional[int] = options.get("max_loops")
        self._cap: Optional[cv2.VideoCapture] = None
        self._loops = 0
        self._pts_offset = 0.0
        self._next_due = 0.0
        self._src_fps = 0.0
        self._duration = 0.0

    def _open(self) -> None:
        if not os.path.isfile(self.uri):
            raise FileNotFoundError(self.uri)
        self._cap = cv2.VideoCapture(self.uri)
        if not self._cap.isOpened():
            raise RuntimeError(f"cannot open video {self.uri}")
        self._src_fps = self._cap.get(cv2.CAP_PROP_FPS) or 25.0
        n = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self._duration = n / self._src_fps if n > 0 else 0.0
        self._next_due = time.monotonic()

    def _period(self) -> float:
        fps = self.target_fps or self._src_fps
        return 1.0 / fps if fps > 0 else 0.0

    def _read(self):
        assert self._cap is not None
        # 降帧：目标帧率低于源帧率时跳过中间帧
        if self.target_fps and self._src_fps > self.target_fps:
            skip = int(round(self._src_fps / self.target_fps)) - 1
            for _ in range(max(0, skip)):
                self._cap.grab()
        ok, img = self._cap.read()
        if not ok:
            if self.loop and (self.max_loops is None or self._loops + 1 < self.max_loops):
                self._loops += 1
                self._pts_offset += self._duration
                self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, img = self._cap.read()
            if not ok:
                self.state = SourceState.EOF
                return None
        pts = self._pts_offset + self._cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if self.realtime:
            period = self._period()
            now = time.monotonic()
            if self._next_due > now:
                time.sleep(self._next_due - now)
            self._next_due = max(self._next_due + period, time.monotonic() - period)
        return img, pts

    def _close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def info(self) -> SourceInfo:
        w = h = 0
        n = -1
        if self._cap is not None:
            w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            n = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        return SourceInfo(kind=self.kind, uri=self.uri, width=w, height=h,
                          fps=self.target_fps or self._src_fps, frame_count=n,
                          extra={"loop": self.loop, "realtime": self.realtime,
                                 "source_fps": self._src_fps, "loops_done": self._loops})
