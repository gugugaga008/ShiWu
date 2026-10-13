"""多路并发：多条管道共享一个识别引擎（模型只加载一份），每路有自己的跟踪器。

引擎内部有 asyncio loop 且 ONNX 会话非线程安全，所以推理用锁串行化；各路的自适应抽帧
会把等锁时间计入单帧耗时，从而在路数增加时自动降低每路帧率（资源控制）。
"""
from __future__ import annotations

import threading
from typing import Optional

from .engine import FaceEngine


class SharedEngineView(FaceEngine):
    def __init__(self, base, lock: Optional[threading.Lock] = None):
        self.base = base
        self.lock = lock or threading.Lock()
        self.tracker = base._new_tracker() if getattr(base, "enable_tracking", False) else None

    def process(self, image, frame_rate=None):
        with self.lock:
            saved = self.base.tracker
            self.base.tracker = self.tracker
            try:
                return self.base.process(image, frame_rate=frame_rate)
            finally:
                self.base.tracker = saved

    def reset(self) -> None:
        if self.tracker is not None:
            self.tracker = self.base._new_tracker()
