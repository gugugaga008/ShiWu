"""网络流源：RTSP / HTTP(MJPEG/HLS) / 任何 OpenCV(FFmpeg) 能打开的 URL。断流自动重连。"""
from __future__ import annotations

import time
from typing import Optional

import cv2

from ..base import FrameSource, SourceInfo, SourceState
from ..registry import register_source


@register_source("url")
class UrlStreamSource(FrameSource):
    """options:
        reconnect (bool=True)       断流后重连
        reconnect_delay (float=2.0)
        max_reconnects (int|None)
        backend (int=cv2.CAP_FFMPEG)
        open_timeout_ms (int=5000)
    """

    def __init__(self, uri: str, **options):
        super().__init__(uri, **options)
        self.reconnect = bool(options.get("reconnect", True))
        self.reconnect_delay = float(options.get("reconnect_delay", 2.0))
        self.max_reconnects: Optional[int] = options.get("max_reconnects")
        self.backend = options.get("backend", cv2.CAP_FFMPEG)
        self.open_timeout_ms = int(options.get("open_timeout_ms", 5000))
        self._cap: Optional[cv2.VideoCapture] = None
        self._reconnects = 0

    def _connect(self) -> None:
        params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, self.open_timeout_ms]
        self._cap = cv2.VideoCapture(self.uri, self.backend, params)
        if not self._cap.isOpened():
            raise RuntimeError(f"cannot open stream {self.uri}")

    def _open(self) -> None:
        self._connect()

    def _read(self):
        ok, img = (self._cap.read() if self._cap is not None else (False, None))
        if ok:
            return img, time.time() - self._t0
        if not self.reconnect or (self.max_reconnects is not None
                                  and self._reconnects >= self.max_reconnects):
            self.state = SourceState.EOF
            return None
        self._reconnects += 1
        self._close()
        time.sleep(self.reconnect_delay)
        try:
            self._connect()
        except RuntimeError as e:
            self.last_error = str(e)
        return None

    def _close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def info(self) -> SourceInfo:
        w = h = 0
        fps = 0.0
        if self._cap is not None:
            w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = float(self._cap.get(cv2.CAP_PROP_FPS) or 0.0)
        return SourceInfo(kind=self.kind, uri=self.uri, width=w, height=h, fps=fps,
                          extra={"reconnects": self._reconnects})
