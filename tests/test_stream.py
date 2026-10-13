"""stream 包单元测试（不依赖模型）+ 可选冒烟测试（需 ONNX 模型与素材）。"""
import os
import sys
import threading
from pathlib import Path

import cv2
import numpy as np
import pytest

from shiwu.stream import (  # noqa: E402
    FrameSource, SourceInfo, SourceState, register_source, create_source, available_sources,
    StreamPipeline, PipelineConfig, EventBus, QueueSink, CallbackSink,
)
from shiwu.stream.engine import FaceEngine  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def tiny_video(tmp_path_factory):
    p = tmp_path_factory.mktemp("v") / "tiny.avi"
    w = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"MJPG"), 20, (64, 48))
    for i in range(10):
        w.write(np.full((48, 64, 3), i * 20, np.uint8))
    w.release()
    return str(p)


def test_builtin_plugins_registered():
    assert {"file", "url", "camera"} <= set(available_sources())


def test_file_source_reads_all_then_eof(tiny_video):
    s = create_source("file", tiny_video, realtime=False).start()
    frames = list(s)
    assert len(frames) == 10 and s.state == SourceState.EOF
    assert [f.index for f in frames] == list(range(10))
    assert frames[-1].pts > frames[0].pts
    info = s.info()
    assert info.kind == "file"
    s.stop()


def test_file_source_loop_and_downsample(tiny_video):
    s = create_source("file", tiny_video, realtime=False, loop=True, max_loops=3).start()
    assert len(list(s)) == 30
    s = create_source("file", tiny_video, realtime=False, fps=10).start()  # 20fps -> 10fps
    assert len(list(s)) == 5


def test_file_source_missing():
    with pytest.raises(FileNotFoundError):
        create_source("file", "/nope.mp4").start()


def test_url_source_bad_url_raises():
    s = create_source("url", "rtsp://127.0.0.1:1/none", open_timeout_ms=500)
    with pytest.raises(RuntimeError):
        s.start()
    assert s.state == SourceState.ERROR


def test_camera_push_mode():
    cam = create_source("camera", "push://test").start()
    img = np.zeros((10, 10, 3), np.uint8)
    for _ in range(3):
        assert cam.push_frame(img)
    cam.end_of_stream()
    assert len(list(cam)) == 3


def test_custom_plugin_registration():
    @register_source("dummy")
    class Dummy(FrameSource):
        def _open(self): self.n = 0
        def _read(self):
            self.n += 1
            if self.n > 4:
                self.state = SourceState.EOF
                return None
            return np.zeros((4, 4, 3), np.uint8), self.n / 10
        def _close(self): pass
        def info(self): return SourceInfo(kind=self.kind, uri=self.uri, fps=10)
    s = create_source("dummy", "x").start()
    assert len(list(s)) == 4 and s.kind == "dummy"


class FakeEngine(FaceEngine):
    def process(self, image, frame_rate=None):
        return [{"bbox": {"x": 1, "y": 1, "width": 10, "height": 10}, "confidence": 0.9,
                 "track_id": 1, "person_id": "P1", "similarity": 0.8}]


def test_pipeline_events(tiny_video):
    bus = EventBus()
    q = bus.subscribe(QueueSink())
    seen = []
    bus.subscribe(CallbackSink(seen.append, types=["person_recognized"]))
    src = create_source("file", tiny_video, realtime=False)
    pipe = StreamPipeline(src, FakeEngine(), PipelineConfig(process_every_n=2, recognize_cooldown_s=100),
                          bus=bus, name_resolver=lambda pid: "张三")
    pipe.start(background=True); pipe.join(5)
    types = []
    while not q.queue.empty():
        types.append(q.queue.get().type)
    assert types[0] == "source_started" and types[-1] == "source_stopped"
    assert types.count("frame_result") == 5
    assert len(seen) == 1 and seen[0].data["name"] == "张三"
    assert pipe.summary()["frames_read"] == 10


def test_pipeline_stop_on_live_source():
    cam = create_source("camera", "push://live")
    pipe = StreamPipeline(cam, FakeEngine(), bus=EventBus())
    pipe.start(background=True)
    import time; time.sleep(0.1)
    cam.push_frame(np.zeros((8, 8, 3), np.uint8)); time.sleep(0.2)
    pipe.stop(2)
    assert pipe.stats["frames_processed"] >= 1


VIDEO = ROOT / "assets" / "videos" / "pexels_6760570.mp4"


@pytest.mark.skipif(not VIDEO.exists() or os.getenv("SKIP_SMOKE") == "1", reason="no asset")
def test_smoke_local_engine_detects_faces():
    from shiwu.stream.engine import LocalEngine
    eng = LocalEngine(min_face_size=40)
    src = create_source("file", str(VIDEO), realtime=False, fps=2)
    bus = EventBus(); q = bus.subscribe(QueueSink(types=["frame_result"]))
    StreamPipeline(src, eng, PipelineConfig(max_frames=5), bus=bus).start(background=False)
    counts = [len(q.queue.get().data["faces"]) for _ in range(q.queue.qsize())]
    assert len(counts) == 5 and max(counts) >= 2


