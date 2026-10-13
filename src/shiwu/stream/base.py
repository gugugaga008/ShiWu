"""视频源抽象：所有输入（文件 / 网络流 / 摄像头插件）都实现 FrameSource。"""
from __future__ import annotations

import abc
import enum
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, Optional

import numpy as np


class SourceState(str, enum.Enum):
    CREATED = "created"
    RUNNING = "running"
    STOPPED = "stopped"
    EOF = "eof"
    ERROR = "error"


@dataclass
class SourceInfo:
    """视频源元信息。"""
    kind: str                       # 注册名，如 "file" / "url" / "camera"
    uri: str                        # 文件路径 / URL / 设备号
    width: int = 0
    height: int = 0
    fps: float = 0.0                # 源原生帧率（未知为 0）
    frame_count: int = -1           # 未知/直播为 -1
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind, "uri": self.uri, "width": self.width,
            "height": self.height, "fps": self.fps,
            "frame_count": self.frame_count, "extra": self.extra,
        }


@dataclass
class Frame:
    """一帧画面 + 时间戳。image 为 BGR uint8 (H, W, 3)。"""
    image: np.ndarray
    index: int                      # 源内帧序号（从 0 开始，循环播放时持续递增）
    pts: float                      # 媒体时间（秒），文件取 POS_MSEC，直播取相对开始时间
    wall_time: float                # 采集时的 time.time()
    source_id: str = ""
    meta: Dict[str, Any] = field(default_factory=dict)


class FrameSource(abc.ABC):
    """视频源接口。

    生命周期：start() -> read()* -> stop()。也支持 with 语句与迭代。
    read() 返回 None 表示暂时无帧或已结束；结束时 state == EOF。
    实现者只需关心 _open/_read/_close 三个钩子。
    """

    kind: str = "abstract"

    def __init__(self, uri: str, source_id: Optional[str] = None, **options: Any):
        self.uri = uri
        self.source_id = source_id or f"{self.kind}:{uri}"
        self.options = options
        self.state = SourceState.CREATED
        self._index = 0
        self._t0 = 0.0
        self.last_error: Optional[str] = None

    # ---- 公共 API ----
    def start(self) -> "FrameSource":
        if self.state == SourceState.RUNNING:
            return self
        try:
            self._open()
        except Exception as e:  # noqa: BLE001
            self.state = SourceState.ERROR
            self.last_error = str(e)
            raise
        self._t0 = time.time()
        self._index = 0
        self.state = SourceState.RUNNING
        return self

    def read(self) -> Optional[Frame]:
        if self.state != SourceState.RUNNING:
            return None
        item = self._read()
        if item is None:
            return None
        image, pts = item
        frame = Frame(image=image, index=self._index, pts=pts,
                      wall_time=time.time(), source_id=self.source_id)
        self._index += 1
        return frame

    def stop(self) -> None:
        if self.state in (SourceState.STOPPED,):
            return
        try:
            self._close()
        finally:
            if self.state != SourceState.ERROR:
                self.state = SourceState.STOPPED

    @property
    def is_running(self) -> bool:
        return self.state == SourceState.RUNNING

    @abc.abstractmethod
    def info(self) -> SourceInfo: ...

    # ---- 子类钩子 ----
    @abc.abstractmethod
    def _open(self) -> None: ...

    @abc.abstractmethod
    def _read(self) -> Optional[tuple]:
        """返回 (bgr_image, pts_seconds)；无帧返回 None（结束时把 state 置为 EOF）。"""

    @abc.abstractmethod
    def _close(self) -> None: ...

    # ---- 便利 ----
    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()

    def __iter__(self) -> Iterator[Frame]:
        while self.is_running:
            f = self.read()
            if f is None:
                if self.state != SourceState.RUNNING:
                    break
                time.sleep(0.005)
                continue
            yield f
