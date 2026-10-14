"""FaceEngine：识别引擎接口 + 本地 ONNX 实现。

直接实例化 shiwu.core.models 里的 FaceDetector / FaceRecognizer / FaceTracker，
复用 shiwu.config.models 的配置与同一个 face_database.db（与 /attendance 注册的人脸共享）。
"""
from __future__ import annotations

import abc
import asyncio
import threading
from typing import Dict, List, Optional

import numpy as np


class FaceEngine(abc.ABC):
    @abc.abstractmethod
    def process(self, image: np.ndarray, frame_rate: Optional[int] = None) -> List[Dict]:
        """返回人脸列表：{bbox{x,y,width,height}, confidence, landmarks_5, track_id,
        person_id|None, similarity}"""

    def reset(self) -> None:  # 换源时清空追踪状态
        pass

    def close(self) -> None:
        pass


class LocalEngine(FaceEngine):
    def __init__(self, similarity_threshold: Optional[float] = None,
                 min_face_size: Optional[int] = None,
                 organization_id: Optional[str] = None,
                 enable_tracking: bool = True,
                 gallery=None, include_library_templates: bool = True):
        from shiwu.config.models import (
            FACE_DETECTOR_CONFIG as DC, FACE_RECOGNIZER_CONFIG as RC,
            FACE_TRACKER_CONFIG as TC,
        )
        from shiwu.core.models import FaceDetector, FaceRecognizer, FaceTracker

        self.org = organization_id
        self._TC, self._FaceTracker = TC, FaceTracker
        self.detector = FaceDetector(
            model_path=str(DC["model_path"]), input_size=DC["input_size"],
            conf_threshold=DC["score_threshold"], nms_threshold=DC["nms_threshold"],
            top_k=DC["top_k"],
            min_face_size=DC["min_face_size"] if min_face_size is None else min_face_size,
            edge_margin=DC["edge_margin"],
        )
        self.recognizer = FaceRecognizer(
            model_path=str(RC["model_path"]), input_size=RC["input_size"],
            similarity_threshold=(RC["similarity_threshold"] if similarity_threshold is None
                                  else similarity_threshold),
            providers=RC["providers"], database_path=str(RC["database_path"]),
            session_options=RC["session_options"],
        )
        # 同一引擎可被采集、照片补录及监控线程共用；嵌套调用需可重入。
        self._loop_lock = threading.RLock()
        self._loop = asyncio.new_event_loop()
        self._run_recognizer(self.recognizer.initialize)
        self.gallery = gallery                       # LocalGallery：多模板
        self.include_library_templates = include_library_templates
        self.enable_tracking = enable_tracking
        self.tracker = self._new_tracker() if enable_tracking else None
        self._refresh_pending = False

    def _new_tracker(self):
        TC = self._TC
        return self._FaceTracker(track_thresh=TC["track_thresh"], match_thresh=TC["match_thresh"],
                                 track_buffer=TC["track_buffer"], frame_rate=TC["frame_rate"])

    def _run_recognizer(self, call, *args, **kwargs):
        with self._loop_lock:
            # 先检查再创建协程，避免 close 后留下未 await 的协程。
            if self._loop.is_closed():
                raise RuntimeError("Event loop is closed")
            return self._loop.run_until_complete(call(*args, **kwargs))

    def refresh_gallery(self) -> None:
        with self._loop_lock:
            self._refresh_pending = False
            self._run_recognizer(self.recognizer.refresh_cache, self.org)
            if self.gallery is not None:
                self.gallery._cache = None

    def export_embeddings(self) -> Dict[str, np.ndarray]:
        """串行读取识别库，供采集候选人物匹配使用。"""
        with self._loop_lock:
            if self._refresh_pending:
                self.refresh_gallery()
            return self._run_recognizer(self.recognizer.export_embeddings, self.org)

    def request_refresh(self) -> None:
        """线程安全：标记缓存失效，下一帧在引擎所在线程内刷新（人员变更后立即生效）。"""
        self._refresh_pending = True
        if self.gallery is not None:
            self.gallery.invalidate()

    def embed(self, image, faces) -> list:
        """对给定人脸（需 landmarks_5）提取归一化 512 维特征。"""
        return self._run_recognizer(self.recognizer._extract_embeddings, image, faces)

    def _match_with_gallery(self, image, faces):
        embs = self.embed(image, faces)
        M, ids = self.gallery.matrix()
        if self.include_library_templates:
            fx = self.export_embeddings()
            if fx:
                M = np.vstack([M, np.stack(list(fx.values())).astype(np.float32)]) if len(M) else \
                    np.stack(list(fx.values())).astype(np.float32)
                ids = list(ids) + list(fx.keys())
        res = self.gallery.match(np.stack(embs) if embs else np.zeros((0, 512)), M, ids,
                                 self.recognizer.similarity_threshold)
        return [{"person_id": p, "similarity": s} for p, s in res]

    def reset(self) -> None:
        with self._loop_lock:
            if self.enable_tracking:
                self.tracker = self._new_tracker()

    def process(self, image, frame_rate=None):
        with self._loop_lock:
            if self._refresh_pending:
                self.refresh_gallery()
            faces = self.detector.detect_faces(image) or []
            if self.tracker is not None:
                faces = self.tracker.update(faces, frame_rate=frame_rate)
            if not faces:
                return []
            if self.gallery is not None:
                results = self._match_with_gallery(image, faces)
            else:
                results = self._run_recognizer(
                    self.recognizer.recognize_faces, image, faces, organization_id=self.org)
            out = []
            for f, r in zip(faces, results):
                f = dict(f)
                f["person_id"] = r.get("person_id")
                f["similarity"] = float(r.get("similarity") or 0.0)
                out.append(f)
            return out

    def close(self) -> None:
        with self._loop_lock:
            self._loop.close()
