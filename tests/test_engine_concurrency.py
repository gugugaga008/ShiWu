"""共享 LocalEngine 的线程串行化回归；模型替换为可控协程，数据仅用临时库。"""
from __future__ import annotations

import asyncio
import io
import threading
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import Mock

import cv2
import numpy as np
import pytest


class Recognizer:
    def __init__(self, **kwargs):
        self.similarity_threshold = 0.5
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.active = 0
        self.max_active = 0
        self.calls = []
        self.fail = False
        self.block_name = None

    async def initialize(self):
        pass

    async def operation(self, name, result):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.calls.append(name)
        try:
            if self.block_name is None or name == self.block_name:
                self.entered.set()
                deadline = asyncio.get_running_loop().time() + 3
                while not self.release.is_set():
                    assert asyncio.get_running_loop().time() < deadline, "测试协程未被释放"
                    await asyncio.sleep(0.005)
            await asyncio.sleep(0.001)
            if self.fail:
                self.fail = False
                raise ValueError("测试推理失败")
            return result
        finally:
            self.active -= 1

    async def refresh_cache(self, org):
        return await self.operation("refresh", None)

    async def _extract_embeddings(self, image, faces):
        vector = [0, 1] if image is not None and image[0, 0, 0] else [1, 0]
        return await self.operation("embed", [np.array(vector, np.float32) for _ in faces])

    async def export_embeddings(self, org):
        return await self.operation("export", {"known": np.array([1, 0], np.float32)})

    async def recognize_faces(self, image, faces, organization_id=None):
        return await self.operation("recognize", [{"person_id": "known", "similarity": 1.0} for _ in faces])


class Detector:
    def __init__(self, **kwargs):
        self.min_face_size = 40

    def set_min_face_size(self, value):
        self.min_face_size = value

    def detect_faces(self, image):
        return [{"bbox": {"x": 40, "y": 40, "width": 100, "height": 100}, "confidence": 0.99,
                 "landmarks_5": [[65, 70], [115, 70], [90, 95], [70, 115], [110, 115]]}]


@pytest.fixture
def engine(monkeypatch, tmp_path):
    monkeypatch.setenv("SHIWU_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SHIWU_GALLERY_DIR", str(tmp_path / "gallery"))
    monkeypatch.setenv("SHIWU_MACHINE_KEY", "11" * 32)
    from shiwu.core import models
    from shiwu.stream.engine import LocalEngine
    monkeypatch.setattr(models, "FaceDetector", Detector)
    monkeypatch.setattr(models, "FaceRecognizer", Recognizer)
    eng = LocalEngine(enable_tracking=False)
    yield eng
    eng.recognizer.release.set()
    # 测试失败也不能因锁死挂住 pytest 退出。
    assert eng._loop_lock.acquire(timeout=3), "引擎锁未释放"
    try:
        eng.close()
    finally:
        eng._loop_lock.release()


def spawn(call):
    future = Future()
    started = threading.Event()

    def work():
        future.set_running_or_notify_cancel()
        started.set()
        try:
            future.set_result(call())
        except BaseException as error:
            future.set_exception(error)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    assert started.wait(2)
    return future


def operation(engine, name):
    image = np.zeros((200, 200, 3), np.uint8)
    faces = engine.detector.detect_faces(image)
    return {"embed": lambda: engine.embed(image, faces), "refresh": engine.refresh_gallery,
            "recognize": lambda: engine.process(image), "export": engine.export_embeddings}[name]


@pytest.mark.parametrize("first", ["embed", "refresh", "recognize", "export"])
@pytest.mark.parametrize("second", ["embed", "refresh", "recognize", "export"])
def test_loop_operations_serialize_across_threads(engine, first, second):
    recognizer = engine.recognizer
    recognizer.release.clear()
    one = spawn(operation(engine, first))
    assert recognizer.entered.wait(2)
    two = spawn(operation(engine, second))
    try:
        # 第一协程仍在 await，第二调用必须等待，不能立即报 loop already running。
        with pytest.raises(TimeoutError):
            two.result(timeout=0.05)
        assert recognizer.calls == [first]
    finally:
        recognizer.release.set()
    one.result(timeout=3)
    two.result(timeout=3)
    assert recognizer.calls == [first, second]
    assert recognizer.max_active == 1


def test_gallery_process_can_reenter_embed_and_export_without_deadlock(engine, tmp_path):
    from shiwu.enroll import LocalGallery
    gallery = LocalGallery(str(tmp_path / "templates.db"))
    engine.gallery = gallery
    try:
        result = spawn(operation(engine, "recognize")).result(timeout=3)
        assert result[0]["person_id"] == "known"
        assert engine.recognizer.calls == ["embed", "export"]
        assert engine.recognizer.max_active == 1
    finally:
        gallery._db.close()


