"""注册人脸质量门槛（纯函数，便于单测）。

landmarks_5 顺序（YuNet 标准）：[右眼, 左眼, 鼻尖, 右嘴角, 左嘴角]（图像坐标）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Sequence, Tuple


@dataclass
class QualityConfig:
    min_width: int = 80               # 人脸框宽度下限（px）
    edge_margin_ratio: float = 0.03   # 离画面边缘的最小距离 = ratio * min(H, W)
    min_edge_margin_px: int = 8
    max_yaw_ratio: float = 0.30       # |鼻尖相对两眼中点的水平偏移| / 眼距，≈0 为正脸；0.30 约 ±25°
    max_roll_deg: float = 25.0
    min_det_conf: float = 0.85
    min_landmark_inside: bool = True  # 5 个关键点都必须在框内（排除半张脸/遮挡）
    # 「尽量正脸」：注册视频里找不到合格正脸时，放宽到此 yaw 再试，并在模板上标记 relaxed_pose
    relaxed_yaw_ratio: float = 0.60


# 照片注册：允许贴边证件照；视频采集仍用 QualityConfig 默认值
PHOTO_ENROLL_QUALITY = QualityConfig(
    min_edge_margin_px=0, edge_margin_ratio=0, min_det_conf=0.75,
)


@dataclass
class QualityResult:
    ok: bool
    reasons: List[str] = field(default_factory=list)
    metrics: Dict[str, float] = field(default_factory=dict)

    @property
    def score(self) -> float:
        """越大越好：用于在多张候选里挑最佳（正脸、大、清晰优先）。"""
        m = self.metrics
        return (m.get("width", 0) / 200.0 + (1 - min(1.0, abs(m.get("yaw_ratio", 1)) / 0.5))
                + m.get("det_conf", 0))


def _bbox_xywh(bbox) -> Tuple[float, float, float, float]:
    if isinstance(bbox, dict):
        return bbox["x"], bbox["y"], bbox["width"], bbox["height"]
    x, y, w, h = bbox[:4]
    return x, y, w, h


def estimate_pose(landmarks_5: Sequence[Sequence[float]]) -> Tuple[float, float]:
    """返回 (yaw_ratio, roll_deg)。"""
    re, le, nose = landmarks_5[0], landmarks_5[1], landmarks_5[2]
    ex, ey = le[0] - re[0], le[1] - re[1]
    eye_dist = math.hypot(ex, ey) or 1e-6
    mid_x = (re[0] + le[0]) / 2
    yaw_ratio = (nose[0] - mid_x) / eye_dist
    roll = math.degrees(math.atan2(ey, ex))
    if roll > 90:
        roll -= 180
    elif roll < -90:
        roll += 180
    return yaw_ratio, roll


def check_face_quality(image_shape, bbox, landmarks_5, det_conf: float = 1.0,
                       cfg: QualityConfig = QualityConfig()) -> QualityResult:
    H, W = image_shape[:2]
    x, y, w, h = _bbox_xywh(bbox)
    reasons: List[str] = []
    margin = max(cfg.min_edge_margin_px, cfg.edge_margin_ratio * min(H, W))
    dist_edge = min(x, y, W - (x + w), H - (y + h))
    m: Dict[str, float] = {"width": float(w), "height": float(h), "edge_dist": float(dist_edge),
                           "edge_margin_required": float(margin), "det_conf": float(det_conf)}
    if w < cfg.min_width:
        reasons.append(f"face_too_small({w:.0f}<{cfg.min_width}px)")
    if dist_edge < margin:
        reasons.append(f"too_close_to_edge({dist_edge:.0f}<{margin:.0f}px)")
    if det_conf < cfg.min_det_conf:
        reasons.append(f"low_detection_conf({det_conf:.2f})")
    if not landmarks_5 or len(landmarks_5) < 5:
        reasons.append("missing_landmarks")
    else:
        yaw, roll = estimate_pose(landmarks_5)
        m["yaw_ratio"], m["roll_deg"] = round(yaw, 3), round(roll, 1)
        if abs(yaw) > cfg.max_yaw_ratio:
            reasons.append(f"not_frontal(yaw_ratio={yaw:.2f})")
        if abs(roll) > cfg.max_roll_deg:
            reasons.append(f"head_tilted(roll={roll:.0f}deg)")
        if cfg.min_landmark_inside:
            pad = 0.05 * w
            if any(not (x - pad <= px <= x + w + pad and y - pad <= py <= y + h + pad)
                   for px, py in landmarks_5):
                reasons.append("landmarks_outside_box(incomplete_face)")
    return QualityResult(ok=not reasons, reasons=reasons, metrics=m)
