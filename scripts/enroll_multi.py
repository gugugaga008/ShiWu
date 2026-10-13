"""带质量门槛的多照片注册。

  # 从注册视频：锚点帧选人 -> 自动在该视频里挑最多 N 张多角度合格模板
  python scripts/enroll_multi.py --name "厨房-演员C" --video assets/videos/pexels_6760570.mp4 --at 12.3 --face 0
  # 从多张图片
  python scripts/enroll_multi.py --name "张三" --images a.jpg b.jpg c.jpg
  # 只做质量检查
  python scripts/enroll_multi.py --check --video ... --at 1.0 --face 0

成员不存在时会通过 API 创建，并用锚点照片做主模板（前端人员列表可见）；
额外模板写入 data/templates.db。
"""
import argparse, json, os, sys
from pathlib import Path

import cv2, httpx

from shiwu.enroll import LocalGallery, EnrollmentService, QualityConfig
from shiwu.enroll.service import select_face
from shiwu.stream.engine import LocalEngine
from shiwu.stream.annotate import draw_faces
ap = argparse.ArgumentParser()
ap.add_argument("--name")
ap.add_argument("--video"); ap.add_argument("--at", type=float, default=0.0)
ap.add_argument("--images", nargs="*")
ap.add_argument("--face", default="largest")
ap.add_argument("--max-templates", type=int, default=5)
ap.add_argument("--window", type=float, default=None, help="只在锚点前后 N 秒内挑模板")
ap.add_argument("--min-width", type=int, default=80)
ap.add_argument("--max-yaw", type=float, default=0.30)
ap.add_argument("--check", action="store_true", help="只检查锚点质量，不注册")
ap.add_argument("--replace", action="store_true", help="先清空该人在多模板库里的旧模板")
ap.add_argument("--gallery", default=None)
ap.add_argument("--out", default=None, help="保存锚点/模板缩略图的目录")
ap.add_argument("--api", default="http://127.0.0.1:7400")
ap.add_argument("--token", default=os.getenv("SHIWU_API_TOKEN", "shiwu-dev-token"))
a = ap.parse_args()
sel = a.face if a.face == "largest" else int(a.face)
q = QualityConfig(min_width=a.min_width, max_yaw_ratio=a.max_yaw)
engine = LocalEngine(enable_tracking=False)
gallery = LocalGallery(a.gallery)
svc = EnrollmentService(engine, gallery, q)

if a.check:
    cap = cv2.VideoCapture(a.video); cap.set(cv2.CAP_PROP_POS_MSEC, a.at * 1000); _, img = cap.read()
    f = select_face(svc._detect(img), sel)
    r = svc.check(img, f) if f else None
    print(json.dumps({"ok": r.ok, "reasons": r.reasons, "metrics": r.metrics} if r else {"ok": False, "reasons": ["no_face"]},
                     ensure_ascii=False))
    sys.exit(0 if r and r.ok else 2)

cli = httpx.Client(base_url=a.api, headers={"X-Shiwu-Token": a.token}, timeout=30)
members = cli.get("/attendance/members").json()
m = next((m for m in members if m["name"] == a.name), None)
anchor_holder = {}

def on_anchor(img, face):
    if svc.check(img, face).ok:
        anchor_holder["img"], anchor_holder["face"] = img, face

if a.video:
    pid_tmp = m["person_id"] if m else "__pending__"
    if a.replace and m:
        gallery.remove_person(m["person_id"])
    rep = svc.enroll_from_video(pid_tmp, a.video, a.at, sel, a.name, a.max_templates,
                                window_s=a.window, on_anchor=on_anchor)
else:
    imgs = [cv2.imread(p) for p in a.images]
    pid_tmp = m["person_id"] if m else "__pending__"
    if a.replace and m:
        gallery.remove_person(m["person_id"])
    rep = svc.enroll_images(pid_tmp, imgs, a.name, sources=a.images, selector=sel,
                            max_templates=a.max_templates)

if not rep.accepted:
    print(json.dumps({"enrolled": False, "rejected_count": len(rep.rejected),
                      "first_rejections": rep.rejected[:3]}, ensure_ascii=False, indent=1))
    sys.exit(2)

if m is None:  # 新成员：建档 + 主模板
    groups = cli.get("/attendance/groups").json()
    gid = next((g["id"] for g in groups if g["name"] == "默认组"), None) or \
        cli.post("/attendance/groups", json={"name": "默认组"}).json()["id"]
    m = cli.post("/attendance/members", json={"name": a.name, "group_id": gid}).json()
    img, face = anchor_holder.get("img"), anchor_holder.get("face")
    if img is not None:
        jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
        b = face["bbox"]
        r = cli.post(f"/attendance/groups/{gid}/persons/{m['person_id']}/enroll-face",
                     files={"image": ("f.jpg", jpg, "image/jpeg")},
                     data={"metadata": json.dumps({"bbox": [b["x"], b["y"], b["width"], b["height"]],
                                                   "landmarks_5": face["landmarks_5"]})})
        r.raise_for_status()
    gallery._db.execute("UPDATE templates SET person_id=? WHERE person_id='__pending__'", (m["person_id"],))
    gallery._db.commit()

out = {"enrolled": True, "name": a.name, "person_id": m["person_id"],
       "templates_total": gallery.count().get(m["person_id"], 0),
       "accepted": [{"source": x["source"], "width": x["metrics"]["width"],
                     "yaw_ratio": x["metrics"].get("yaw_ratio"),
                     "relaxed_pose": bool(x["metrics"].get("relaxed_pose"))} for x in rep.accepted],
       "rejected_count": len(rep.rejected),
       "rejected_reasons": sorted({r.split("(")[0] for x in rep.rejected for r in x["reasons"]})}
if a.out:
    Path(a.out).mkdir(parents=True, exist_ok=True)
    json.dump({**out, "detail": rep.to_dict()}, open(Path(a.out) / f"enroll_{m['person_id']}.json", "w"),
              ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1))
