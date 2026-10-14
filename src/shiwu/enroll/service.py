"""注册服务：从图片或注册视频中挑选高质量、多角度的人脸模板。"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence

import cv2
import numpy as np

from .gallery import LocalGallery
from .quality import PHOTO_ENROLL_QUALITY, QualityConfig, QualityResult, check_face_quality

logger = logging.getLogger(__name__)


@dataclass
class Candidate:
    image: np.ndarray
    face: dict
    quality: QualityResult
    pts: float = 0.0
    embedding: Optional[np.ndarray] = None
    source: str = ""


@dataclass
class EnrollReport:
    person_id: str
    accepted: List[dict] = field(default_factory=list)
    rejected: List[dict] = field(default_factory=list)

    def to_dict(self):
        return {"person_id": self.person_id, "accepted": self.accepted, "rejected": self.rejected}


def _iou(a, b):
    ax, ay, aw, ah = a["x"], a["y"], a["width"], a["height"]
    bx, by, bw, bh = b["x"], b["y"], b["width"], b["height"]
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / (aw * ah + bw * bh - inter + 1e-6)


def select_face(faces: List[dict], selector="largest") -> Optional[dict]:
    if not faces:
        return None
    if selector == "largest":
        return max(faces, key=lambda f: f["bbox"]["width"])
    if isinstance(selector, (tuple, list)):  # (x, y) 点选
        px, py = selector
        inside = [f for f in faces if f["bbox"]["x"] <= px <= f["bbox"]["x"] + f["bbox"]["width"]
                  and f["bbox"]["y"] <= py <= f["bbox"]["y"] + f["bbox"]["height"]]
        return inside[0] if inside else None
    return sorted(faces, key=lambda f: f["bbox"]["x"])[int(selector)]


class EnrollmentService:
    def __init__(self, engine, gallery: LocalGallery, quality: QualityConfig = QualityConfig(),
                 consistency_min_sim: float = 0.5, diversity_max_sim: float = 0.92):
        """engine: LocalEngine（用其 detector / embed）。
        consistency_min_sim: 候选与锚点模板的最低相似度（防止轨迹串人）。
        diversity_max_sim: 与已选模板相似度高于此值视为重复，不再加入。"""
        self.engine, self.gallery, self.q = engine, gallery, quality
        self.consistency_min_sim, self.diversity_max_sim = consistency_min_sim, diversity_max_sim

    # ---------- 质量检查 ----------
    def check(self, image, face) -> QualityResult:
        return check_face_quality(image.shape, face["bbox"], face.get("landmarks_5"),
                                  face.get("confidence", 1.0), self.q)

    def _detect(self, image):
        # 注册检测不设最小尺寸，由质量门槛统一判断
        det = self.engine.detector
        old = det.min_face_size
        det.set_min_face_size(0)
        try:
            return det.detect_faces(image) or []
        finally:
            det.set_min_face_size(old)

    # ---------- 选择多样化模板 ----------
    def _pick(self, cands: List[Candidate], anchor: Candidate, k: int, rep: EnrollReport):
        good = [c for c in cands if c.quality.ok]
        for c in cands:
            if not c.quality.ok:
                rep.rejected.append({"source": c.source, "reasons": c.quality.reasons,
                                     "metrics": c.quality.metrics})
        if not good:
            return []
        for c in good:
            c.embedding = np.asarray(self.engine.embed(c.image, [c.face])[0], np.float32)
        a = anchor.embedding
        good = [c for c in good if float(c.embedding @ a) >= self.consistency_min_sim
                or rep.rejected.append({"source": c.source,
                                        "reasons": [f"inconsistent_with_anchor({float(c.embedding @ a):.2f})"]})]
        good.sort(key=lambda c: c.quality.score, reverse=True)
        chosen = [anchor] if anchor in good else []
        pool = [c for c in good if c is not anchor]
        while pool and len(chosen) < k:
            # 选与已选集合「最不像」（但仍在 consistency 内）的候选 → 角度/光照多样
            def max_sim(c):
                return max((float(c.embedding @ s.embedding) for s in chosen), default=0.0)
            pool.sort(key=lambda c: (max_sim(c), -c.quality.score))
            c = pool.pop(0)
            if chosen and max_sim(c) > self.diversity_max_sim:
                break
            chosen.append(c)
        return chosen

    def _save(self, person_id, name, chosen: Sequence[Candidate], rep: EnrollReport):
        for c in chosen:
            tid = self.gallery.add(person_id, c.embedding, name=name,
                                   quality=c.quality.metrics, source=c.source)
            rep.accepted.append({"template_id": tid, "source": c.source,
                                 "metrics": c.quality.metrics})

    # ---------- 入口 1：多张图片 ----------
    def enroll_images(self, person_id: str, images: Sequence[np.ndarray], name: str = "",
                      sources: Optional[Sequence[str]] = None, selector="largest",
                      max_templates: int = 5) -> EnrollReport:
        rep = EnrollReport(person_id)
        cands = []
        for i, img in enumerate(images):
            src = sources[i] if sources else f"image[{i}]"
            f = select_face(self._detect(img), selector)
            if f is None:
                rep.rejected.append({"source": src, "reasons": ["no_face"]})
                continue
            q = check_face_quality(img.shape, f["bbox"], f.get("landmarks_5"),
                                   f.get("confidence", 1.0), PHOTO_ENROLL_QUALITY)
            cands.append(Candidate(img, f, q, source=src))
        ok = [c for c in cands if c.quality.ok]
        if not ok:
            for c in cands:
                rep.rejected.append({"source": c.source, "reasons": c.quality.reasons})
            return rep
        anchor = max(ok, key=lambda c: c.quality.score)
        anchor.embedding = np.asarray(self.engine.embed(anchor.image, [anchor.face])[0], np.float32)
        self._save(person_id, name, self._pick(cands, anchor, max_templates, rep), rep)
        return rep

    # ---------- 入口 2：注册视频（跟踪锚点人物，自动挑多角度帧） ----------
    def enroll_from_video(self, person_id: str, video: str, at_s: float, selector="largest",
                          name: str = "", max_templates: int = 5, sample_fps: float = 5.0,
                          window_s: Optional[float] = None,
                          on_anchor: Optional[Callable[[np.ndarray, dict], None]] = None) -> EnrollReport:
        rep = EnrollReport(person_id)
        cap = cv2.VideoCapture(video)
        cap.set(cv2.CAP_PROP_POS_MSEC, at_s * 1000)
        ok, img = cap.read()
        if not ok:
            raise RuntimeError("cannot read anchor frame")
        faces0 = self._detect(img)
        if selector == "largest":  # 优先在合格人脸里选最大的
            okf = [x for x in faces0 if self.check(img, x).ok]
            f = select_face(okf or faces0, "largest")
        else:
            f = select_face(faces0, selector)
        if f is None:
            raise ValueError("no face at anchor frame")
        anchor = Candidate(img, f, self.check(img, f), pts=at_s, source=f"{video}@{at_s:.2f}s")
        # 锚点只用于「指认是谁」；不合格的锚点不会成为模板，但可用来在视频里找该人的合格帧
        if not anchor.quality.ok:
            rep.rejected.append({"source": anchor.source, "reasons": anchor.quality.reasons,
                                 "metrics": anchor.quality.metrics, "anchor": True})
        anchor.embedding = np.asarray(self.engine.embed(img, [f])[0], np.float32)
        if on_anchor:
            on_anchor(img, f)

        # 在整段（或窗口内）视频里按 embedding 找同一人；不依赖跟踪 ID，避免串轨
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        step = max(1, int(round(fps / sample_fps)))
        lo, hi = 0, n
        if window_s:
            lo, hi = int(max(0, at_s - window_s) * fps), int(min(n, (at_s + window_s) * fps))
        cands = [anchor] if anchor.quality.ok else []
        for i in range(lo, hi, step):
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, im = cap.read()
            if not ok:
                break
            faces = self._detect(im)
            if not faces:
                continue
            embs = self.engine.embed(im, faces)
            j = int(np.argmax([float(np.asarray(e) @ anchor.embedding) for e in embs]))
            if float(np.asarray(embs[j]) @ anchor.embedding) < self.consistency_min_sim:
                continue
            c = Candidate(im, faces[j], self.check(im, faces[j]), pts=i / fps,
                          source=f"{video}@{i / fps:.2f}s")
            c.embedding = np.asarray(embs[j], np.float32)
            cands.append(c)
        cap.release()
        good = [c for c in cands if c.quality.ok]
        if not good and self.q.relaxed_yaw_ratio > self.q.max_yaw_ratio:
            # 没有合格正脸：仅放宽姿态一项（尺寸/边缘/完整性仍严格），并标记
            from dataclasses import replace
            rq = replace(self.q, max_yaw_ratio=self.q.relaxed_yaw_ratio)
            for c in cands:
                r = check_face_quality(c.image.shape, c.face["bbox"], c.face.get("landmarks_5"),
                                       c.face.get("confidence", 1.0), rq)
                if r.ok:
                    r.metrics["relaxed_pose"] = 1.0
                    c.quality = r
            good = [c for c in cands if c.quality.ok]
            if good:
                logger.warning("no frontal face found; using %d relaxed-pose candidates", len(good))
        rejected = [c for c in cands if not c.quality.ok]
        rep.rejected += [{"source": c.source, "reasons": c.quality.reasons} for c in rejected]
        good.sort(key=lambda c: c.quality.score, reverse=True)
        if not good:
            return rep
        # 首个模板：合格锚点；否则与锚点最相似的合格帧（同一人置信度最高）
        first = anchor if anchor.quality.ok else max(good, key=lambda c: float(c.embedding @ anchor.embedding))
        chosen = [first]
        pool = [c for c in good if c is not first]
        while pool and len(chosen) < max_templates:
            ms = lambda c: max(float(c.embedding @ s.embedding) for s in chosen)  # noqa: E731
            pool.sort(key=lambda c: (ms(c), -c.quality.score))
            c = pool.pop(0)
            if ms(c) > self.diversity_max_sim:
                break
            chosen.append(c)
        self._save(person_id, name, chosen, rep)
        return rep


def choose_templates(cands: List[Candidate], q: QualityConfig, max_templates: int = 5,
                     diversity_max_sim: float = 0.92) -> List[Candidate]:
    """从已带 embedding 的候选里挑合格且多样的模板（供一键采集等复用）。

    先按严格门槛；一个都没有时只放宽姿态（标记 relaxed_pose）。"""
    from dataclasses import replace

    def _rq(cfg):
        out = []
        for c in cands:
            r = check_face_quality(c.image_shape if hasattr(c, "image_shape") else c.image.shape,
                                   c.face["bbox"], c.face.get("landmarks_5"),
                                   c.face.get("confidence", 1.0), cfg)
            c.quality = r
            if r.ok:
                out.append(c)
        return out

    good = _rq(q)
    if not good and q.relaxed_yaw_ratio > q.max_yaw_ratio:
        good = _rq(replace(q, max_yaw_ratio=q.relaxed_yaw_ratio))
        for c in good:
            c.quality.metrics["relaxed_pose"] = 1.0
    if not good:
        return []
    good.sort(key=lambda c: c.quality.score, reverse=True)
    chosen = [good[0]]
    pool = good[1:]
    while pool and len(chosen) < max_templates:
        ms = lambda c: max(float(c.embedding @ s.embedding) for s in chosen)  # noqa: E731
        pool.sort(key=lambda c: (ms(c), -c.quality.score))
        c = pool.pop(0)
        if ms(c) > diversity_max_sim:
            break
        chosen.append(c)
    return chosen
