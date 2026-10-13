"""StreamPipeline：任意 FrameSource -> 抽帧 -> FaceEngine -> 事件。"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from .base import Frame, FrameSource, SourceState
from .engine import FaceEngine
from .events import EventBus, StreamEvent
from .voting import TrackVoter

logger = logging.getLogger(__name__)


@dataclass
class PipelineConfig:
    process_every_n: int = 1          # 每 N 帧处理 1 帧
    max_process_fps: float = 0.0      # 处理帧率上限（0 不限），与 every_n 叠加
    emit_frame_results: bool = True   # 每个处理帧发 frame_result
    recognize_cooldown_s: float = 5.0 # 同一 track+person 的 person_recognized 去重间隔
    track_lost_after_s: float = 2.0
    max_frames: Optional[int] = None  # 处理帧数上限（测试用）
    track_voting: bool = True         # 轨迹级投票
    vote_min_sim: float = 0.50        # 可靠命中的单帧相似度下限
    vote_min_hits: int = 1            # 轨迹定身份所需可靠命中次数
    # 自适应抽帧：画面里有人时用 active_fps，连续 idle_after_s 没人降到 idle_fps；
    # 同时按单帧耗时限制，保证识别占用 ≤ cpu_budget（单核比例）。开启后忽略 max_process_fps。
    adaptive: bool = False
    active_fps: float = 8.0
    idle_fps: float = 2.0
    idle_after_s: float = 3.0
    cpu_budget: float = 0.6


class StreamPipeline:
    def __init__(self, source: FrameSource, engine: FaceEngine,
                 config: Optional[PipelineConfig] = None,
                 bus: Optional[EventBus] = None,
                 name_resolver: Optional[Callable[[str], Optional[str]]] = None,
                 on_processed: Optional[Callable[[Frame, List[Dict]], None]] = None):
        self.source, self.engine = source, engine
        self.cfg = config or PipelineConfig()
        self.bus = bus or EventBus()
        self.name_resolver = name_resolver or (lambda pid: None)
        self.on_processed = on_processed   # 例如保存标注截图
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last_recog: Dict[tuple, float] = {}
        self._tracks: Dict[int, Dict] = {}
        self.voter = (TrackVoter(self.cfg.vote_min_sim, self.cfg.vote_min_hits)
                      if self.cfg.track_voting else None)
        self.stats = {"frames_read": 0, "frames_processed": 0, "faces": 0,
                      "recognized": 0, "proc_ms_total": 0.0}
        self._ema_ms = 0.0
        self._last_face_t = -1e9

    # ---- 控制 ----
    def start(self, background: bool = True) -> "StreamPipeline":
        self._stop.clear()
        if background:
            self._thread = threading.Thread(target=self.run, name="StreamPipeline", daemon=True)
            self._thread.start()
        else:
            self.run()
        return self

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread:
            self._thread.join(timeout)

    # ---- 主循环 ----
    def _emit(self, type_, frame: Optional[Frame], data):
        self.bus.emit(StreamEvent(
            type=type_, source_id=self.source.source_id,
            frame_index=frame.index if frame else -1,
            pts=round(frame.pts, 3) if frame else 0.0,
            wall_time=frame.wall_time if frame else time.time(), data=data))

    def run(self) -> None:
        src = self.source
        try:
            if not src.is_running:
                src.start()
        except Exception as e:  # noqa: BLE001
            self._emit("error", None, {"stage": "source_start", "error": str(e)})
            return
        self.engine.reset()
        if self.voter:
            self.voter.reset()
        self._emit("source_started", None, src.info().to_dict())
        last_proc = 0.0
        fr = int(round(src.info().fps or 25))
        try:
            while not self._stop.is_set():
                frame = src.read()
                if frame is None:
                    if src.state != SourceState.RUNNING:
                        break
                    continue
                self.stats["frames_read"] += 1
                if frame.index % max(1, self.cfg.process_every_n):
                    continue
                if self.cfg.adaptive:
                    now = time.monotonic()
                    target = self.target_fps()
                    if now - last_proc < 1.0 / target:
                        continue
                    last_proc = now
                elif self.cfg.max_process_fps > 0:
                    now = time.monotonic()
                    if now - last_proc < 1.0 / self.cfg.max_process_fps:
                        continue
                    last_proc = now
                self._process(frame, fr)
                if self.cfg.max_frames and self.stats["frames_processed"] >= self.cfg.max_frames:
                    break
        except Exception as e:  # noqa: BLE001
            logger.exception("pipeline error")
            self._emit("error", None, {"stage": "loop", "error": str(e)})
        finally:
            src.stop()
            self._emit("source_stopped", None, {"stats": self.summary()})

    def target_fps(self) -> float:
        """当前自适应处理帧率。"""
        c = self.cfg
        busy = time.monotonic() - self._last_face_t <= c.idle_after_s
        fps = c.active_fps if busy else c.idle_fps
        if self._ema_ms > 0:
            fps = min(fps, c.cpu_budget * 1000.0 / self._ema_ms)
        fps = max(0.5, fps)
        self.stats["target_fps"] = round(fps, 2)
        return fps

    def _process(self, frame: Frame, frame_rate: int) -> None:
        t = time.perf_counter()
        faces = self.engine.process(frame.image, frame_rate=frame_rate)
        ms = (time.perf_counter() - t) * 1000
        self._ema_ms = ms if self._ema_ms <= 0 else 0.8 * self._ema_ms + 0.2 * ms
        if faces:
            self._last_face_t = time.monotonic()
        if self.voter:
            self.voter.update(faces, frame.pts)
            for ch in self.voter.changes:  # 轨迹身份确定/变更：下游可据此回填该轨迹的历史帧
                ch["name"] = self.name_resolver(ch["person_id"]) if ch["person_id"] else None
                self._emit("track_identity", frame, ch)
        self.stats["frames_processed"] += 1
        self.stats["faces"] += len(faces)
        self.stats["proc_ms_total"] += ms
        for f in faces:
            f["name"] = self.name_resolver(f["person_id"]) if f.get("person_id") else None
        if self.cfg.emit_frame_results:
            self._emit("frame_result", frame, {
                "proc_ms": round(ms, 1),
                "faces": [_slim(f) for f in faces]})
        now = frame.pts
        for f in faces:
            tid = f.get("track_id", -1)
            self._tracks[tid] = {"last": now, "person_id": f.get("person_id")}
            if f.get("person_id"):
                key = (tid, f["person_id"])
                if now - self._last_recog.get(key, -1e9) >= self.cfg.recognize_cooldown_s:
                    self._last_recog[key] = now
                    self.stats["recognized"] += 1
                    self._emit("person_recognized", frame, _slim(f))
            elif tid >= 0 and tid not in getattr(self, "_unknown_seen", set()):
                self.__dict__.setdefault("_unknown_seen", set()).add(tid)
                self._emit("face_unknown", frame, _slim(f))
        for tid, st in list(self._tracks.items()):
            if now - st["last"] > self.cfg.track_lost_after_s:
                del self._tracks[tid]
                self._emit("track_lost", frame, {"track_id": tid, "person_id": st["person_id"]})
        if self.on_processed:
            self.on_processed(frame, faces)

    def summary(self) -> Dict:
        s = dict(self.stats)
        n = s["frames_processed"] or 1
        s["avg_proc_ms"] = round(s.pop("proc_ms_total") / n, 1)
        return s


def _slim(f: Dict) -> Dict:
    b = f.get("bbox", {})
    return {"track_id": f.get("track_id"), "person_id": f.get("person_id"),
            "name": f.get("name"), "similarity": round(f.get("similarity", 0.0), 4),
            "det_conf": round(float(f.get("confidence", 0.0)), 4),
            "bbox": [round(b.get("x", 0)), round(b.get("y", 0)),
                     round(b.get("width", 0)), round(b.get("height", 0))],
            "frame_person_id": f.get("frame_person_id", f.get("person_id")),
            "frame_similarity": round(f.get("frame_similarity", f.get("similarity", 0.0)), 4),
            "identity_source": f.get("identity_source", "frame" if f.get("person_id") else "none")}
