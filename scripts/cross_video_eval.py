"""跨视频识别评测：使用当前人脸库（已在其它视频注册），播放目标视频并统计。

python scripts/cross_video_eval.py --video assets/videos/pexels_6760590.mp4 \
    --expect "厨房-演员A" "厨房-演员C" --out out/cross_6760590
"""
import argparse, json, os, sys, time
from collections import Counter, defaultdict
from pathlib import Path

import cv2, httpx

from shiwu.stream import create_source, StreamPipeline, PipelineConfig, EventBus, JsonlSink
from shiwu.stream.engine import LocalEngine
from shiwu.stream.annotate import draw_faces
ap = argparse.ArgumentParser()
ap.add_argument("--video", required=True)
ap.add_argument("--expect", nargs="*", default=[], help="视频中确实出现的已注册姓名（人工标注）")
ap.add_argument("--out", required=True)
ap.add_argument("--fps", type=float, default=5)
ap.add_argument("--min-face", type=int, default=40)
ap.add_argument("--threshold", type=float, default=None)
ap.add_argument("--shot-every", type=float, default=2.0)
ap.add_argument("--max-shots", type=int, default=8)
ap.add_argument("--no-vote", action="store_true", help="关闭轨迹级投票")
ap.add_argument("--vote-min-sim", type=float, default=0.50)
ap.add_argument("--multi", action="store_true", help="使用 data/templates.db 多模板库")
ap.add_argument("--gt", default=str(Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "eval" / "gt_tracks.json"))
ap.add_argument("--api", default="http://127.0.0.1:7400")
ap.add_argument("--token", default=os.getenv("SHIWU_API_TOKEN", "shiwu-dev-token"))
a = ap.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
for p in out.glob("shot_*.jpg"): p.unlink()

members = httpx.get(f"{a.api}/attendance/members", headers={"X-Shiwu-Token": a.token}).json()
names = {m["person_id"]: m["name"] for m in members if m.get("has_face_data")}
gallery = None
if a.multi:
    from shiwu.enroll import LocalGallery
    gallery = LocalGallery()
engine = LocalEngine(min_face_size=a.min_face, similarity_threshold=a.threshold, gallery=gallery)
engine.refresh_gallery()
bus = EventBus(); js = bus.subscribe(JsonlSink(str(out / "events.jsonl")))
shots = {"n": 0, "last": -1e9}

def save(frame, faces):
    if faces and frame.pts - shots["last"] >= a.shot_every and shots["n"] < a.max_shots:
        shots["n"] += 1; shots["last"] = frame.pts
        cv2.imwrite(str(out / f"shot_{shots['n']:02d}_t{frame.pts:05.2f}.jpg"),
                    draw_faces(frame.image, faces, f"{Path(a.video).name} t={frame.pts:.2f}s"))

src = create_source("file", a.video, realtime=False, fps=a.fps)
pipe = StreamPipeline(src, engine, PipelineConfig(recognize_cooldown_s=3, track_voting=not a.no_vote,
                                                  vote_min_sim=a.vote_min_sim), bus=bus,
                      name_resolver=names.get, on_processed=save)
pipe.start(background=False); js.close()

frames = [json.loads(l) for l in open(out / "events.jsonl")]
frames = [e for e in frames if e["type"] == "frame_result"]
per = defaultdict(list); track_ids = defaultdict(Counter); unknown_sims = []
for e in frames:
    for f in e["data"]["faces"]:
        if f["name"]:
            per[f["name"]].append(f["similarity"])
        else:
            unknown_sims.append(f["similarity"])
        track_ids[f["track_id"]][f["name"] or "unknown"] += 1

def dist(v):
    if not v: return {}
    v = sorted(v); n = len(v)
    q = lambda p: v[min(n - 1, int(p * n))]
    bins = Counter(f"{int(x*10)/10:.1f}" for x in v)
    return {"n": n, "min": round(v[0], 3), "p25": round(q(.25), 3), "median": round(q(.5), 3),
            "p75": round(q(.75), 3), "max": round(v[-1], 3), "mean": round(sum(v) / n, 3),
            "hist_0.1": dict(sorted(bins.items()))}

n_proc = len(frames)
n_face_frames = sum(1 for e in frames if e["data"]["faces"])
report = {"video": a.video, "expect": a.expect, "processed_frames": n_proc,
          "frames_with_faces": n_face_frames, "pipeline": pipe.summary(), "identities": {}}
for name in sorted(set(per) | set(a.expect)):
    fr = sum(1 for e in frames if any(f["name"] == name for f in e["data"]["faces"]))
    report["identities"][name] = {
        "expected_present": name in a.expect, "frames_recognized": fr,
        "rate_over_face_frames": round(fr / max(1, n_face_frames), 3),
        "similarity": dist(per[name])}
# 误识：未在视频中出现的已注册身份被识别出来的人脸次数
report["false_identity_faces"] = sum(len(v) for k, v in per.items() if k not in a.expect)
report["mixed_tracks"] = {str(t): dict(c) for t, c in track_ids.items()
                          if len([k for k in c if k != "unknown"]) > 1}
report["unknown_faces"] = dist(unknown_sims)
# ---- 基于人工轨迹真值的评测：单帧结果 vs 轨迹投票结果 ----
gt_all = json.load(open(a.gt)) if os.path.exists(a.gt) else {}
key = next((k for k in gt_all if k != "_doc" and Path(k).name == Path(a.video).name), None)
if key:
    gt = gt_all[key]; tracks_gt = gt["tracks"]; present = set(gt["expect"])
    def evaluate(field):
        per_id = defaultdict(lambda: {"faces": 0, "correct": 0})
        mis = []
        for e in frames:
            for f in e["data"]["faces"]:
                pred_pid = f.get(field)
                pred = names.get(pred_pid) if pred_pid else None
                t = str(f["track_id"]) if f["track_id"] >= 0 else None
                g = tracks_gt.get(t, "?") if t else "?"
                if g == "?":
                    if pred and pred not in present:
                        mis.append({"t": e["pts"], "track": f["track_id"], "pred": pred, "gt": g})
                    continue
                if g != "unknown":
                    per_id[g]["faces"] += 1
                    per_id[g]["correct"] += int(pred == g)
                if pred and pred != g:
                    mis.append({"t": e["pts"], "track": f["track_id"], "pred": pred, "gt": g})
        return {"per_identity": {k: {**v, "recall": round(v["correct"] / max(1, v["faces"]), 3)}
                                 for k, v in per_id.items()},
                "misidentifications": len(mis), "mis_examples": mis[:5]}
    report["gt_eval"] = {"frame_level": evaluate("frame_person_id"),
                         "final": evaluate("person_id"),
                         "config": {"track_voting": not a.no_vote, "vote_min_sim": a.vote_min_sim,
                                    "multi_template": a.multi}}
report["screenshots"] = sorted(p.name for p in out.glob("shot_*.jpg"))
json.dump(report, open(out / "report.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in report.items() if k != "screenshots"}, ensure_ascii=False, indent=1))
