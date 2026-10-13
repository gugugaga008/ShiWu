"""摄像头插件 + 自适应抽帧单元测试（不依赖模型）。"""
import sys
import time
from pathlib import Path

import numpy as np
import pytest

from shiwu.stream import PipelineConfig, StreamPipeline  # noqa: E402
from shiwu.stream.sources.camera_source import CameraBusyError, CameraSource, list_cameras  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "assets" / "videos" / "pexels_9652478.mp4"


@pytest.fixture
def fake_cam(monkeypatch):
    if not VIDEO.exists():
        pytest.skip("缺少素材")
    monkeypatch.setenv("SHIWU_FAKE_CAMERAS", f"7={VIDEO}")


def test_list_and_read_fake_camera(fake_cam):
    cams = list_cameras()
    c = [x for x in cams if x["id"] == "7"][0]
    assert c["fake"] and c["busy"] is None
    src = CameraSource("7", owner="测试").start()
    try:
        f = src.read()
        assert f is not None and f.image.shape[2] == 3
        assert src.info().width == 1280 and src.info().extra["fake"]
        assert [x for x in list_cameras() if x["id"] == "7"][0]["busy"] == "测试"
        with pytest.raises(CameraBusyError, match="正被本应用的「测试」使用"):
            CameraSource("/dev/video7").start()
    finally:
        src.stop()
    assert [x for x in list_cameras() if x["id"] == "7"][0]["busy"] is None


def test_missing_device_message():
    with pytest.raises(RuntimeError, match="不存在|无法打开"):
        CameraSource("/dev/video63").start()


def test_reconnect_then_error(fake_cam, monkeypatch):
    src = CameraSource("7", reconnect_s=1.5).start()
    src._cap.release()            # 模拟设备句柄失效（拔插 / 休眠）
    src._cap = None
    monkeypatch.setattr(src, "_open_device", lambda: (_ for _ in ()).throw(RuntimeError("gone")))
    t0 = time.time()
    while src.is_running and time.time() - t0 < 5:
        src.read()
    assert src.state.value == "error" and "断开" in src.last_error
    src.stop()


def test_reconnect_recovers(fake_cam):
    src = CameraSource("7", reconnect_s=5).start()
    src._cap.release()
    src._cap = None
    frames = [src.read() for _ in range(3)]
    assert src.reconnects == 1 and any(f is not None for f in frames)
    src.stop()


def test_push_mode_drops_oldest():
    src = CameraSource("push://electron", queue_size=2).start()
    img = np.zeros((10, 10, 3), np.uint8)
    for i in range(5):
        assert src.push_frame(img + i)
    a, b = src.read(), src.read()
    assert int(a.image[0, 0, 0]) == 3 and int(b.image[0, 0, 0]) == 4
    assert src.read() is None
    src.end_of_stream()
    src.read()
    assert src.state.value == "eof"


class SlowEngine:
    def __init__(self, ms, faces):
        self.ms, self.faces = ms, faces

    def reset(self):
        pass

    def process(self, image, frame_rate=None):
        time.sleep(self.ms / 1000)
        return [dict(f) for f in self.faces]


def _pipe(engine, **kw):
    src = CameraSource("push://t")
    return StreamPipeline(src, engine, PipelineConfig(adaptive=True, track_voting=False, **kw))


def test_adaptive_idle_active_and_cpu_cap():
    p = _pipe(SlowEngine(1, []), active_fps=8, idle_fps=2)
    assert p.target_fps() == 2                      # 没人：降频
    p._last_face_t = time.monotonic()
    assert p.target_fps() == 8                      # 有人：提频
    p._ema_ms = 200                                 # 单帧 200ms，预算 60% → ≤3fps
    assert p.target_fps() == pytest.approx(3.0)
    p._ema_ms = 5000
    assert p.target_fps() == 0.5                    # 下限


def test_adaptive_pipeline_processes_less_when_idle():
    def run(faces):
        p = _pipe(SlowEngine(1, faces), active_fps=10, idle_fps=2, idle_after_s=10)
        p.start(background=True)
        img = np.zeros((20, 20, 3), np.uint8)
        t0 = time.time()
        while time.time() - t0 < 1.6:
            p.source.push_frame(img)
            time.sleep(0.02)
        p.stop()
        return p.stats["frames_processed"]
    idle, busy = run([]), run([{"track_id": 1, "person_id": None, "bbox": {"x": 0, "y": 0, "width": 5, "height": 5}}])
    assert idle <= 5 and busy >= 10, (idle, busy)
