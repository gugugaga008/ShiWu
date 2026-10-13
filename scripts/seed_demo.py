"""示例数据（仅用于演示/截图/E2E，产品默认数据为空）：
  1) 用素材视频「一键采集」登记人员：王总(老板)、张经理(领导)、小李(白名单)、小陈(同事)
  2) 写入 v1.1 规则示例（人员规则/时间段/距离/陌生人/白名单/离开恢复/邮件）
  3) --history N：在事件日志里生成过去 N 天的识别/触发记录（含加密快照），供统计/时间线页展示
用法：python scripts/seed_demo.py --url http://127.0.0.1:7411 --token T [--history 7] [--data-dir D]
--history 需与服务使用相同的 SHIWU_DATA_DIR / SHIWU_GALLERY_DIR（快照用同一机器密钥加密）。

人像素材选的是中国面孔的正面近景（见 scripts/fetch_assets.sh）：每人一段视频，一段只登记一个人。
注册质量门槛是「脸宽 ≥ 80px 且正脸（yaw ≤ 0.3）」，远景/侧脸的素材会一个合格样本都取不到，
换素材时先用 /boss/captures 看一眼 clusters[].quality_ok 再往里加。
"""
import argparse
import os
import random
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
V = ROOT / "assets" / "videos"
# (视频, 姓名, 角色)：一段视频登记一个人
PEOPLE = [
    ("pexels_7845250.mp4", "王总", "boss"),
    ("pexels_8136078.mp4", "张经理", "leader"),
    ("pexels_7844921.mp4", "小李", "whitelist"),
    ("pexels_8519360.mp4", "小陈", "staff"),
]
V_SNAPSHOT = V / "pexels_8519360.mp4"


def capture(c, video, secs=8):
    sid = c.post("/captures", json={"kind": "file", "uri": str(video), "duration_s": secs, "fps": 5}).json()["id"]
    for _ in range(120):
        d = c.get(f"/captures/{sid}").json()
        if d["status"] in ("ready", "error"):
            return sid, d
        time.sleep(1)
    raise TimeoutError(video)


def enroll(c, sid, cl, name, role):
    r = c.post(f"/captures/{sid}/clusters/{cl['id']}/confirm", json={"action": "enroll", "name": name, "role": role})
    if r.status_code != 200:
        print("  跳过", name, r.text[:120])
        return None
    print(f"  登记 {name}（{role}）← 簇 {cl['id']}，{len(r.json().get('enrolled_templates', []))} 个模板")
    return r.json()["person_id"]


def people(c):
    ids = {}
    for video, name, role in PEOPLE:
        sid, d = capture(c, V / video, 10)
        cl = [x for x in d["clusters"] if x["quality_ok"] > 0 and not x.get("known_person_id")]
        if not cl:
            print(f"  跳过 {name}：{video} 没有合格正脸样本")
            continue
        pid = enroll(c, sid, max(cl, key=lambda x: x["quality_ok"]), name, role)
        if pid:
            ids[name] = pid
    return ids


def rules(c, ids):
    wd = {"days": [0, 1, 2, 3, 4], "start": "09:00", "end": "19:00"}
    rs = [
        {"id": "whitelist", "role": "whitelist", "whitelist": True, "suppress_others": False, "min_frames": 1,
         "note": "白名单：同事路过不触发"},
        {"id": "boss", "role": "boss", "min_frames": 3, "cooldown_s": 60, "restore_on_leave": True, "leave_after_s": 15,
         "actions": [{"type": "notify"}, {"type": "sound"}, {"type": "cover", "params": {"style": "spreadsheet"}},
                     {"type": "minimize_all"}, {"type": "email", "params": {"attach_snapshot": True}}],
         "note": "识别到老板：遮挡 + 最小化 + 邮件，离开 15 秒自动恢复"},
        {"id": "leader-near", "role": "leader", "min_frames": 3, "cooldown_s": 120, "min_face_ratio": 0.08,
         "schedule": [wd], "actions": [{"type": "notify"}], "note": "领导走近（脸宽≥画面 8%）且在工作时间才提醒"},
        {"id": "staff", "role": "staff", "enabled": False, "min_frames": 5, "cooldown_s": 300,
         "actions": [{"type": "log"}], "note": "同事：只记录"},
        {"id": "stranger", "stranger": True, "stranger_after_s": 5, "min_frames": 3, "cooldown_s": 300,
         "sources": ["门口"], "actions": [{"type": "notify"}, {"type": "email"}], "note": "门口出现陌生人 5 秒"},
    ]
    if ids.get("王总"):
        rs.insert(1, {"id": "wang-door", "person_ids": [ids["王总"]], "min_frames": 2, "cooldown_s": 60,
                      "sources": ["门口"], "min_face_px": 60, "restore_on_leave": True, "leave_after_s": 10,
                      "actions": [{"type": "cover", "params": {"style": "code"}}, {"type": "minimize_all"},
                                  {"type": "email", "params": {"attach_snapshot": True}}],
                      "note": "王总从门口进来：立刻遮挡"})
    r = c.put("/rules", json=rs)
    r.raise_for_status()
    print(f"  规则 {len(r.json()['rules'])} 条")


