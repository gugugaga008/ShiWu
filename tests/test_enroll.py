"""注册质量门槛与多模板库单元测试（不依赖模型）。"""
import sys
from pathlib import Path

import numpy as np
import pytest

from shiwu.enroll import LocalGallery, QualityConfig, check_face_quality, estimate_pose  # noqa

SHAPE = (720, 1280, 3)


def lm(cx, cy, w, yaw=0.0):
    """生成 5 点：yaw 为鼻尖相对眼距的水平偏移比例。"""
    ed = 0.4 * w
    return [[cx - ed / 2, cy - 0.15 * w], [cx + ed / 2, cy - 0.15 * w],
            [cx + yaw * ed, cy + 0.05 * w], [cx - ed / 2.5, cy + 0.25 * w], [cx + ed / 2.5, cy + 0.25 * w]]


def box(x, y, w, h=None):
    return {"x": x, "y": y, "width": w, "height": h or int(w * 1.25)}


def test_good_frontal_face_passes():
    r = check_face_quality(SHAPE, box(500, 200, 120), lm(560, 275, 120), 0.95)
    assert r.ok, r.reasons
    assert abs(r.metrics["yaw_ratio"]) < 0.01


@pytest.mark.parametrize("bbox,lms,conf,reason", [
    (box(500, 200, 60), lm(530, 237, 60), 0.95, "face_too_small"),
    (box(0, 200, 120), lm(60, 275, 120), 0.95, "too_close_to_edge"),
    (box(1270 - 120, 200, 120), lm(1270 - 60, 275, 120), 0.95, "too_close_to_edge"),
    (box(500, 200, 120), lm(560, 275, 120, yaw=0.6), 0.95, "not_frontal"),
    (box(500, 200, 120), lm(560, 275, 120), 0.5, "low_detection_conf"),
    (box(500, 200, 120), None, 0.95, "missing_landmarks"),
])
def test_rejections(bbox, lms, conf, reason):
    r = check_face_quality(SHAPE, bbox, lms, conf)
    assert not r.ok and any(x.startswith(reason) for x in r.reasons), r.reasons


def test_incomplete_face_landmarks_outside_box():
    pts = lm(560, 275, 120)
    pts[1][0] += 200   # 左眼跑到框外（半张脸被截断时的典型情况）
    r = check_face_quality(SHAPE, box(500, 200, 120), pts, 0.95)
    assert any(x.startswith("landmarks_outside_box") for x in r.reasons)


def test_bbox_list_format_and_roll():
    pts = lm(560, 275, 120)
    pts[1][1] += 60   # 头部倾斜
    r = check_face_quality(SHAPE, [500, 200, 120, 150], pts, 0.95)
    assert any(x.startswith("head_tilted") for x in r.reasons)
    yaw, roll = estimate_pose(lm(0, 0, 100, yaw=0.2))
    assert abs(yaw - 0.2) < 1e-6 and abs(roll) < 1e-6


def test_custom_config():
    r = check_face_quality(SHAPE, box(500, 200, 60), lm(530, 237, 60), 0.95, QualityConfig(min_width=50))
    assert r.ok


def test_gallery_multi_template_max_match(tmp_path):
    g = LocalGallery(str(tmp_path / "g.db"))
    rng = np.random.default_rng(0)
    a1, a2, b = (rng.normal(size=512) for _ in range(3))
    g.add("A", a1, "甲"); g.add("A", a2, "甲"); g.add("B", b, "乙")
    assert g.count() == {"A": 2, "B": 1}
    M, ids = g.matrix()
    q = a2 / np.linalg.norm(a2)
    (pid, sim), = g.match(q[None], M, ids, 0.45)
    assert pid == "A" and sim > 0.99           # 命中第二个模板
    (pid, sim), = g.match(rng.normal(size=(1, 512)) / 30, M, ids, 0.45)
    assert pid is None
    assert g.remove_person("A") == 2 and g.count() == {"B": 1}


def test_gallery_empty(tmp_path):
    g = LocalGallery(str(tmp_path / "e.db"))
    M, ids = g.matrix()
    assert g.match(np.ones((2, 512)), M, ids, 0.4) == [(None, 0.0), (None, 0.0)]


ROOT = Path(__file__).resolve().parents[1]
VID = ROOT / "assets" / "videos" / "pexels_6760570.mp4"


@pytest.mark.skipif(not VID.exists(), reason="no asset")
def test_smoke_enroll_gate_and_multi_template(tmp_path):
    from shiwu.enroll import EnrollmentService
    from shiwu.stream.engine import LocalEngine
    eng = LocalEngine(enable_tracking=False)
    svc = EnrollmentService(eng, LocalGallery(str(tmp_path / "g.db")))
    # t=1.0 最左侧是被画面边缘截断的半张脸：必须被拒
    bad = svc.enroll_from_video("X", str(VID), 1.0, selector=0, max_templates=3)
    assert not bad.accepted
    assert any("too_close_to_edge" in r for x in bad.rejected for r in x["reasons"])
    # 选最大的合格人脸（演员 A），自动挑多张多样化模板
    good = svc.enroll_from_video("A", str(VID), 1.0, max_templates=3, window_s=6)
    assert 2 <= len(good.accepted) <= 3
    assert all(x["metrics"]["width"] >= 80 for x in good.accepted)
