"""端到端：从视频取一帧 -> 通过 API 注册其中一人 -> FileVideoSource 播放 -> pipeline 识别。

用法：python scripts/e2e_file_stream.py --video assets/videos/pexels_6760570.mp4 \
        --enroll-at 1.0 --name "演员A" --out out/6760570
需服务已在 http://127.0.0.1:7400 运行（SHIWU_API_TOKEN 一致）。
"""
import argparse, json, os, sys, time
from pathlib import Path

import cv2, httpx

from shiwu.stream import (create_source, StreamPipeline, PipelineConfig,
                                EventBus, JsonlSink, CallbackSink)
from shiwu.stream.engine import LocalEngine
from shiwu.stream.annotate import draw_faces
ap = argparse.ArgumentParser()
ap.add_argument("--video", required=True)
ap.add_argument("--enroll-at", type=float, default=1.0, help="注册帧时间（秒）")
ap.add_argument("--face", default="largest", help="largest 或 从左到右序号 0,1,...")
ap.add_argument("--name", default="注册演员")
ap.add_argument("--out", required=True)
ap.add_argument("--fps", type=float, default=5.0, help="pipeline 处理帧率")
ap.add_argument("--api", default="http://127.0.0.1:7400")
ap.add_argument("--token", default=os.getenv("SHIWU_API_TOKEN", "shiwu-dev-token"))
ap.add_argument("--max-shots", type=int, default=6)
ap.add_argument("--shot-every", type=float, default=3.0, help="截图最小间隔（秒）")
a = ap.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
H = {"X-Shiwu-Token": a.token}
cli = httpx.Client(base_url=a.api, headers=H, timeout=30)

# 1. 取注册帧
cap = cv2.VideoCapture(a.video); cap.set(cv2.CAP_PROP_POS_MSEC, a.enroll_at * 1000)
ok, img = cap.read(); cap.release(); assert ok, "cannot read enroll frame"
jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
det = cli.post("/detect", files={"image": ("f.jpg", jpg, "image/jpeg")}).json()
faces = [f for f in det["faces"] if f.get("landmarks_5")]
def _bb(f):  # API 返回 bbox 可能是 [x,y,w,h] 或 dict
    b = f["bbox"]
    return b if isinstance(b, dict) else dict(zip(("x", "y", "width", "height"), b))
assert faces, f"no face in enroll frame: {det}"
if a.face == "largest":
    face = max(faces, key=lambda f: _bb(f)["width"])
else:
    face = sorted(faces, key=lambda f: _bb(f)["x"])[int(a.face)]
cv2.imwrite(str(out / "enroll_frame.jpg"),
            draw_faces(img, [dict(face, bbox=_bb(face), person_id="ENROLL", name=a.name, similarity=1.0, track_id=0)],
                       f"enroll @ {a.enroll_at}s"))

# 2. 建组/成员并注册
groups = cli.get("/attendance/groups").json()
gid = next((g["id"] for g in groups if g["name"] == "默认组"), None) or \
    cli.post("/attendance/groups", json={"name": "默认组"}).json()["id"]
existing = [m for m in cli.get("/attendance/members").json()
            if m["name"] == a.name and m.get("has_face_data")]
if existing:  # 复跑时复用已注册成员，避免重复注册
    pid = existing[0]["person_id"]; print("reuse enrolled member", pid)
else:
  member = cli.post("/attendance/members", json={"name": a.name, "group_id": gid}).json()
  pid = member["person_id"]
  r = cli.post(f"/attendance/groups/{gid}/persons/{pid}/enroll-face",
             files={"image": ("f.jpg", jpg, "image/jpeg")},
               data={"metadata": json.dumps({"bbox": face["bbox"], "landmarks_5": face["landmarks_5"]})})
  print("enroll:", r.status_code, r.text[:200])
  r.raise_for_status()
names = {m["person_id"]: m["name"] for m in cli.get("/attendance/members").json()}

# 3. 播放视频 -> pipeline
engine = LocalEngine(min_face_size=40)
src = create_source("file", a.video, realtime=True, fps=25, loop=False)
bus = EventBus()
jsonl = bus.subscribe(JsonlSink(str(out / "events.jsonl")))
recog = []
bus.subscribe(CallbackSink(lambda e: recog.append(e), types=["person_recognized"]))
shots = {"n": 0, "last": -1e9}

def save(frame, faces):
    hit = any(f.get("person_id") == pid for f in faces)
    if hit and frame.pts - shots["last"] >= a.shot_every and shots["n"] < a.max_shots:
        shots["n"] += 1; shots["last"] = frame.pts
        cv2.imwrite(str(out / f"hit_{shots['n']:02d}_t{frame.pts:05.2f}.jpg"),
                    draw_faces(frame.image, faces, f"{Path(a.video).name} t={frame.pts:.2f}s"))

pipe = StreamPipeline(src, engine, PipelineConfig(max_process_fps=a.fps, recognize_cooldown_s=3),
                      bus=bus, name_resolver=names.get, on_processed=save)
t0 = time.time(); pipe.start(background=True); pipe.join(); jsonl.close()

# 4. 汇总
events = [json.loads(l) for l in open(out / "events.jsonl")]
frames = [e for e in events if e["type"] == "frame_result"]
hits = [f for e in frames for f in e["data"]["faces"] if f["person_id"] == pid]
others = [f for e in frames for f in e["data"]["faces"] if f["person_id"] not in (None, pid)]
frames_with_target = sum(any(f["person_id"] == pid for f in e["data"]["faces"]) for e in frames)
sims = [f["similarity"] for f in hits]
summary = {
    "video": a.video, "enrolled_person_id": pid, "enrolled_name": a.name,
    "enroll_at_s": a.enroll_at, "wall_s": round(time.time() - t0, 1),
    "pipeline": pipe.summary(),
    "processed_frames": len(frames), "frames_with_target": frames_with_target,
    "target_hit_rate": round(frames_with_target / max(1, len(frames)), 3),
    "similarity": {"min": min(sims, default=0), "max": max(sims, default=0),
                   "mean": round(sum(sims) / len(sims), 4) if sims else 0},
    "false_identity_hits": len(others),
    "person_recognized_events": len(recog), "screenshots": shots["n"],
}
json.dump(summary, open(out / "summary.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False, indent=2))