def history(ids, days, data_dir=None):
    import cv2
    from shiwu.notify import SnapshotStore
    from shiwu.rules import EventLog
    el, snaps = EventLog(), SnapshotStore()
    frames = []
    cap = cv2.VideoCapture(str(V_SNAPSHOT))
    for ms in (3000, 8000, 13000, 17000):
        cap.set(cv2.CAP_PROP_POS_MSEC, ms)
        ok, f = cap.read()
        if ok:
            f = cv2.resize(f, (960, 540))
            cv2.rectangle(f, (380, 90), (600, 360), (0, 0, 255), 4)
            frames.append(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes())
    rnd = random.Random(7)
    roles = {"王总": "boss", "小李": "whitelist", "张经理": "leader", "小陈": "staff", "小赵": "staff"}
    peak = {"王总": [10, 11, 15, 16], "张经理": [9, 14, 17], "小李": [9, 10, 11, 13, 14, 15, 16, 17],
            "小陈": list(range(9, 19)), "小赵": list(range(9, 19))}
    now = time.time()
    n_rec = n_act = 0
    for d in range(days, 0, -1):
        base = time.mktime(time.localtime(now - d * 86400)[:3] + (0, 0, 0, 0, 0, -1))
        weekend = time.localtime(base).tm_wday >= 5
        for name, pid in ids.items():
            k = rnd.randint(0, 2) if weekend else rnd.randint(2, 7 if name != "王总" else 5)
            for i in range(k):
                ts = base + rnd.choice(peak[name]) * 3600 + rnd.randint(0, 3599)
                src = rnd.choice(["门口", "门口", "桌面"])
                tid = rnd.randint(1, 10_000)
                el.add("recognized", ts=ts, person_id=pid, name=name, role=roles[name], track_id=tid,
                       similarity=round(rnd.uniform(0.6, 0.85), 3), source=src, detail="track_identity")
                n_rec += 1
                if name in ("王总", "张经理") and (name == "王总" or rnd.random() < 0.4):
                    rid = "wang-door" if (name == "王总" and src == "门口") else ("boss" if name == "王总" else "leader-near")
                    sid = snaps.save(rnd.choice(frames), ts + 1) if frames else None
                    acts = [{"type": "cover", "params": {}}, {"type": "email", "params": {}}] if name == "王总" else [{"type": "notify", "params": {}}]
                    el.add("action", ts=ts + 1, person_id=pid, name=name, role=roles[name], rule_id=rid, track_id=tid,
                           similarity=0.75, actions=acts, source=src, snapshot=sid, detail={"event_id": f"demo{n_act}"})
                    n_act += 1
                    if name == "王总":
                        el.add("left", ts=ts + rnd.randint(30, 300), person_id=pid, name=name, role="boss",
                               rule_id=rid, source=src, detail={"action_id": f"demo{n_act}", "away_s": 15})
        if not weekend and rnd.random() < 0.5:
            ts = base + rnd.randint(9, 18) * 3600
            el.add("action", ts=ts, name="陌生人", role=None, rule_id="stranger", track_id=rnd.randint(1, 999),
                   actions=[{"type": "notify", "params": {}}], source="门口",
                   snapshot=snaps.save(rnd.choice(frames), ts) if frames else None, detail={"event_id": "demo-s"})
            n_act += 1
    print(f"  历史：{n_rec} 条识别、{n_act} 次触发（{days} 天）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--history", type=int, default=0)
    ap.add_argument("--no-people", action="store_true")
    a = ap.parse_args()
    c = httpx.Client(base_url=a.url.rstrip("/") + "/boss", headers={"X-Shiwu-Token": a.token}, timeout=120)
    ids = {p["name"]: p["person_id"] for p in c.get("/people").json()}
    if not a.no_people and "王总" not in ids:
        ids.update(people(c))
    rules(c, ids)
    if a.history:
        history(ids, a.history)
    print("完成：", ", ".join(ids))


if __name__ == "__main__":
    main()
