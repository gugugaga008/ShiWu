"""视频 / 现场采集：读取画面源 → 检测 + 追踪 + 特征 → DBSCAN 聚类 → 候选人物。"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import cv2
import numpy as np

from ...enroll import QualityConfig, check_face_quality
from ...stream import create_source

logger = logging.getLogger(__name__)


@dataclass
class Sample:
    id: int
    frame_id: int
    pts: float
    track_id: int
    bbox: Dict[str, float]
    landmarks_5: list
    confidence: float
    embedding: np.ndarray
    quality_ok: bool
    quality: Dict[str, float]
    reasons: List[str]


@dataclass
class Cluster:
    id: int
    sample_ids: List[int]
    status: str = "pending"          # pending | enrolled | ignored
    person_id: Optional[str] = None
    name: Optional[str] = None
    role: Optional[str] = None
    known_person_id: Optional[str] = None
    known_similarity: float = 0.0


@dataclass
class CaptureConfig:
    duration_s: float = 15.0
    fps: float = 5.0
    min_face: int = 40
    eps: float = 0.42                # DBSCAN 余弦距离半径（1 - 相似度）
    min_samples: int = 3
    track_smoothing: bool = True     # 同一轨迹的样本归入多数簇
    min_cluster_size: int = 3


class CaptureSession:
    def __init__(self, engine, kind: str, uri: str, cfg: CaptureConfig,
                 known_matcher=None, source_options: Optional[dict] = None):
        self.id = uuid.uuid4().hex[:12]
        self.engine, self.kind, self.uri, self.cfg = engine, kind, uri, cfg
        self.source_options = source_options or {}
        self.known_matcher = known_matcher       # fn(embedding) -> (person_id|None, sim)
        self.status = "created"                  # created|recording|clustering|ready|error|cancelled
        self.error: Optional[str] = None
        self.progress = 0.0
        self.frames: Dict[int, bytes] = {}       # frame_id -> jpeg（仅含人脸的帧）
        self.frame_shapes: Dict[int, tuple] = {}
        self.samples: Dict[int, Sample] = {}
        self.clusters: Dict[int, Cluster] = {}
        self.noise: List[int] = []
        self.created_at = time.time()
        self.lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.stats: Dict[str, float] = {}

    # ---------------- 运行 ----------------
    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"capture-{self.id}", daemon=True)
        self._thread.start()
        return self

    def cancel(self):
        self._cancel.set()

    def _run(self):
        try:
            self.status = "recording"
            self._record()
            if self._cancel.is_set():
                self.status = "cancelled"
                return
            self.status = "clustering"
            self._cluster()
            self.status = "ready"
            self.progress = 1.0
        except Exception as e:  # noqa: BLE001
            logger.exception("capture failed")
            self.status, self.error = "error", str(e)

    def _record(self):
        cfg = self.cfg
        opts = dict(self.source_options)
        if self.kind == "file":
            opts.setdefault("realtime", False)
            opts.setdefault("fps", cfg.fps)
        src = create_source(self.kind, self.uri, **opts).start()
        det = self.engine.detector
        old_min = det.min_face_size
        det.set_min_face_size(cfg.min_face)
        tracker = self.engine._new_tracker()
        t0 = time.time()
        sid = 0
        last_pts = None
        min_dt = 1.0 / cfg.fps if cfg.fps > 0 else 0
        try:
            while not self._cancel.is_set():
                fr = src.read()
                if fr is None:
                    if not src.is_running:
                        break
                    continue
                elapsed = fr.pts if self.kind == "file" else time.time() - t0
                if elapsed > cfg.duration_s:
                    break
                if self.kind != "file" and last_pts is not None and fr.pts - last_pts < min_dt:
                    continue
                last_pts = fr.pts
                self.progress = min(0.95, elapsed / cfg.duration_s)
                faces = det.detect_faces(fr.image) or []
                faces = tracker.update(faces, frame_rate=int(cfg.fps)) if faces else tracker.update([])
                faces = [f for f in faces if f.get("landmarks_5")]
                if not faces:
                    continue
                embs = self.engine.embed(fr.image, faces)
                self.frames[fr.index] = cv2.imencode(".jpg", fr.image, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
                self.frame_shapes[fr.index] = fr.image.shape
                for f, e in zip(faces, embs):
                    q = check_face_quality(fr.image.shape, f["bbox"], f["landmarks_5"], f.get("confidence", 1.0),
                                           QualityConfig())
                    self.samples[sid] = Sample(sid, fr.index, round(fr.pts, 3), int(f.get("track_id", -1)),
                                               f["bbox"], f["landmarks_5"], float(f.get("confidence", 0)),
                                               np.asarray(e, np.float32), q.ok, q.metrics, q.reasons)
                    sid += 1
        finally:
            det.set_min_face_size(old_min)
            src.stop()
        self.stats.update({"frames_with_faces": len(self.frames), "samples": len(self.samples),
                           "record_s": round(time.time() - t0, 1)})

    def _cluster(self):
        from sklearn.cluster import DBSCAN
        ids = list(self.samples)
        if not ids:
            return
        X = np.stack([self.samples[i].embedding for i in ids])
        labels = DBSCAN(eps=self.cfg.eps, min_samples=self.cfg.min_samples, metric="cosine").fit_predict(X)
        lab = dict(zip(ids, labels))
        if self.cfg.track_smoothing:
            by_track = defaultdict(list)
            for i in ids:
                if self.samples[i].track_id >= 0:
                    by_track[self.samples[i].track_id].append(i)
            for tid, sids in by_track.items():
                c = Counter(lab[i] for i in sids if lab[i] >= 0)
                if c:
                    major = c.most_common(1)[0][0]
                    for i in sids:
                        lab[i] = major
        groups = defaultdict(list)
        for i, l in lab.items():
            groups[l].append(i)
        self.noise = groups.pop(-1, [])
        cid = 0
        for l, sids in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            if len(sids) < self.cfg.min_cluster_size:
                self.noise += sids
                continue
            cid += 1
            self.clusters[cid] = Cluster(cid, sorted(sids))
            self._refresh_known(self.clusters[cid])
        self.stats.update({"clusters": len(self.clusters), "noise": len(self.noise)})

    def _refresh_known(self, c: Cluster):
        if not self.known_matcher:
            return
        m = np.mean([self.samples[i].embedding for i in c.sample_ids], axis=0)
        m = m / (np.linalg.norm(m) or 1)
        pid, sim = self.known_matcher(m)
        c.known_person_id, c.known_similarity = pid, round(float(sim), 3)

    # ---------------- 编辑 ----------------
    def merge(self, cluster_ids: List[int]) -> Cluster:
        with self.lock:
            cs = [self.clusters[i] for i in cluster_ids]
            keep = cs[0]
            for c in cs[1:]:
                keep.sample_ids += c.sample_ids
                del self.clusters[c.id]
            keep.sample_ids.sort()
            self._refresh_known(keep)
            return keep

    def split(self, cluster_id: int, sample_ids: Optional[List[int]] = None, by_track: bool = False
              ) -> List[Cluster]:
        with self.lock:
            src = self.clusters[cluster_id]
            new_groups: List[List[int]] = []
            if by_track:
                g = defaultdict(list)
                for i in src.sample_ids:
                    g[self.samples[i].track_id].append(i)
                new_groups = list(g.values())[1:]
            elif sample_ids:
                new_groups = [[i for i in sample_ids if i in src.sample_ids]]
            out = []
            for grp in new_groups:
                if not grp or len(grp) == len(src.sample_ids):
                    continue
                src.sample_ids = [i for i in src.sample_ids if i not in grp]
                nid = max(self.clusters) + 1
                self.clusters[nid] = Cluster(nid, sorted(grp))
                self._refresh_known(self.clusters[nid])
                out.append(self.clusters[nid])
            self._refresh_known(src)
            return [src] + out

    # ---------------- 输出 ----------------
    def frame_image(self, frame_id: int) -> np.ndarray:
        return cv2.imdecode(np.frombuffer(self.frames[frame_id], np.uint8), cv2.IMREAD_COLOR)

    def crop_jpeg(self, sample_id: int, size: int = 160) -> bytes:
        s = self.samples[sample_id]
        img = self.frame_image(s.frame_id)
        b = s.bbox
        cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        half = max(b["width"], b["height"]) * 0.75
        H, W = img.shape[:2]
        x1, y1 = int(max(0, cx - half)), int(max(0, cy - half))
        x2, y2 = int(min(W, cx + half)), int(min(H, cy + half))
        crop = cv2.resize(img[y1:y2, x1:x2], (size, size))
        return cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()

    def cluster_dict(self, c: Cluster, max_thumbs: int = 12) -> dict:
        ss = [self.samples[i] for i in c.sample_ids]
        good = sorted(ss, key=lambda s: (s.quality_ok, s.quality.get("width", 0)), reverse=True)
        # 缩略图：按时间均匀取，优先合格样本
        step = max(1, len(good) // max_thumbs)
        thumbs = good[::step][:max_thumbs]
        return {"id": c.id, "size": len(ss), "status": c.status, "person_id": c.person_id,
                "name": c.name, "role": c.role,
                "tracks": sorted({s.track_id for s in ss}),
                "quality_ok": sum(s.quality_ok for s in ss),
                "time_range": [min(s.pts for s in ss), max(s.pts for s in ss)],
                "known_person_id": c.known_person_id, "known_similarity": c.known_similarity,
                "cover_sample_id": good[0].id,
                "thumbs": [{"sample_id": s.id, "track_id": s.track_id, "pts": s.pts,
                            "quality_ok": s.quality_ok, "width": round(s.bbox["width"])} for s in thumbs]}

    def to_dict(self, with_clusters: bool = True) -> dict:
        d = {"id": self.id, "status": self.status, "error": self.error,
             "progress": round(self.progress, 3), "source": {"kind": self.kind, "uri": self.uri},
             "config": self.cfg.__dict__, "stats": self.stats, "created_at": self.created_at}
        if with_clusters:
            d["clusters"] = [self.cluster_dict(c) for c in sorted(self.clusters.values(), key=lambda c: c.id)]
            d["noise_count"] = len(self.noise)
        return d