# ---------------- 轨迹投票 ----------------
from shiwu.stream.voting import TrackVoter  # noqa: E402


def _f(tid, pid=None, sim=0.0, x=0):
    return {"track_id": tid, "person_id": pid, "similarity": sim,
            "bbox": {"x": x, "y": 0, "width": 10, "height": 10}}


def test_vote_propagates_after_one_reliable_hit():
    v = TrackVoter(min_sim=0.5)
    out = v.update([_f(1, None, 0.3)], 0.0)
    assert out[0]["person_id"] is None and out[0]["identity_source"] == "none"
    out = v.update([_f(1, "A", 0.6)], 0.2)
    assert out[0]["person_id"] == "A" and out[0]["identity_source"] == "frame"
    assert v.changes and v.changes[0]["person_id"] == "A" and v.changes[0]["first_seen"] == 0.0
    out = v.update([_f(1, None, 0.2)], 0.4)
    assert out[0]["person_id"] == "A" and out[0]["identity_source"] == "track"
    assert out[0]["frame_person_id"] is None and out[0]["frame_similarity"] == 0.2


def test_vote_weak_hit_not_trusted():
    v = TrackVoter(min_sim=0.5)
    out = v.update([_f(1, "A", 0.46)], 0.0)   # 过了识别阈值但不够「可靠」
    assert out[0]["person_id"] is None and out[0]["frame_person_id"] == "A"


def test_vote_conflict_majority_wins():
    v = TrackVoter(min_sim=0.5)
    v.update([_f(1, "A", 0.9)], 0)
    v.update([_f(1, "B", 0.6)], 1)
    out = v.update([_f(1, "B", 0.6)], 2)
    assert out[0]["person_id"] == "B" and out[0]["track_votes"] == {"A": 1, "B": 2}
    assert v.changes[0]["previous"] == "A"


def test_vote_tie_broken_by_similarity_sum():
    v = TrackVoter(min_sim=0.5)
    v.update([_f(1, "A", 0.55)], 0)
    out = v.update([_f(1, "B", 0.80)], 1)
    assert out[0]["person_id"] == "B"


def test_vote_untracked_and_duplicate_suppression():
    v = TrackVoter(min_sim=0.5)
    v.update([_f(1, "A", 0.7, 0), _f(2, "A", 0.6, 50)], 0)   # 两条轨迹都投了 A
    out = v.update([_f(1, None, 0.3, 0), _f(2, "A", 0.7, 50), _f(-1, "A", 0.9, 90)], 1)
    srcs = {f["track_id"]: (f["person_id"], f["identity_source"]) for f in out}
    # 本帧单帧命中 A 的轨迹 2 优先；轨迹 1 仅靠投票 -> 被抑制；负 id 只用单帧结果但同帧重复也被抑制
    assert srcs[2] == ("A", "frame")
    assert srcs[1][0] is None and srcs[1][1] == "suppressed_duplicate"
    assert sum(1 for f in out if f["person_id"] == "A") == 1


def test_vote_min_hits():
    v = TrackVoter(min_sim=0.5, min_hits=2)
    assert v.update([_f(1, "A", 0.9)], 0)[0]["person_id"] is None
    assert v.update([_f(1, "A", 0.9)], 1)[0]["person_id"] == "A"


def test_pipeline_emits_track_identity(tiny_video):
    class FlakyEngine(FaceEngine):
        n = 0
        def process(self, image, frame_rate=None):
            self.n += 1
            hit = self.n == 3
            return [{"bbox": {"x": 1, "y": 1, "width": 10, "height": 10}, "confidence": 0.9,
                     "track_id": 7, "person_id": "P" if hit else None, "similarity": 0.8 if hit else 0.1}]
    bus = EventBus(); q = bus.subscribe(QueueSink())
    StreamPipeline(create_source("file", tiny_video, realtime=False), FlakyEngine(),
                   bus=bus).start(background=False)
    evs = [q.queue.get() for _ in range(q.queue.qsize())]
    ti = [e for e in evs if e.type == "track_identity"]
    assert len(ti) == 1 and ti[0].data["track_id"] == 7 and ti[0].data["frames_so_far"] == 3
    fr = [e for e in evs if e.type == "frame_result"]
    srcs = [e.data["faces"][0]["identity_source"] for e in fr]
    assert srcs[:3] == ["none", "none", "frame"] and set(srcs[3:]) == {"track"}


def test_pipeline_voting_can_be_disabled(tiny_video):
    class E(FaceEngine):
        def process(self, image, frame_rate=None):
            return [{"bbox": {"x": 1, "y": 1, "width": 10, "height": 10}, "track_id": 1,
                     "person_id": None, "similarity": 0.1}]
    p = StreamPipeline(create_source("file", tiny_video, realtime=False), E(),
                       PipelineConfig(track_voting=False), bus=EventBus())
    assert p.voter is None
