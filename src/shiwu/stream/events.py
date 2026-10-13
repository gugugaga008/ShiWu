"""事件模型与分发：回调 / 队列 / JSONL 文件 / WebSocket（预留）。"""
from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Protocol

logger = logging.getLogger(__name__)


@dataclass
class StreamEvent:
    """type: source_started | frame_result | person_recognized | face_unknown |
             track_lost | track_identity | source_stopped | error"""
    type: str
    source_id: str
    frame_index: int = -1
    pts: float = 0.0
    wall_time: float = 0.0
    data: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class EventSink(Protocol):
    def handle(self, event: StreamEvent) -> None: ...


class CallbackSink:
    def __init__(self, fn: Callable[[StreamEvent], None], types: Optional[List[str]] = None):
        self.fn, self.types = fn, set(types) if types else None

    def handle(self, event: StreamEvent) -> None:
        if self.types is None or event.type in self.types:
            self.fn(event)


class QueueSink:
    """线程安全队列，消费者自行 get()。满时丢弃最旧事件。"""
    def __init__(self, maxsize: int = 1000, types: Optional[List[str]] = None):
        self.queue: "queue.Queue[StreamEvent]" = queue.Queue(maxsize=maxsize)
        self.types = set(types) if types else None

    def handle(self, event: StreamEvent) -> None:
        if self.types is not None and event.type not in self.types:
            return
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            self.queue.put_nowait(event)


class JsonlSink:
    def __init__(self, path: str, types: Optional[List[str]] = None):
        self.path, self.types = path, set(types) if types else None
        self._lock = threading.Lock()
        self._fh = open(path, "w", encoding="utf-8")

    def handle(self, event: StreamEvent) -> None:
        if self.types is not None and event.type not in self.types:
            return
        with self._lock:
            self._fh.write(json.dumps(event.to_dict(), ensure_ascii=False) + "\n")
            self._fh.flush()

    def close(self) -> None:
        self._fh.close()


class WebSocketSink:
    """预留：把事件广播给 FastAPI WebSocket 连接。

    用法（挂到 FastAPI 时）：
        sink = WebSocketSink(loop=asyncio.get_running_loop())
        @app.websocket("/ws/boss/{cid}")
        async def ws(websocket): await websocket.accept(); sink.add(websocket); ...
    pipeline 在工作线程调用 handle()，这里用 run_coroutine_threadsafe 切回事件循环。
    """
    def __init__(self, loop: Optional[asyncio.AbstractEventLoop] = None,
                 types: Optional[List[str]] = None):
        self.loop = loop
        self.types = set(types) if types else None
        self._clients: set = set()

    def add(self, ws) -> None:
        self._clients.add(ws)

    def remove(self, ws) -> None:
        self._clients.discard(ws)

    def handle(self, event: StreamEvent) -> None:
        if not self._clients or self.loop is None:
            return
        if self.types is not None and event.type not in self.types:
            return
        payload = event.to_dict()
        for ws in list(self._clients):
            fut = asyncio.run_coroutine_threadsafe(ws.send_json(payload), self.loop)
            fut.add_done_callback(lambda f, w=ws: f.exception() and self.remove(w))


class EventBus:
    def __init__(self) -> None:
        self._sinks: List[Any] = []

    def subscribe(self, sink) -> Any:
        self._sinks.append(sink)
        return sink

    def unsubscribe(self, sink) -> None:
        if sink in self._sinks:
            self._sinks.remove(sink)

    def emit(self, event: StreamEvent) -> None:
        for s in list(self._sinks):
            try:
                s.handle(event)
            except Exception as e:  # noqa: BLE001
                logger.warning("sink %s failed: %s", s, e)