def test_failed_coroutine_releases_lock_for_other_thread(engine):
    engine.recognizer.fail = True
    with pytest.raises(ValueError, match="测试推理失败"):
        spawn(operation(engine, "embed")).result(timeout=3)
    assert spawn(engine.export_embeddings).result(timeout=3)["known"].tolist() == [1, 0]
    assert engine.recognizer.max_active == 1


def test_refresh_requested_during_refresh_is_not_lost(engine):
    recognizer = engine.recognizer
    recognizer.release.clear()
    refreshing = spawn(engine.refresh_gallery)
    assert recognizer.entered.wait(2)
    engine.request_refresh()
    recognizer.release.set()
    refreshing.result(timeout=3)
    assert engine._refresh_pending
    spawn(engine.export_embeddings).result(timeout=3)
    assert recognizer.calls == ["refresh", "refresh", "export"]
    assert not engine._refresh_pending


def test_close_waits_for_inflight_embedding_and_creates_no_late_coroutine(engine):
    recognizer = engine.recognizer
    recognizer.release.clear()
    embedding = spawn(operation(engine, "embed"))
    assert recognizer.entered.wait(2)
    closing = spawn(engine.close)
    try:
        with pytest.raises(TimeoutError):
            closing.result(timeout=0.05)
        assert not engine._loop.is_closed()
    finally:
        recognizer.release.set()
    embedding.result(timeout=3)
    closing.result(timeout=3)
    assert engine._loop.is_closed()
    with pytest.raises(RuntimeError, match="Event loop is closed"):
        engine.embed(None, [])


def test_file_live_photo_and_known_match_share_one_loop(engine, monkeypatch, tmp_path):
    from shiwu.api.boss import routes
    from shiwu.api.boss.capture import CaptureConfig
    from shiwu.api.boss.runtime import BossRuntime
    from shiwu.enroll import LocalGallery
    from starlette.datastructures import UploadFile

    gallery = LocalGallery(str(tmp_path / "templates.db"))
    engine.gallery = gallery
    engine._new_tracker = lambda: SimpleNamespace(update=lambda faces, **kwargs: faces)
    runtime = object.__new__(BossRuntime)
    runtime._engine_lock = threading.Lock()
    runtime._capture_engine = engine
    runtime.gallery = gallery
    runtime.captures = {}
    runtime.runners = {}
    runtime.resolve_video = lambda uri: uri
    runtime.name_of = lambda pid: "测试人员"
    runtime.invalidate_people = Mock(side_effect=engine.request_refresh)
    monkeypatch.setattr(routes, "runtime", runtime)

    async def members():
        return [{"person_id": "photo-person"}]

    monkeypatch.setattr(routes.bridge, "list_members", members)
    image = np.zeros((200, 200, 3), np.uint8)

    class Source:
        def __init__(self):
            self.frames = [SimpleNamespace(image=image, pts=0.0, index=0)]
            self.is_running = False

        def start(self):
            return self

        def read(self):
            return self.frames.pop() if self.frames else None

        def stop(self):
            pass

    monkeypatch.setattr("shiwu.api.boss.capture.create_source", lambda *args, **kwargs: Source())
    sessions = []
    engine.recognizer.block_name = "embed"
    engine.recognizer.release.clear()
    cfg = CaptureConfig(min_samples=1, min_cluster_size=1)
    try:
        # 文件实际 _record 正在提特征时，现场 start_capture 的 refresh 必须等待。
        file = runtime.start_capture("file", "test.mp4", cfg)
        sessions.append(file)
        assert engine.recognizer.entered.wait(2)
        live_start = spawn(lambda: runtime.start_capture("camera", "test-camera", cfg))
        encoded = cv2.imencode(".jpg", np.full_like(image, 100))[1].tobytes()
        photo = UploadFile(file=io.BytesIO(encoded), filename="test.jpg")
        upload = spawn(lambda: asyncio.run(routes.person_photos("photo-person", [photo])))
        known = spawn(lambda: runtime.known_match(np.array([1, 0], np.float32)))
        try:
            with pytest.raises(TimeoutError):
                live_start.result(timeout=0.05)
            assert not upload.done()
            assert not known.done()
        finally:
            engine.recognizer.release.set()
        live = live_start.result(timeout=5)
        sessions.append(live)
        assert upload.result(timeout=5)["accepted"] == 1
        assert known.result(timeout=5)[0] == "known"
        for session in sessions:
            session._thread.join(5)
            assert not session._thread.is_alive(), "采集线程锁死"
            assert session.status == "ready", session.error
            assert len(session.samples) == 1
            assert session.clusters[1].known_person_id == "known"
        assert runtime.captures[file.id] is file and runtime.captures[live.id] is live
        assert file.id != live.id
        assert gallery.count() == {"photo-person": 1}
        assert engine.recognizer.max_active == 1
    finally:
        engine.recognizer.release.set()
        for session in sessions:
            session.cancel()
            session._thread.join(5)
        gallery._db.close()
